import { execFileSync } from "node:child_process";
import pg from "pg";

/**
 * Integration tests run against a REAL PostgreSQL (RLS, triggers and grants cannot be faked).
 * Locally:  scripts/dev-db.sh up   (Postgres on :54329).   CI: a postgres service container.
 * A throw-away database `websekolah_test` is created from the real migrations for every run.
 */
const ADMIN = {
  host: process.env.TEST_PG_HOST ?? "/tmp",
  port: Number(process.env.TEST_PG_PORT ?? 54329),
  user: process.env.TEST_PG_ADMIN_USER ?? "postgres",
  password: process.env.TEST_PG_ADMIN_PASSWORD,
};
const DB = "websekolah_test";
// same defaults as scripts/dev-db.sh, so the test run never changes the roles used by the dev database
export const TEST_PASSWORDS = {
  mig: process.env.TEST_MIG_PW ?? "dev-migrator-pw",
  tenant: process.env.TEST_TENANT_PW ?? "dev-tenant-pw",
  platform: process.env.TEST_PLATFORM_PW ?? "dev-platform-pw",
};

export default async function setup() {
  const admin = new pg.Client({ ...ADMIN, database: "postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const connArgs = ["-h", ADMIN.host, "-p", String(ADMIN.port), "-U", ADMIN.user, "-d", DB, "-v", "ON_ERROR_STOP=1", "-q"];
  execFileSync("psql", [...connArgs, "-v", `mig_pw=${TEST_PASSWORDS.mig}`, "-v", `tenant_pw=${TEST_PASSWORDS.tenant}`, "-v", `platform_pw=${TEST_PASSWORDS.platform}`, "-f", "scripts/db-bootstrap.sql"],
    { stdio: "pipe", env: { ...process.env, PGPASSWORD: ADMIN.password ?? "" } });
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL_MIGRATE: `postgresql://ws_migrator:${TEST_PASSWORDS.mig}@127.0.0.1:${ADMIN.port}/${DB}` },
  });
}
