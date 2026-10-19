import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { platformClient, type Tx } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/rbac";
import type { Actor } from "@/lib/actor";
import { env } from "@/lib/env";
import { AppError, NotFoundError, ReauthRequiredError, ValidationError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs";
import { INVITATION_TTL_HOURS } from "@/lib/auth/invitations";
import { hashToken, newToken } from "@/lib/security/tokens";

/**
 * Tenant lifecycle (PRD §5.1, §9, TEN01/TEN04, ADM01). Only a Super Admin (MFA-verified) may call these; every function
 * re-checks the capability. Sensitive operations additionally require authentication within the last 10 minutes.
 * Provisioning is idempotent: retrying with the same key never creates a second tenant, invoice or invitation.
 */
export const SCHOOL_TYPES = ["TK", "SD", "SMP", "SMA", "SMK", "Madrasah", "Pesantren", "Lainnya"] as const;
const RESTORE_WINDOW_DAYS = 30; // NFR08

const createSchema = z.object({
  name: z.string().trim().min(3, "Nama minimal 3 karakter").max(100),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/, "Slug 3–40 karakter: huruf kecil, angka, tanda hubung"),
  type: z.enum(SCHOOL_TYPES),
  planCode: z.string().min(1).max(40),
  interval: z.enum(["MONTHLY", "YEARLY"]),
  adminName: z.string().trim().min(2, "Nama admin wajib").max(80),
  adminEmail: z.string().trim().toLowerCase().email("Email tidak valid").max(254),
});
export type CreateTenantInput = z.input<typeof createSchema>;

const RESERVED = new Set(["admin", "api", "www", "cms", "super", "login", "app", "mail", "static", "assets", "cdn", "media", "ftp", "status", "support", "ns1", "ns2", "smtp", "imap", "pop", "webmail", "dashboard", "auth", "internal", "health"]);

function superOnly(actor: Actor) { assertCan(actor.principal, "tenant.manage"); }
function needReauth(actor: Actor) { if (!actor.reauthOk) throw new ReauthRequiredError(); }

const issueInvitation = async (tx: Tx, o: { tenantId: string; schoolName: string; email: string; createdById: string }) => {
  const token = newToken();
  await tx.invitation.deleteMany({ where: { tenantId: o.tenantId, email: o.email, usedAt: null } }); // re-sending revokes the old token
  const inv = await tx.invitation.create({ data: { tenantId: o.tenantId, email: o.email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITATION_TTL_HOURS * 3_600_000), createdById: o.createdById } });
  await enqueue(tx, { type: "email.invitation", tenantId: o.tenantId, payload: { to: o.email, schoolName: o.schoolName }, secret: { token }, dedupeKey: `invite:${inv.id}` });
  return inv;
};

async function nextInvoiceNumber(tx: Tx): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('invoice-number', 0))`;
  const year = new Date().getUTCFullYear();
  const last = await tx.invoice.findFirst({ where: { number: { startsWith: `INV-${year}-` } }, orderBy: { number: "desc" }, select: { number: true } });
  const n = last ? Number(last.number.split("-")[2]) + 1 : 1;
  return `INV-${year}-${String(n).padStart(4, "0")}`;
}

export async function createTenant(actor: Actor, raw: CreateTenantInput, idempotencyKey: string): Promise<{ tenantId: string; duplicate: boolean }> {
  superOnly(actor);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) throw new ValidationError({ _key: "Kunci idempotensi tidak valid" });
  const p = createSchema.safeParse(raw);
  if (!p.success) throw new ValidationError(Object.fromEntries(p.error.issues.map((i) => [String(i.path[0] ?? "_"), i.message])));
  const d = p.data;
  if (RESERVED.has(d.slug)) throw new ValidationError({ slug: "Slug ini dicadangkan sistem" });

  return platformClient().$transaction(async (tx) => {
    // idempotency: the key row is inserted in the SAME transaction, so a failed attempt leaves nothing behind and a retry can run again
    const fresh = await tx.$executeRaw`INSERT INTO idempotency_keys (key, scope, actor_id) VALUES (${idempotencyKey}, 'tenant.create', ${actor.userId}::uuid) ON CONFLICT DO NOTHING`;
    if (Number(fresh) === 0) {
      const prev = await tx.idempotencyKey.findUnique({ where: { key_scope: { key: idempotencyKey, scope: "tenant.create" } } });
      const id = (prev?.result as { tenantId?: string } | null)?.tenantId;
      if (id) return { tenantId: id, duplicate: true };
      throw new AppError("Permintaan dengan kunci ini sedang diproses", "in_progress", 409);
    }
    if (await tx.tenant.findUnique({ where: { slug: d.slug }, select: { id: true } })) throw new ValidationError({ slug: "Slug sudah dipakai" });
    if (await tx.user.findUnique({ where: { email: d.adminEmail }, select: { id: true } })) throw new ValidationError({ adminEmail: "Email sudah terdaftar pada akun lain" });
    const pv = await tx.planVersion.findFirst({ where: { plan: { code: d.planCode }, interval: d.interval }, orderBy: { version: "desc" }, include: { plan: true } });
    if (!pv) throw new ValidationError({ planCode: "Paket tidak ditemukan" });
    const theme = await tx.themeVersion.findFirst({ where: { theme: { key: "umum-klasik" }, active: true }, orderBy: { version: "desc" } });
    if (!theme) throw new AppError("Katalog tema belum diisi (jalankan seed)", "config", 500);

    const tenant = await tx.tenant.create({ data: { name: d.name, slug: d.slug, type: d.type, status: "PROVISIONING" } });
    await tx.user.create({ data: { tenantId: tenant.id, email: d.adminEmail, name: d.adminName, role: "SCHOOL_ADMIN", active: true } });
    const days = d.interval === "YEARLY" ? 365 : 30;
    const sub = await tx.subscription.create({ data: { tenantId: tenant.id, planVersionId: pv.id, status: "PENDING", periodStart: new Date(), periodEnd: new Date(Date.now() + days * 864e5) } });
    await tx.tenantTheme.create({ data: { tenantId: tenant.id, themeVersionId: theme.id } });
    await tx.domain.create({ data: { tenantId: tenant.id, hostname: `${d.slug}.${env().PLATFORM_DOMAIN}`, kind: "SUBDOMAIN", status: "ACTIVE", primary: true, verifiedAt: new Date(), tlsState: "valid" } });
    await tx.page.create({ data: { tenantId: tenant.id, slug: "beranda", title: "Beranda", isHome: true, draftBlocks: [] } });
    await tx.invoice.create({ data: { tenantId: tenant.id, subscriptionId: sub.id, number: await nextInvoiceNumber(tx), planName: pv.plan.name, interval: pv.interval, amount: pv.amount, status: "DRAFT", periodStart: sub.periodStart, periodEnd: sub.periodEnd, dueAt: new Date(Date.now() + 7 * 864e5) } });
    await issueInvitation(tx, { tenantId: tenant.id, schoolName: d.name, email: d.adminEmail, createdById: actor.userId });
    await writeAudit(tx, { tenantId: tenant.id, actorId: actor.userId, actorEmail: actor.email, action: "tenant.create", resource: `tenant:${d.slug}`, ip: actor.ip });
    await tx.idempotencyKey.update({ where: { key_scope: { key: idempotencyKey, scope: "tenant.create" } }, data: { result: { tenantId: tenant.id } as Prisma.InputJsonValue } });
    return { tenantId: tenant.id, duplicate: false };
  });
}

export async function resendInvitation(actor: Actor, tenantId: string) {
  superOnly(actor);
  await platformClient().$transaction(async (tx) => {
    const t = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } }); if (!t) throw new NotFoundError("Sekolah");
    const admin = await tx.user.findFirst({ where: { tenantId, role: "SCHOOL_ADMIN", active: true } }); if (!admin) throw new NotFoundError("Admin sekolah");
    if (admin.passwordHash || admin.authSubject) throw new AppError("Akun admin sudah aktif; undangan tidak diperlukan", "already_active", 409);
    await issueInvitation(tx, { tenantId, schoolName: t.name, email: admin.email, createdById: actor.userId });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "invitation.resend", resource: `user:${admin.id}`, ip: actor.ip });
  });
}

export async function activateTenant(actor: Actor, tenantId: string) {
  superOnly(actor);
  await platformClient().$transaction(async (tx) => {
    const t = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } }); if (!t) throw new NotFoundError("Sekolah");
    if (t.status === "ACTIVE") return;
    if (!(await tx.invitation.count({ where: { tenantId } })) && !(await tx.user.count({ where: { tenantId, role: "SCHOOL_ADMIN", active: true } }))) throw new AppError("Provisioning belum lengkap: tidak ada admin/undangan", "incomplete", 409);
    await tx.tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE", suspendReason: null } });
    await tx.subscription.updateMany({ where: { tenantId, status: "PENDING" }, data: { status: "ACTIVE", periodStart: new Date() } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "tenant.activate", resource: `tenant:${t.slug}`, ip: actor.ip });
    await enqueue(tx, { type: "cache.invalidate", tenantId, payload: { what: "tenant" }, dedupeKey: `cache:${tenantId}:tenant:${Date.now()}` });
  });
}

export async function suspendTenant(actor: Actor, tenantId: string, reason: string) {
  superOnly(actor); needReauth(actor);
  const r = reason.trim(); if (r.length < 3 || r.length > 200) throw new ValidationError({ reason: "Alasan wajib diisi (3–200 karakter)" });
  await platformClient().$transaction(async (tx) => {
    const t = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } }); if (!t) throw new NotFoundError("Sekolah");
    await tx.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED", suspendReason: r } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "tenant.suspend", resource: `tenant:${t.slug}`, reason: r, ip: actor.ip });
    await enqueue(tx, { type: "cache.invalidate", tenantId, payload: { what: "tenant" }, dedupeKey: `cache:${tenantId}:tenant:${Date.now()}` });
  });
}

export async function softDeleteTenant(actor: Actor, tenantId: string, confirmSlug: string) {
  superOnly(actor); needReauth(actor);
  await platformClient().$transaction(async (tx) => {
    const t = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } }); if (!t) throw new NotFoundError("Sekolah");
    if (confirmSlug !== t.slug) throw new ValidationError({ confirm: "Slug konfirmasi tidak cocok" });
    await tx.tenant.update({ where: { id: tenantId }, data: { deletedAt: new Date(), status: "SUSPENDED", suspendReason: "dihapus" } });
    const users = await tx.user.findMany({ where: { tenantId }, select: { id: true } });
    await tx.session.updateMany({ where: { userId: { in: users.map((u) => u.id) }, revokedAt: null }, data: { revokedAt: new Date() } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "tenant.soft_delete", resource: `tenant:${t.slug}`, ip: actor.ip });
  });
}

export async function restoreTenant(actor: Actor, tenantId: string) {
  superOnly(actor); needReauth(actor);
  await platformClient().$transaction(async (tx) => {
    const t = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: { not: null } } }); if (!t) throw new NotFoundError("Sekolah terhapus");
    if (Date.now() - t.deletedAt!.getTime() > RESTORE_WINDOW_DAYS * 864e5) throw new AppError("Masa pemulihan 30 hari telah lewat", "restore_expired", 409);
    await tx.tenant.update({ where: { id: tenantId }, data: { deletedAt: null, status: "SUSPENDED", suspendReason: "dipulihkan — menunggu aktivasi" } });
    // AC14: all content and relations are back, but custom domains must be re-verified before they serve again
    await tx.domain.updateMany({ where: { tenantId, kind: "CUSTOM" }, data: { status: "AWAITING_DNS", primary: false, verifiedAt: null, tlsState: "none" } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "tenant.restore", resource: `tenant:${t.slug}`, ip: actor.ip });
  });
}

/** TEN02: replace the single admin. The old account is deactivated, ALL its sessions revoked, a new one invited. */
export async function replaceAdmin(actor: Actor, tenantId: string, input: { name: string; email: string }) {
  superOnly(actor); needReauth(actor);
  const email = input.email.trim().toLowerCase(), name = input.name.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError({ email: "Email tidak valid" });
  if (name.length < 2) throw new ValidationError({ name: "Nama wajib" });
  await platformClient().$transaction(async (tx) => {
    const t = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } }); if (!t) throw new NotFoundError("Sekolah");
    if (await tx.user.findUnique({ where: { email }, select: { id: true } })) throw new ValidationError({ email: "Email sudah terdaftar pada akun lain" });
    const old = await tx.user.findMany({ where: { tenantId, role: "SCHOOL_ADMIN", active: true }, select: { id: true } });
    await tx.user.updateMany({ where: { id: { in: old.map((o) => o.id) } }, data: { active: false } });
    await tx.session.updateMany({ where: { userId: { in: old.map((o) => o.id) }, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.invitation.deleteMany({ where: { tenantId, usedAt: null } });
    await tx.user.create({ data: { tenantId, email, name, role: "SCHOOL_ADMIN", active: true } });
    await issueInvitation(tx, { tenantId, schoolName: t.name, email, createdById: actor.userId });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "tenant.replace_admin", resource: `tenant:${t.slug}`, reason: `→ ${email}`, ip: actor.ip });
  });
}

/* ── reads for the console ── */
export async function listTenants(actor: Actor, o: { q?: string; status?: string; trash?: boolean; page?: number } = {}) {
  superOnly(actor);
  const where: Prisma.TenantWhereInput = { deletedAt: o.trash ? { not: null } : null, ...(o.status ? { status: o.status as never } : {}), ...(o.q ? { OR: [{ name: { contains: o.q, mode: "insensitive" } }, { slug: { contains: o.q, mode: "insensitive" } }] } : {}) };
  const page = Math.max(1, o.page ?? 1);
  const db = platformClient();
  const [total, rows] = await Promise.all([db.tenant.count({ where }), db.tenant.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * 20, take: 20, include: { subscription: { select: { status: true, planVersion: { select: { plan: { select: { name: true } } } } } } } })]);
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / 20)) };
}

export async function getTenantDetail(actor: Actor, tenantId: string) {
  superOnly(actor);
  const db = platformClient();
  const t = await db.tenant.findUnique({ where: { id: tenantId }, include: { subscription: { include: { planVersion: { include: { plan: true } } } }, domains: true } });
  if (!t) throw new NotFoundError("Sekolah");
  const [admin, invitation, audit] = await Promise.all([
    db.user.findFirst({ where: { tenantId, role: "SCHOOL_ADMIN", active: true }, select: { id: true, name: true, email: true, passwordHash: true, authSubject: true, lastLoginAt: true } }),
    db.invitation.findFirst({ where: { tenantId }, orderBy: { createdAt: "desc" }, select: { expiresAt: true, usedAt: true } }),
    db.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 15, select: { id: true, createdAt: true, actorEmail: true, action: true, resource: true, result: true, reason: true } }),
  ]);
  return { tenant: t, admin: admin ? { id: admin.id, name: admin.name, email: admin.email, activated: !!(admin.passwordHash || admin.authSubject), lastLoginAt: admin.lastLoginAt } : null, invitation, audit };
}

export async function listPlans() {
  return (await platformClient().planVersion.findMany({ where: { version: 1 }, include: { plan: true }, orderBy: [{ plan: { code: "asc" } }, { interval: "asc" }] })).map((v) => ({ code: v.plan.code, name: v.plan.name, interval: v.interval, amount: v.amount }));
}
