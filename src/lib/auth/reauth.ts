import { platformClient } from "@/lib/db";
import { audit } from "@/lib/audit";
import { consume } from "@/lib/security/ratelimit";
import { verifyPassword } from "@/lib/security/password";
import { verifyLoginMfa } from "@/lib/auth/totp";
import { markReauth } from "@/lib/auth/session";

export type ReauthResult = "ok" | "invalid" | "locked";

/**
 * Step-up authentication for sensitive operations (PRD §10): accounts with MFA must present a fresh TOTP code
 * (a code already used for login cannot be replayed — wait for the next one); other accounts present their password.
 */
export async function reauthenticate(o: { userId: string; sessionId: string; code?: string; password?: string; ip?: string }): Promise<ReauthResult> {
  const db = platformClient();
  const user = await db.user.findUnique({ where: { id: o.userId }, select: { email: true, tenantId: true, totpEnabled: true, passwordHash: true } });
  if (!user) return "invalid";
  let result: ReauthResult;
  if (user.totpEnabled) {
    result = await verifyLoginMfa(o.userId, o.sessionId, (o.code ?? "").replace(/\s/g, ""), o.ip); // also bumps reauth_at via markMfaVerified
  } else {
    const rl = await consume(`reauth:${o.userId}`, 6, 300);
    if (!rl.allowed) result = "locked";
    else result = (await verifyPassword(user.passwordHash, (o.password ?? "").slice(0, 256))) ? "ok" : "invalid";
    if (result === "ok") await markReauth(o.sessionId);
  }
  await audit({ tenantId: user.tenantId, actorId: o.userId, actorEmail: user.email, action: "auth.reauth", resource: `user:${o.userId}`, result: result === "ok" ? "success" : result === "locked" ? "denied" : "failure", ip: o.ip });
  return result;
}
