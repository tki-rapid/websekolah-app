"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { env } from "@/lib/env";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { requestMeta } from "@/lib/auth/cookies";
import { assertSameOrigin, OriginError, uuidParam } from "@/lib/security/request";
import { AppError, ReauthRequiredError, ValidationError } from "@/lib/errors";
import { activateTenant, createTenant, replaceAdmin, resendInvitation, restoreTenant, softDeleteTenant, suspendTenant } from "@/lib/services/provisioning";

export type SuperState = { error?: string; fields?: Record<string, string>; ok?: string };

async function context() {
  const meta = await requestMeta();
  try { assertSameOrigin(meta.headers, env().APP_URL); } catch (e) { if (e instanceof OriginError) redirect("/login?error=origin"); throw e; }
  const s = await requireSuperAdmin(); // the session — never the form — decides who is acting
  return { actor: actorOf(s.ctx, meta.ip) };
}
const text = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function createTenantAction(_p: SuperState, form: FormData): Promise<SuperState> {
  const { actor } = await context();
  let id: string;
  try {
    const r = await createTenant(actor, { name: text(form, "name"), slug: text(form, "slug"), type: text(form, "type") as never, planCode: text(form, "plan").split(":")[0] ?? "", interval: (text(form, "plan").split(":")[1] ?? "") as never, adminName: text(form, "adminName"), adminEmail: text(form, "adminEmail") }, text(form, "idem"));
    id = r.tenantId;
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message, fields: e.fields };
    if (e instanceof ReauthRequiredError) redirect("/reauth?next=/super/tenants/new");
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/super/tenants");
  redirect(`/super/tenants/${id}?created=1`);
}

const OPS = ["activate", "suspend", "delete", "restore", "resend", "replace"] as const;

/** One action for every lifecycle button; the operation name is validated against a fixed list. */
export async function tenantOpAction(_p: SuperState, form: FormData): Promise<SuperState> {
  const { actor } = await context();
  const id = uuidParam(text(form, "tenantId")); const op = text(form, "op") as (typeof OPS)[number];
  if (!id || !OPS.includes(op)) return { error: "Permintaan tidak valid" };
  try {
    if (op === "activate") await activateTenant(actor, id);
    else if (op === "suspend") await suspendTenant(actor, id, text(form, "reason"));
    else if (op === "delete") await softDeleteTenant(actor, id, text(form, "confirmSlug"));
    else if (op === "restore") await restoreTenant(actor, id);
    else if (op === "resend") await resendInvitation(actor, id);
    else await replaceAdmin(actor, id, { name: text(form, "name"), email: text(form, "email") });
  } catch (e) {
    if (e instanceof ReauthRequiredError) redirect(`/reauth?next=/super/tenants/${id}`);
    if (e instanceof ValidationError) return { error: Object.values(e.fields)[0] ?? e.message, fields: e.fields };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/super/tenants/${id}`); revalidatePath("/super/tenants");
  return { ok: { activate: "Sekolah diaktifkan.", suspend: "Sekolah ditangguhkan.", delete: "Sekolah dihapus (dapat dipulihkan 30 hari).", restore: "Sekolah dipulihkan (status: ditangguhkan, aktifkan ulang bila siap).", resend: "Undangan baru dikirim; tautan lama tidak berlaku.", replace: "Admin diganti; sesi admin lama dicabut dan undangan dikirim." }[op] };
}
