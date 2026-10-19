import * as OTPAuth from "otpauth";
import { platformClient } from "@/lib/db";
import { audit } from "@/lib/audit";
import { openSecret, sealSecret } from "@/lib/security/crypto";
import { consume } from "@/lib/security/ratelimit";
import { markMfaVerified } from "@/lib/auth/session";

const ISSUER = "WebSekolah";
const mk = (secretB32: string, label: string) =>
  new OTPAuth.TOTP({ issuer: ISSUER, label, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secretB32) });

/** Step number (30 s counter) of an accepted code, or null if invalid. Tolerates ±1 step of clock drift. */
export function verifyTotpCode(secretB32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = mk(secretB32, "x").validate({ token: code, window: 1, timestamp: now });
  if (delta === null) return null;
  return Math.floor(now / 30_000) + delta;
}

/** Start enrolment: store the sealed secret (still disabled) and return the provisioning URI for the QR code. */
export async function beginEnrollment(userId: string, email: string) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  await platformClient().user.update({ where: { id: userId }, data: { totpSecretEnc: sealSecret(secret), totpEnabled: false, totpLastStep: null } });
  return { secret, otpauthUrl: mk(secret, email).toString() };
}

export async function confirmEnrollment(userId: string, sessionId: string, code: string): Promise<boolean> {
  const user = await platformClient().user.findUnique({ where: { id: userId }, select: { email: true, totpSecretEnc: true, totpEnabled: true } });
  if (!user?.totpSecretEnc || user.totpEnabled) return false;
  const step = verifyTotpCode(openSecret(user.totpSecretEnc), code);
  if (step === null) return false;
  await platformClient().user.update({ where: { id: userId }, data: { totpEnabled: true, totpLastStep: BigInt(step) } });
  await markMfaVerified(sessionId);
  await audit({ actorId: userId, actorEmail: user.email, action: "mfa.enrolled", resource: `user:${userId}` });
  return true;
}

/**
 * Verify a login MFA code. Rate-limited per user, and replay-protected: the same 30-second step can be
 * accepted only once (atomic UPDATE ... WHERE totp_last_step < step).
 */
export async function verifyLoginMfa(userId: string, sessionId: string, code: string, ip?: string): Promise<"ok" | "invalid" | "locked"> {
  const rl = await consume(`mfa:${userId}`, 6, 300);
  const db = platformClient();
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, totpSecretEnc: true, totpEnabled: true } });
  if (!rl.allowed) {
    await audit({ actorId: userId, actorEmail: user?.email ?? "unknown", action: "mfa.locked", resource: `user:${userId}`, result: "denied", ip });
    return "locked";
  }
  if (!user?.totpSecretEnc || !user.totpEnabled) return "invalid";
  const step = verifyTotpCode(openSecret(user.totpSecretEnc), code);
  let accepted = false;
  if (step !== null) {
    const n = await db.$executeRaw`UPDATE users SET totp_last_step = ${BigInt(step)} WHERE id = ${userId}::uuid AND (totp_last_step IS NULL OR totp_last_step < ${BigInt(step)})`;
    accepted = Number(n) === 1;
  }
  await audit({ actorId: userId, actorEmail: user.email, action: "mfa.verify", resource: `user:${userId}`, result: accepted ? "success" : "failure", ip });
  if (!accepted) return "invalid";
  await markMfaVerified(sessionId);
  return "ok";
}
