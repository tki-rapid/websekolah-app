import { afterAll, describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import { disconnectAll, platformClient } from "@/lib/db";
import { createSession, hasRecentReauth, isFullyAuthenticated, markMfaVerified, markReauth, revokeAllSessions, revokeSession, validateSession, REAUTH_MAX_AGE_MS } from "@/lib/auth/session";
import { passwordLogin } from "@/lib/auth/login";
import { acceptInvitationWithPassword, createInvitation, peekInvitation } from "@/lib/auth/invitations";
import { consumePasswordReset, createPasswordReset } from "@/lib/auth/password-reset";
import { parseClaims, resolveGoogleLogin } from "@/lib/auth/google";
import { beginEnrollment, confirmEnrollment, verifyLoginMfa, verifyTotpCode } from "@/lib/auth/totp";
import { consume } from "@/lib/security/ratelimit";
import { hashToken } from "@/lib/security/tokens";
import { makeAdmin, makeSuper, makeTenant, rnd } from "./helpers";

afterAll(disconnectAll);
const db = () => platformClient();
const PW = "Sekolah-Aman-2026!x";
const ip = () => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

describe("sessions (revocable, hashed, expiring)", () => {
  it("stores only the hash of the token, and validates by raw token", async () => {
    const t = await makeTenant("s1"); const u = await makeAdmin(t.id);
    const { token, sessionId } = await createSession(u, { provider: "password" });
    const row = await db().session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toContain(token);
    expect((await validateSession(token))?.user.id).toBe(u.id);
    expect(await validateSession(token + "x")).toBeNull();
    expect(await validateSession("short")).toBeNull();
    expect(await validateSession(null)).toBeNull();
  });
  it("revocation takes effect immediately, for one session or all of a user's sessions", async () => {
    const t = await makeTenant("s2"); const u = await makeAdmin(t.id);
    const a = await createSession(u, { provider: "password" }), b = await createSession(u, { provider: "google" }), c = await createSession(u, { provider: "password" });
    await revokeSession(a.sessionId);
    expect(await validateSession(a.token)).toBeNull();
    expect(await validateSession(b.token)).not.toBeNull();
    await revokeAllSessions(u.id, c.sessionId);
    expect(await validateSession(b.token)).toBeNull();
    expect(await validateSession(c.token)).not.toBeNull();
  });
  it("replacing/deactivating the admin invalidates their sessions", async () => {
    const t = await makeTenant("s3"); const u = await makeAdmin(t.id);
    const s = await createSession(u, { provider: "password" });
    await db().user.update({ where: { id: u.id }, data: { active: false } });
    expect(await validateSession(s.token)).toBeNull();
  });
  it("enforces absolute and idle expiry", async () => {
    const t = await makeTenant("s4"); const u = await makeAdmin(t.id);
    const s1 = await createSession(u, { provider: "password" }); const s2 = await createSession(u, { provider: "password" });
    await db().session.update({ where: { id: s1.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await db().session.update({ where: { id: s2.sessionId }, data: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSession(s1.token)).toBeNull();
    expect(await validateSession(s2.token)).toBeNull();
  });
  it("super admin sessions are shorter than school admin sessions", async () => {
    const t = await makeTenant("s5"); const a = await makeAdmin(t.id); const s = await makeSuper();
    const sa = await createSession(a, { provider: "password" }), ss = await createSession(s, { provider: "password" });
    expect(ss.expiresAt.getTime()).toBeLessThan(sa.expiresAt.getTime());
  });
  it("super admin is not fully authenticated until MFA is verified; re-auth window is 10 minutes", async () => {
    const s = await makeSuper(); const { token, sessionId } = await createSession(s, { provider: "password" });
    let ctx = (await validateSession(token))!;
    expect(isFullyAuthenticated(ctx)).toBe(false);
    await markMfaVerified(sessionId);
    ctx = (await validateSession(token))!;
    expect(isFullyAuthenticated(ctx)).toBe(true);
    expect(hasRecentReauth(ctx.session)).toBe(true);
    expect(hasRecentReauth(ctx.session, Date.now() + REAUTH_MAX_AGE_MS + 5000)).toBe(false);
    await markReauth(sessionId);
  });
});

describe("password login (brute-force + enumeration resistance)", () => {
  it("succeeds with the right password and fails identically for wrong password / unknown user / inactive user", async () => {
    const t = await makeTenant("l1"); const u = await makeAdmin(t.id, { password: PW }); const off = await makeAdmin((await makeTenant("l1b")).id, { password: PW, active: false });
    const ok = await passwordLogin({ email: u.email, password: PW, ip: ip() });
    expect(ok.ok && ok.user.id).toBe(u.id);
    const bad = [
      await passwordLogin({ email: u.email, password: "salah-salah-salah", ip: ip() }),
      await passwordLogin({ email: `nobody-${rnd()}@x.test`, password: PW, ip: ip() }),
      await passwordLogin({ email: off.email, password: PW, ip: ip() }),
      await passwordLogin({ email: "bukan-email", password: PW, ip: ip() }),
    ];
    for (const r of bad) expect(r).toEqual({ ok: false, error: "invalid" });
  });
  it("a user without a password (invited, Google-only) cannot log in with a blank/any password", async () => {
    const t = await makeTenant("l2"); const u = await makeAdmin(t.id);
    expect(await passwordLogin({ email: u.email, password: "", ip: ip() })).toEqual({ ok: false, error: "invalid" });
    expect(await passwordLogin({ email: u.email, password: "apa-saja-1234567", ip: ip() })).toEqual({ ok: false, error: "invalid" });
  });
  it("locks an account after repeated failures, even with the correct password afterwards", async () => {
    const t = await makeTenant("l3"); const u = await makeAdmin(t.id, { password: PW });
    for (let i = 0; i < 8; i++) await passwordLogin({ email: u.email, password: "salah-" + i, ip: ip() });
    const locked = await passwordLogin({ email: u.email, password: PW, ip: ip() });
    expect(locked).toMatchObject({ ok: false, error: "rate_limited" });
    expect((locked as { retryAfterSec?: number }).retryAfterSec).toBeGreaterThan(0);
  });
  it("rate-limits one IP hammering many accounts", async () => {
    const addr = ip(); let limited = false;
    for (let i = 0; i < 35 && !limited; i++) {
      const r = await passwordLogin({ email: `victim${i}-${rnd()}@x.test`, password: "x".repeat(14), ip: addr });
      limited = !r.ok && r.error === "rate_limited";
    }
    expect(limited).toBe(true);
  });
  it("a successful login is audited, and a super admin is told MFA enrolment is required", async () => {
    const s = await makeSuper({ password: PW });
    const r = await passwordLogin({ email: s.email, password: PW, ip: ip() });
    expect(r.ok && r.mfa).toBe("enroll");
    const log = await db().auditLog.findFirst({ where: { actorId: s.id, action: "auth.login" } });
    expect(log?.result).toBe("success");
  });
  it("never writes the password or token into the audit log", async () => {
    const t = await makeTenant("l4"); const u = await makeAdmin(t.id, { password: PW });
    const r = await passwordLogin({ email: u.email, password: PW, ip: ip() });
    const rows = await db().auditLog.findMany({ where: { actorId: u.id } });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(PW);
    if (r.ok) expect(dump).not.toContain(r.token);
  });
});

describe("rate limiter", () => {
  it("counts within a window and reports retry-after", async () => {
    const key = `t:${rnd()}`;
    const r = [await consume(key, 2, 60), await consume(key, 2, 60), await consume(key, 2, 60)];
    expect(r.map((x) => x.allowed)).toEqual([true, true, false]);
    expect(r[2]!.retryAfterSec).toBeGreaterThan(0);
  });
  it("is atomic under concurrency (no lost updates)", async () => {
    const key = `c:${rnd()}`;
    const rs = await Promise.all(Array.from({ length: 20 }, () => consume(key, 5, 60)));
    expect(rs.filter((x) => x.allowed)).toHaveLength(5);
  });
});

describe("invitations (PRD §5.1: one-time, 24h, no self-registration)", () => {
  it("accept once; second use and tampered token fail; password policy enforced; session cookie material not stored", async () => {
    const t = await makeTenant("i1"); const u = await makeAdmin(t.id);
    const { token } = await createInvitation({ tenantId: t.id, email: u.email });
    const row = await db().invitation.findFirstOrThrow({ where: { tenantId: t.id } });
    expect(row.tokenHash).toBe(hashToken(token)); expect(JSON.stringify(row)).not.toContain(token);
    expect((await peekInvitation(token)).state).toBe("valid");
    expect(await acceptInvitationWithPassword(token, "pendek")).toMatchObject({ ok: false });
    expect((await peekInvitation(token)).state).toBe("valid"); // a rejected password must NOT burn the token
    const ok = await acceptInvitationWithPassword(token, PW);
    expect(ok.ok).toBe(true);
    expect((await peekInvitation(token)).state).toBe("used");
    expect(await acceptInvitationWithPassword(token, PW)).toMatchObject({ ok: false });
    expect((await peekInvitation(token + "x")).state).toBe("invalid");
    expect(await passwordLogin({ email: u.email, password: PW, ip: ip() })).toMatchObject({ ok: true });
  });
  it("expired invitations are refused, and re-sending revokes the old token", async () => {
    const t = await makeTenant("i2"); const u = await makeAdmin(t.id);
    const a = await createInvitation({ tenantId: t.id, email: u.email });
    await db().$executeRaw`UPDATE invitations SET expires_at = now() - interval '1 second', created_at = now() - interval '1 day' WHERE tenant_id = ${t.id}::uuid`;
    expect((await peekInvitation(a.token)).state).toBe("expired");
    expect(await acceptInvitationWithPassword(a.token, PW)).toMatchObject({ ok: false });
    const b = await createInvitation({ tenantId: t.id, email: u.email });
    expect((await peekInvitation(a.token)).state).toBe("invalid"); // old token revoked
    expect((await peekInvitation(b.token)).state).toBe("valid");
  });
  it("only one of two concurrent acceptances wins (atomic)", async () => {
    const t = await makeTenant("i3"); const u = await makeAdmin(t.id);
    const { token } = await createInvitation({ tenantId: t.id, email: u.email });
    const rs = await Promise.all([acceptInvitationWithPassword(token, PW), acceptInvitationWithPassword(token, PW + "2")]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });
  it("cannot hijack an already-active account with a fresh invitation to the same e-mail", async () => {
    const t = await makeTenant("i4"); const u = await makeAdmin(t.id, { password: PW });
    const { token } = await createInvitation({ tenantId: t.id, email: u.email });
    expect(await acceptInvitationWithPassword(token, "Password-Baru-2026!!")).toMatchObject({ ok: false });
    expect(await passwordLogin({ email: u.email, password: PW, ip: ip() })).toMatchObject({ ok: true }); // original password intact
  });
});

describe("password reset (single-use, 30 min, revokes sessions)", () => {
  it("resets the password, kills old sessions, cannot be reused, and reveals nothing for unknown e-mails", async () => {
    const t = await makeTenant("r1"); const u = await makeAdmin(t.id, { password: PW });
    const s = await createSession(u, { provider: "password" });
    expect(await createPasswordReset(`ghost-${rnd()}@x.test`)).toBeNull();
    const { token } = (await createPasswordReset(u.email))!;
    expect(await consumePasswordReset(token, "pendek")).toMatchObject({ ok: false });
    const NEW = "Kata-Sandi-Baru-9876!";
    expect(await consumePasswordReset(token, NEW)).toEqual({ ok: true });
    expect(await validateSession(s.token)).toBeNull();
    expect(await consumePasswordReset(token, NEW + "x")).toMatchObject({ ok: false });
    expect(await passwordLogin({ email: u.email, password: PW, ip: ip() })).toMatchObject({ ok: false });
    expect(await passwordLogin({ email: u.email, password: NEW, ip: ip() })).toMatchObject({ ok: true });
  });
  it("expires after 30 minutes", async () => {
    const t = await makeTenant("r2"); const u = await makeAdmin(t.id, { password: PW });
    const { token } = (await createPasswordReset(u.email))!;
    await db().$executeRaw`UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE token_hash = ${hashToken(token)}`;
    expect(await consumePasswordReset(token, "Kata-Sandi-Baru-9876!")).toMatchObject({ ok: false });
  });
});

describe("Login with Google (no self-registration; identity linked by stable sub)", () => {
  const claims = (email: string, sub = `g-${rnd()}`, verified = true) => ({ sub, email, email_verified: verified, name: "Nama" });

  it("rejects unverified e-mail and unregistered accounts", async () => {
    expect(await resolveGoogleLogin(claims("x@gmail.com", "s1", false))).toEqual({ ok: false, reason: "unverified_email" });
    expect(await resolveGoogleLogin(claims(`nobody-${rnd()}@gmail.com`))).toEqual({ ok: false, reason: "not_registered" });
    const log = await db().auditLog.findFirst({ where: { action: "auth.google", result: "denied" } });
    expect(log).not.toBeNull();
  });
  it("links the Google sub on first login of an activated user, then matches by sub", async () => {
    const t = await makeTenant("g1"); const u = await makeAdmin(t.id, { password: PW });
    const c = claims(u.email);
    const first = await resolveGoogleLogin(c);
    expect(first).toMatchObject({ ok: true, linked: true });
    expect((await db().user.findUniqueOrThrow({ where: { id: u.id } })).authSubject).toBe(c.sub);
    // later the user changes e-mail at Google: still the same person by `sub`
    expect(await resolveGoogleLogin({ ...c, email: "renamed@gmail.com" })).toMatchObject({ ok: true, linked: false });
  });
  it("refuses a DIFFERENT Google account claiming the same e-mail address (account takeover)", async () => {
    const t = await makeTenant("g2"); const u = await makeAdmin(t.id, { password: PW });
    await resolveGoogleLogin(claims(u.email, "sub-legit"));
    expect(await resolveGoogleLogin(claims(u.email, "sub-attacker"))).toEqual({ ok: false, reason: "subject_mismatch" });
  });
  it("an un-activated admin can only activate with a valid invitation (consumed atomically)", async () => {
    const t = await makeTenant("g3"); const u = await makeAdmin(t.id);
    expect(await resolveGoogleLogin(claims(u.email))).toEqual({ ok: false, reason: "invitation_expired" }); // no invitation at all
    await createInvitation({ tenantId: t.id, email: u.email });
    const r = await resolveGoogleLogin(claims(u.email));
    expect(r).toMatchObject({ ok: true, acceptedInvitation: true });
    expect((await db().invitation.findFirstOrThrow({ where: { tenantId: t.id } })).usedAt).not.toBeNull();
  });
  it("rejects inactive users and soft-deleted schools", async () => {
    const t = await makeTenant("g4"); const off = await makeAdmin(t.id, { password: PW, active: false });
    expect(await resolveGoogleLogin(claims(off.email))).toEqual({ ok: false, reason: "inactive" });
    const t2 = await makeTenant("g5"); const u2 = await makeAdmin(t2.id, { password: PW });
    await db().tenant.update({ where: { id: t2.id }, data: { deletedAt: new Date() } });
    expect(await resolveGoogleLogin(claims(u2.email))).toEqual({ ok: false, reason: "tenant_unavailable" });
  });
  it("validates ID-token claims: issuer, audience and shape", () => {
    const base = { sub: "1", email: "a@b.co", email_verified: true };
    expect(parseClaims({ ...base, iss: "https://accounts.google.com", aud: "cid" }, "cid")).not.toBeNull();
    expect(parseClaims({ ...base, iss: "https://evil.example", aud: "cid" }, "cid")).toBeNull();
    expect(parseClaims({ ...base, iss: "https://accounts.google.com", aud: "other" }, "cid")).toBeNull();
    expect(parseClaims({ ...base, email: "not-an-email" })).toBeNull();
    expect(parseClaims({ sub: "1" })).toBeNull();
  });
});

describe("TOTP MFA (mandatory for Super Admin)", () => {
  const code = (secret: string, t = Date.now()) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({ timestamp: t });

  it("enrols, stores the seed ENCRYPTED, and verifies codes", async () => {
    const s = await makeSuper({ password: PW }); const { sessionId } = await createSession(s, { provider: "password" });
    const e = await beginEnrollment(s.id, s.email);
    expect(e.otpauthUrl).toContain("otpauth://totp/");
    const stored = (await db().user.findUniqueOrThrow({ where: { id: s.id } })).totpSecretEnc!;
    expect(stored.startsWith("v1.")).toBe(true); expect(stored).not.toContain(e.secret);
    expect(await confirmEnrollment(s.id, sessionId, "000000")).toBe(false);
    expect(await confirmEnrollment(s.id, sessionId, code(e.secret))).toBe(true);
    expect((await db().user.findUniqueOrThrow({ where: { id: s.id } })).totpEnabled).toBe(true);
  });
  it("rejects wrong codes, accepts drift of one step, and blocks REPLAY of the same code", async () => {
    const s = await makeSuper(); const login = await createSession(s, { provider: "password" });
    const e = await beginEnrollment(s.id, s.email);
    const now = Date.now();
    await db().user.update({ where: { id: s.id }, data: { totpEnabled: true } });
    expect(await verifyLoginMfa(s.id, login.sessionId, "123456")).toBe("invalid");
    const prev = code(e.secret, now - 30_000); // previous step — within tolerance
    expect(verifyTotpCode(e.secret, prev, now)).not.toBeNull();
    expect(verifyTotpCode(e.secret, code(e.secret, now - 90_000), now)).toBeNull(); // too old
    const c = code(e.secret, now);
    expect(await verifyLoginMfa(s.id, login.sessionId, c)).toBe("ok");
    const second = await createSession(s, { provider: "password" });
    expect(await verifyLoginMfa(s.id, second.sessionId, c)).toBe("invalid"); // replay of a used code
  });
  it("locks MFA verification after too many wrong codes", async () => {
    const s = await makeSuper(); const login = await createSession(s, { provider: "password" });
    await beginEnrollment(s.id, s.email); await db().user.update({ where: { id: s.id }, data: { totpEnabled: true } });
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await verifyLoginMfa(s.id, login.sessionId, "000000"));
    expect(results).toContain("locked");
  });
  it("totp seed in the database is not the plaintext secret (AES-GCM envelope)", async () => {
    const s = await makeSuper(); const e = await beginEnrollment(s.id, s.email);
    const raw = await db().$queryRaw<{ v: string }[]>`SELECT totp_secret_enc AS v FROM users WHERE id = ${s.id}::uuid`;
    expect(raw[0]!.v).not.toContain(e.secret);
  });
});
