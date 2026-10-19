import "server-only";
import { withTenant } from "@/lib/db";

/** Data-access layer for tenant-scoped reads. Every query runs inside withTenant(), i.e. under RLS. */
export async function getTenantOverview(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, type: true, status: true, timezone: true, enableEn: true, defaultLang: true, gaEnabled: true },
    });
    const [subscription, drafts, published, pages, media] = await Promise.all([
      tx.subscription.findFirst({ select: { status: true, periodEnd: true, graceUntil: true } }),
      tx.contentItem.count({ where: { publishedAt: null, deletedAt: null } }),
      tx.contentItem.count({ where: { publishedAt: { not: null }, deletedAt: null } }),
      tx.page.count(),
      tx.mediaAsset.count(),
    ]);
    return { tenant, subscription, counts: { drafts, published, pages, media } };
  });
}
