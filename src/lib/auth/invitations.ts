import { platformClient } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashToken, newToken } from "@/lib/security/tokens";
import { hashPassword, passwordPolicyError } from "@/lib/security/password";

export const INVITATION_TTL_HOURS = 24; // PRD §5.1: one-time, valid 24h

/** Create (or re-send) an invitation. Any earlier unused token for the same school+email is revoked. */
export async function createInvitation(o: { tenantId: string; email: string; createdById?: string; ttlHours?: number }) {
  const email = o.email.trim().toLowerCase();
  const token = newToken();
  const db = platformClient();
  const ttl = Math.min(o.ttlHours ?? INVITATION_TTL_HOURS, 24 * 7);
  await db.$transaction(async (tx) => {
    await tx.invitation.deleteMany({ where: { tenantId: o.tenantId, email, usedAt: null } });
    await tx.invitation.create({
      data: { tenantId: o.tenantId, email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttl * 3_600_000), createdById: o.createdById ?? null },
    });
  });
  return { token }; // raw token is returned ONCE to be e-mailed; it is never stored
}

export type InvitationView =
  | { state: "valid"; email: string; schoolName: string; expiresAt: Date }
  | { state: "used" | "expired" | "invalid" };

export async function peekInvitation(rawToken: string): Promise<InvitationView> {
  if (!rawToken || rawToken.length > 200) return { state: "invalid" };
  const inv = await platformClient().invitation.findUnique({ where: { tokenHash: hashToken(rawToken) }, include: { tenant: { select: { name: true, deletedAt: true } } } });
  if (!inv || inv.tenant.deletedAt) return { state: "invalid" };
  if (inv.usedAt) return { state: "used" };
  if (inv.expiresAt.getTime() <= Date.now()) return { state: "expired" };
  return { state: "valid", email: inv.email, schoolName: inv.tenant.name, expiresAt: inv.expiresAt };
}

/** Atomically consume an invitation (single UPDATE ... RETURNING: two concurrent attempts cannot both win). */
export async function consumeInvitationByHash(tokenHash: string): Promise<{ tenantId: string; email: string } | null> {
  const rows = await platformClient().$queryRaw<{ tenant_id: string; email: string }[]>`
    UPDATE invitations SET used_at = now() WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > now()
    RETURNING tenant_id, email`;
  return rows[0] ? { tenantId: rows[0].tenant_id, email: rows[0].email } : null;
}

export type AcceptResult = { ok: true; userId: string; tenantId: string } | { ok: false; error: string };

/** Accept an invitation by choosing a password. Rolls back the consumption if the account cannot be activated. */
export async function acceptInvitationWithPassword(rawToken: string, password: string): Promise<AcceptResult> {
  const hash = hashToken(rawToken);
  const pre = await peekInvitation(rawToken);
  if (pre.state !== "valid") return { ok: false, error: "Undangan tidak valid atau sudah kedaluwarsa" };
  const policy = passwordPolicyError(password, { email: pre.email });
  if (policy) return { ok: false, error: policy };
  const pwHash = await hashPassword(password);
  const db = platformClient();
  try {
    const result = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ tenant_id: string; email: string }[]>`
        UPDATE invitations SET used_at = now() WHERE token_hash = ${hash} AND used_at IS NULL AND expires_at > now() RETURNING tenant_id, email`;
      const inv = rows[0];
      if (!inv) return null;
      const user = await tx.user.findFirst({ where: { email: inv.email, tenantId: inv.tenant_id, active: true, passwordHash: null, authSubject: null }, select: { id: true } });
      if (!user) throw new Error("account-not-pending");
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: pwHash, version: { increment: 1 } } });
      return { userId: user.id, tenantId: inv.tenant_id as string, email: inv.email };
    });
    if (!result) return { ok: false, error: "Undangan tidak valid atau sudah kedaluwarsa" };
    await audit({ tenantId: result.tenantId, actorId: result.userId, actorEmail: result.email, action: "invitation.accepted", resource: `user:${result.userId}` });
    return { ok: true, userId: result.userId, tenantId: result.tenantId };
  } catch {
    return { ok: false, error: "Akun tidak dapat diaktifkan dengan undangan ini" };
  }
}
