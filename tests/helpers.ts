import { randomBytes } from "node:crypto";
import { platformClient, withTenant } from "@/lib/db";
import { hashPassword } from "@/lib/security/password";

export const rnd = () => randomBytes(4).toString("hex");

export async function makeTenant(label = "sekolah") {
  const db = platformClient();
  const slug = `${label}-${rnd()}`;
  const tenant = await db.tenant.create({ data: { name: `SMA ${slug}`, slug, type: "SMA", status: "ACTIVE" } });
  return tenant;
}

export async function makeAdmin(tenantId: string, o: { password?: string; email?: string; active?: boolean } = {}) {
  const email = o.email ?? `admin-${rnd()}@sekolah.test`;
  return platformClient().user.create({
    data: { tenantId, email, name: "Admin Uji", role: "SCHOOL_ADMIN", active: o.active ?? true, passwordHash: o.password ? await hashPassword(o.password) : null },
  });
}

export async function makeSuper(o: { password?: string; email?: string } = {}) {
  const email = o.email ?? `super-${rnd()}@platform.test`;
  return platformClient().user.create({
    data: { tenantId: null, email, name: "Operator Uji", role: "SUPER_ADMIN", passwordHash: o.password ? await hashPassword(o.password) : null },
  });
}

export async function addNews(tenantId: string, slug: string, title = "Judul") {
  return withTenant(tenantId, (tx) =>
    tx.contentItem.create({ data: { tenantId, type: "news", slug, draftPayload: { title }, publishedPayload: { title }, publishedAt: new Date() } }),
  );
}

export async function makeSubscription(tenantId: string, storageMB = 100, status: "ACTIVE" | "PENDING" = "ACTIVE") {
  const db = platformClient();
  const plan = await db.plan.create({ data: { code: `plan-${rnd()}`, name: "Uji" } });
  const pv = await db.planVersion.create({ data: { planId: plan.id, version: 1, interval: "MONTHLY", amount: 100000, quotas: { storageMB, pages: 20 }, features: { gallery: true, ppdb: true } } });
  return db.subscription.create({ data: { tenantId, planVersionId: pv.id, status, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 864e5) } });
}
