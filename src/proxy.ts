import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, SECURITY_HEADERS } from "@/lib/security/csp";
import { normalizeHostname } from "@/lib/security/hostname";

/**
 * Runs before every route (Next 16 "proxy", formerly middleware):
 *  1. rejects malformed Host headers (no default-tenant fallback, PRD §13.2),
 *  2. issues a per-request CSP nonce and the security headers (PRD §13.1),
 *  3. marks authenticated / auth routes as non-cacheable.
 * Authorisation is NOT decided here — every page, action and route handler re-checks the session on the server.
 */
const NO_STORE = [/^\/cms(\/|$)/, /^\/super(\/|$)/, /^\/login(\/|$)/, /^\/invite\//, /^\/forgot/, /^\/reset\//, /^\/reauth/, /^\/api\/auth\//, /^\/api\/media\//, /^\/api\/internal\//];

export function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  if (!normalizeHostname(host) && !(host ?? "").startsWith("localhost") && !(host ?? "").startsWith("127.0.0.1")) {
    return new NextResponse("Bad Request", { status: 400 });
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // Only the CMS uploads media straight to the private GCS bucket (V4 signed URL), so only there connect-src may reach it.
  const gcsUpload = process.env.MEDIA_BACKEND === "gcs" && /^\/cms(\/|$)/.test(request.nextUrl.pathname);
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== "production", extra: gcsUpload ? { "connect-src": ["https://storage.googleapis.com"] } : {} });

  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("x-nonce", nonce);
  reqHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: reqHeaders } });

  res.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (k === "Strict-Transport-Security" && process.env.NODE_ENV !== "production") continue;
    res.headers.set(k, v);
  }
  if (NO_STORE.some((re) => re.test(request.nextUrl.pathname))) res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
