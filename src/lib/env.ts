import { z } from "zod";

/**
 * Validated, typed environment. The process refuses to start with missing/weak secrets
 * (fail fast) instead of failing open at request time.
 */
const b64Key = (name: string) =>
  z.string().refine((v) => Buffer.from(v, "base64").length >= 32, `${name} must be >= 32 bytes, base64-encoded`);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url(), // canonical origin of the platform app, e.g. https://app.websekolah.id
  PLATFORM_DOMAIN: z.string().default("websekolah.id"),
  DATABASE_URL_TENANT: z.string().min(1),
  DATABASE_URL_PLATFORM: z.string().min(1),
  APP_SECRET: b64Key("APP_SECRET"), // HMAC key (ip hashing, signed cookies)
  TOTP_ENC_KEY: b64Key("TOTP_ENC_KEY"), // AES-256-GCM key for TOTP secrets
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  // outbound e-mail (SMTP). Unset in dev => messages are logged instead of sent.
  SMTP_URL: z.string().optional(), // e.g. smtps://user:pass@smtp.example.com:465
  MAIL_FROM: z.string().default("WebSekolah <no-reply@websekolah.id>"),
  // shared secret for the internal job-runner endpoint (Cloud Scheduler). Unset => endpoint disabled.
  JOB_RUNNER_TOKEN: z.string().min(32).optional(),
  // media storage
  MEDIA_BACKEND: z.enum(["gcs", "local"]).default("local"),
  MEDIA_BUCKET: z.string().optional(),
  MEDIA_LOCAL_DIR: z.string().default(".media-dev"),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.APP_URL.startsWith("https://")) {
    throw new Error("APP_URL must be https:// in production");
  }
  if (parsed.data.NODE_ENV === "production") {
    if (parsed.data.MEDIA_BACKEND !== "gcs" || !parsed.data.MEDIA_BUCKET) throw new Error("production requires MEDIA_BACKEND=gcs and MEDIA_BUCKET");
    if (!parsed.data.SMTP_URL) throw new Error("production requires SMTP_URL (invitations and password resets are e-mailed)");
  }
  cached = parsed.data;
  return cached;
}

export const isProd = () => process.env.NODE_ENV === "production";
export function resetEnvCacheForTests() {
  cached = undefined;
}
