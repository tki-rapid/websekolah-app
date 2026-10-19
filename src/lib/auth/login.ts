import { z } from "zod";
import { platformClient } from "@/lib/db";
import { audit } from "@/lib/audit";
import { consume, resetLimit } from "@/lib/security/ratelimit";
import { verifyPassword } from "@/lib/security/password";
import { sha256Hex } from "@/lib/security/tokens";
import { createSession, mfaRequired, type SessionUser } from "@/lib/auth/session";

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export type PasswordLoginResult =
  | { ok: true; token: string; expiresAt: Date; sessionId: string; user: SessionUser; mfa: "none" | "verify" | "enroll" }
  | { ok: false; error: "invalid" | "rate_limited"; retryAfterSec?: number };

const GENERIC = { ok: false, error: "invalid" } as const; // identical for wrong password / unknown user / inactive

/**
 * E-mail + password login. Brute-force controls: per-IP and per-account windows in PostgreSQL (shared across
 * instances); constant-work password check even for unknown users; one generic failure message; every attempt audited.
 */
export async function passwordLogin(o: { email: string; password: string; ip: string; userAgent?: string }): Promise<PasswordLoginResult> {
  const parsed = emailSchema.safeParse(o.email);
  const pw = o.password ?? "";
  const email = parsed.success ? parsed.data : "";
  const ipRl = await consume(`login:ip:${o.ip}`, 30, 900);
  const acctRl = await consume(`login:acct:${sha256Hex(email || "-")}`, 8, 900);
  if (!ipRl.allowed || !acctRl.allowed) {
    await audit({ actorEmail: email || "unknown", action: "auth.login", resource: "password", result: "denied", reason: "rate_limited", ip: o.ip });
    return { ok: false, error: "rate_limited", retryAfterSec: Math.max(ipRl.retryAfterSec, acctRl.retryAfterSec) };
  }
  if (!parsed.success || pw.length === 0 || pw.length > 256) {
    await verifyPassword(null, "x"); // keep timing uniform
    return GENERIC;
  }
  const db = platformClient();
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, tenantId: true, active: true, totpEnabled: true, passwordHash: true, tenant: { select: { deletedAt: true } } },
  });
  const ok = await verifyPassword(user?.passwordHash, pw);
  if (!user || !ok || !user.active || user.tenant?.deletedAt) {
    await audit({ tenantId: user?.tenantId ?? null, actorId: user?.id ?? null, actorEmail: email || "unknown", action: "auth.login", resource: "password", result: "failure", ip: o.ip });
    return GENERIC;
  }
  await resetLimit(`login:acct:${sha256Hex(email)}`);
  const { passwordHash: _ph, tenant: _t, ...u } = user;
  const sess = await createSession(u, { provider: "password", ip: o.ip, userAgent: o.userAgent });
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ tenantId: user.tenantId, actorId: user.id, actorEmail: email, action: "auth.login", resource: "password", ip: o.ip });
  const mfa = mfaRequired(u) ? (u.totpEnabled ? "verify" : "enroll") : "none";
  return { ok: true, token: sess.token, expiresAt: sess.expiresAt, sessionId: sess.sessionId, user: u, mfa };
}

/** Session creation for the Google path (identity already established by resolveGoogleLogin). */
export async function googleSession(user: SessionUser, o: { ip: string; userAgent?: string }) {
  const sess = await createSession(user, { provider: "google", ip: o.ip, userAgent: o.userAgent });
  await platformClient().user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ tenantId: user.tenantId, actorId: user.id, actorEmail: user.email, action: "auth.login", resource: "google", ip: o.ip });
  const mfa = mfaRequired(user) ? (user.totpEnabled ? "verify" : "enroll") : "none";
  return { ...sess, mfa } as const;
}
