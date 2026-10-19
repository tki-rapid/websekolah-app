/**
 * RBAC matrix from PRD §10. Enforced on the SERVER for every operation (hiding a button is not security).
 * Principals: visitor (anonymous), SCHOOL_ADMIN, SUPER_ADMIN, and a SUPER_ADMIN acting through an
 * impersonation session (read by default; write only when explicitly granted; a hard deny-list always applies).
 */
export type Capability =
  | "public.read"
  | "content.read" | "content.write" | "publish" | "theme.change"
  | "analytics.tenant"
  | "tenant.manage" | "tenant.delete"
  | "billing.view_own" | "billing.manage"
  | "domain.request" | "domain.activate" | "quota.manage" | "flags.manage"
  | "audit.read_platform" | "analytics.platform"
  | "credentials.change_own" | "impersonate.start";

export type Principal =
  | { kind: "visitor" }
  | { kind: "school_admin"; userId: string; tenantId: string }
  | { kind: "super_admin"; userId: string; mfaVerified: boolean }
  | { kind: "impersonation"; actorId: string; tenantId: string; mode: "READ" | "WRITE" };

const SCHOOL_ADMIN: ReadonlySet<Capability> = new Set([
  "public.read", "content.read", "content.write", "publish", "theme.change", "analytics.tenant",
  "billing.view_own", "domain.request", "credentials.change_own",
]);
const SUPER_ADMIN: ReadonlySet<Capability> = new Set([
  "public.read", "tenant.manage", "tenant.delete", "billing.manage", "domain.activate", "quota.manage", "flags.manage",
  "audit.read_platform", "analytics.platform", "impersonate.start", "credentials.change_own",
]);
const IMPERSONATION_READ: ReadonlySet<Capability> = new Set(["public.read", "content.read", "analytics.tenant"]);
const IMPERSONATION_WRITE: ReadonlySet<Capability> = new Set([...IMPERSONATION_READ, "content.write", "publish", "theme.change"]);
/** Never allowed during impersonation, whatever the mode (PRD §5.6). */
export const IMPERSONATION_FORBIDDEN: ReadonlySet<Capability> = new Set([
  "credentials.change_own", "billing.manage", "billing.view_own", "tenant.manage", "tenant.delete", "domain.request", "domain.activate",
]);

export function can(p: Principal, cap: Capability, target?: { tenantId?: string }): boolean {
  switch (p.kind) {
    case "visitor":
      return cap === "public.read";
    case "school_admin": {
      if (!SCHOOL_ADMIN.has(cap)) return false;
      // tenant-scoped capabilities only ever apply to the admin's OWN school
      return target?.tenantId === undefined || target.tenantId === p.tenantId;
    }
    case "super_admin":
      // Super Admin without a verified MFA session can do nothing but read public pages (PRD §10).
      if (!p.mfaVerified) return cap === "public.read";
      return SUPER_ADMIN.has(cap);
    case "impersonation": {
      if (IMPERSONATION_FORBIDDEN.has(cap)) return false;
      const set = p.mode === "WRITE" ? IMPERSONATION_WRITE : IMPERSONATION_READ;
      return set.has(cap) && (target?.tenantId === undefined || target.tenantId === p.tenantId);
    }
  }
}

export class ForbiddenError extends Error {
  constructor(public readonly capability: Capability) {
    super(`forbidden: ${capability}`);
  }
}
export function assertCan(p: Principal, cap: Capability, target?: { tenantId?: string }): void {
  if (!can(p, cap, target)) throw new ForbiddenError(cap);
}
