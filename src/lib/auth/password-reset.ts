import { platformClient } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashToken, newToken, sha256Hex } from "@/lib/security/tokens";
import { enqueue } from "@/lib/jobs";
import { consume } from "@/lib/security/ratelimit";
import { hashPassword, passwordPolicyError } from "@/lib/security/password";
import { revokeAllSessions } from "@/lib/auth/session";

export const RESET_TTL_MINUTES = 30; // PRD §10

/** Returns a raw token to e-mail, or null when no eligible account exists (callers must respond identically either way). */
export async function createPasswordReset(emailRaw: string): Promise<{ token: string } | null> {
  const email = emailRaw.trim().toLowerCase();
  const db = platformClient();
  const user = await db.user.findFirst({ where: { email, active: true, NOT: { passwordHash: null } }, select: { id: true, tenantId: true } });
  if (!user) return null;
  const token = newToken();
  await db.$transaction([
    db.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } }),
    db.passwordReset.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000) } }),
  ]);
  await audit({ tenantId: user.tenantId, actorId: user.id, actorEmail: email, action: "password.reset_requested", resource: `user:${user.id}` });
  return { token };
}

export async function consumePasswordReset(rawToken: string, newPassword: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = platformClient();
  const rows = await db.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM password_resets WHERE token_hash = ${hashToken(rawToken)} AND used_at IS NULL AND expires_at > now()`;
  const row = rows[0];
  if (!row) return { ok: false, error: "Tautan reset tidak valid atau kedaluwarsa" };
  const user = await db.user.findUnique({ where: { id: row.user_id }, select: { id: true, email: true, tenantId: true, active: true } });
  if (!user?.active) return { ok: false, error: "Tautan reset tidak valid atau kedaluwarsa" };
  const policy = passwordPolicyError(newPassword, { email: user.email });
  if (policy) return { ok: false, error: policy };
  const pwHash = await hashPassword(newPassword);
  const used = await db.$executeRaw`UPDATE password_resets SET used_at = now() WHERE token_hash = ${hashToken(rawToken)} AND used_at IS NULL AND expires_at > now()`;
  if (Number(used) !== 1) return { ok: false, error: "Tautan reset tidak valid atau kedaluwarsa" };
  await db.user.update({ where: { id: user.id }, data: { passwordHash: pwHash, version: { increment: 1 } } });
  await revokeAllSessions(user.id); // a reset logs the account out everywhere
  await audit({ tenantId: user.tenantId, actorId: user.id, actorEmail: user.email, action: "password.reset_completed", resource: `user:${user.id}` });
  return { ok: true };
}

/**
 * Self-service "forgot password": always responds the same way (no account enumeration), rate-limited per IP and per e-mail,
 * and the e-mail is queued durably — the raw token only ever exists inside the sealed job payload.
 */
export async function requestPasswordReset(emailRaw: string, ip: string): Promise<void> {
  const email = emailRaw.trim().toLowerCase().slice(0, 254);
  const a = await consume(`reset:ip:${ip}`, 10, 3600), b = await consume(`reset:email:${sha256Hex(email)}`, 3, 3600);
  if (!a.allowed || !b.allowed) return; // silently drop: caller shows the same neutral message
  const r = await createPasswordReset(email);
  if (r) await enqueue(platformClient(), { type: "email.password_reset", payload: { to: email }, secret: { token: r.token }, dedupeKey: `reset:${hashToken(r.token)}` });
}
