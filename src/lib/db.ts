import "server-only";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@/lib/env";

/**
 * Two physically separate database logins (PRD §12 defence in depth):
 *
 *  - tenantClient():  ws_tenant_app   — subject to Row Level Security by app.tenant_id. ALL tenant-scoped
 *                     reads/writes go through withTenant(). Cannot read password hashes or sessions.
 *  - platformClient(): ws_platform_app — cross-tenant. Allowed ONLY in lib/auth, lib/platform and the worker.
 *                     ESLint forbids importing it from route/UI code (see eslint.config.mjs).
 *
 * This file and tests/prisma seed are the only places allowed to import the generated client.
 */
type Globals = { __wsTenantDb?: PrismaClient; __wsPlatformDb?: PrismaClient };
const g = globalThis as unknown as Globals;
// Force UTC on every session: timestamptz must round-trip identically regardless of the server's default time zone.
const make = (url: string, max: number) => new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max, options: "-c timezone=UTC" }) });

export const tenantClient = (): PrismaClient => (g.__wsTenantDb ??= make(env().DATABASE_URL_TENANT, 10));
export const platformClient = (): PrismaClient => (g.__wsPlatformDb ??= make(env().DATABASE_URL_PLATFORM, 10));
export type Tx = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/**
 * Run `fn` inside a transaction pinned to ONE school. `set_config(..., true)` is transaction-local, so the
 * tenant id can never leak to another request on the same pooled connection. The id must come from the
 * authenticated principal or from host resolution — never from user-supplied request input.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(tenantId)) throw new Error("withTenant: invalid tenant id");
  return tenantClient().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { maxWait: 5_000, timeout: 15_000 },
  );
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([g.__wsTenantDb?.$disconnect(), g.__wsPlatformDb?.$disconnect()]);
  g.__wsTenantDb = undefined;
  g.__wsPlatformDb = undefined;
}
