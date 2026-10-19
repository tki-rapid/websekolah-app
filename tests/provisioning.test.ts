import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectAll, platformClient } from "@/lib/db";
import { activateTenant, createTenant, getTenantDetail, listTenants, replaceAdmin, restoreTenant, resendInvitation, softDeleteTenant, suspendTenant } from "@/lib/services/provisioning";
import { acceptInvitationWithPassword, peekInvitation } from "@/lib/auth/invitations";
import { createSession, validateSession } from "@/lib/auth/session";
import { passwordLogin } from "@/lib/auth/login";
import { requestPasswordReset, consumePasswordReset } from "@/lib/auth/password-reset";
import { runDueJobs, registerHandler, enqueue } from "@/lib/jobs";
import { bootJobs } from "@/lib/jobs-boot";
import { setMailSender, type Mail } from "@/lib/mail/mailer";
import { ForbiddenError } from "@/lib/auth/rbac";
import { NotFoundError, ReauthRequiredError, ValidationError } from "@/lib/errors";
import type { Actor } from "@/lib/actor";
import { makeAdmin, makeSuper, makeTenant, rnd } from "./helpers";

afterAll(async () => { setMailSender(undefined); await disconnectAll(); });
const db = () => platformClient();
const PW = "Kata-Sandi-Panjang-2026!";
let sup: Actor, supNoReauth: Actor, outbox: Mail[];

beforeAll(async () => {
  const theme = await db().theme.upsert({ where: { key: "umum-klasik" }, update: {}, create: { key: "umum-klasik", name: "Umum Klasik" } });
  await db().themeVersion.upsert({ where: { themeId_version: { themeId: theme.id, version: 1 } }, update: {}, create: { themeId: theme.id, version: 1, schema: {}, allowedVariants: {} } });
  const plan = await db().plan.upsert({ where: { code: "standard" }, update: {}, create: { code: "standard", name: "Standard" } });
  for (const interval of ["MONTHLY", "YEARLY"] as const)
    await db().planVersion.upsert({ where: { planId_version_interval: { planId: plan.id, version: 1, interval } }, update: {}, create: { planId: plan.id, version: 1, interval, amount: interval === "MONTHLY" ? 199000 : 1990000, quotas: { storageMB: 2048, pages: 20 }, features: {} } });
  const s = await makeSuper();
  const base = { principal: { kind: "super_admin" as const, userId: s.id, mfaVerified: true }, userId: s.id, email: s.email, tenantId: null };
  sup = { ...base, reauthOk: true }; supNoReauth = { ...base, reauthOk: false };
});
beforeEach(() => { outbox = []; setMailSender(async (m) => { outbox.push(m); }); bootJobs(); });

const input = (o: Record<string, unknown> = {}) => ({ name: "SMA Uji Coba", slug: `uji-${rnd()}`, type: "SMA", planCode: "standard", interval: "MONTHLY", adminName: "Budi", adminEmail: `budi-${rnd()}@sekolah.test`, ...o }) as never;
const key = () => `idem-${rnd()}-${rnd()}-${rnd()}`;

describe("create tenant (TEN01, AC01)", () => {
  it("creates tenant + admin + subscription + theme + subdomain + home page + draft invoice + invitation, atomically", async () => {
    const i = input(); const { tenantId, duplicate } = await createTenant(sup, i, key());
    expect(duplicate).toBe(false);
    const d = await getTenantDetail(sup, tenantId);
    expect(d.tenant.status).toBe("PROVISIONING"); expect(d.tenant.subscription?.status).toBe("PENDING");
    expect(d.tenant.domains.map((x) => x.hostname)).toEqual([`${(i as { slug: string }).slug}.websekolah.id`]);
    expect(d.admin?.activated).toBe(false);
    expect(await db().page.count({ where: { tenantId, isHome: true } })).toBe(1);
    expect(await db().tenantTheme.count({ where: { tenantId } })).toBe(1);
    const inv = await db().invoice.findFirstOrThrow({ where: { tenantId } }); expect(inv.status).toBe("DRAFT"); expect(inv.number).toMatch(/^INV-\d{4}-\d{4}$/); expect(inv.amount).toBe(199000);
    expect(d.audit[0]!.action).toBe("tenant.create");
  });
  it("is idempotent: the same key never creates a second tenant, invoice, or invitation (AC01)", async () => {
    const k = key(); const i = input();
    const a = await createTenant(sup, i, k), b = await createTenant(sup, i, k), c = await createTenant(sup, input({ slug: "lain-lagi" + rnd() }), k);
    expect(b).toEqual({ tenantId: a.tenantId, duplicate: true }); expect(c.tenantId).toBe(a.tenantId); // even with different input the key wins
    expect(await db().tenant.count({ where: { slug: (i as { slug: string }).slug } })).toBe(1);
    expect(await db().invoice.count({ where: { tenantId: a.tenantId } })).toBe(1);
    expect(await db().invitation.count({ where: { tenantId: a.tenantId } })).toBe(1);
  });
  it("two concurrent identical requests create exactly one tenant", async () => {
    const k = key(); const i = input();
    const rs = await Promise.allSettled([createTenant(sup, i, k), createTenant(sup, i, k)]);
    expect(await db().tenant.count({ where: { slug: (i as { slug: string }).slug } })).toBe(1);
    expect(rs.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  });
  it("a failed provisioning leaves nothing behind and the same key can be retried", async () => {
    const k = key(); const taken = await makeTenant("dupslug");
    await expect(createTenant(sup, input({ slug: taken.slug }), k)).rejects.toBeInstanceOf(ValidationError);
    expect(await db().idempotencyKey.count({ where: { key: k } })).toBe(0);
    const ok = await createTenant(sup, input(), k); expect(ok.duplicate).toBe(false);
  });
  it("rejects reserved/invalid slugs, unknown plans, duplicate admin e-mails and bad keys", async () => {
    for (const slug of ["admin", "api", "www", "Bad Slug", "ab", "-x-", "x".repeat(41)]) await expect(createTenant(sup, input({ slug }), key()), slug).rejects.toBeInstanceOf(ValidationError);
    await expect(createTenant(sup, input({ planCode: "nope" }), key())).rejects.toBeInstanceOf(ValidationError);
    const existing = await makeAdmin((await makeTenant("em")).id);
    await expect(createTenant(sup, input({ adminEmail: existing.email }), key())).rejects.toBeInstanceOf(ValidationError);
    await expect(createTenant(sup, input(), "short")).rejects.toBeInstanceOf(ValidationError);
  });
  it("is refused for anyone who is not an MFA-verified Super Admin (AC01)", async () => {
    const t = await makeTenant("na"); const admin = await makeAdmin(t.id);
    const schoolAdmin: Actor = { principal: { kind: "school_admin", userId: admin.id, tenantId: t.id }, userId: admin.id, email: admin.email, tenantId: t.id };
    const noMfa: Actor = { ...sup, principal: { kind: "super_admin", userId: sup.userId, mfaVerified: false } };
    const visitor: Actor = { ...sup, principal: { kind: "visitor" } };
    const before = await db().tenant.count();
    for (const a of [schoolAdmin, noMfa, visitor]) await expect(createTenant(a, input(), key())).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db().tenant.count()).toBe(before); expect(await db().job.count({ where: { type: "email.invitation", tenantId: null } })).toBe(0);
  });
});

describe("invitation e-mail (PRD §5.1)", () => {
  it("the e-mail is queued durably; the raw token exists only encrypted in the job and is wiped after sending", async () => {
    const { tenantId } = await createTenant(sup, input(), key());
    const job = await db().job.findFirstOrThrow({ where: { tenantId, type: "email.invitation" } });
    const raw = JSON.stringify(job.payload);
    expect(raw).toContain("enc"); expect(raw).not.toMatch(/\/invite\//);
    const r = await runDueJobs(50); expect(r.done).toBeGreaterThan(0);
    const mail = outbox.find((m) => m.subject.includes("Undangan"))!; expect(mail).toBeTruthy();
    const link = mail.text.match(/https?:\/\/\S+\/invite\/(\S+)/)!; expect(link[1]!.length).toBeGreaterThan(30);
    expect((await db().job.findUniqueOrThrow({ where: { id: job.id } })).payload).toEqual({}); // token wiped from the DB
    expect(await peekInvitation(link[1]!)).toMatchObject({ state: "valid" });
    expect(mail.html).not.toContain("<script"); expect(mail.to).toMatch(/@sekolah\.test$/);
  });
  it("the invited admin activates with the e-mailed link, can log in, and the link is single-use", async () => {
    const i = input(); const { tenantId } = await createTenant(sup, i, key()); await runDueJobs(50);
    const token = outbox.at(-1)!.text.match(/\/invite\/(\S+)/)![1]!;
    expect(await acceptInvitationWithPassword(token, PW)).toMatchObject({ ok: true });
    expect(await acceptInvitationWithPassword(token, PW)).toMatchObject({ ok: false });
    expect(await passwordLogin({ email: (i as { adminEmail: string }).adminEmail, password: PW, ip: `10.9.${Math.floor(Math.random() * 250)}.1` })).toMatchObject({ ok: true });
    expect((await getTenantDetail(sup, tenantId)).admin?.activated).toBe(true);
  });
  it("resend revokes the old link and queues a new e-mail; refuses once the admin is active", async () => {
    const { tenantId } = await createTenant(sup, input(), key()); await runDueJobs(50);
    const old = outbox.at(-1)!.text.match(/\/invite\/(\S+)/)![1]!;
    await resendInvitation(sup, tenantId); await runDueJobs(50);
    const fresh = outbox.at(-1)!.text.match(/\/invite\/(\S+)/)![1]!;
    expect(fresh).not.toBe(old); expect((await peekInvitation(old)).state).toBe("invalid"); expect((await peekInvitation(fresh)).state).toBe("valid");
    await acceptInvitationWithPassword(fresh, PW);
    await expect(resendInvitation(sup, tenantId)).rejects.toMatchObject({ code: "already_active" });
  });
});

describe("lifecycle: activate / suspend / delete / restore / replace admin", () => {
  it("activation turns the pending subscription on; suspend & delete need re-authentication within 10 minutes", async () => {
    const { tenantId } = await createTenant(sup, input(), key());
    await activateTenant(sup, tenantId);
    let d = await getTenantDetail(sup, tenantId); expect(d.tenant.status).toBe("ACTIVE"); expect(d.tenant.subscription?.status).toBe("ACTIVE");
    await expect(suspendTenant(supNoReauth, tenantId, "tunggakan")).rejects.toBeInstanceOf(ReauthRequiredError);
    await expect(softDeleteTenant(supNoReauth, tenantId, d.tenant.slug)).rejects.toBeInstanceOf(ReauthRequiredError);
    await expect(replaceAdmin(supNoReauth, tenantId, { name: "X", email: `x-${rnd()}@s.test` })).rejects.toBeInstanceOf(ReauthRequiredError);
    await expect(suspendTenant(sup, tenantId, "")).rejects.toBeInstanceOf(ValidationError);
    await suspendTenant(sup, tenantId, "Tunggakan melewati masa tenggang");
    d = await getTenantDetail(sup, tenantId); expect(d.tenant.status).toBe("SUSPENDED"); expect(d.tenant.suspendReason).toMatch(/Tunggakan/);
    expect(d.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["tenant.suspend", "tenant.activate", "tenant.create"]));
    await activateTenant(sup, tenantId); expect((await getTenantDetail(sup, tenantId)).tenant.status).toBe("ACTIVE");
  });
  it("soft delete requires the slug as confirmation, hides the school, kills admin sessions; restore brings everything back but custom domains must be re-verified (AC14)", async () => {
    const { tenantId } = await createTenant(sup, input(), key()); const d0 = await getTenantDetail(sup, tenantId);
    const admin = await db().user.findFirstOrThrow({ where: { tenantId } }); const s = await createSession(admin, { provider: "password" });
    await db().domain.create({ data: { tenantId, hostname: `www.${rnd()}.sch.id`, kind: "CUSTOM", status: "ACTIVE", primary: false, verifiedAt: new Date(), tlsState: "valid" } });
    await expect(softDeleteTenant(sup, tenantId, "salah-slug")).rejects.toBeInstanceOf(ValidationError);
    await softDeleteTenant(sup, tenantId, d0.tenant.slug);
    expect((await listTenants(sup, { q: d0.tenant.slug })).rows).toHaveLength(0);
    expect((await listTenants(sup, { trash: true, q: d0.tenant.slug })).rows).toHaveLength(1);
    expect(await validateSession(s.token)).toBeNull();
    await expect(restoreTenant(sup, tenantId)).resolves.toBeUndefined();
    const d = await getTenantDetail(sup, tenantId);
    expect(d.tenant.deletedAt).toBeNull(); expect(d.tenant.status).toBe("SUSPENDED"); // must be re-activated deliberately
    expect(d.tenant.domains.find((x) => x.kind === "CUSTOM")?.status).toBe("AWAITING_DNS");
    expect(d.tenant.domains.find((x) => x.kind === "SUBDOMAIN")?.status).toBe("ACTIVE");
    expect(await db().page.count({ where: { tenantId } })).toBe(1); // content & relations intact
    await db().tenant.update({ where: { id: tenantId }, data: { deletedAt: new Date(Date.now() - 31 * 864e5) } });
    await expect(restoreTenant(sup, tenantId)).rejects.toMatchObject({ code: "restore_expired" });
  });
  it("replacing the admin deactivates the old account, revokes ALL its sessions, and invites the new one (TEN02)", async () => {
    const i = input(); const { tenantId } = await createTenant(sup, i, key()); await runDueJobs(50);
    await acceptInvitationWithPassword(outbox.at(-1)!.text.match(/\/invite\/(\S+)/)![1]!, PW);
    const old = await db().user.findFirstOrThrow({ where: { tenantId, active: true } });
    const s1 = await createSession(old, { provider: "password" }), s2 = await createSession(old, { provider: "google" });
    const newEmail = `baru-${rnd()}@sekolah.test`;
    await expect(replaceAdmin(sup, tenantId, { name: "Admin Baru", email: old.email })).rejects.toBeInstanceOf(ValidationError); // e-mail already taken
    await replaceAdmin(sup, tenantId, { name: "Admin Baru", email: newEmail }); await runDueJobs(50);
    expect(await validateSession(s1.token)).toBeNull(); expect(await validateSession(s2.token)).toBeNull();
    expect(await db().user.count({ where: { tenantId, role: "SCHOOL_ADMIN", active: true } })).toBe(1); // DB-enforced single active admin
    expect((await getTenantDetail(sup, tenantId)).admin?.email).toBe(newEmail);
    expect(outbox.at(-1)!.to).toBe(newEmail);
    expect(await passwordLogin({ email: old.email, password: PW, ip: `10.8.${Math.floor(Math.random() * 250)}.1` })).toMatchObject({ ok: false });
  });
  it("unknown tenants are 404, not an information leak", async () => {
    await expect(getTenantDetail(sup, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
    await expect(activateTenant(sup, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("forgot password via e-mail", () => {
  it("sends a reset e-mail for real accounts only, with identical behaviour for unknown e-mails; token is single-use", async () => {
    const t = await makeTenant("fp"); const u = await makeAdmin(t.id, { password: PW }); const ip = `10.7.${Math.floor(Math.random() * 250)}.9`;
    await requestPasswordReset(`ghost-${rnd()}@sekolah.test`, ip); await requestPasswordReset(u.email, ip); await runDueJobs(50);
    expect(outbox.filter((m) => m.subject.includes("kata sandi"))).toHaveLength(1);
    const token = outbox.at(-1)!.text.match(/\/reset\/(\S+)/)![1]!;
    expect(await consumePasswordReset(token, "Kata-Sandi-Yang-Baru-77!")).toEqual({ ok: true });
    expect(await consumePasswordReset(token, "Kata-Sandi-Yang-Baru-88!")).toMatchObject({ ok: false });
  });
  it("is rate-limited per e-mail address", async () => {
    const t = await makeTenant("fp2"); const u = await makeAdmin(t.id, { password: PW });
    for (let i = 0; i < 6; i++) await requestPasswordReset(u.email, `10.6.${i}.1`);
    await runDueJobs(50);
    expect(outbox.filter((m) => m.to === u.email).length).toBeLessThanOrEqual(3);
  });
});

describe("durable job queue (PRD §11/§13)", () => {
  it("dedupes by key, retries with backoff, and dead-letters after 5 attempts", async () => {
    let calls = 0; registerHandler("test.flaky", async () => { calls++; throw new Error("boom"); });
    const dk = `flaky-${rnd()}`;
    await enqueue(db(), { type: "test.flaky", dedupeKey: dk }); await enqueue(db(), { type: "test.flaky", dedupeKey: dk });
    expect(await db().job.count({ where: { dedupeKey: dk } })).toBe(1);
    for (let n = 1; n <= 5; n++) {
      await db().$executeRaw`UPDATE jobs SET available_at = now() - interval '1 second' WHERE dedupe_key = ${dk} AND state = 'RETRY'`;
      await runDueJobs(50);
      const j = await db().job.findUniqueOrThrow({ where: { dedupeKey: dk } });
      expect(j.attempts).toBe(n); expect(j.state).toBe(n < 5 ? "RETRY" : "DEAD"); expect(j.lastError).toContain("boom");
      if (n < 5) expect(j.availableAt.getTime()).toBeGreaterThan(Date.now()); // backoff
    }
    expect(calls).toBe(5);
    await runDueJobs(50); expect(calls).toBe(5); // dead jobs are not retried
  });
  it("two workers never run the same job twice (SKIP LOCKED)", async () => {
    let calls = 0; registerHandler("test.once", async () => { calls++; await new Promise((r) => setTimeout(r, 50)); });
    await enqueue(db(), { type: "test.once", dedupeKey: `once-${rnd()}` });
    await Promise.all([runDueJobs(10), runDueJobs(10), runDueJobs(10)]);
    expect(calls).toBe(1);
  });
  it("a job whose worker crashed (stale RUNNING) is picked up again", async () => {
    let calls = 0; registerHandler("test.stale", async () => { calls++; });
    const dk = `stale-${rnd()}`; await enqueue(db(), { type: "test.stale", dedupeKey: dk });
    await db().$executeRaw`UPDATE jobs SET state = 'RUNNING', locked_at = now() - interval '10 minutes', attempts = 1 WHERE dedupe_key = ${dk}`;
    await runDueJobs(10); expect(calls).toBe(1);
  });
});
