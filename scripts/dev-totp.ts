/** DEV ONLY: print the current TOTP code of a user (for manual testing of MFA / re-auth flows). Refuses in production. */
import { platformClient } from "../src/lib/db";
import { openSecret } from "../src/lib/security/crypto";
import * as OTPAuth from "otpauth";

if (process.env.NODE_ENV === "production") throw new Error("refused in production");
const email = process.argv[2]?.toLowerCase();
if (!email) throw new Error("usage: tsx scripts/dev-totp.ts <email>");
async function main() {
const u = await platformClient().user.findUnique({ where: { email }, select: { totpSecretEnc: true } });
if (!u?.totpSecretEnc) throw new Error("no TOTP secret for that user");
const totp = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(openSecret(u.totpSecretEnc)) });
console.log(totp.generate());
process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
