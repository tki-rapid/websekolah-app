"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { env } from "@/lib/env";
import { requireSchoolAdmin } from "@/lib/auth/guards";
import { actorOf } from "@/lib/auth/actor";
import { requestMeta } from "@/lib/auth/cookies";
import { assertSameOrigin, OriginError, uuidParam } from "@/lib/security/request";
import { AppError, ConflictError, ValidationError } from "@/lib/errors";
import { ForbiddenError } from "@/lib/auth/rbac";
import { deleteContent, reorderContent, saveContent, setPublication } from "@/lib/services/content";
import { saveSettings, type SettingsInput } from "@/lib/services/settings";

export type SaveResult =
  | { ok: true; id: string; version: number; status: string; slug: string; message: string }
  | { ok: false; error: string; fields?: Record<string, string>; conflict?: { currentVersion: number } };

async function context() {
  const meta = await requestMeta();
  try { assertSameOrigin(meta.headers, env().APP_URL); } catch (e) { if (e instanceof OriginError) redirect("/login?error=origin"); throw e; }
  const s = await requireSchoolAdmin(); // tenant comes from the session; no action takes a tenant id
  return actorOf(s.ctx, meta.ip);
}

function fail(e: unknown): SaveResult {
  if (e instanceof ConflictError) return { ok: false, error: e.message, conflict: { currentVersion: e.currentVersion } };
  if (e instanceof ValidationError) return { ok: false, error: e.message, fields: e.fields };
  if (e instanceof ForbiddenError) return { ok: false, error: "Anda tidak memiliki izin untuk aksi ini" };
  if (e instanceof AppError) return { ok: false, error: e.message };
  throw e;
}

type SaveArgs = { type: string; id: string | null; payload: unknown; slug?: string; mode: "draft" | "publish"; expectedVersion?: number };

export async function saveContentAction(a: SaveArgs): Promise<SaveResult> {
  const actor = await context();
  if (typeof a !== "object" || a === null || typeof a.type !== "string" || (a.mode !== "draft" && a.mode !== "publish")) return { ok: false, error: "Permintaan tidak valid" };
  try {
    const r = await saveContent(actor, { type: a.type, id: a.id ? uuidParam(a.id) : null, payload: a.payload, slug: typeof a.slug === "string" ? a.slug : undefined, mode: a.mode, expectedVersion: typeof a.expectedVersion === "number" ? a.expectedVersion : undefined });
    revalidatePath(`/cms/${a.type}`);
    return { ok: true, id: r.id, version: r.version, status: r.status, slug: r.slug, message: a.mode === "publish" ? "Diterbitkan." : "Draft tersimpan." };
  } catch (e) { return fail(e); }
}

export async function publicationAction(a: { id: string; version: number; publish: boolean }): Promise<SaveResult> {
  const actor = await context(); const id = uuidParam(a?.id);
  if (!id || typeof a.version !== "number") return { ok: false, error: "Permintaan tidak valid" };
  try {
    const r = await setPublication(actor, id, a.version, !!a.publish);
    revalidatePath(`/cms/${r.type}`);
    return { ok: true, id: r.id, version: r.version, status: r.status, slug: r.slug, message: a.publish ? "Diterbitkan." : "Ditarik kembali ke draft." };
  } catch (e) { return fail(e); }
}

export async function deleteContentAction(a: { id: string; type: string }): Promise<SaveResult> {
  const actor = await context(); const id = uuidParam(a?.id);
  if (!id) return { ok: false, error: "Permintaan tidak valid" };
  try { await deleteContent(actor, id); revalidatePath(`/cms/${a.type}`); return { ok: true, id, version: 0, status: "deleted", slug: "", message: "Dihapus." }; } catch (e) { return fail(e); }
}

export async function reorderAction(a: { type: string; ids: string[] }): Promise<SaveResult> {
  const actor = await context();
  if (!Array.isArray(a?.ids) || a.ids.length > 500) return { ok: false, error: "Permintaan tidak valid" };
  try { await reorderContent(actor, a.type, a.ids.map((i) => uuidParam(i)).filter((i): i is string => !!i)); revalidatePath(`/cms/${a.type}`); return { ok: true, id: "", version: 0, status: "", slug: "", message: "Urutan tersimpan." }; } catch (e) { return fail(e); }
}

export type SettingsState = { ok?: string; error?: string; fields?: Record<string, string> };
export async function saveSettingsAction(_p: SettingsState, form: FormData): Promise<SettingsState> {
  const actor = await context();
  const on = (k: string) => form.get(k) === "on";
  const input: SettingsInput = { enableEn: on("enableEn"), defaultLang: (String(form.get("defaultLang") ?? "id") === "en" ? "en" : "id"), showLangSwitcher: on("showLangSwitcher"), gaEnabled: on("gaEnabled"), gaMeasurementId: String(form.get("gaMeasurementId") ?? ""), gaRequireConsent: on("gaRequireConsent"), gaSkipAdmins: on("gaSkipAdmins") };
  try { await saveSettings(actor, input); revalidatePath("/cms/settings"); return { ok: "Pengaturan tersimpan." }; }
  catch (e) {
    if (e instanceof ValidationError) return { error: e.message, fields: e.fields };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}
