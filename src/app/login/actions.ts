"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/lib/env";
import { passwordLogin } from "@/lib/auth/login";
import { clearSessionCookie, getSession, requestMeta, setSessionCookie } from "@/lib/auth/cookies";
import { beginEnrollment, confirmEnrollment, verifyLoginMfa } from "@/lib/auth/totp";
import { acceptInvitationWithPassword } from "@/lib/auth/invitations";
import { createSession, revokeSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { assertSameOrigin, OriginError } from "@/lib/security/request";
import { consume } from "@/lib/security/ratelimit";
import { requestPasswordReset, consumePasswordReset } from "@/lib/auth/password-reset";
import { reauthenticate } from "@/lib/auth/reauth";
import QRCode from "qrcode";

export type FormState = { error?: string; ok?: boolean; qr?: string; secret?: string };

async function guardOrigin() {
  const meta = await requestMeta();
  try { assertSameOrigin(meta.headers, env().APP_URL); } catch (e) { if (e instanceof OriginError) redirect("/login?error=origin"); throw e; }
  return meta;
}

const loginSchema = z.object({ email: z.string().max(254), password: z.string().max(256) });

export async function passwordLoginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const meta = await guardOrigin();
  const parsed = loginSchema.safeParse({ email: form.get("email") ?? "", password: form.get("password") ?? "" });
  if (!parsed.success) return { error: "Email atau kata sandi salah." };
  const r = await passwordLogin({ ...parsed.data, ip: meta.ip, userAgent: meta.userAgent });
  if (!r.ok) {
    return { error: r.error === "rate_limited" ? `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((r.retryAfterSec ?? 60) / 60)} menit.` : "Email atau kata sandi salah." };
  }
  await setSessionCookie(r.token, r.expiresAt);
  redirect(r.mfa === "none" ? (r.user.role === "SUPER_ADMIN" ? "/super" : "/cms") : "/login/mfa");
}

export async function verifyMfaAction(_prev: FormState, form: FormData): Promise<FormState> {
  const meta = await guardOrigin();
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  const r = await verifyLoginMfa(ctx.user.id, ctx.session.id, code, meta.ip);
  if (r === "locked") return { error: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." };
  if (r !== "ok") return { error: "Kode tidak valid." };
  redirect(ctx.user.role === "SUPER_ADMIN" ? "/super" : "/cms");
}

export async function startEnrollmentAction(): Promise<FormState> {
  await guardOrigin();
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  if (ctx.user.totpEnabled) return { error: "MFA sudah aktif." };
  const rl = await consume(`mfa-enroll:${ctx.user.id}`, 5, 600);
  if (!rl.allowed) return { error: "Terlalu banyak permintaan. Coba lagi nanti." };
  const e = await beginEnrollment(ctx.user.id, ctx.user.email);
  return { ok: true, secret: e.secret, qr: await QRCode.toDataURL(e.otpauthUrl, { margin: 1, width: 200 }) };
}

export async function confirmEnrollmentAction(_prev: FormState, form: FormData): Promise<FormState> {
  await guardOrigin();
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  const ok = await confirmEnrollment(ctx.user.id, ctx.session.id, String(form.get("code") ?? "").replace(/\s/g, ""));
  if (!ok) return { error: "Kode tidak valid. Pastikan jam perangkat Anda akurat." };
  redirect(ctx.user.role === "SUPER_ADMIN" ? "/super" : "/cms");
}

export async function logoutAction(): Promise<void> {
  const meta = await guardOrigin();
  const ctx = await getSession();
  if (ctx) {
    await revokeSession(ctx.session.id);
    await audit({ tenantId: ctx.user.tenantId, actorId: ctx.user.id, actorEmail: ctx.user.email, action: "auth.logout", resource: "session", ip: meta.ip });
  }
  await clearSessionCookie();
  redirect("/login");
}

const inviteSchema = z.object({ token: z.string().min(20).max(200), password: z.string().max(256), confirm: z.string().max(256) });

export async function acceptInviteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const meta = await guardOrigin();
  const p = inviteSchema.safeParse({ token: form.get("token"), password: form.get("password") ?? "", confirm: form.get("confirm") ?? "" });
  if (!p.success) return { error: "Data tidak valid." };
  if (p.data.password !== p.data.confirm) return { error: "Konfirmasi kata sandi tidak sama." };
  const rl = await consume(`invite:ip:${meta.ip}`, 10, 900);
  if (!rl.allowed) return { error: "Terlalu banyak percobaan. Coba lagi nanti." };
  const r = await acceptInvitationWithPassword(p.data.token, p.data.password);
  if (!r.ok) return { error: r.error };
  // activation logs the new admin straight in (session fixation-safe: brand-new session id)
  const user = { id: r.userId, role: "SCHOOL_ADMIN" as const };
  const sess = await createSession(user, { provider: "password", ip: meta.ip, userAgent: meta.userAgent });
  await setSessionCookie(sess.token, sess.expiresAt);
  redirect("/cms");
}


const forgotSchema = z.object({ email: z.string().email().max(254) });

/** Always answers the same way, whether or not the account exists. */
export async function forgotPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  const meta = await guardOrigin();
  const p = forgotSchema.safeParse({ email: String(form.get("email") ?? "").trim() });
  if (p.success) await requestPasswordReset(p.data.email, meta.ip);
  return { ok: true };
}

const resetSchema = z.object({ token: z.string().min(20).max(200), password: z.string().max(256), confirm: z.string().max(256) });

export async function resetPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  const meta = await guardOrigin();
  const p = resetSchema.safeParse({ token: form.get("token"), password: form.get("password") ?? "", confirm: form.get("confirm") ?? "" });
  if (!p.success) return { error: "Data tidak valid." };
  if (p.data.password !== p.data.confirm) return { error: "Konfirmasi kata sandi tidak sama." };
  const rl = await consume(`reset-submit:ip:${meta.ip}`, 10, 900);
  if (!rl.allowed) return { error: "Terlalu banyak percobaan. Coba lagi nanti." };
  const r = await consumePasswordReset(p.data.token, p.data.password);
  if (!r.ok) return { error: r.error };
  redirect("/login?reset=1");
}

/** Step-up authentication; the page that needed it passes `next` (a same-site path) to return to. */
export async function reauthAction(_prev: FormState, form: FormData): Promise<FormState> {
  const meta = await guardOrigin();
  const ctx = await getSession();
  if (!ctx) redirect("/login");
  const r = await reauthenticate({ userId: ctx.user.id, sessionId: ctx.session.id, code: String(form.get("code") ?? ""), password: String(form.get("password") ?? ""), ip: meta.ip });
  if (r === "locked") return { error: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." };
  if (r !== "ok") return { error: ctx.user.totpEnabled ? "Kode tidak valid atau sudah dipakai — tunggu kode berikutnya." : "Kata sandi salah." };
  const next = String(form.get("next") ?? "");
  redirect(/^\/(super|cms)(\/[A-Za-z0-9/_\-.]*)?$/.test(next) ? next : ctx.user.role === "SUPER_ADMIN" ? "/super" : "/cms");
}
