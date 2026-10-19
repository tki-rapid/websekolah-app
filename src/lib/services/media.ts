import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { platformClient, withTenant, type Tx } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/rbac";
import type { Actor } from "@/lib/actor";
import { AppError, NotFoundError, QuotaExceededError, TenantUnavailableError, UploadRejectedError, ValidationError } from "@/lib/errors";
import { getStore } from "@/lib/media/store";
import { consume } from "@/lib/security/ratelimit";

/**
 * Secure media pipeline (PRD §13.1, CMS15, AC06):
 *   presign (validate type/size, atomically RESERVE quota, tenant-prefixed random key, URL ≤ 10 min)
 *   → browser uploads straight to private storage → finalize (verify size + magic bytes, scan, strip metadata,
 *   re-encode, thumbnail, checksum) → READY.   Nothing is public; bytes are served only by the app after an access check.
 */
export const UPLOAD_TTL_SEC = 600;
const RESERVATION_MS = 15 * 60_000;
const MB = 1024 * 1024;
export const ALLOWED: Record<string, { ext: string[]; canon: string; max: number }> = {
  "image/jpeg": { ext: ["jpg", "jpeg"], canon: "jpg", max: 5 * MB },
  "image/png": { ext: ["png"], canon: "png", max: 5 * MB },
  "image/webp": { ext: ["webp"], canon: "webp", max: 5 * MB },
  "application/pdf": { ext: ["pdf"], canon: "pdf", max: 20 * MB },
};
const MAX_PIXELS = 40_000_000;
export class MediaInUseError extends AppError { constructor(public readonly usedBy: string[]) { super("Berkas masih dipakai dan tidak dapat dihapus", "media_in_use", 409); } }

const tenantOf = (a: Actor): string => {
  const p = a.principal; const id = p.kind === "school_admin" || p.kind === "impersonation" ? p.tenantId : null;
  if (!id) throw new NotFoundError("Sekolah"); return id;
};
async function assertWritable(tx: Tx, tenantId: string) {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true, deletedAt: true } });
  if (!t || t.deletedAt || t.status === "SUSPENDED") throw new TenantUnavailableError();
}
export const quotaBytes = async (tx: Tx): Promise<number> => {
  const sub = await tx.subscription.findFirst({ select: { planVersion: { select: { quotas: true } } } });
  const mb = Number((sub?.planVersion.quotas as { storageMB?: number } | undefined)?.storageMB ?? 0);
  return mb * MB;
};
/** READY bytes + live reservations. Caller must hold the tenant's advisory lock for an atomic check-and-reserve. */
const usedBytes = async (tx: Tx): Promise<number> => {
  const r = await tx.$queryRaw<{ n: bigint | null }[]>`SELECT COALESCE(SUM(bytes), 0)::bigint AS n FROM media_assets WHERE state = 'READY' OR (state = 'PENDING' AND upload_expires_at > now())`;
  return Number(r[0]?.n ?? 0);
};
const lockTenant = (tx: Tx, tenantId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"media:" + tenantId}, 0))`;

export function validateUploadRequest(name: unknown, mime: unknown, bytes: unknown) {
  const errs: Record<string, string> = {};
  const spec = typeof mime === "string" ? ALLOWED[mime] : undefined;
  if (!spec) errs.mime = "Hanya JPEG, PNG, WebP (maks 5 MB) dan PDF (maks 20 MB). SVG, HTML, executable, dan arsip ditolak.";
  const nm = typeof name === "string" ? name.replace(/[\\/]/g, "_").slice(0, 120) : "";
  const ext = nm.includes(".") ? nm.split(".").pop()!.toLowerCase() : "";
  if (!nm) errs.name = "Nama berkas wajib";
  else if (spec && !spec.ext.includes(ext)) errs.name = "Ekstensi tidak cocok dengan tipe berkas";
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) errs.bytes = "Ukuran tidak valid";
  else if (spec && bytes > spec.max) errs.bytes = `Ukuran melebihi batas ${spec.max / MB} MB`;
  if (Object.keys(errs).length) throw new ValidationError(errs);
  return { name: nm, mime: mime as string, spec: spec!, bytes: bytes as number };
}

export async function presignUpload(actor: Actor, input: { name: unknown; mime: unknown; bytes: unknown }) {
  const tenantId = tenantOf(actor); assertCan(actor.principal, "content.write", { tenantId });
  const v = validateUploadRequest(input.name, input.mime, input.bytes);
  const rl = await consume(`upload:${actor.userId}`, 60, 600);
  if (!rl.allowed) throw new AppError("Terlalu banyak unggahan. Coba lagi beberapa menit lagi.", "rate_limited", 429);
  const id = randomUUID(); const key = `${tenantId}/${id}.${v.spec.canon}`;
  const asset = await withTenant(tenantId, async (tx) => {
    await assertWritable(tx, tenantId);
    await lockTenant(tx, tenantId); // serialise reservations so concurrent uploads cannot jointly exceed the quota
    const quota = await quotaBytes(tx);
    if ((await usedBytes(tx)) + v.bytes > quota) throw new QuotaExceededError();
    const a = await tx.mediaAsset.create({ data: { id, tenantId, objectKey: key, name: v.name, originalName: v.name, mime: v.mime, bytes: BigInt(v.bytes), state: "PENDING", uploadExpiresAt: new Date(Date.now() + RESERVATION_MS), alt: v.mime.startsWith("image/") ? v.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ") : "" } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "media.presign", resource: `media:${a.id}`, ip: actor.ip });
    return a;
  });
  const ticket = await getStore().createUploadUrl(key, { contentType: v.mime, maxBytes: v.bytes, expiresInSec: UPLOAD_TTL_SEC });
  return { assetId: asset.id, ticket };
}

/* ───── content inspection ───── */
const startsWith = (b: Buffer, sig: number[], off = 0) => sig.every((x, i) => b[off + i] === x);
export function sniffMime(b: Buffer): string | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
/**
 * Malware-scan hook. Phase 2 ships a minimal built-in check (EICAR test signature, active-content markers in PDFs).
 * PRODUCTION MUST plug a real scanner here (ClamAV sidecar / Cloud Storage malware scanning) — see docs/SECURITY.md.
 */
export async function scanBuffer(b: Buffer, mime: string): Promise<string | null> {
  const s = b.toString("latin1");
  if (s.includes(EICAR)) return "Terdeteksi sebagai berkas berbahaya";
  if (mime === "application/pdf" && /\/(Launch|JavaScript|JS|EmbeddedFile|RichMedia)\b/.test(s)) return "PDF berisi konten aktif (skrip/lampiran) dan ditolak";
  return null;
}

async function reject(tenantId: string, id: string, key: string, actor: Actor, reason: string): Promise<never> {
  await getStore().remove(key).catch(() => undefined);
  await withTenant(tenantId, async (tx) => {
    await tx.mediaAsset.updateMany({ where: { id, state: "PENDING" }, data: { state: "REJECTED", uploadExpiresAt: null, bytes: 1 } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "media.rejected", resource: `media:${id}`, result: "denied", reason, ip: actor.ip });
  });
  throw new UploadRejectedError(reason);
}

export async function finalizeUpload(actor: Actor, assetId: string) {
  const tenantId = tenantOf(actor); assertCan(actor.principal, "content.write", { tenantId });
  const asset = await withTenant(tenantId, (tx) => tx.mediaAsset.findFirst({ where: { id: assetId } }));
  if (!asset) throw new NotFoundError("Media");
  if (asset.state === "READY") return asset; // idempotent
  if (asset.state !== "PENDING") throw new UploadRejectedError("Unggahan ini sudah ditolak");
  const store = getStore(); const key = asset.objectKey; const declared = Number(asset.bytes);
  if (!asset.uploadExpiresAt || asset.uploadExpiresAt.getTime() < Date.now()) return reject(tenantId, asset.id, key, actor, "Waktu unggah habis");
  const head = await store.head(key);
  if (!head || head.size === 0) throw new UploadRejectedError("Berkas belum diunggah");
  const spec = ALLOWED[asset.mime]!;
  if (head.size > declared || head.size > spec.max) return reject(tenantId, asset.id, key, actor, "Ukuran berkas melebihi yang dilaporkan");
  const raw = await store.read(key);
  if (sniffMime(raw) !== asset.mime) return reject(tenantId, asset.id, key, actor, "Isi berkas tidak sesuai tipe yang dilaporkan");
  const bad = await scanBuffer(raw, asset.mime);
  if (bad) return reject(tenantId, asset.id, key, actor, bad);

  let out = raw, width: number | null = null, height: number | null = null, thumbKey: string | null = null;
  if (asset.mime.startsWith("image/")) {
    try {
      const img = sharp(raw, { limitInputPixels: MAX_PIXELS, failOn: "error" });
      const meta = await img.metadata(); width = meta.width ?? null; height = meta.height ?? null;
      const pipe = img.rotate(); // bake EXIF orientation in, then drop ALL metadata (GPS, camera, …): sharp strips it unless withMetadata() is called
      out = asset.mime === "image/jpeg" ? await pipe.jpeg({ quality: 85, mozjpeg: true }).toBuffer() : asset.mime === "image/png" ? await pipe.png({ compressionLevel: 9 }).toBuffer() : await pipe.webp({ quality: 85 }).toBuffer();
      const thumb = await sharp(out).resize({ width: 480, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
      thumbKey = `${tenantId}/thumb/${asset.id}.webp`;
      await store.write(thumbKey, thumb, "image/webp");
    } catch { return reject(tenantId, asset.id, key, actor, "Gambar rusak atau tidak dapat diproses"); }
    if (out.length > spec.max) return reject(tenantId, asset.id, key, actor, "Ukuran setelah pemrosesan melebihi batas");
    await store.write(key, out, asset.mime);
  }
  const sha = createHash("sha256").update(out).digest("hex");
  return withTenant(tenantId, async (tx) => {
    await lockTenant(tx, tenantId);
    const a = await tx.mediaAsset.update({ where: { id: asset.id }, data: { state: "READY", bytes: BigInt(out.length), checksum: sha, width, height, thumbKey, uploadExpiresAt: null } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "media.upload", resource: `media:${a.id}`, ip: actor.ip });
    return a;
  });
}

/* ───── reads / maintenance ───── */
export async function listMedia(actor: Actor, o: { kind?: "image" | "pdf"; q?: string; page?: number } = {}) {
  const tenantId = tenantOf(actor); assertCan(actor.principal, "content.read", { tenantId });
  return withTenant(tenantId, async (tx) => {
    const where = { state: "READY" as const, ...(o.kind === "image" ? { mime: { startsWith: "image/" } } : o.kind === "pdf" ? { mime: "application/pdf" } : {}), ...(o.q ? { name: { contains: o.q, mode: "insensitive" as const } } : {}) };
    const [total, rows, used, quota, refs] = await Promise.all([
      tx.mediaAsset.count({ where }), tx.mediaAsset.findMany({ where, orderBy: { createdAt: "desc" }, skip: ((o.page ?? 1) - 1) * 24, take: 24 }),
      usedBytes(tx), quotaBytes(tx), tx.mediaReference.groupBy({ by: ["assetId"], _count: { _all: true } }),
    ]);
    const refMap = new Map(refs.map((r) => [r.assetId, r._count._all]));
    return { rows: rows.map((r) => ({ id: r.id, name: r.name, mime: r.mime, bytes: Number(r.bytes), alt: r.alt, width: r.width, height: r.height, createdAt: r.createdAt, usedIn: refMap.get(r.id) ?? 0 })), total, pages: Math.max(1, Math.ceil(total / 24)), usage: { used, quota } };
  });
}

export async function deleteMedia(actor: Actor, id: string) {
  const tenantId = tenantOf(actor); assertCan(actor.principal, "content.write", { tenantId });
  const keys = await withTenant(tenantId, async (tx) => {
    await assertWritable(tx, tenantId);
    const a = await tx.mediaAsset.findFirst({ where: { id } });
    if (!a) throw new NotFoundError("Media");
    const refs = await tx.mediaReference.findMany({ where: { assetId: id }, select: { ownerType: true, ownerId: true } });
    if (refs.length) throw new MediaInUseError(refs.map((r) => `${r.ownerType}:${r.ownerId}`)); // CMS15: used files cannot be deleted
    await tx.mediaAsset.delete({ where: { id } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "media.delete", resource: `media:${id}`, ip: actor.ip });
    return [a.objectKey, a.thumbKey].filter(Boolean) as string[];
  });
  await Promise.all(keys.map((k) => getStore().remove(k).catch(() => undefined)));
}

export async function updateAlt(actor: Actor, id: string, alt: string) {
  const tenantId = tenantOf(actor); assertCan(actor.principal, "content.write", { tenantId });
  if (alt.length > 140) throw new ValidationError({ alt: "Maksimal 140 karakter" });
  await withTenant(tenantId, async (tx) => { await assertWritable(tx, tenantId); const r = await tx.mediaAsset.updateMany({ where: { id }, data: { alt: alt.trim() } }); if (!r.count) throw new NotFoundError("Media"); });
}

/** Bytes for CMS preview. Access is decided by RLS (own school only) + state READY. Public delivery arrives with the public site (Phase 3). */
export async function readMedia(actor: Actor, id: string, variant: "orig" | "thumb" = "orig") {
  const tenantId = tenantOf(actor); assertCan(actor.principal, "content.read", { tenantId });
  const a = await withTenant(tenantId, (tx) => tx.mediaAsset.findFirst({ where: { id, state: "READY" } }));
  if (!a) throw new NotFoundError("Media");
  const key = variant === "thumb" && a.thumbKey ? a.thumbKey : a.objectKey;
  return { data: await getStore().read(key), mime: variant === "thumb" && a.thumbKey ? "image/webp" : a.mime, name: a.name };
}

/** Worker job: free reservations whose upload never completed (PRD §13.1). */
export async function cleanupExpiredUploads(): Promise<number> {
  const db = platformClient();
  const stale = await db.mediaAsset.findMany({ where: { state: "PENDING", uploadExpiresAt: { lt: new Date() } }, select: { id: true, objectKey: true } });
  for (const s of stale) { await getStore().remove(s.objectKey).catch(() => undefined); await db.mediaAsset.delete({ where: { id: s.id } }); }
  return stale.length;
}
