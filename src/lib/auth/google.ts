import { Google, decodeIdToken, generateCodeVerifier, generateState } from "arctic";
import { z } from "zod";
import { platformClient } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { hashToken } from "@/lib/security/tokens";
import type { SessionUser } from "@/lib/auth/session";

/**
 * "Login with Google" (OpenID Connect, authorization-code + PKCE + state).
 *
 * Policy — Google proves WHO someone is; it never grants access by itself:
 *  - No self-registration (PRD §5.1): the e-mail must already belong to a provisioned, active user.
 *  - Only `email_verified` Google identities are accepted.
 *  - First login links the stable Google `sub` to the user; afterwards identity is matched by `sub`
 *    (e-mail changes at Google cannot hijack an account) and a different `sub` for the same user is refused.
 *  - A school admin who has not yet accepted the invitation can activate via Google only while the
 *    invitation is valid (atomically consumed) — same 24h/one-time rule as the password path.
 *  - Super Admin still needs TOTP MFA after Google (enforced by the session layer).
 */
export const googleConfigured = () => !!(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET);
export const googleRedirectUri = () => new URL("/api/auth/google/callback", env().APP_URL).toString();

export function googleClient(): Google {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env();
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("Google login is not configured");
  return new Google(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, googleRedirectUri());
}

export function startGoogleAuth() {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = googleClient().createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
  url.searchParams.set("prompt", "select_account");
  return { url, state, codeVerifier };
}

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().email().max(254),
  email_verified: z.boolean(),
  name: z.string().max(200).optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  iss: z.string().optional(),
});
export type GoogleClaims = z.infer<typeof claimsSchema>;

/** Validate the (already signature-verified by arctic's token exchange) ID-token claims. */
export function parseClaims(raw: unknown, expectedAud?: string): GoogleClaims | null {
  const p = claimsSchema.safeParse(raw);
  if (!p.success) return null;
  const c = p.data;
  if (c.iss && !["https://accounts.google.com", "accounts.google.com"].includes(c.iss)) return null;
  if (expectedAud && c.aud) {
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!auds.includes(expectedAud)) return null;
  }
  return c;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<GoogleClaims | null> {
  const tokens = await googleClient().validateAuthorizationCode(code, codeVerifier);
  return parseClaims(decodeIdToken(tokens.idToken()), env().GOOGLE_CLIENT_ID);
}

export type GoogleLoginResult =
  | { ok: true; user: SessionUser; linked: boolean; acceptedInvitation: boolean }
  | { ok: false; reason: "unverified_email" | "not_registered" | "inactive" | "subject_mismatch" | "invitation_expired" | "tenant_unavailable" };

const userSelect = { id: true, email: true, name: true, role: true, tenantId: true, active: true, totpEnabled: true, passwordHash: true, authSubject: true, tenant: { select: { deletedAt: true } } } as const;

export async function resolveGoogleLogin(claims: GoogleClaims, ctx: { ip?: string } = {}): Promise<GoogleLoginResult> {
  const db = platformClient();
  const email = claims.email.trim().toLowerCase();
  const fail = async (reason: Extract<GoogleLoginResult, { ok: false }>["reason"], userId?: string, tenantId?: string | null): Promise<GoogleLoginResult> => {
    await audit({ tenantId: tenantId ?? null, actorId: userId ?? null, actorEmail: email, action: "auth.google", resource: "google", result: "denied", reason, ip: ctx.ip });
    return { ok: false, reason };
  };
  if (!claims.email_verified) return fail("unverified_email");

  const strip = <T extends { passwordHash: string | null; authSubject: string | null; tenant: unknown }>({ passwordHash: _p, authSubject: _a, tenant: _t, ...u }: T) => u;

  const bySub = await db.user.findUnique({ where: { authSubject: claims.sub }, select: userSelect });
  if (bySub) {
    if (!bySub.active) return fail("inactive", bySub.id, bySub.tenantId);
    if (bySub.tenant?.deletedAt) return fail("tenant_unavailable", bySub.id, bySub.tenantId);
    return { ok: true, user: strip(bySub) as SessionUser, linked: false, acceptedInvitation: false };
  }

  const byEmail = await db.user.findUnique({ where: { email }, select: userSelect });
  if (!byEmail) return fail("not_registered");
  if (!byEmail.active) return fail("inactive", byEmail.id, byEmail.tenantId);
  if (byEmail.tenant?.deletedAt) return fail("tenant_unavailable", byEmail.id, byEmail.tenantId);
  if (byEmail.authSubject && byEmail.authSubject !== claims.sub) return fail("subject_mismatch", byEmail.id, byEmail.tenantId);

  let acceptedInvitation = false;
  const pending = !byEmail.passwordHash && !byEmail.authSubject && byEmail.role === "SCHOOL_ADMIN";
  if (pending) {
    // Not yet activated: only a valid, unused invitation for this very e-mail may activate it.
    const inv = await db.$queryRaw<{ id: string }[]>`
      UPDATE invitations SET used_at = now()
       WHERE id = (SELECT id FROM invitations WHERE tenant_id = ${byEmail.tenantId}::uuid AND email = ${email} AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1)
         AND used_at IS NULL
      RETURNING id`;
    if (!inv[0]) return fail("invitation_expired", byEmail.id, byEmail.tenantId);
    acceptedInvitation = true;
  }
  await db.user.update({ where: { id: byEmail.id }, data: { authSubject: claims.sub, version: { increment: 1 } } });
  await audit({ tenantId: byEmail.tenantId, actorId: byEmail.id, actorEmail: email, action: acceptedInvitation ? "invitation.accepted_google" : "auth.google_linked", resource: `user:${byEmail.id}`, ip: ctx.ip });
  return { ok: true, user: strip(byEmail) as SessionUser, linked: true, acceptedInvitation };
}

export { hashToken as _hashTokenForTests };
