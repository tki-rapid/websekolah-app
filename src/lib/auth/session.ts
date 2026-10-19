import { platformClient } from "@/lib/db";
import { env } from "@/lib/env";
import { hashToken, hmacHex, newToken } from "@/lib/security/tokens";
import type { Role } from "@/generated/prisma/client";

/**
 * Server-side sessions (PRD §10, TEN02): an opaque 256-bit token in an HttpOnly cookie; only its SHA-256 is
 * stored. Unlike stateless JWTs a session can be revoked instantly — replacing a school admin or changing a
 * password kills every old session. Sessions have an absolute lifetime AND a sliding idle timeout.
 */
const MIN = 60_000, HOUR = 60 * MIN;
export const SESSION_POLICY: Record<Role, { absoluteMs: number; idleMs: number }> = {
  SCHOOL_ADMIN: { absoluteMs: 12 * HOUR, idleMs: 2 * HOUR },
  SUPER_ADMIN: { absoluteMs: 8 * HOUR, idleMs: 30 * MIN },
};
export const REAUTH_MAX_AGE_MS = 10 * MIN; // PRD §10: sensitive actions need re-auth within 10 minutes
const TOUCH_EVERY_MS = 60_000;

export type SessionUser = {
  id: string; email: string; name: string; role: Role; tenantId: string | null; active: boolean; totpEnabled: boolean;
};
export type SessionRecord = {
  id: string; userId: string; provider: string; expiresAt: Date; idleExpiresAt: Date;
  mfaVerifiedAt: Date | null; reauthAt: Date | null; createdAt: Date;
};
export type SessionContext = { session: SessionRecord; user: SessionUser };

export async function createSession(
  user: { id: string; role: Role },
  o: { provider: "password" | "google"; ip?: string; userAgent?: string; mfaVerified?: boolean },
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = newToken();
  const now = Date.now();
  const policy = SESSION_POLICY[user.role];
  const s = await platformClient().session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      provider: o.provider,
      expiresAt: new Date(now + policy.absoluteMs),
      idleExpiresAt: new Date(now + policy.idleMs),
      mfaVerifiedAt: o.mfaVerified ? new Date(now) : null,
      reauthAt: new Date(now), // a fresh login counts as authentication for the re-auth window
      ipHash: o.ip ? hmacHex(env().APP_SECRET, o.ip) : null,
      userAgent: o.userAgent?.slice(0, 300) ?? null,
    },
    select: { id: true, expiresAt: true },
  });
  return { token, expiresAt: s.expiresAt, sessionId: s.id };
}

const userSelect = { id: true, email: true, name: true, role: true, tenantId: true, active: true, totpEnabled: true } as const;

/** Returns the session+user if the token is valid, unexpired, unrevoked and the user is still active. */
export async function validateSession(rawToken: string | undefined | null): Promise<SessionContext | null> {
  if (!rawToken || rawToken.length < 20 || rawToken.length > 200) return null;
  const db = platformClient();
  const row = await db.session.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { id: true, userId: true, provider: true, expiresAt: true, idleExpiresAt: true, lastSeenAt: true, mfaVerifiedAt: true, reauthAt: true, revokedAt: true, createdAt: true, user: { select: userSelect } },
  });
  if (!row || row.revokedAt) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() <= now || row.idleExpiresAt.getTime() <= now) return null;
  if (!row.user.active) return null;
  if (now - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    const idle = new Date(Math.min(now + SESSION_POLICY[row.user.role].idleMs, row.expiresAt.getTime()));
    await db.session.update({ where: { id: row.id }, data: { lastSeenAt: new Date(now), idleExpiresAt: idle } });
  }
  const { user, ...session } = row;
  return { session, user };
}

export const revokeSession = (sessionId: string) =>
  platformClient().session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });

/** Kill every session of a user (admin replaced, password changed/reset, account deactivated). */
export const revokeAllSessions = (userId: string, exceptSessionId?: string) =>
  platformClient().session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });

export const markMfaVerified = (sessionId: string) =>
  platformClient().session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: new Date(), reauthAt: new Date() } });

export const markReauth = (sessionId: string) =>
  platformClient().session.update({ where: { id: sessionId }, data: { reauthAt: new Date() } });

export const hasRecentReauth = (s: Pick<SessionRecord, "reauthAt">, now = Date.now()) =>
  !!s.reauthAt && now - s.reauthAt.getTime() <= REAUTH_MAX_AGE_MS;

/** MFA is mandatory for Super Admin and for anyone who enrolled TOTP. */
export const mfaRequired = (u: Pick<SessionUser, "role" | "totpEnabled">) => u.role === "SUPER_ADMIN" || u.totpEnabled;
export const isFullyAuthenticated = (ctx: SessionContext) => !mfaRequired(ctx.user) || ctx.session.mfaVerifiedAt != null;
