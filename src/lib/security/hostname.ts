import { domainToASCII } from "node:url";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalise a Host header / domain input (PRD §13.2): lower-case, strip port and trailing dot,
 * convert IDN to punycode, then validate. Returns null for anything that is not a plain DNS name
 * (IP literals, userinfo, paths, empty labels...). Unknown or invalid hosts must resolve to a 404 —
 * never to a default tenant.
 */
export function normalizeHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (/[\s/\\@?#]/.test(h)) return null;
  if (h.startsWith("[")) return null; // IPv6 literal
  h = h.replace(/:\d{1,5}$/, "");
  h = h.replace(/\.+$/, "");
  if (!h || h.length > 253) return null;
  const ascii = domainToASCII(h);
  if (!ascii) return null;
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (/^\d+(\.\d+){3}$/.test(ascii)) return null; // IPv4 literal
  return ascii;
}
