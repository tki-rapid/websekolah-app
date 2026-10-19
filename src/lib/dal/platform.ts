import "server-only";
import { platformClient } from "@/lib/db";
import { assertCan, type Principal } from "@/lib/auth/rbac";

/** Cross-tenant reads for the Super Admin console. Every function re-checks the capability (defence in depth). */
export async function listTenants(p: Principal) {
  assertCan(p, "tenant.manage");
  return platformClient().tenant.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, name: true, slug: true, type: true, status: true, createdAt: true, subscription: { select: { status: true } } },
  });
}

export async function recentAudit(p: Principal, limit = 20) {
  assertCan(p, "audit.read_platform");
  return platformClient().auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 100),
    select: { id: true, createdAt: true, actorEmail: true, action: true, resource: true, result: true },
  });
}
