import type { Prisma } from "@/generated/prisma/client";
import { withTenant, type Tx } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { assertCan, can, ForbiddenError } from "@/lib/auth/rbac";
import type { Actor } from "@/lib/actor";
import { ConflictError, NotFoundError, TenantUnavailableError, ValidationError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs";
import { slugify } from "@/lib/richtext";
import { translationState, validatePayload } from "@/lib/content/validate";
import { typeDef, type TypeDef } from "@/lib/content/types";

/**
 * Content service (PRD §7): draft / publish separation, optimistic locking (409), unique slugs, media reference tracking,
 * audit in the SAME transaction as the change, cache-invalidation job in the same transaction (outbox pattern).
 * Identity and tenant come from the Actor (session) — never from input.
 */
export const PAGE_SIZE = 20;
type Payload = Record<string, unknown>;
export type ContentStatus = "draft" | "published" | "changed";

export type ContentDto = {
  id: string; type: string; slug: string; version: number; position: number; updatedAt: Date; publishedAt: Date | null;
  status: ContentStatus; title: string; draft: Payload; published: Payload | null; en: "none" | "partial" | "complete";
};

const tenantIdOf = (a: Actor): string => {
  const p = a.principal;
  const id = p.kind === "school_admin" || p.kind === "impersonation" ? p.tenantId : null;
  if (!id) throw new ForbiddenError("content.read");
  return id;
};
const statusOf = (draft: Payload, published: Payload | null): ContentStatus =>
  !published ? "draft" : JSON.stringify(draft) === JSON.stringify(published) ? "published" : "changed";

function toDto(def: TypeDef, r: { id: string; type: string; slug: string; version: number; position: number; updatedAt: Date; publishedAt: Date | null; draftPayload: Prisma.JsonValue; publishedPayload: Prisma.JsonValue | null }): ContentDto {
  const draft = r.draftPayload as Payload; const published = (r.publishedPayload as Payload | null) ?? null;
  return { id: r.id, type: r.type, slug: r.slug, version: r.version, position: r.position, updatedAt: r.updatedAt, publishedAt: r.publishedAt, status: statusOf(draft, published), title: String(draft[def.titleField] ?? ""), draft, published, en: translationState(def, draft) };
}

async function assertWritable(tx: Tx, tenantId: string) {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true, deletedAt: true } });
  if (!t || t.deletedAt || t.status === "SUSPENDED") throw new TenantUnavailableError(); // suspended schools lose publishing rights (TEN04)
}

function def(type: string): TypeDef { const d = typeDef(type); if (!d) throw new NotFoundError("Jenis konten"); return d; }

async function uniqueSlug(tx: Tx, type: Prisma.ContentItemWhereInput["type"], base: string, selfId?: string): Promise<string> {
  const root = base || "item";
  for (let n = 1; n < 200; n++) {
    const s = n === 1 ? root : `${root}-${n}`;
    const hit = await tx.contentItem.findFirst({ where: { type, slug: s, ...(selfId ? { id: { not: selfId } } : {}) }, select: { id: true } });
    if (!hit) return s;
  }
  throw new ValidationError({ _slug: "Tidak dapat membuat slug unik" });
}

/** References must point at THIS school's READY media of the right kind (composite FK also guards cross-tenant). */
async function checkMedia(tx: Tx, d: TypeDef, ids: string[], draft: Payload) {
  if (!ids.length) return;
  const rows = await tx.mediaAsset.findMany({ where: { id: { in: ids } }, select: { id: true, mime: true, state: true } });
  const by = new Map(rows.map((r) => [r.id, r]));
  const errs: Record<string, string> = {};
  const check = (name: string, accept: string | undefined, id: unknown, path: string) => {
    if (!id) return; const m = by.get(String(id));
    if (!m || m.state !== "READY") errs[path] = "Media tidak ditemukan atau belum siap";
    else if (accept === "image" && !m.mime.startsWith("image/")) errs[path] = "Harus berupa gambar";
    else if (accept === "pdf" && m.mime !== "application/pdf") errs[path] = "Harus berupa PDF";
    void name;
  };
  for (const f of d.fields) {
    if (f.kind === "media") check(f.name, f.accept, draft[f.name], f.name);
    if (f.kind === "repeater") ((draft[f.name] as Payload[]) ?? []).forEach((row, i) => (f.sub ?? []).filter((s) => s.kind === "media").forEach((s) => check(s.name, s.accept, row[s.name], `${f.name}.${i}.${s.name}`)));
  }
  if (Object.keys(errs).length) throw new ValidationError(errs);
}

async function syncRefs(tx: Tx, tenantId: string, ownerId: string, ids: string[]) {
  await tx.mediaReference.deleteMany({ where: { ownerType: "content", ownerId } });
  if (ids.length) await tx.mediaReference.createMany({ data: ids.map((assetId) => ({ tenantId, assetId, ownerType: "content", ownerId })) });
}

const invalidate = (tx: Tx, tenantId: string, what: string) =>
  enqueue(tx, { type: "cache.invalidate", tenantId, payload: { what }, dedupeKey: `cache:${tenantId}:${what}:${Math.floor(Date.now() / 5000)}` });

/* ───────────────────────────── reads ───────────────────────────── */
export async function listContent(actor: Actor, type: string, o: { q?: string; status?: ContentStatus; page?: number } = {}) {
  const d = def(type); const tenantId = tenantIdOf(actor); assertCan(actor.principal, "content.read", { tenantId });
  const page = Math.max(1, o.page ?? 1);
  return withTenant(tenantId, async (tx) => {
    const where: Prisma.ContentItemWhereInput = { type: d.type, deletedAt: null, ...(o.q ? { draftPayload: { path: [d.titleField], string_contains: o.q, mode: "insensitive" } } : {}) };
    const all = await tx.contentItem.findMany({ where, orderBy: d.ordered ? [{ position: "asc" }, { createdAt: "asc" }] : [{ updatedAt: "desc" }] });
    const dtos = all.map((r) => toDto(d, r)).filter((x) => !o.status || x.status === o.status);
    const pages = Math.max(1, Math.ceil(dtos.length / PAGE_SIZE)); const p = Math.min(page, pages);
    return { rows: dtos.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), total: dtos.length, page: p, pages };
  });
}

export async function getContent(actor: Actor, id: string): Promise<ContentDto> {
  const tenantId = tenantIdOf(actor); assertCan(actor.principal, "content.read", { tenantId });
  return withTenant(tenantId, async (tx) => {
    const r = await tx.contentItem.findFirst({ where: { id, deletedAt: null } }); // RLS hides other schools' rows
    if (!r) throw new NotFoundError("Konten");
    return toDto(def(r.type), r);
  });
}

export async function getSingleton(actor: Actor, type: string): Promise<ContentDto | null> {
  const d = def(type); const tenantId = tenantIdOf(actor); assertCan(actor.principal, "content.read", { tenantId });
  return withTenant(tenantId, async (tx) => { const r = await tx.contentItem.findFirst({ where: { type: d.type, deletedAt: null } }); return r ? toDto(d, r) : null; });
}

/* ───────────────────────────── writes ───────────────────────────── */
export type SaveInput = { type: string; id?: string | null; payload: unknown; slug?: string; mode: "draft" | "publish"; expectedVersion?: number };

export async function saveContent(actor: Actor, input: SaveInput): Promise<ContentDto> {
  const d = def(input.type); const tenantId = tenantIdOf(actor);
  assertCan(actor.principal, input.mode === "publish" ? "publish" : "content.write", { tenantId });
  const v = validatePayload(d, input.payload, { relaxed: input.mode === "draft" });
  if (input.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug)) v.errors._slug = "Slug hanya huruf kecil, angka, dan tanda hubung";
  if (Object.keys(v.errors).length) throw new ValidationError(v.errors);

  return withTenant(tenantId, async (tx) => {
    await assertWritable(tx, tenantId);
    await checkMedia(tx, d, v.mediaIds, v.clean);
    const title = String(v.clean[d.titleField] ?? d.label);
    let row: Awaited<ReturnType<typeof tx.contentItem.findFirst>>;
    const existing = input.id ? await tx.contentItem.findFirst({ where: { id: input.id, deletedAt: null } }) : d.singleton ? await tx.contentItem.findFirst({ where: { type: d.type, deletedAt: null } }) : null;
    if (input.id && !existing) throw new NotFoundError("Konten");
    if (existing && existing.type !== d.type) throw new NotFoundError("Konten");
    const publishNow = input.mode === "publish";

    if (!existing) {
      const slug = d.singleton ? d.type : await uniqueSlug(tx, d.type, input.slug || slugify(title));
      const count = await tx.contentItem.count({ where: { type: d.type } });
      row = await tx.contentItem.create({ data: { tenantId, type: d.type, slug, draftPayload: v.clean as Prisma.InputJsonValue, publishedPayload: publishNow ? (v.clean as Prisma.InputJsonValue) : undefined, publishedAt: publishNow ? new Date() : null, position: count } });
    } else {
      if (input.expectedVersion === undefined) throw new ValidationError({ _version: "Versi data tidak dikirim" });
      const slug = d.singleton ? existing.slug : input.slug ? await uniqueSlug(tx, d.type, input.slug, existing.id) : existing.slug;
      // optimistic lock: the UPDATE only matches if nobody saved in between
      const res = await tx.contentItem.updateMany({
        where: { id: existing.id, version: input.expectedVersion },
        data: { draftPayload: v.clean as Prisma.InputJsonValue, slug, version: { increment: 1 }, ...(publishNow ? { publishedPayload: v.clean as Prisma.InputJsonValue, publishedAt: existing.publishedAt ?? new Date() } : {}) },
      });
      if (res.count === 0) { const cur = await tx.contentItem.findUnique({ where: { id: existing.id }, select: { version: true } }); throw new ConflictError(cur?.version ?? input.expectedVersion + 1); }
      row = await tx.contentItem.findUniqueOrThrow({ where: { id: existing.id } });
    }
    await syncRefs(tx, tenantId, row!.id, v.mediaIds);
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: publishNow ? "content.publish" : "content.save", resource: `${d.type}:${row!.id}`, ip: actor.ip });
    await invalidate(tx, tenantId, d.type);
    return toDto(d, row!);
  });
}

/** Publish the current draft as-is, or pull a published item back to draft. */
export async function setPublication(actor: Actor, id: string, expectedVersion: number, publish: boolean): Promise<ContentDto> {
  const tenantId = tenantIdOf(actor); assertCan(actor.principal, "publish", { tenantId });
  return withTenant(tenantId, async (tx) => {
    await assertWritable(tx, tenantId);
    const cur = await tx.contentItem.findFirst({ where: { id, deletedAt: null } });
    if (!cur) throw new NotFoundError("Konten");
    const d = def(cur.type);
    if (publish) { const v = validatePayload(d, cur.draftPayload); if (Object.keys(v.errors).length) throw new ValidationError(v.errors, "Tidak dapat diterbitkan: lengkapi isian yang wajib"); }
    const res = await tx.contentItem.updateMany({
      where: { id, version: expectedVersion },
      data: publish ? { publishedPayload: cur.draftPayload as Prisma.InputJsonValue, publishedAt: cur.publishedAt ?? new Date(), version: { increment: 1 } } : { publishedPayload: undefined, publishedAt: null, version: { increment: 1 } },
    });
    if (res.count === 0) throw new ConflictError(cur.version);
    if (!publish) await tx.$executeRaw`UPDATE content_items SET published_payload = NULL WHERE id = ${id}::uuid`; // Prisma cannot set a Json column to SQL NULL via undefined
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: publish ? "content.publish" : "content.unpublish", resource: `${cur.type}:${id}`, ip: actor.ip });
    await invalidate(tx, tenantId, cur.type);
    return toDto(d, await tx.contentItem.findUniqueOrThrow({ where: { id } }));
  });
}

export async function deleteContent(actor: Actor, id: string): Promise<void> {
  const tenantId = tenantIdOf(actor); assertCan(actor.principal, "content.write", { tenantId });
  await withTenant(tenantId, async (tx) => {
    await assertWritable(tx, tenantId);
    const cur = await tx.contentItem.findFirst({ where: { id, deletedAt: null } });
    if (!cur) throw new NotFoundError("Konten");
    await tx.mediaReference.deleteMany({ where: { ownerType: "content", ownerId: id } });
    await tx.contentItem.delete({ where: { id } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "content.delete", resource: `${cur.type}:${id}`, ip: actor.ip });
    await invalidate(tx, tenantId, cur.type);
  });
}

/** Persist a new order for ordered modules (staff, facility). Unknown ids are ignored; positions are rewritten atomically. */
export async function reorderContent(actor: Actor, type: string, orderedIds: string[]): Promise<void> {
  const d = def(type); const tenantId = tenantIdOf(actor); assertCan(actor.principal, "content.write", { tenantId });
  if (!d.ordered) throw new ValidationError({ _type: "Modul ini tidak dapat diurutkan" });
  await withTenant(tenantId, async (tx) => {
    await assertWritable(tx, tenantId);
    const rows = await tx.contentItem.findMany({ where: { type: d.type, id: { in: orderedIds } }, select: { id: true } });
    const ok = new Set(rows.map((r) => r.id));
    let i = 0; for (const id of orderedIds) if (ok.has(id)) await tx.contentItem.update({ where: { id }, data: { position: i++, version: { increment: 1 } } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "content.reorder", resource: type, ip: actor.ip });
    await invalidate(tx, tenantId, type);
  });
}

export const canWriteContent = (a: Actor) => { try { return can(a.principal, "content.write", { tenantId: tenantIdOf(a) }); } catch { return false; } };
