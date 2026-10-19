/** Client IP from X-Forwarded-For when running behind a trusted proxy chain (Cloud Run / HTTPS LB). */
export function clientIp(headers: Headers, trustedHops: number): string {
  if (trustedHops <= 0) return "unknown";
  const xff = headers.get("x-forwarded-for");
  if (!xff) return "unknown";
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  // Our proxies APPEND the peer they saw, so the entry `hops` from the right is the real client.
  // Anything further left is attacker-controlled and ignored.
  return parts[parts.length - trustedHops] ?? parts[0] ?? "unknown";
}

export class OriginError extends Error {}

/** CSRF defence for cookie-authenticated mutations: Origin (or Referer) must match our own origin. */
export function assertSameOrigin(headers: Headers, appUrl: string, extraAllowedHosts: string[] = []): void {
  const origin = headers.get("origin");
  const source = origin ?? headers.get("referer");
  if (!source) throw new OriginError("missing origin");
  let host: string;
  try { host = new URL(source).host; } catch { throw new OriginError("bad origin"); }
  const allowed = [new URL(appUrl).host, ...extraAllowedHosts];
  if (!allowed.includes(host)) throw new OriginError("cross-origin request blocked");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Route/path parameters are untrusted: only a well-formed UUID is passed on to the database layer. */
export const uuidParam = (v: string | undefined): string | null => (v && UUID_RE.test(v) ? v.toLowerCase() : null);
