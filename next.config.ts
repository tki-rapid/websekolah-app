import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone", // small container image for Cloud Run
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@node-rs/argon2", "pg", "sharp"],
  // security headers + CSP are set per-request in src/proxy.ts (CSP needs a fresh nonce)
};
export default config;
