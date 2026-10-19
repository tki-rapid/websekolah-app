import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Security boundaries enforced by lint (PRD R02: tenant isolation must not depend on developer discipline):
 *  - Only src/lib/db.ts may construct database clients (pg / Prisma). Everything else uses withTenant() or the DAL.
 *  - UI and route code (src/app) may NOT import the raw clients; they call lib/dal or lib/auth.
 *  - Only lib/auth, lib/dal and lib/audit may use platformClient() (cross-tenant).
 */
const RAW_DB = [
  { name: "pg", message: "Database access goes through src/lib/db.ts (withTenant / platformClient)." },
  { name: "@prisma/client", message: "Use the client from src/lib/db.ts." },
  { name: "@prisma/adapter-pg", message: "Only src/lib/db.ts may build database adapters." },
];

export default tseslint.config(
  { ignores: ["src/generated/**", ".next/**", "node_modules/**", "next-env.d.ts", "coverage/**", "infra/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/db.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: RAW_DB,
        patterns: [{ group: ["**/generated/prisma", "**/generated/prisma/*"], allowTypeImports: true, message: "Import the runtime client only from src/lib/db.ts (types are fine)." }],
      }],
    },
  },
  {
    // route/UI layer: no direct DB clients at all
    files: ["src/app/**/*.{ts,tsx}"],
    ignores: ["src/app/api/health/route.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: [...RAW_DB, { name: "@/lib/db", importNames: ["platformClient", "tenantClient", "withTenant"], message: "UI/route code must call lib/dal or lib/auth, not the DB layer." }],
        patterns: [{ group: ["**/generated/prisma", "**/generated/prisma/*"], allowTypeImports: true, message: "Types only." }],
      }],
    },
  },
  {
    // tenant-scoped DAL must not reach for the cross-tenant client
    files: ["src/lib/dal/tenant.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [...RAW_DB, { name: "@/lib/db", importNames: ["platformClient"], message: "Tenant DAL is RLS-scoped: use withTenant() only." }] }],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "no-eval": "error", "no-implied-eval": "error", "no-new-func": "error",
    },
  },
);
