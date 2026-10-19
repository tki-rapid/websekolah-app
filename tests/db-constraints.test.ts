import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { disconnectAll, platformClient, withTenant } from "@/lib/db";
import { makeAdmin, makeTenant, makeSuper, rnd } from "./helpers";

const platformPg = () => new pg.Client({ connectionString: process.env.DATABASE_URL_PLATFORM });
const db = () => platformClient();
afterAll(disconnectAll);

describe("tenants & users (TEN01, TEN02)", () => {
  it("rejects bad or reserved slugs", async () => {
    for (const slug of ["admin", "api", "www", "UPPER", "a", "-bad", "bad-", "has space", "x".repeat(41)]) {
      await expect(db().tenant.create({ data: { name: "x", slug, type: "SMA" } }), slug).rejects.toThrow();
    }
  });
  it("slug is globally unique", async () => {
    const t = await makeTenant("dup");
    await expect(db().tenant.create({ data: { name: "y", slug: t.slug, type: "SD" } })).rejects.toThrow();
  });
  it("only ONE active school admin per tenant — enforced by a partial unique index", async () => {
    const t = await makeTenant("one");
    await makeAdmin(t.id);
    await expect(makeAdmin(t.id)).rejects.toThrow();
    // replacing: deactivate the old one first, then a new one is allowed
    await db().user.updateMany({ where: { tenantId: t.id }, data: { active: false } });
    await expect(makeAdmin(t.id)).resolves.toBeTruthy();
  });
  it("super admin has no tenant; school admin must have one", async () => {
    await expect(db().user.create({ data: { email: `a-${rnd()}@x.test`, name: "x", role: "SUPER_ADMIN", tenantId: (await makeTenant("t")).id } })).rejects.toThrow();
    await expect(db().user.create({ data: { email: `b-${rnd()}@x.test`, name: "x", role: "SCHOOL_ADMIN", tenantId: null } })).rejects.toThrow();
  });
  it("e-mail must be stored lower-case", async () => {
    await expect(db().user.create({ data: { email: `Mixed-${rnd()}@X.test`, name: "x", role: "SUPER_ADMIN" } })).rejects.toThrow();
  });
  it("a user's role and linked Google subject are immutable", async () => {
    const s = await makeSuper();
    await expect(db().user.update({ where: { id: s.id }, data: { role: "SCHOOL_ADMIN" } })).rejects.toThrow();
    await db().user.update({ where: { id: s.id }, data: { authSubject: `sub-${rnd()}` } });
    await expect(db().user.update({ where: { id: s.id }, data: { authSubject: "other" } })).rejects.toThrow(/cannot be changed/);
  });
  it("language / GA settings are validated", async () => {
    const t = await makeTenant("lang");
    await expect(db().tenant.update({ where: { id: t.id }, data: { defaultLang: "en", enableEn: false } })).rejects.toThrow();
    await expect(db().tenant.update({ where: { id: t.id }, data: { gaEnabled: true } })).rejects.toThrow();
    await expect(db().tenant.update({ where: { id: t.id }, data: { gaEnabled: true, gaMeasurementId: "UA-12345-1" } })).rejects.toThrow();
    await expect(db().tenant.update({ where: { id: t.id }, data: { gaEnabled: true, gaMeasurementId: "G-ABC123XYZ9" } })).resolves.toBeTruthy();
  });
});

describe("domains (WEB03, AC07)", () => {
  it("hostnames must be normalised and are unique across ALL tenants", async () => {
    const a = await makeTenant("da"), b = await makeTenant("db");
    const h = `www.${rnd()}.sch.id`;
    await db().domain.create({ data: { tenantId: a.id, hostname: h, kind: "CUSTOM" } });
    await expect(db().domain.create({ data: { tenantId: b.id, hostname: h, kind: "CUSTOM" } })).rejects.toThrow(); // taken by another school
    for (const bad of ["WWW.Upper.id", "has space.id", "x.id:8080", "trailing.dot.", "single", "a..b.id", "-bad.id"]) {
      await expect(db().domain.create({ data: { tenantId: b.id, hostname: bad, kind: "CUSTOM" } }), bad).rejects.toThrow();
    }
  });
  it("at most one ACTIVE primary domain per tenant", async () => {
    const t = await makeTenant("pri");
    await db().domain.create({ data: { tenantId: t.id, hostname: `a.${rnd()}.id`, kind: "CUSTOM", status: "ACTIVE", primary: true } });
    await expect(db().domain.create({ data: { tenantId: t.id, hostname: `b.${rnd()}.id`, kind: "CUSTOM", status: "ACTIVE", primary: true } })).rejects.toThrow();
  });
});

describe("content, pages, navigation (CMS02, CMS13, CMS14, AC05)", () => {
  it("content slug is unique per tenant+type but may repeat across types and tenants", async () => {
    const a = await makeTenant("ca"), b = await makeTenant("cb");
    const mk = (tenantId: string, type: "news" | "announcement", slug: string) =>
      withTenant(tenantId, (tx) => tx.contentItem.create({ data: { tenantId, type, slug, draftPayload: {} } }));
    await mk(a.id, "news", "sama");
    await expect(mk(a.id, "news", "sama")).rejects.toThrow();
    await expect(mk(a.id, "announcement", "sama")).resolves.toBeTruthy();
    await expect(mk(b.id, "news", "sama")).resolves.toBeTruthy();
    await expect(mk(a.id, "news", "Bad Slug")).rejects.toThrow();
  });
  it("a page holds at most 20 blocks and reserved slugs are refused", async () => {
    const t = await makeTenant("pg");
    const block = (i: number) => ({ id: `b${i}`, type: "richtext", schemaVersion: 1, props: {} });
    const mk = (slug: string, n: number) => withTenant(t.id, (tx) => tx.page.create({ data: { tenantId: t.id, slug, title: slug, draftBlocks: Array.from({ length: n }, (_, i) => block(i)) } }));
    await expect(mk("dua-puluh", 20)).resolves.toBeTruthy();
    await expect(mk("dua-satu", 21)).rejects.toThrow();
    for (const slug of ["berita", "p", "beranda", "en", "api"]) await expect(mk(slug, 1), slug).rejects.toThrow();
  });
  it("only one home page per tenant", async () => {
    const t = await makeTenant("home");
    const home = (slug: string) => withTenant(t.id, (tx) => tx.page.create({ data: { tenantId: t.id, slug, title: "H", isHome: true, draftBlocks: [] } }));
    await home("beranda"); await expect(home("beranda2")).rejects.toThrow();
  });
  it("navigation depth is limited to 3 levels", async () => {
    const t = await makeTenant("nav");
    const mk = (parentId: string | null, label: string) =>
      withTenant(t.id, (tx) => tx.menuItem.create({ data: { tenantId: t.id, parentId, label, type: "SYSTEM", systemTarget: "berita" } }));
    const l1 = await mk(null, "1"), l2 = await mk(l1.id, "2"), l3 = await mk(l2.id, "3");
    await expect(mk(l3.id, "4")).rejects.toThrow(/depth/);
  });
  it("menu items need exactly one valid target; external links must be https", async () => {
    const t = await makeTenant("nav2");
    const mk = (data: object) => withTenant(t.id, (tx) => tx.menuItem.create({ data: { tenantId: t.id, label: "x", ...data } as never }));
    await expect(mk({ type: "URL", url: "http://insecure.example.com" })).rejects.toThrow();
    await expect(mk({ type: "URL", url: "javascript:alert(1)" })).rejects.toThrow();
    await expect(mk({ type: "URL", url: "https://ok.example.com" })).resolves.toBeTruthy();
    await expect(mk({ type: "SYSTEM" })).rejects.toThrow();
  });
});

describe("media (CMS15, AC06)", () => {
  it("only JPEG/PNG/WebP/PDF within size caps, with a tenant-prefixed object key", async () => {
    const t = await makeTenant("media");
    const mk = (o: Record<string, unknown>) => withTenant(t.id, (tx) => tx.mediaAsset.create({ data: { tenantId: t.id, objectKey: `${t.id}/${rnd()}`, name: "f", mime: "image/png", bytes: 1000, state: "READY", ...o } as never }));
    await expect(mk({})).resolves.toBeTruthy();
    for (const mime of ["image/svg+xml", "text/html", "application/x-msdownload", "application/zip"]) await expect(mk({ mime }), mime).rejects.toThrow();
    await expect(mk({ bytes: 6 * 1024 * 1024 })).rejects.toThrow(); // image > 5 MB
    await expect(mk({ mime: "application/pdf", bytes: 21 * 1024 * 1024 })).rejects.toThrow(); // pdf > 20 MB
    await expect(mk({ mime: "application/pdf", bytes: 19 * 1024 * 1024 })).resolves.toBeTruthy();
    await expect(mk({ objectKey: `other-tenant/${rnd()}` })).rejects.toThrow(); // key must be prefixed with own tenant id
  });
});

describe("billing integrity (ADM03, ADM08, AC08)", () => {
  async function setup() {
    const t = await makeTenant("bill"); const admin = await makeSuper();
    const plan = await db().plan.create({ data: { code: `p-${rnd()}`, name: "Standard" } });
    const pv = await db().planVersion.create({ data: { planId: plan.id, version: 1, interval: "MONTHLY", amount: 199000, quotas: {}, features: {} } });
    const sub = await db().subscription.create({ data: { tenantId: t.id, planVersionId: pv.id, status: "ACTIVE", periodStart: new Date(), periodEnd: new Date(Date.now() + 864e5 * 30) } });
    const invoice = (n = `INV-${rnd()}`) => db().invoice.create({ data: { tenantId: t.id, subscriptionId: sub.id, number: n, planName: "Standard", interval: "MONTHLY", amount: 199000, status: "ISSUED", periodStart: new Date(), periodEnd: new Date(Date.now() + 864e5 * 30), dueAt: new Date(Date.now() + 864e5 * 7) } });
    return { t, admin, pv, invoice };
  }
  it("plan versions are immutable (old invoices keep their price)", async () => {
    const { pv } = await setup();
    await expect(db().planVersion.update({ where: { id: pv.id }, data: { amount: 1 } })).rejects.toThrow(/immutable/);
    await expect(db().planVersion.delete({ where: { id: pv.id } })).rejects.toThrow();
  });
  it("amounts must be non-negative integers in IDR", async () => {
    const { pv } = await setup();
    await expect(db().planVersion.create({ data: { planId: pv.planId, version: 2, interval: "MONTHLY", amount: -1, quotas: {}, features: {} } })).rejects.toThrow();
    await expect(db().planVersion.create({ data: { planId: pv.planId, version: 3, interval: "MONTHLY", amount: 1, currency: "USD", quotas: {}, features: {} } })).rejects.toThrow();
  });
  it("marking paid needs a payment; a second payment for the same invoice or reference is rejected; paid invoices are final", async () => {
    const { t, admin, invoice } = await setup();
    const inv = await invoice();
    await expect(db().invoice.update({ where: { id: inv.id }, data: { status: "PAID", paidAt: new Date() } })).rejects.toThrow(/without a payment/);
    const ref = `TRF-${rnd()}`;
    await db().$transaction(async (tx) => {
      await tx.payment.create({ data: { tenantId: t.id, invoiceId: inv.id, reference: ref, amount: inv.amount, verifierId: admin.id } });
      await tx.invoice.update({ where: { id: inv.id }, data: { status: "PAID", paidAt: new Date() } });
    });
    await expect(db().payment.create({ data: { tenantId: t.id, invoiceId: inv.id, reference: `TRF-${rnd()}`, amount: inv.amount, verifierId: admin.id } })).rejects.toThrow(); // not ISSUED anymore / unique(invoice)
    const inv2 = await invoice();
    await expect(db().payment.create({ data: { tenantId: t.id, invoiceId: inv2.id, reference: ref, amount: inv2.amount, verifierId: admin.id } })).rejects.toThrow(); // reference reuse
    await expect(db().payment.create({ data: { tenantId: t.id, invoiceId: inv2.id, reference: `TRF-${rnd()}`, amount: 1, verifierId: admin.id } })).rejects.toThrow(/amount/);
    await expect(db().invoice.update({ where: { id: inv.id }, data: { amount: 1 } })).rejects.toThrow(/final/);
    await expect(db().invoice.delete({ where: { id: inv.id } })).rejects.toThrow();
    await expect(db().payment.update({ where: { invoiceId: inv.id }, data: { amount: 1 } })).rejects.toThrow(/append-only|permission denied/);
  });
  it("issued invoice fields are frozen; invoice numbers are unique", async () => {
    const { invoice } = await setup();
    const inv = await invoice("INV-UNIQ-" + rnd());
    await expect(db().invoice.update({ where: { id: inv.id }, data: { amount: 5 } })).rejects.toThrow(/immutable/);
    await expect(invoice(inv.number)).rejects.toThrow();
  });
});

describe("audit log is append-only (ADM07)", () => {
  it("cannot be updated, deleted or truncated — not even by the platform role", async () => {
    const t = await makeTenant("aud");
    const row = await db().auditLog.create({ data: { tenantId: t.id, actorEmail: "x@y.test", action: "test", resource: "r" } });
    await expect(db().auditLog.update({ where: { id: row.id }, data: { action: "edited" } })).rejects.toThrow(/append-only|permission/);
    await expect(db().auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only|permission/);
    const c = platformPg(); await c.connect();
    try { await expect(c.query("TRUNCATE audit_logs")).rejects.toThrow(/permission denied|append-only/); } finally { await c.end(); }
  });
  it("a tenant can append and read only its own audit entries", async () => {
    const a = await makeTenant("aa"), b = await makeTenant("ab");
    await withTenant(a.id, (tx) => tx.auditLog.create({ data: { tenantId: a.id, actorEmail: "a@a.test", action: "x", resource: "r" } }));
    await expect(withTenant(a.id, (tx) => tx.auditLog.create({ data: { tenantId: b.id, actorEmail: "a@a.test", action: "x", resource: "r" } }))).rejects.toThrow();
    const rows = await withTenant(a.id, (tx) => tx.auditLog.findMany());
    expect(rows.every((r) => r.tenantId === a.id)).toBe(true);
  });
});

describe("feature flags & jobs", () => {
  it("global flag keys are unique; tenant flags need a tenant", async () => {
    const k = `flag-${rnd()}`, t = await makeTenant("fl");
    await db().featureFlag.create({ data: { key: k, scope: "GLOBAL", enabled: true } });
    await expect(db().featureFlag.create({ data: { key: k, scope: "GLOBAL", enabled: false } })).rejects.toThrow();
    await expect(db().featureFlag.create({ data: { key: k, scope: "TENANT", enabled: false } })).rejects.toThrow();
    await expect(db().featureFlag.create({ data: { key: k, scope: "TENANT", tenantId: t.id, enabled: false } })).resolves.toBeTruthy();
  });
  it("jobs deduplicate and cap attempts at 5", async () => {
    const key = `dedupe-${rnd()}`;
    await db().job.create({ data: { type: "cache.invalidate", dedupeKey: key } });
    await expect(db().job.create({ data: { type: "cache.invalidate", dedupeKey: key } })).rejects.toThrow();
    await expect(db().job.create({ data: { type: "x", dedupeKey: `${key}-2`, attempts: 6 } })).rejects.toThrow();
  });
  it("impersonation sessions are capped at 15 minutes", async () => {
    const t = await makeTenant("imp"); const s = await makeSuper();
    const sess = await db().session.create({ data: { userId: s.id, tokenHash: `h-${rnd()}`, provider: "password", expiresAt: new Date(Date.now() + 36e5), idleExpiresAt: new Date(Date.now() + 36e5) } });
    const mk = (min: number) => db().impersonationSession.create({ data: { actorId: s.id, tenantId: t.id, sessionId: sess.id, reason: "TKT-1", expiresAt: new Date(Date.now() + min * 60_000) } });
    await expect(mk(15)).resolves.toBeTruthy();
    await expect(mk(16)).rejects.toThrow();
  });
});

describe("media reservations (Phase 2)", () => {
  it("a PENDING upload must carry an expiry so abandoned reservations can always be reclaimed", async () => {
    const t = await makeTenant("pend");
    await expect(withTenant(t.id, (tx) => tx.mediaAsset.create({ data: { tenantId: t.id, objectKey: `${t.id}/${rnd()}.png`, name: "p", mime: "image/png", bytes: 10, state: "PENDING" } }))).rejects.toThrow();
    await expect(withTenant(t.id, (tx) => tx.mediaAsset.create({ data: { tenantId: t.id, objectKey: `${t.id}/${rnd()}.png`, name: "p", mime: "image/png", bytes: 10, state: "PENDING", uploadExpiresAt: new Date(Date.now() + 60_000) } }))).resolves.toBeTruthy();
  });
});
