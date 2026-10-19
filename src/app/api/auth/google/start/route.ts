import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { env, isProd } from "@/lib/env";
import { googleConfigured, startGoogleAuth } from "@/lib/auth/google";
import { OAUTH_COOKIE, requestMeta } from "@/lib/auth/cookies";
import { consume } from "@/lib/security/ratelimit";

export const dynamic = "force-dynamic";

/** Begin Google OIDC: random `state` + PKCE verifier kept in a short-lived HttpOnly cookie. */
export async function GET() {
  const to = (p: string) => NextResponse.redirect(new URL(p, env().APP_URL));
  if (!googleConfigured()) return to("/login?error=google_unavailable");
  const { ip } = await requestMeta();
  if (!(await consume(`google:start:${ip}`, 30, 900)).allowed) return to("/login?error=rate_limited");
  const { url, state, codeVerifier } = startGoogleAuth();
  (await cookies()).set(OAUTH_COOKIE, JSON.stringify({ s: state, v: codeVerifier }), {
    httpOnly: true, secure: isProd(), sameSite: "lax", path: "/", maxAge: 600,
  });
  return NextResponse.redirect(url);
}
