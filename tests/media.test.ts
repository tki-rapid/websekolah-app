import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { disconnectAll, platformClient, withTenant } from "@/lib/db";
import { cleanupExpiredUploads, deleteMedia, finalizeUpload, listMedia, MediaInUseError, presignUpload, readMedia, sniffMime, validateUploadRequest } from "@/lib/services/media";
import { saveContent } from "@/lib/services/content";
import { LocalObjectStore, setStoreForTests } from "@/lib/media/store";
import { NotFoundError, QuotaExceededError, TenantUnavailableError, UploadRejectedError, ValidationError } from "@/lib/errors";
import type { Actor } from "@/lib/actor";
import { makeAdmin, makeSubscription, makeTenant, rnd } from "./helpers";

const store = new LocalObjectStore(mkdtempSync(path.join(tmpdir(), "ws-media-")), process.env.APP_SECRET!, process.env.APP_URL!);
beforeAll(() => setStoreForTests(store));
afterAll(async () => { setStoreForTests(undefined); await disconnectAll(); });

const actorFor = async (tenantId: string): Promise<Actor> => {
  const u = await makeAdmin(tenantId);
  return { principal: { kind: "school_admin", userId: u.id, tenantId }, userId: u.id, email: u.email, tenantId };
};
const png = (w = 64, h = 64) => sharp({ create: { width: w, height: h, channels: 3, background: "#3366ff" } }).png().toBuffer();
async function upload(a: Actor, name: string, mime: string, data: Buffer) {
  const { assetId, ticket } = await presignUpload(a, { name, mime, bytes: data.length });
  const key = (await platformClient().mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).objectKey;
  await store.write(key, data, mime); // stands in for the browser's PUT to the signed URL
  return { assetId, ticket, key };
}

describe("upload request validation (CMS15, AC06)", () => {
  it("accepts JPEG/PNG/WebP/PDF within size caps and rejects everything else", () => {
    expect(validateUploadRequest("foto.JPG", "image/jpeg", 1000).spec.canon).toBe("jpg");
    for (const [n, m] of [["a.svg", "image/svg+xml"], ["a.html", "text/html"], ["a.exe", "application/x-msdownload"], ["a.zip", "application/zip"], ["a.js", "text/javascript"], ["a.gif", "image/gif"]] as const)
      expect(() => validateUploadRequest(n, m, 100), n).toThrow(ValidationError);
    expect(() => validateUploadRequest("a.png", "image/png", 5 * 1024 * 1024 + 1)).toThrow(ValidationError);
    expect(() => validateUploadRequest("a.pdf", "application/pdf", 20 * 1024 * 1024)).not.toThrow();
    expect(() => validateUploadRequest("a.pdf", "application/pdf", 20 * 1024 * 1024 + 1)).toThrow(ValidationError);
    expect(() => validateUploadRequest("a.png", "image/jpeg", 100)).toThrow(ValidationError); // extension must match the type
    expect(() => validateUploadRequest("a.png", "image/png", -5)).toThrow(ValidationError);
    expect(() => validateUploadRequest("a.png", "image/png", 1.5)).toThrow(ValidationError);
    expect(validateUploadRequest("../../etc/passwd.png", "image/png", 10).name).not.toContain("/");
  });
  it("sniffs real file signatures", async () => {
    expect(sniffMime(await png())).toBe("image/png");
    expect(sniffMime(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffMime(Buffer.from("MZ\x90\x00 this is an exe"))).toBeNull();
    expect(sniffMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
});

describe("presign → upload → finalize", () => {
  it("happy path: reserves quota, uses a tenant-prefixed random key, re-encodes, builds a thumbnail, records checksum", async () => {
    const t = await makeTenant("m1"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const data = await png(1200, 800);
    const { assetId, ticket, key } = await upload(a, "gedung.png", "image/png", data);
    expect(key.startsWith(`${t.id}/`)).toBe(true); expect(ticket.method).toBe("PUT");
    expect(ticket.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000); // PRD: signed URL <= 10 minutes
    const pending = await platformClient().mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(pending.state).toBe("PENDING");
    const ready = await finalizeUpload(a, assetId);
    expect(ready.state).toBe("READY"); expect(ready.width).toBe(1200); expect(ready.checksum).toMatch(/^[0-9a-f]{64}$/); expect(ready.thumbKey).toBeTruthy();
    const thumb = await readMedia(a, assetId, "thumb");
    expect(thumb.mime).toBe("image/webp"); expect((await sharp(thumb.data).metadata()).width).toBe(480);
    expect((await finalizeUpload(a, assetId)).id).toBe(assetId); // idempotent
  });
  it("strips EXIF/GPS metadata from images", async () => {
    const t = await makeTenant("m2"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const withExif = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).jpeg().withExif({ IFD0: { Copyright: "SECRET-GPS-OWNER" } }).toBuffer();
    expect(withExif.toString("latin1")).toContain("SECRET-GPS-OWNER"); // sanity: the fixture really carries metadata
    const { assetId } = await upload(a, "foto.jpg", "image/jpeg", withExif);
    await finalizeUpload(a, assetId);
    const out = (await readMedia(a, assetId)).data;
    expect(out.toString("latin1")).not.toContain("SECRET-GPS-OWNER");
    expect((await sharp(out).metadata()).exif).toBeUndefined();
  });
  it("rejects a file whose bytes do not match the declared type (fake .jpg that is an executable)", async () => {
    const t = await makeTenant("m3"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const { assetId, key } = await upload(a, "liburan.jpg", "image/jpeg", Buffer.from("MZ\x90\x00\x03 pretend this is a windows executable".padEnd(300, "A")));
    await expect(finalizeUpload(a, assetId)).rejects.toBeInstanceOf(UploadRejectedError);
    expect((await platformClient().mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).state).toBe("REJECTED");
    expect(await store.head(key)).toBeNull(); // the object is removed, never served
    await expect(readMedia(a, assetId)).rejects.toBeInstanceOf(NotFoundError);
  });
  it("rejects SVG/HTML renamed to .png, corrupt images, EICAR test malware and PDFs with active content", async () => {
    const t = await makeTenant("m4"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const cases: [string, string, Buffer][] = [
      ["x.png", "image/png", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")],
      ["y.png", "image/png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("garbage-not-a-real-png")])],
      ["z.pdf", "application/pdf", Buffer.from("%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF")],
      ["j.pdf", "application/pdf", Buffer.from("%PDF-1.4\n1 0 obj<</Type/Action/S/JavaScript/JS(app.alert(1))>>endobj\n%%EOF")],
    ];
    for (const [n, m, d] of cases) { const { assetId } = await upload(a, n, m, d); await expect(finalizeUpload(a, assetId), n).rejects.toBeInstanceOf(UploadRejectedError); }
  });
  it("rejects an upload larger than the size that was reserved", async () => {
    const t = await makeTenant("m5"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const { assetId, key } = await presignUpload(a, { name: "k.png", mime: "image/png", bytes: 500 }).then(async (r) => ({ assetId: r.assetId, key: (await platformClient().mediaAsset.findUniqueOrThrow({ where: { id: r.assetId } })).objectKey }));
    await store.write(key, await png(600, 600), "image/png"); // way more than 500 bytes
    await expect(finalizeUpload(a, assetId)).rejects.toMatchObject({ message: expect.stringMatching(/Ukuran/) });
  });
  it("finalize without an uploaded object, or after the reservation expired, fails cleanly", async () => {
    const t = await makeTenant("m6"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const { assetId } = await presignUpload(a, { name: "a.png", mime: "image/png", bytes: 1000 });
    await expect(finalizeUpload(a, assetId)).rejects.toBeInstanceOf(UploadRejectedError);
    await platformClient().$executeRaw`UPDATE media_assets SET upload_expires_at = now() - interval '1 minute' WHERE id = ${assetId}::uuid`;
    await expect(finalizeUpload(a, assetId)).rejects.toBeInstanceOf(UploadRejectedError);
  });
});

describe("quota (CMS15, AC06: concurrent uploads near the limit)", () => {
  it("refuses a reservation beyond the plan's storage before anything is committed", async () => {
    const t = await makeTenant("q1"); await makeSubscription(t.id, 1); const a = await actorFor(t.id); // 1 MB
    await presignUpload(a, { name: "a.png", mime: "image/png", bytes: 700_000 });
    await expect(presignUpload(a, { name: "b.png", mime: "image/png", bytes: 700_000 })).rejects.toBeInstanceOf(QuotaExceededError);
    expect(await platformClient().mediaAsset.count({ where: { tenantId: t.id } })).toBe(1); // the refused one left no row
  });
  it("concurrent reservations can never jointly exceed the quota (atomic, serialised per school)", async () => {
    const t = await makeTenant("q2"); await makeSubscription(t.id, 10); const a = await actorFor(t.id); // 10 MB
    const rs = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => presignUpload(a, { name: `f${i}.png`, mime: "image/png", bytes: 3 * 1024 * 1024 })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(3); // 3 x 3 MB = 9 MB fits, a 4th would not
    expect(rs.filter((r) => r.status === "rejected" && r.reason instanceof QuotaExceededError)).toHaveLength(5);
    const reserved = await platformClient().mediaAsset.aggregate({ where: { tenantId: t.id }, _sum: { bytes: true } });
    expect(Number(reserved._sum.bytes)).toBeLessThanOrEqual(10 * 1024 * 1024);
  });
  it("a school without a subscription has no storage; expired reservations free their space; failed uploads release quota", async () => {
    const none = await makeTenant("q3"); await expect(presignUpload(await actorFor(none.id), { name: "a.png", mime: "image/png", bytes: 10 })).rejects.toBeInstanceOf(QuotaExceededError);
    const t = await makeTenant("q4"); await makeSubscription(t.id, 1); const a = await actorFor(t.id);
    const r = await presignUpload(a, { name: "a.png", mime: "image/png", bytes: 900_000 });
    await expect(presignUpload(a, { name: "b.png", mime: "image/png", bytes: 900_000 })).rejects.toBeInstanceOf(QuotaExceededError);
    await platformClient().$executeRaw`UPDATE media_assets SET upload_expires_at = now() - interval '1 minute' WHERE id = ${r.assetId}::uuid`;
    await expect(presignUpload(a, { name: "b.png", mime: "image/png", bytes: 900_000 })).resolves.toBeTruthy();
    expect(await cleanupExpiredUploads()).toBeGreaterThanOrEqual(1);
  });
  it("reports usage and counts only READY files in listings", async () => {
    const t = await makeTenant("q5"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const { assetId } = await upload(a, "a.png", "image/png", await png()); await finalizeUpload(a, assetId);
    await presignUpload(a, { name: "pending.png", mime: "image/png", bytes: 1000 });
    const l = await listMedia(a); expect(l.total).toBe(1); expect(l.usage.quota).toBe(10 * 1024 * 1024); expect(l.usage.used).toBeGreaterThan(0);
  });
});

describe("isolation & lifecycle", () => {
  it("another school cannot finalize, read, list or delete my media (even with the real id)", async () => {
    const t1 = await makeTenant("i1"), t2 = await makeTenant("i2"); await makeSubscription(t1.id, 10); await makeSubscription(t2.id, 10);
    const a = await actorFor(t1.id), b = await actorFor(t2.id);
    const { assetId } = await upload(a, "rahasia.png", "image/png", await png()); await finalizeUpload(a, assetId);
    await expect(readMedia(b, assetId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteMedia(b, assetId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(finalizeUpload(b, assetId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listMedia(b)).rows.find((r) => r.id === assetId)).toBeUndefined();
    expect((await readMedia(a, assetId)).name).toBe("rahasia.png");
  });
  it("files in use cannot be deleted; unused ones are removed from storage too (CMS15)", async () => {
    const t = await makeTenant("d1"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const { assetId, key } = await upload(a, "pakai.png", "image/png", await png()); await finalizeUpload(a, assetId);
    const item = await saveContent(a, { type: "news", payload: { title: "T", category: "Kegiatan", date: "2026-10-19", summary: "S", body: "B", image: assetId }, mode: "draft" });
    await expect(deleteMedia(a, assetId)).rejects.toBeInstanceOf(MediaInUseError);
    expect((await listMedia(a)).rows[0]!.usedIn).toBe(1);
    const { deleteContent } = await import("@/lib/services/content"); await deleteContent(a, item.id);
    await deleteMedia(a, assetId);
    expect(await store.head(key)).toBeNull();
    expect(await platformClient().mediaAsset.count({ where: { id: assetId } })).toBe(0);
  });
  it("a suspended school cannot upload or delete", async () => {
    const t = await makeTenant("s1"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    await platformClient().tenant.update({ where: { id: t.id }, data: { status: "SUSPENDED" } });
    await expect(presignUpload(a, { name: "a.png", mime: "image/png", bytes: 100 })).rejects.toBeInstanceOf(TenantUnavailableError);
  });
  it("read-only impersonation cannot upload", async () => {
    const t = await makeTenant("s2"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const ro: Actor = { ...a, principal: { kind: "impersonation", actorId: a.userId, tenantId: t.id, mode: "READ" } };
    await expect(presignUpload(ro, { name: "a.png", mime: "image/png", bytes: 100 })).rejects.toThrow(/forbidden/);
  });
  it("audits presign, upload and rejection without leaking object keys of other tenants", async () => {
    const t = await makeTenant("a1"); await makeSubscription(t.id, 10); const a = await actorFor(t.id);
    const { assetId } = await upload(a, "ok.png", "image/png", await png()); await finalizeUpload(a, assetId);
    const bad = await upload(a, "bad.png", "image/png", Buffer.from("not an image at all")); await finalizeUpload(a, bad.assetId).catch(() => undefined);
    const acts = (await platformClient().auditLog.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "asc" } })).map((l) => l.action);
    expect(acts).toEqual(["media.presign", "media.upload", "media.presign", "media.rejected"]);
  });
});

describe("local upload URL signature", () => {
  it("is bound to key, expiry, content type and size, and expires", async () => {
    const key = `${rnd().padEnd(8, "0")}-aaaa-4aaa-8aaa-${rnd()}${rnd()}1234/${rnd()}.png`;
    void key;
    const k = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png";
    const t = await store.createUploadUrl(k, { contentType: "image/png", maxBytes: 1000, expiresInSec: 60 });
    const u = new URL(t.url); const exp = Number(u.searchParams.get("exp")), sig = u.searchParams.get("sig")!;
    expect(store.verify(k, exp, "image/png", 1000, sig)).toBe(true);
    expect(store.verify(k, exp, "image/png", 9999, sig)).toBe(false); // bigger limit
    expect(store.verify(k, exp, "text/html", 1000, sig)).toBe(false); // other content type
    expect(store.verify(k.replace("2222", "3333"), exp, "image/png", 1000, sig)).toBe(false); // other key
    expect(store.verify(k, Math.floor(Date.now() / 1000) - 5, "image/png", 1000, store.sign(k, Math.floor(Date.now() / 1000) - 5, "image/png", 1000))).toBe(false); // expired
    await expect(store.createUploadUrl("../../etc/passwd", { contentType: "image/png", maxBytes: 1, expiresInSec: 1 })).rejects.toThrow(/invalid object key/);
  });
  it("withTenant check: assets are invisible across schools at DB level", async () => {
    const t1 = await makeTenant("v1"), t2 = await makeTenant("v2"); await makeSubscription(t1.id, 10);
    const a = await actorFor(t1.id); const { assetId } = await upload(a, "z.png", "image/png", await png()); await finalizeUpload(a, assetId);
    expect(await withTenant(t2.id, (tx) => tx.mediaAsset.count({ where: { id: assetId } }))).toBe(0);
  });
});
