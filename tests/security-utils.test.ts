import { describe, expect, it } from "vitest";
import { normalizeHostname } from "@/lib/security/hostname";
import { assertSameOrigin, clientIp, OriginError } from "@/lib/security/request";
import { buildCsp, SECURITY_HEADERS } from "@/lib/security/csp";
import { passwordPolicyError, hashPassword, verifyPassword } from "@/lib/security/password";
import { sealSecret, openSecret } from "@/lib/security/crypto";
import { hashToken, newToken, safeEqual } from "@/lib/security/tokens";
import { env, resetEnvCacheForTests } from "@/lib/env";

describe("hostname normalisation (PRD §13.2)", () => {
  it.each([
    ["SMAN1.WebSekolah.ID", "sman1.websekolah.id"],
    ["sman1.websekolah.id:8443", "sman1.websekolah.id"],
    ["sman1.websekolah.id.", "sman1.websekolah.id"],
    ["  www.contoh.sch.id  ", "www.contoh.sch.id"],
    ["Bücher.example", "xn--bcher-kva.example"], // IDN -> punycode
  ])("%s -> %s", (raw, expected) => expect(normalizeHostname(raw)).toBe(expected));
  it.each(["", "localhost", "192.168.1.1", "[::1]", "a..b.id", "evil.com/path", "user@evil.com", "a b.id", "-x.id", "x".repeat(64) + ".id", "http://x.id", "x.id#frag", null, undefined])(
    "rejects %s", (raw) => expect(normalizeHostname(raw as string)).toBeNull());
});

describe("client IP behind a trusted proxy", () => {
  it("takes the Nth entry from the right, ignoring attacker-supplied left entries", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" });
    expect(clientIp(h, 1)).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 10.0.0.1" }), 2)).toBe("1.2.3.4");
  });
  it("is 'unknown' when no proxy is trusted or the header is missing", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }), 0)).toBe("unknown");
    expect(clientIp(new Headers(), 1)).toBe("unknown");
  });
});

describe("CSRF origin check", () => {
  const APP = "https://app.websekolah.id";
  it("accepts same-origin and rejects cross-origin / missing", () => {
    expect(() => assertSameOrigin(new Headers({ origin: APP }), APP)).not.toThrow();
    expect(() => assertSameOrigin(new Headers({ referer: APP + "/login" }), APP)).not.toThrow();
    expect(() => assertSameOrigin(new Headers({ origin: "https://evil.example" }), APP)).toThrow(OriginError);
    expect(() => assertSameOrigin(new Headers({ origin: "https://app.websekolah.id.evil.example" }), APP)).toThrow(OriginError);
    expect(() => assertSameOrigin(new Headers(), APP)).toThrow(OriginError);
    expect(() => assertSameOrigin(new Headers({ origin: "null" }), APP)).toThrow(OriginError);
  });
});

describe("Content-Security-Policy & headers (PRD §13.1)", () => {
  const csp = buildCsp("abc123");
  it("uses a nonce + strict-dynamic and forbids inline script, eval, framing, plugins", () => {
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-inline'"); expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'"); expect(csp).toContain("object-src 'none'"); expect(csp).toContain("base-uri 'self'"); expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });
  it("dev mode only relaxes what Next's dev server needs", () => expect(buildCsp("n", { dev: true })).toContain("'unsafe-eval'"));
  it("ships HSTS, nosniff, referrer policy, permissions policy, COOP", () => {
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}/);
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toContain("camera=()");
    expect(SECURITY_HEADERS["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });
});

describe("passwords & secrets", () => {
  it("policy favours length", () => {
    expect(passwordPolicyError("pendek")).not.toBeNull();
    expect(passwordPolicyError("aaaaaaaaaaaaaaaa")).not.toBeNull();
    expect(passwordPolicyError("Password1234")).not.toBeNull();
    expect(passwordPolicyError("budisantoso@sekolah.id", { email: "budisantoso@sekolah.id" })).not.toBeNull();
    expect(passwordPolicyError("kuda-biru-makan-roti-2026")).toBeNull();
  });
  it("argon2id hashes verify, are salted, and never match wrong input / null hash", async () => {
    const h1 = await hashPassword("kuda-biru-makan-roti-2026"), h2 = await hashPassword("kuda-biru-makan-roti-2026");
    expect(h1).toMatch(/^\$argon2id\$/); expect(h1).not.toBe(h2);
    expect(await verifyPassword(h1, "kuda-biru-makan-roti-2026")).toBe(true);
    expect(await verifyPassword(h1, "kuda-biru-makan-roti-2027")).toBe(false);
    expect(await verifyPassword(null, "apa-saja")).toBe(false);
  });
  it("AES-GCM envelope round-trips and detects tampering", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(openSecret(sealed)).toBe("JBSWY3DPEHPK3PXP");
    const parts = sealed.split("."); parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => openSecret(parts.join("."))).toThrow();
    expect(sealSecret("x")).not.toBe(sealSecret("x")); // fresh IV each time
  });
  it("tokens are long, unique, hashed with SHA-256, compared in constant time", () => {
    const a = newToken(), b = newToken();
    expect(a).not.toBe(b); expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(safeEqual("abc", "abc")).toBe(true); expect(safeEqual("abc", "abd")).toBe(false); expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("environment validation fails fast", () => {
  it("rejects weak secrets and non-https APP_URL in production", () => {
    const saved = { ...process.env };
    try {
      process.env.APP_SECRET = Buffer.alloc(8).toString("base64"); resetEnvCacheForTests();
      expect(() => env()).toThrow(/APP_SECRET/);
      process.env.APP_SECRET = saved.APP_SECRET; (process.env as Record<string, string>).NODE_ENV = "production"; process.env.APP_URL = "http://insecure.example.com"; resetEnvCacheForTests();
      expect(() => env()).toThrow(/https/);
    } finally { Object.assign(process.env, saved); resetEnvCacheForTests(); }
  });
});
