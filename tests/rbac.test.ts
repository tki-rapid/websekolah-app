import { describe, expect, it } from "vitest";
import { assertCan, can, ForbiddenError, IMPERSONATION_FORBIDDEN, type Capability, type Principal } from "@/lib/auth/rbac";

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";
const visitor: Principal = { kind: "visitor" };
const admin: Principal = { kind: "school_admin", userId: "u1", tenantId: T1 };
const superOk: Principal = { kind: "super_admin", userId: "s1", mfaVerified: true };
const superNoMfa: Principal = { kind: "super_admin", userId: "s1", mfaVerified: false };
const impRead: Principal = { kind: "impersonation", actorId: "s1", tenantId: T1, mode: "READ" };
const impWrite: Principal = { kind: "impersonation", actorId: "s1", tenantId: T1, mode: "WRITE" };

// PRD §10 matrix: [capability, visitor, school admin, super admin, impersonation(read), impersonation(write)]
const MATRIX: [Capability, boolean, boolean, boolean, boolean, boolean][] = [
  ["public.read",            true,  true,  true,  true,  true],
  ["content.read",           false, true,  false, true,  true],
  ["content.write",          false, true,  false, false, true],
  ["publish",                false, true,  false, false, true],
  ["theme.change",           false, true,  false, false, true],
  ["analytics.tenant",       false, true,  false, true,  true],
  ["analytics.platform",     false, false, true,  false, false],
  ["tenant.manage",          false, false, true,  false, false],
  ["tenant.delete",          false, false, true,  false, false],
  ["billing.view_own",       false, true,  false, false, false],
  ["billing.manage",         false, false, true,  false, false],
  ["domain.request",         false, true,  false, false, false],
  ["domain.activate",        false, false, true,  false, false],
  ["quota.manage",           false, false, true,  false, false],
  ["flags.manage",           false, false, true,  false, false],
  ["audit.read_platform",    false, false, true,  false, false],
  ["credentials.change_own", false, true,  true,  false, false],
  ["impersonate.start",      false, false, true,  false, false],
];

describe("RBAC matrix (PRD §10)", () => {
  it.each(MATRIX)("%s", (cap, v, a, s, ir, iw) => {
    expect({ visitor: can(visitor, cap), admin: can(admin, cap), super: can(superOk, cap), impRead: can(impRead, cap), impWrite: can(impWrite, cap) })
      .toEqual({ visitor: v, admin: a, super: s, impRead: ir, impWrite: iw });
  });
  it("a school admin's capabilities apply to their OWN school only", () => {
    expect(can(admin, "content.write", { tenantId: T1 })).toBe(true);
    expect(can(admin, "content.write", { tenantId: T2 })).toBe(false);
    expect(can(admin, "publish", { tenantId: T2 })).toBe(false);
  });
  it("impersonation is scoped to the target school", () => {
    expect(can(impWrite, "content.write", { tenantId: T1 })).toBe(true);
    expect(can(impWrite, "content.write", { tenantId: T2 })).toBe(false);
  });
  it("a Super Admin without verified MFA can do nothing beyond public reads", () => {
    for (const [cap] of MATRIX) expect(can(superNoMfa, cap), cap).toBe(cap === "public.read");
  });
  it("super admin has NO direct access to a school's private content (must go through impersonation)", () => {
    expect(can(superOk, "content.read")).toBe(false);
    expect(can(superOk, "content.write")).toBe(false);
  });
  it("forbidden-while-impersonating actions are denied in both modes (password, payment, admin, domain, delete)", () => {
    for (const cap of IMPERSONATION_FORBIDDEN) { expect(can(impRead, cap)).toBe(false); expect(can(impWrite, cap)).toBe(false); }
  });
  it("assertCan throws ForbiddenError", () => {
    expect(() => assertCan(visitor, "content.write")).toThrow(ForbiddenError);
    expect(() => assertCan(admin, "content.write", { tenantId: T1 })).not.toThrow();
  });
});
