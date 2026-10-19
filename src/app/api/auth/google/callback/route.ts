import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { env, isProd } from "@/lib/env";
import { exchangeCode, resolveGoogleLogin } from "@/lib/auth/google";
import { googleSession } from "@/lib/auth/login";
import { OAUTH_COOKIE, requestMeta, setSessionCookie } from "@/lib/auth/cookies";
import { consume } from "@/lib/security/ratelimit";
import { safeEqual } from "@/lib/security/tokens";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const to = (p: string) => NextResponse.redirect(new URL(p, env().APP_URL));
  const jar = await cookies();
  const raw = jar.get(OAUTH_COOKIE)?.value;
  jar.set(OAUTH_COOKIE, "", { httpOnly: true, secure: isProd(), sameSite: "lax", path: "/", maxAge: 0 }); // single use
  const { ip, userAgent } = await requestMeta();
  if (!(await consume(`google:cb:${ip}`, 30, 900)).allowed) return to("/login?error=rate_limited");

  const q = req.nextUrl.searchParams;
  let saved: { s?: string; v?: string } = {};
  try { saved = JSON.parse(raw ?? "{}"); } catch { /* fallthrough */ }
  const state = q.get("state"), code = q.get("code");
  if (!saved.s || !saved.v || !state || !code || !safeEqual(saved.s, state)) {
    await audit({ actorEmail: "unknown", action: "auth.google", resource: "google", result: "denied", reason: "bad_state", ip });
    return to("/login?error=google_state");
  }
  let claims;
  try { claims = await exchangeCode(code, saved.v); } catch {
    await audit({ actorEmail: "unknown", action: "auth.google", resource: "google", result: "failure", reason: "code_exchange", ip });
    return to("/login?error=google_state");
  }
  if (!claims) return to("/login?error=google_denied");
  const r = await resolveGoogleLogin(claims, { ip });
  if (!r.ok) return to("/login?error=google_denied"); // one generic message: never reveal whether an e-mail is registered
  const s = await googleSession(r.user, { ip, userAgent });
  await setSessionCookie(s.token, s.expiresAt);
  return to(s.mfa === "none" ? (r.user.role === "SUPER_ADMIN" ? "/super" : "/cms") : "/login/mfa");
}
