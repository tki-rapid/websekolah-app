import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended Argon2id parameters (m=19 MiB, t=2, p=1). Algorithm 2 = Argon2id.
const OPTS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, OPTS);

export async function verifyPassword(stored: string | null | undefined, pw: string): Promise<boolean> {
  // Always do the same amount of work, so unknown users / passwordless accounts are indistinguishable by timing.
  const target = stored ?? (await dummyHash());
  try {
    const ok = await verify(target, pw);
    return ok && stored != null;
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hash("not-a-real-password-for-timing", OPTS));

const COMMON = new Set(["password1234", "123456789012", "qwertyuiop12", "sekolah12345", "websekolah123", "admin1234567", "passw0rd1234"]);

/** Password policy: length over composition (NIST 800-63B). Returns an error message or null. */
export function passwordPolicyError(pw: string, ctx: { email?: string } = {}): string | null {
  if (pw.length < 12) return "Kata sandi minimal 12 karakter";
  if (pw.length > 128) return "Kata sandi maksimal 128 karakter";
  if (COMMON.has(pw.toLowerCase())) return "Kata sandi terlalu umum";
  if (new Set(pw).size < 5) return "Kata sandi terlalu sederhana";
  if (ctx.email && pw.toLowerCase().includes(ctx.email.split("@")[0]!.toLowerCase()) && ctx.email.split("@")[0]!.length >= 4)
    return "Kata sandi tidak boleh memuat nama email";
  return null;
}
