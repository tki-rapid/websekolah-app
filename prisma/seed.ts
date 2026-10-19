/**
 * Seed: reference data (plans, themes, flags), the first Super Admin, and — only on request — demo schools.
 *   SEED_SUPERADMIN_EMAIL=you@example.com [SEED_SUPERADMIN_PASSWORD=...] npm run db:seed
 *   SEED_DEMO=1 npm run db:seed        (refused when NODE_ENV=production)
 * Uses the PLATFORM database login. Idempotent.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword, passwordPolicyError } from "../src/lib/security/password";
import { createHash, randomBytes } from "node:crypto";

const url = process.env.DATABASE_URL_PLATFORM;
if (!url) throw new Error("DATABASE_URL_PLATFORM is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: "-c timezone=UTC" }) });

const PLANS = [
  { code: "starter", name: "Starter", m: 99_000, y: 990_000, quotas: { storageMB: 500, pages: 5 }, features: { gallery: true, ppdb: false, page_builder: false, custom_domain: false, analytics: true } },
  { code: "standard", name: "Standard", m: 199_000, y: 1_990_000, quotas: { storageMB: 2048, pages: 20 }, features: { gallery: true, ppdb: true, page_builder: true, custom_domain: false, analytics: true } },
  { code: "premium", name: "Premium", m: 349_000, y: 3_490_000, quotas: { storageMB: 10240, pages: 60 }, features: { gallery: true, ppdb: true, page_builder: true, custom_domain: true, analytics: true } },
];
// PRICES ARE PLACEHOLDERS — final pricing is open decision Q01 in the PRD.
const THEMES = ["umum-klasik", "umum-modern", "sd-ceria", "smp-aktif", "sma-akademik", "smk-vokasi", "minimal", "editorial", "madrasah", "pesantren"];
const FLAGS = ["gallery", "ppdb", "page_builder", "custom_domain", "analytics", "multilang"];

async function reference() {
  for (const p of PLANS) {
    const plan = await db.plan.upsert({ where: { code: p.code }, update: {}, create: { code: p.code, name: p.name } });
    for (const [interval, amount] of [["MONTHLY", p.m], ["YEARLY", p.y]] as const) {
      await db.planVersion.upsert({
        where: { planId_version_interval: { planId: plan.id, version: 1, interval } },
        update: {}, create: { planId: plan.id, version: 1, interval, amount, quotas: p.quotas, features: p.features },
      });
    }
  }
  for (const key of THEMES) {
    const theme = await db.theme.upsert({ where: { key }, update: {}, create: { key, name: key.replace(/-/g, " ") } });
    await db.themeVersion.upsert({
      where: { themeId_version: { themeId: theme.id, version: 1 } }, update: {},
      create: { themeId: theme.id, version: 1, schema: { tokens: ["primary", "accent", "fontHeading", "fontBody"] }, allowedVariants: { header: ["classic", "centered", "compact"], hero: ["full", "split", "minimal"], list: ["grid", "list"] } },
    });
  }
  for (const key of FLAGS) {
    const exists = await db.featureFlag.findFirst({ where: { key, scope: "GLOBAL" } });
    if (!exists) await db.featureFlag.create({ data: { key, scope: "GLOBAL", enabled: true } });
  }
}

async function superAdmin() {
  const email = process.env.SEED_SUPERADMIN_EMAIL?.trim().toLowerCase();
  if (!email) { console.log("• SEED_SUPERADMIN_EMAIL not set — skipping Super Admin"); return; }
  const pw = process.env.SEED_SUPERADMIN_PASSWORD;
  if (pw) { const err = passwordPolicyError(pw, { email }); if (err) throw new Error(`SEED_SUPERADMIN_PASSWORD: ${err}`); }
  await db.user.upsert({
    where: { email }, update: {},
    create: { email, name: "Super Admin", role: "SUPER_ADMIN", tenantId: null, passwordHash: pw ? await hashPassword(pw) : null },
  });
  console.log(`✓ Super Admin ${email} ${pw ? "(password set)" : "(sign in with Google; MFA enrolment is forced on first login)"}`);
}

async function demo() {
  if (process.env.NODE_ENV === "production") throw new Error("SEED_DEMO refused in production");
  const std = await db.planVersion.findFirstOrThrow({ where: { plan: { code: "standard" }, interval: "MONTHLY", version: 1 } });
  const day = 864e5;
  const schools = [
    { slug: "sman1nusantara", name: "SMA Negeri 1 Nusantara", type: "SMA", status: "ACTIVE" as const, admin: "admin@sman1nusantara.sch.id", pw: "demo-sekolah-2026" },
    { slug: "smpharapan", name: "SMP Aktif Harapan", type: "SMP", status: "PROVISIONING" as const, admin: "admin@smpharapan.sch.id", pw: null },
  ];
  for (const s of schools) {
    const t = await db.tenant.upsert({ where: { slug: s.slug }, update: {}, create: { slug: s.slug, name: s.name, type: s.type, status: s.status, enableEn: s.slug === "sman1nusantara" } });
    await db.user.upsert({ where: { email: s.admin }, update: {}, create: { email: s.admin, name: `Admin ${s.name}`, role: "SCHOOL_ADMIN", tenantId: t.id, passwordHash: s.pw ? await hashPassword(s.pw) : null } });
    await db.subscription.upsert({ where: { tenantId: t.id }, update: {}, create: { tenantId: t.id, planVersionId: std.id, status: s.status === "ACTIVE" ? "ACTIVE" : "PENDING", periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * day) } });
    await db.domain.upsert({ where: { hostname: `${s.slug}.websekolah.id` }, update: {}, create: { tenantId: t.id, hostname: `${s.slug}.websekolah.id`, kind: "SUBDOMAIN", status: "ACTIVE", primary: true } });
    if (!s.pw) {
      const token = randomBytes(32).toString("base64url");
      await db.invitation.deleteMany({ where: { tenantId: t.id, usedAt: null } });
      await db.invitation.create({ data: { tenantId: t.id, email: s.admin, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + day) } });
      console.log(`✓ Invitation for ${s.admin}: ${process.env.APP_URL ?? "http://localhost:3000"}/invite/${token}`);
    } else console.log(`✓ Demo admin ${s.admin} / ${s.pw}`);
  }
}

(async () => {
  await reference();
  console.log("✓ Reference data (plans, themes, flags)");
  await superAdmin();
  if (process.env.SEED_DEMO === "1") await demo();
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
