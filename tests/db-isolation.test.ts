import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { disconnectAll, platformClient, withTenant, tenantClient } from "@/lib/db";
import { addNews, makeAdmin, makeTenant, rnd } from "./helpers";

/**
 * PRD AC02 / TEN03 / R02 — tenant isolation proven at the DATABASE level, so a bug in application code
 * (a missing WHERE, an IDOR, a forged id) still cannot cross schools.
 */
const port = process.env.TEST_PG_PORT ?? "54329";
const tenantPg = () => new pg.Client({ connectionString: process.env.DATABASE_URL_TENANT });
const platformPg = () => new pg.Client({ connectionString: process.env.DATABASE_URL_PLATFORM });

let A: Awaited<ReturnType<typeof makeTenant>>, B: Awaited<ReturnType<typeof makeTenant>>;
let aNews: { id: string }, bNews: { id: string };

beforeAll(async () => {
  A = await makeTenant("alpha"); B = await makeTenant("beta");
  await makeAdmin(A.id); await makeAdmin(B.id);
  aNews = await addNews(A.id, "berita-a", "Berita A");
  bNews = await addNews(B.id, "berita-b", "Berita B");
});
afterAll(disconnectAll);

describe("RLS: reads", () => {
  it("a tenant context only sees its own rows", async () => {
    const rows = await withTenant(A.id, (tx) => tx.contentItem.findMany({ select: { id: true, tenantId: true } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === A.id)).toBe(true);
    expect(rows.find((r) => r.id === bNews.id)).toBeUndefined();
  });

  it("looking up another school's row by its real id returns nothing (AC02)", async () => {
    const r = await withTenant(A.id, (tx) => tx.contentItem.findUnique({ where: { id: bNews.id } }));
    expect(r).toBeNull();
  });

  it("no tenant context => zero rows (fails closed)", async () => {
    const c = tenantPg(); await c.connect();
    try {
      const r = await c.query("SELECT count(*)::int AS n FROM content_items");
      expect(r.rows[0].n).toBe(0);
      const t = await c.query("SELECT count(*)::int AS n FROM tenants");
      expect(t.rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it("the tenant role sees only its own tenants row", async () => {
    const rows = await withTenant(A.id, (tx) => tx.tenant.findMany({ select: { id: true } }));
    expect(rows.map((r) => r.id)).toEqual([A.id]);
  });

  it("platform role sees every school", async () => {
    const rows = await platformClient().contentItem.findMany({ where: { id: { in: [aNews.id, bNews.id] } }, select: { id: true } });
    expect(rows).toHaveLength(2);
  });
});

describe("RLS: writes", () => {
  it("cannot INSERT a row that belongs to another school", async () => {
    await expect(
      withTenant(A.id, (tx) => tx.contentItem.create({ data: { tenantId: B.id, type: "news", slug: `x-${rnd()}`, draftPayload: {} } })),
    ).rejects.toThrow();
  });

  it("UPDATE of another school's row affects 0 rows", async () => {
    const r = await withTenant(A.id, (tx) => tx.contentItem.updateMany({ where: { id: bNews.id }, data: { slug: "diretas" } }));
    expect(r.count).toBe(0);
    const still = await platformClient().contentItem.findUnique({ where: { id: bNews.id } });
    expect(still?.slug).toBe("berita-b");
  });

  it("DELETE of another school's row affects 0 rows", async () => {
    const r = await withTenant(A.id, (tx) => tx.contentItem.deleteMany({ where: { id: bNews.id } }));
    expect(r.count).toBe(0);
    expect(await platformClient().contentItem.findUnique({ where: { id: bNews.id } })).not.toBeNull();
  });

  it("tenant_id can never be moved to another school (trigger)", async () => {
    await expect(withTenant(A.id, (tx) => tx.contentItem.update({ where: { id: aNews.id }, data: { tenantId: B.id } }))).rejects.toThrow();
  });
});

describe("RLS: composite foreign keys block cross-tenant references (AC02/AC03)", () => {
  it("a media reference cannot point at another school's asset", async () => {
    const asset = await withTenant(B.id, (tx) =>
      tx.mediaAsset.create({ data: { tenantId: B.id, objectKey: `${B.id}/${rnd()}.png`, name: "b.png", mime: "image/png", bytes: 1000, state: "READY" } }),
    );
    await expect(
      withTenant(A.id, (tx) => tx.mediaReference.create({ data: { tenantId: A.id, assetId: asset.id, ownerType: "news", ownerId: aNews.id } })),
    ).rejects.toThrow(); // FK (tenant_id, asset_id) -> media_assets(tenant_id, id) fails, and RLS hides the row anyway
  });

  it("a menu item cannot target another school's page", async () => {
    const bPage = await withTenant(B.id, (tx) => tx.page.create({ data: { tenantId: B.id, slug: "halaman", title: "H", draftBlocks: [] } }));
    await expect(
      withTenant(A.id, (tx) => tx.menuItem.create({ data: { tenantId: A.id, label: "x", type: "PAGE", targetPageId: bPage.id } })),
    ).rejects.toThrow();
  });
});

describe("least privilege for the tenant role", () => {
  it("cannot read password hashes, TOTP secrets or Google subjects", async () => {
    const c = tenantPg(); await c.connect();
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [A.id]);
      await expect(c.query("SELECT password_hash FROM users")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT totp_secret_enc FROM users")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT auth_subject FROM users")).rejects.toThrow(/permission denied/);
      const ok = await c.query("SELECT id, email, role FROM users");
      expect(ok.rows.length).toBe(1); // only this school's admin
    } finally { await c.end(); }
  });

  it("cannot touch sessions, password resets or rate limits at all", async () => {
    const c = tenantPg(); await c.connect();
    try {
      for (const t of ["sessions", "password_resets", "rate_limits"]) {
        await expect(c.query(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/);
      }
    } finally { await c.end(); }
  });

  it("cannot activate a domain or create a primary one (operator-only, ADM04)", async () => {
    await expect(
      withTenant(A.id, (tx) => tx.domain.create({ data: { tenantId: A.id, hostname: `www.${rnd()}.sch.id`, kind: "CUSTOM", status: "ACTIVE" } })),
    ).rejects.toThrow();
    const ok = await withTenant(A.id, (tx) => tx.domain.create({ data: { tenantId: A.id, hostname: `www.${rnd()}.sch.id`, kind: "CUSTOM", status: "REQUESTED" } }));
    expect(ok.status).toBe("REQUESTED");
    await expect(withTenant(A.id, (tx) => tx.domain.update({ where: { id: ok.id }, data: { status: "ACTIVE" } }))).rejects.toThrow();
  });

  it("cannot change billing data (plans, invoices, subscriptions are read-only)", async () => {
    const c = tenantPg(); await c.connect();
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [A.id]);
      await expect(c.query("UPDATE invoices SET amount = 0")).rejects.toThrow(/permission denied/);
      await expect(c.query("DELETE FROM subscriptions")).rejects.toThrow(/permission denied/);
      await expect(c.query("UPDATE plan_versions SET amount = 0")).rejects.toThrow(/permission denied/);
    } finally { await c.end(); }
  });

  it("may update only its own language/analytics settings on tenants, not name/slug/status", async () => {
    const c = tenantPg(); await c.connect();
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [A.id]);
      const ok = await c.query("UPDATE tenants SET enable_en = true, default_lang = 'en' WHERE id = $1", [A.id]);
      expect(ok.rowCount).toBe(1);
      await expect(c.query("UPDATE tenants SET status = 'SUSPENDED'")).rejects.toThrow(/permission denied/);
      await expect(c.query("UPDATE tenants SET slug = 'curang'")).rejects.toThrow(/permission denied/);
      await expect(c.query("UPDATE tenants SET deleted_at = now()")).rejects.toThrow(/permission denied/);
    } finally { await c.end(); }
  });

  it("is NOT a superuser and does not bypass RLS", async () => {
    const c = tenantPg(); await c.connect();
    try {
      const r = await c.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const p = platformPg(); await p.connect();
      const q = await p.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      expect(q.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await p.end();
    } finally { await c.end(); }
  });
});

describe("host resolution (PRD §13.2)", () => {
  it("resolve_host returns the tenant for an ACTIVE domain and nothing else", async () => {
    const host = `${A.slug}.websekolah.id`;
    const db = platformClient();
    await db.domain.create({ data: { tenantId: A.id, hostname: host, kind: "SUBDOMAIN", status: "ACTIVE", primary: true } });
    const pendingHost = `www.${rnd()}.sch.id`;
    await db.domain.create({ data: { tenantId: B.id, hostname: pendingHost, kind: "CUSTOM", status: "AWAITING_DNS" } });

    // callable WITHOUT any tenant context, by the tenant role
    const hit = await tenantClient().$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM resolve_host(${host})`;
    expect(hit[0]?.tenant_id).toBe(A.id);
    const upper = await tenantClient().$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM resolve_host(${host.toUpperCase()})`;
    expect(upper[0]?.tenant_id).toBe(A.id);
    expect(await tenantClient().$queryRaw`SELECT * FROM resolve_host(${pendingHost})`).toHaveLength(0); // not verified/active => no tenant
    expect(await tenantClient().$queryRaw`SELECT * FROM resolve_host(${"unknown.example.com"})`).toHaveLength(0); // no default tenant
  });

  it("a soft-deleted school resolves to nothing", async () => {
    const T = await makeTenant("gone");
    const host = `${T.slug}.websekolah.id`;
    await platformClient().domain.create({ data: { tenantId: T.id, hostname: host, kind: "SUBDOMAIN", status: "ACTIVE", primary: true } });
    await platformClient().tenant.update({ where: { id: T.id }, data: { deletedAt: new Date() } });
    expect(await tenantClient().$queryRaw`SELECT * FROM resolve_host(${host})`).toHaveLength(0);
  });

  it("the definer function does not leak the table: the tenant role still cannot SELECT domains of others", async () => {
    const rows = await withTenant(A.id, (tx) => tx.domain.findMany({ select: { tenantId: true } }));
    expect(rows.every((r) => r.tenantId === A.id)).toBe(true);
  });
});

describe("clock & time zone", () => {
  it("DB and app agree on UTC for both pools (timestamps round-trip exactly)", async () => {
    for (const client of [platformClient(), tenantClient()]) {
      const r = await client.$queryRaw<{ now: Date; tz: string }[]>`SELECT now() AS now, current_setting('TimeZone') AS tz`;
      expect(r[0]!.tz).toBe("UTC");
      expect(Math.abs(r[0]!.now.getTime() - Date.now())).toBeLessThan(5_000);
    }
    const d = new Date(Date.now() + 30 * 60_000);
    const inv = await platformClient().$queryRaw<{ ok: boolean }[]>`SELECT (${d}::timestamptz - now()) BETWEEN interval '29 minutes' AND interval '31 minutes' AS ok`;
    expect(inv[0]!.ok).toBe(true);
  });
});

describe("withTenant guards", () => {
  it("rejects a non-uuid tenant id (no string smuggling into the setting)", async () => {
    await expect(withTenant("not-a-uuid'; DROP TABLE tenants;--", async () => 1)).rejects.toThrow(/invalid tenant id/);
  });
  it("tenant context does not leak between sequential transactions on the pool", async () => {
    await withTenant(A.id, async (tx) => { await tx.contentItem.findMany(); });
    const c = tenantPg(); await c.connect();
    try { const r = await c.query("SELECT current_setting('app.tenant_id', true) AS v"); expect(r.rows[0].v ?? "").toBe(""); } finally { await c.end(); }
    const n = await tenantClient().contentItem.count(); // outside withTenant on the pool: no context
    expect(n).toBe(0);
  });
  it("port sanity", () => expect(Number(port)).toBeGreaterThan(0));
});
