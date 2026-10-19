import { z } from "zod";
import { withTenant } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { assertCan, ForbiddenError } from "@/lib/auth/rbac";
import type { Actor } from "@/lib/actor";
import { TenantUnavailableError, ValidationError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs";

/** School-level settings the admin may change: language (all plans) and Google Analytics. Column grants in the DB limit this to the same fields. */
const tenantIdOf = (a: Actor): string => {
  const p = a.principal; const id = p.kind === "school_admin" || p.kind === "impersonation" ? p.tenantId : null;
  if (!id) throw new ForbiddenError("content.read"); return id;
};

const schema = z.object({
  enableEn: z.boolean(),
  defaultLang: z.enum(["id", "en"]),
  showLangSwitcher: z.boolean(),
  gaEnabled: z.boolean(),
  gaMeasurementId: z.string().trim().toUpperCase().regex(/^G-[A-Z0-9]{6,12}$/, "Format ID pengukuran: G-XXXXXXXXXX").or(z.literal("")),
  gaRequireConsent: z.boolean(),
  gaSkipAdmins: z.boolean(),
});
export type SettingsInput = z.input<typeof schema>;

export async function getSettings(actor: Actor) {
  const tenantId = tenantIdOf(actor); assertCan(actor.principal, "content.read", { tenantId });
  return withTenant(tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, slug: true, enableEn: true, defaultLang: true, showLangSwitcher: true, gaEnabled: true, gaMeasurementId: true, gaRequireConsent: true, gaSkipAdmins: true } }));
}

export async function saveSettings(actor: Actor, raw: SettingsInput) {
  const tenantId = tenantIdOf(actor); assertCan(actor.principal, "content.write", { tenantId });
  const p = schema.safeParse(raw);
  if (!p.success) throw new ValidationError(Object.fromEntries(p.error.issues.map((i) => [String(i.path[0] ?? "_"), i.message])));
  const v = p.data; const errs: Record<string, string> = {};
  if (v.defaultLang === "en" && !v.enableEn) errs.defaultLang = "Bahasa awal Inggris memerlukan konten bahasa Inggris diaktifkan";
  if (v.gaEnabled && !v.gaMeasurementId) errs.gaMeasurementId = "Isi ID pengukuran untuk mengaktifkan Google Analytics";
  if (Object.keys(errs).length) throw new ValidationError(errs);
  await withTenant(tenantId, async (tx) => {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true, deletedAt: true } });
    if (!t || t.deletedAt || t.status === "SUSPENDED") throw new TenantUnavailableError();
    await tx.tenant.update({ where: { id: tenantId }, data: { enableEn: v.enableEn, defaultLang: v.defaultLang, showLangSwitcher: v.showLangSwitcher, gaEnabled: v.gaEnabled, gaMeasurementId: v.gaMeasurementId || null, gaRequireConsent: v.gaRequireConsent, gaSkipAdmins: v.gaSkipAdmins } });
    await writeAudit(tx, { tenantId, actorId: actor.userId, actorEmail: actor.email, action: "settings.update", resource: `tenant:${tenantId}`, reason: `lang=${v.defaultLang}${v.enableEn ? "+en" : ""} ga=${v.gaEnabled ? v.gaMeasurementId : "off"}`, ip: actor.ip });
    await enqueue(tx, { type: "cache.invalidate", tenantId, payload: { what: "settings" }, dedupeKey: `cache:${tenantId}:settings:${Math.floor(Date.now() / 5000)}` });
  });
}

/** The school's own audit trail (RLS limits it to this school). */
export async function listSchoolAudit(actor: Actor, page = 1) {
  const tenantId = tenantIdOf(actor); assertCan(actor.principal, "content.read", { tenantId });
  const take = 30, p = Math.max(1, page);
  return withTenant(tenantId, async (tx) => {
    const [total, rows] = await Promise.all([tx.auditLog.count(), tx.auditLog.findMany({ orderBy: { createdAt: "desc" }, skip: (p - 1) * take, take, select: { id: true, createdAt: true, actorEmail: true, action: true, resource: true, result: true, reason: true } })]);
    return { rows, total, page: p, pages: Math.max(1, Math.ceil(total / take)) };
  });
}
