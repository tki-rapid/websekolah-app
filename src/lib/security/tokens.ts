import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit random, URL-safe. Raw tokens go to the user; only their hash is stored. */
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
export const hashToken = sha256Hex;
export const hmacHex = (secretB64: string, v: string) =>
  createHmac("sha256", Buffer.from(secretB64, "base64")).update(v).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
