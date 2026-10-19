import { afterAll, describe, expect, it } from "vitest";
import { disconnectAll, platformClient } from "@/lib/db";
import { getSettings, listSchoolAudit, saveSettings } from "@/lib/services/settings";
import { ForbiddenError } from "@/lib/auth/rbac";
import { TenantUnavailableError, ValidationError } from "@/lib/errors";
import type { Actor } from "@/lib/actor";
import { makeAdmin, makeTenant } from "./helpers";

afterAll(disconnectAll);
const actorFor = async (suffix: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") => {
  const t = await makeTenant(suffix); const u = await makeAdmin(t.id);
  await platformClient().tenant.update({ where: { id: t.id }, data: { status } });
  return { t, a: { principal: { kind: "school_admin", userId: u.id, tenantId: t.id }, userId: u.id, email: u.email, tenantId: t.id } as Actor };
};
const base = { enableEn: true, defaultLang: "id" as const, showLangSwitcher: true, gaEnabled: false, gaMeasurementId: "", gaRequireConsent: true, gaSkipAdmins: true };

describe("school settings (language + Google Analytics)", () => {
  it("saves language and GA settings, normalises the measurement id, audits it", async () => {
    const { a, t } = await actorFor("set1");
    await saveSettings(a, { ...base, defaultLang: "en", gaEnabled: true, gaMeasurementId: " g-abc123xyz " });
    expect(await getSettings(a)).toMatchObject({ enableEn: true, defaultLang: "en", gaEnabled: true, gaMeasurementId: "G-ABC123XYZ" });
    const log = await listSchoolAudit(a); expect(log.rows[0]!.action).toBe("settings.update"); expect(log.rows.every((r) => r.action.length > 0)).toBe(true);
    expect(await platformClient().job.count({ where: { tenantId: t.id, type: "cache.invalidate" } })).toBe(1);
  });
  it("rejects invalid combinations", async () => {
    const { a } = await actorFor("set2");
    await expect(saveSettings(a, { ...base, enableEn: false, defaultLang: "en" })).rejects.toMatchObject({ fields: { defaultLang: expect.any(String) } });
    await expect(saveSettings(a, { ...base, gaEnabled: true, gaMeasurementId: "" })).rejects.toBeInstanceOf(ValidationError);
    for (const bad of ["UA-123456-1", "G-<script>", "G-1", "G-ABCDEFGHIJKLMNOP", "'; DROP TABLE tenants;--"]) await expect(saveSettings(a, { ...base, gaEnabled: true, gaMeasurementId: bad }), bad).rejects.toBeInstanceOf(ValidationError);
  });
  it("suspended schools cannot change settings; other roles cannot either", async () => {
    const { a } = await actorFor("set3", "SUSPENDED");
    await expect(saveSettings(a, base)).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(saveSettings({ ...a, principal: { kind: "visitor" } }, base)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("one school never sees or changes another school's settings or audit trail", async () => {
    const x = await actorFor("setx"), y = await actorFor("sety");
    await saveSettings(x.a, { ...base, gaEnabled: true, gaMeasurementId: "G-XXXXXXXXXX" });
    expect((await getSettings(y.a)).gaEnabled).toBe(false);
    expect((await listSchoolAudit(y.a)).rows.every((r) => r.actorEmail === y.a.email)).toBe(true);
  });
});
