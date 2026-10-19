import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, platformClient, withTenant } from "@/lib/db";
import { deleteContent, getContent, getSingleton, listContent, reorderContent, saveContent, setPublication } from "@/lib/services/content";
import { ConflictError, NotFoundError, TenantUnavailableError, ValidationError } from "@/lib/errors";
import { ForbiddenError, type Principal } from "@/lib/auth/rbac";
import type { Actor } from "@/lib/actor";
import { makeAdmin, makeTenant, rnd } from "./helpers";
import { hasRawHtml, richToHtml } from "@/lib/richtext";
import { translationState, validatePayload } from "@/lib/content/validate";
import { TYPES } from "@/lib/content/types";

afterAll(disconnectAll);
const actorFor = async (tenantId: string): Promise<Actor> => {
  const u = await makeAdmin(tenantId);
  const principal: Principal = { kind: "school_admin", userId: u.id, tenantId };
  return { principal, userId: u.id, email: u.email, tenantId };
};
const news = (o: Record<string, unknown> = {}) => ({ title: "Judul Berita", category: "Kegiatan", date: "2026-10-19", summary: "Ringkasan", body: "Isi **berita**", ...o });

let A: Awaited<ReturnType<typeof makeTenant>>, B: Awaited<ReturnType<typeof makeTenant>>;
let a: Actor, b: Actor;
beforeAll(async () => { A = await makeTenant("ca"); B = await makeTenant("cb"); a = await actorFor(A.id); b = await actorFor(B.id); });

describe("draft / publish lifecycle (CMS02, AC03)", () => {
  it("a new item is a private draft; publishing exposes a snapshot; later edits stay draft-only until republished", async () => {
    const d = await saveContent(a, { type: "news", payload: news(), mode: "draft" });
    expect(d.status).toBe("draft"); expect(d.published).toBeNull(); expect(d.slug).toBe("judul-berita");
    const p = await setPublication(a, d.id, d.version, true);
    expect(p.status).toBe("published"); expect(p.published?.title).toBe("Judul Berita");
    const e = await saveContent(a, { type: "news", id: p.id, expectedVersion: p.version, payload: news({ title: "Judul Revisi" }), mode: "draft" });
    expect(e.status).toBe("changed");
    expect(e.published?.title).toBe("Judul Berita"); // the live version is untouched (AC03)
    const u = await setPublication(a, e.id, e.version, false);
    expect(u.status).toBe("draft"); expect(u.published).toBeNull();
  });
  it("draft saves tolerate incomplete work, but publishing enforces required fields", async () => {
    const d = await saveContent(a, { type: "news", payload: { title: "Hanya judul" }, mode: "draft" });
    await expect(setPublication(a, d.id, d.version, true)).rejects.toBeInstanceOf(ValidationError);
    await expect(saveContent(a, { type: "news", payload: { title: "Hanya judul" }, mode: "publish" })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveContent(a, { type: "news", payload: {}, mode: "draft" })).rejects.toBeInstanceOf(ValidationError); // title is always required
  });
  it("slugs are unique per type within a school and gain a suffix on collision", async () => {
    const t = await makeTenant("slug"); const x = await actorFor(t.id);
    const one = await saveContent(x, { type: "news", payload: news({ title: "Sama" }), mode: "draft" });
    const two = await saveContent(x, { type: "news", payload: news({ title: "Sama" }), mode: "draft" });
    expect([one.slug, two.slug]).toEqual(["sama", "sama-2"]);
    await expect(saveContent(x, { type: "news", payload: news(), slug: "Bad Slug", mode: "draft" })).rejects.toBeInstanceOf(ValidationError);
  });
  it("singletons (profile/contact/ppdb) keep exactly one row and update in place", async () => {
    const t = await makeTenant("single"); const x = await actorFor(t.id);
    const p1 = await saveContent(x, { type: "profile", payload: { name: "SMA X", address: "Jl. A" }, mode: "draft" });
    const p2 = await saveContent(x, { type: "profile", payload: { name: "SMA X Baru", address: "Jl. B" }, mode: "draft", expectedVersion: p1.version });
    expect(p2.id).toBe(p1.id);
    expect((await getSingleton(x, "profile"))?.title).toBe("SMA X Baru");
    expect(await withTenant(t.id, (tx) => tx.contentItem.count({ where: { type: "profile" } }))).toBe(1);
  });
});

describe("optimistic locking — stale tab cannot overwrite (409, AC05)", () => {
  it("rejects a save based on an old version and reports the current one", async () => {
    const d = await saveContent(a, { type: "news", payload: news({ title: "Konflik" }), mode: "draft" });
    const tab1 = await saveContent(a, { type: "news", id: d.id, expectedVersion: d.version, payload: news({ title: "Dari tab 1" }), mode: "draft" });
    const err = await saveContent(a, { type: "news", id: d.id, expectedVersion: d.version, payload: news({ title: "Dari tab lama" }), mode: "draft" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError); expect((err as ConflictError).currentVersion).toBe(tab1.version);
    expect((await getContent(a, d.id)).title).toBe("Dari tab 1"); // nothing was overwritten
    await expect(setPublication(a, d.id, d.version, true)).rejects.toBeInstanceOf(ConflictError);
  });
  it("of two concurrent saves from the same version exactly one wins", async () => {
    const d = await saveContent(a, { type: "news", payload: news({ title: "Balapan" }), mode: "draft" });
    const rs = await Promise.allSettled([1, 2].map((i) => saveContent(a, { type: "news", id: d.id, expectedVersion: d.version, payload: news({ title: `Tulis ${i}` }), mode: "draft" })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rs.filter((r) => r.status === "rejected" && r.reason instanceof ConflictError)).toHaveLength(1);
  });
});

describe("tenant isolation at the service layer (AC02)", () => {
  it("school A cannot read, edit, publish or delete school B's content, even with the real id", async () => {
    const mine = await saveContent(b, { type: "news", payload: news({ title: "Milik B" }), mode: "publish" });
    await expect(getContent(a, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveContent(a, { type: "news", id: mine.id, expectedVersion: mine.version, payload: news(), mode: "draft" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setPublication(a, mine.id, mine.version, false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteContent(a, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getContent(b, mine.id)).published?.title).toBe("Milik B");
    expect((await listContent(a, "news")).rows.find((r) => r.id === mine.id)).toBeUndefined();
  });
  it("capabilities are checked: a visitor / other-school principal is refused before any query", async () => {
    const visitor: Actor = { principal: { kind: "visitor" }, userId: "x", email: "x@x.test", tenantId: A.id };
    await expect(saveContent(visitor, { type: "news", payload: news(), mode: "draft" })).rejects.toBeInstanceOf(ForbiddenError);
    const readOnly: Actor = { ...a, principal: { kind: "impersonation", actorId: a.userId, tenantId: A.id, mode: "READ" } };
    await expect(saveContent(readOnly, { type: "news", payload: news(), mode: "draft" })).rejects.toBeInstanceOf(ForbiddenError); // impersonation READ cannot write
    await expect(listContent(readOnly, "news")).resolves.toBeTruthy(); // but can read
  });
  it("a suspended school cannot create, edit, or publish (TEN04) — data is kept", async () => {
    const t = await makeTenant("susp"); const x = await actorFor(t.id);
    const d = await saveContent(x, { type: "news", payload: news(), mode: "draft" });
    await platformClient().tenant.update({ where: { id: t.id }, data: { status: "SUSPENDED" } });
    await expect(saveContent(x, { type: "news", payload: news(), mode: "draft" })).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(setPublication(x, d.id, d.version, true)).rejects.toBeInstanceOf(TenantUnavailableError);
    expect((await getContent(x, d.id)).id).toBe(d.id); // still readable
  });
});

describe("audit & jobs are written in the same transaction", () => {
  it("every mutation leaves an audit row and a cache-invalidation job", async () => {
    const t = await makeTenant("aud2"); const x = await actorFor(t.id);
    const d = await saveContent(x, { type: "news", payload: news(), mode: "publish" });
    await deleteContent(x, d.id);
    const logs = await platformClient().auditLog.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["content.publish", "content.delete"]);
    expect(logs.every((l) => l.actorId === x.userId)).toBe(true);
    expect(await platformClient().job.count({ where: { tenantId: t.id, type: "cache.invalidate" } })).toBeGreaterThan(0);
  });
  it("a failed (invalid) save leaves no audit row or job behind", async () => {
    const t = await makeTenant("aud3"); const x = await actorFor(t.id);
    await saveContent(x, { type: "news", payload: { title: "" }, mode: "draft" }).catch(() => undefined);
    expect(await platformClient().auditLog.count({ where: { tenantId: t.id } })).toBe(0);
  });
});

describe("list, search, paginate, reorder (CMS list rules)", () => {
  it("paginates 20 per page, newest first, filterable by status and title search", async () => {
    const t = await makeTenant("list"); const x = await actorFor(t.id);
    for (let i = 0; i < 25; i++) await saveContent(x, { type: "news", payload: news({ title: `Berita ${String(i).padStart(2, "0")}` }), mode: i % 5 === 0 ? "publish" : "draft" });
    const p1 = await listContent(x, "news"), p2 = await listContent(x, "news", { page: 2 });
    expect([p1.rows.length, p2.rows.length, p1.total, p1.pages]).toEqual([20, 5, 25, 2]);
    expect(p1.rows[0]!.title).toBe("Berita 24");
    expect((await listContent(x, "news", { status: "published" })).total).toBe(5);
    expect((await listContent(x, "news", { q: "berita 07" })).rows.map((r) => r.title)).toEqual(["Berita 07"]);
  });
  it("persists a new order for ordered modules and ignores foreign ids", async () => {
    const t = await makeTenant("ord"); const x = await actorFor(t.id);
    const mk = (n: string) => saveContent(x, { type: "staff", payload: { name: n, position: "Guru" }, mode: "publish" });
    const [s1, s2, s3] = [await mk("A"), await mk("B"), await mk("C")];
    const foreign = await saveContent(b, { type: "staff", payload: { name: "Z", position: "G" }, mode: "publish" });
    await reorderContent(x, "staff", [s3.id, foreign.id, s1.id, s2.id]);
    expect((await listContent(x, "staff")).rows.map((r) => r.title)).toEqual(["C", "A", "B"]);
    expect((await getContent(b, foreign.id)).position).toBe(0); // untouched
    await expect(reorderContent(x, "news", [])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("validation rules (PRD §7, §13.1)", () => {
  it("rejects raw HTML / script in any text field, and drops unknown keys (no mass assignment)", async () => {
    await expect(saveContent(a, { type: "news", payload: news({ body: "<script>alert(1)</script>" }), mode: "publish" })).rejects.toMatchObject({ fields: { body: expect.stringMatching(/HTML/) } });
    await expect(saveContent(a, { type: "news", payload: news({ title: "<b>x</b>" }), mode: "draft" })).rejects.toBeInstanceOf(ValidationError);
    const d = await saveContent(a, { type: "news", payload: { ...news(), isAdmin: true, tenantId: B.id, __proto__: { x: 1 } }, mode: "draft" });
    expect(d.draft).not.toHaveProperty("isAdmin"); expect(d.draft).not.toHaveProperty("tenantId");
    expect((await withTenant(A.id, (tx) => tx.contentItem.findUniqueOrThrow({ where: { id: d.id } }))).tenantId).toBe(A.id);
  });
  it("field rules: lengths, dates, agenda ordering, achievement year, social hosts, https-only links", async () => {
    const v = (type: string, p: Record<string, unknown>) => validatePayload(TYPES[type]!, p).errors;
    expect(v("news", news({ title: "x".repeat(121) })).title).toMatch(/maksimal 120/);
    expect(v("news", news({ date: "19-10-2026" })).date).toBeTruthy();
    expect(v("agenda", { title: "A", start: "2026-10-20T08:00:00Z", end: "2026-10-19T08:00:00Z" }).end).toMatch(/sebelum/);
    expect(v("achievement", { title: "A", year: "20x5", level: "Sekolah" }).year).toBeTruthy();
    expect(v("achievement", { title: "A", year: "2999", level: "Sekolah" }).year).toBeTruthy();
    expect(v("news", news({ instagramUrl: "https://www.instagram.com/akun/" })).instagramUrl).toBeTruthy();
    expect(v("news", news({ instagramUrl: "https://www.instagram.com/p/AbC123/" })).instagramUrl).toBeUndefined();
    expect(v("news", news({ facebookUrl: "https://evil.com/facebook.com" })).facebookUrl).toBeTruthy();
    expect(v("news", news({ youtubeUrl: "http://youtube.com/watch?v=abcdefg" })).youtubeUrl).toBeTruthy();
    expect(v("news", news({ youtubeUrl: "https://www.youtube.com/@sekolah", youtubeEmbed: true })).youtubeUrl).toMatch(/bukan video/);
    expect(v("news", news({ youtubeUrl: "https://www.youtube.com/@sekolah", youtubeEmbed: false })).youtubeUrl).toBeUndefined();
    expect(v("contact", { mapUrl: "javascript:alert(1)" }).mapUrl).toBeTruthy();
    expect(v("ppdb", { status: "open", year: "2026/2027", periodStart: "2026-10-10", periodEnd: "2026-10-01", intro: "x", requirements: "y" }).periodEnd).toBeTruthy();
    expect(v("ppdb", { status: "open", year: "2026/2027", periodStart: "2026-10-01", periodEnd: "2026-10-10", intro: "x", requirements: "y" }).ctaUrl).toMatch(/tautan pendaftaran/);
  });
  it("media fields must reference this school's own READY media of the right kind", async () => {
    const t = await makeTenant("med"); const x = await actorFor(t.id);
    const foreign = await withTenant(B.id, (tx) => tx.mediaAsset.create({ data: { tenantId: B.id, objectKey: `${B.id}/${rnd()}.png`, name: "b.png", mime: "image/png", bytes: 100, state: "READY" } }));
    await expect(saveContent(x, { type: "news", payload: news({ image: foreign.id }), mode: "draft" })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveContent(x, { type: "news", payload: news({ image: "bukan-uuid" }), mode: "draft" })).rejects.toBeInstanceOf(ValidationError);
    const pdf = await withTenant(t.id, (tx) => tx.mediaAsset.create({ data: { tenantId: t.id, objectKey: `${t.id}/${rnd()}.pdf`, name: "a.pdf", mime: "application/pdf", bytes: 100, state: "READY" } }));
    await expect(saveContent(x, { type: "news", payload: news({ image: pdf.id }), mode: "draft" })).rejects.toMatchObject({ fields: { image: expect.stringMatching(/gambar/) } });
    const img = await withTenant(t.id, (tx) => tx.mediaAsset.create({ data: { tenantId: t.id, objectKey: `${t.id}/${rnd()}.png`, name: "a.png", mime: "image/png", bytes: 100, state: "READY" } }));
    const ok = await saveContent(x, { type: "news", payload: news({ image: img.id }), mode: "draft" });
    expect(await withTenant(t.id, (tx) => tx.mediaReference.count({ where: { ownerId: ok.id, assetId: img.id } }))).toBe(1); // reference tracked
    await deleteContent(x, ok.id);
    expect(await withTenant(t.id, (tx) => tx.mediaReference.count({ where: { ownerId: ok.id } }))).toBe(0);
  });
});

describe("English translation (_en)", () => {
  it("stores only translatable fields, reports coverage, and never trusts non-string/unknown translation keys", async () => {
    const d = await saveContent(a, { type: "news", payload: { ...news(), _en: { title: "English title", summary: "S", body: "B", image: "x", foo: "bar", category: "Hack" } }, mode: "publish" });
    expect(d.draft._en).toEqual({ title: "English title", summary: "S", body: "B" }); // image/foo/category dropped
    expect(d.en).toBe("complete");
    const partial = await saveContent(a, { type: "news", payload: { ...news(), _en: { title: "Only title" } }, mode: "draft" });
    expect(partial.en).toBe("partial");
    expect((await saveContent(a, { type: "news", payload: news(), mode: "draft" })).en).toBe("none");
    await expect(saveContent(a, { type: "news", payload: { ...news(), _en: { body: "<script>x</script>" } }, mode: "draft" })).rejects.toBeInstanceOf(ValidationError);
    expect(translationState(TYPES.news!, { _en: { title: "t", summary: "s", body: "b" } })).toBe("complete");
  });
  it("repeater translations stay aligned with the Indonesian rows", async () => {
    const t = await makeTenant("trr"); const x = await actorFor(t.id);
    const d = await saveContent(x, { type: "profile", payload: { name: "S", address: "A", stats: [{ label: "Siswa", value: "300" }, { label: "Guru", value: "28" }], _en: { stats: [{ label: "Students" }, { label: "Teachers" }, { label: "Extra row ignored" }] } }, mode: "draft" });
    expect((d.draft._en as { stats: unknown[] }).stats).toEqual([{ label: "Students" }, { label: "Teachers" }]);
  });
});

describe("rich text safety", () => {
  it("renders a safe subset and escapes everything else", () => {
    expect(richToHtml("Halo **tebal** dan *miring*\n\n- satu\n- dua")).toBe("<p>Halo <strong>tebal</strong> dan <em>miring</em></p><ul><li>satu</li><li>dua</li></ul>");
    expect(richToHtml("<img src=x onerror=alert(1)>")).not.toContain("<img");
    expect(richToHtml("[klik](https://ok.example/a)")).toContain('rel="noopener noreferrer"');
    expect(richToHtml("[jahat](javascript:alert(1))")).not.toContain("<a ");
    expect(richToHtml("[http](http://insecure.example)")).not.toContain("<a ");
    for (const bad of ["<script>x</script>", "<iframe src=x>", "javascript:alert(1)", "<a onclick=x>", "x onerror=alert(1)"]) expect(hasRawHtml(bad), bad).toBe(true);
    expect(hasRawHtml("Harga < 5 dan > 3")).toBe(false);
  });
});
