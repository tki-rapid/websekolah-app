import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { env, isProd } from "@/lib/env";
import { validateSession, type SessionContext } from "@/lib/auth/session";
import { clientIp } from "@/lib/security/request";

// "__Host-" prefix (Secure, Path=/, no Domain) stops sibling subdomains from planting/overwriting the cookie.
export const SESSION_COOKIE = isProd() ? "__Host-ws_session" : "ws_session";
export const OAUTH_COOKIE = isProd() ? "__Host-ws_oauth" : "ws_oauth";

const base = () => ({ httpOnly: true, secure: isProd(), sameSite: "lax" as const, path: "/" });

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, { ...base(), expires: expiresAt });
}
export async function clearSessionCookie() {
  (await cookies()).set(SESSION_COOKIE, "", { ...base(), maxAge: 0 });
}

/** Per-request memoised session lookup (a render may ask several times; the DB is hit once). */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return validateSession(token);
});

export async function requestMeta() {
  const h = await headers();
  return { ip: clientIp(h, env().TRUSTED_PROXY_HOPS), userAgent: h.get("user-agent") ?? undefined, headers: h };
}
