import "server-only";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/cookies";
import { hasRecentReauth, isFullyAuthenticated, type SessionContext } from "@/lib/auth/session";
import type { Principal } from "@/lib/auth/rbac";

export function principalOf(ctx: SessionContext): Principal {
  if (ctx.user.role === "SUPER_ADMIN") return { kind: "super_admin", userId: ctx.user.id, mfaVerified: isFullyAuthenticated(ctx) };
  if (!ctx.user.tenantId) throw new Error("school admin without tenant"); // impossible by DB constraint
  return { kind: "school_admin", userId: ctx.user.id, tenantId: ctx.user.tenantId };
}

/** Pages/actions for a school's CMS. The tenant id ALWAYS comes from the session, never from the URL or form. */
export async function requireSchoolAdmin() {
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  if (!isFullyAuthenticated(ctx)) redirect("/login/mfa");
  if (ctx.user.role !== "SCHOOL_ADMIN" || !ctx.user.tenantId) redirect("/login?error=forbidden");
  return { ctx, user: ctx.user, tenantId: ctx.user.tenantId, principal: principalOf(ctx) };
}

export async function requireSuperAdmin() {
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  if (ctx.user.role !== "SUPER_ADMIN") redirect("/login?error=forbidden");
  if (!isFullyAuthenticated(ctx)) redirect("/login/mfa");
  return { ctx, user: ctx.user, principal: principalOf(ctx) };
}

/** For sensitive operations: authentication must have happened within the last 10 minutes (PRD §10). */
export function needsReauth(ctx: SessionContext): boolean {
  return !hasRecentReauth(ctx.session);
}
