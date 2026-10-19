import { defineConfig } from "prisma/config";

// DATABASE_URL_MIGRATE must connect as the schema OWNER role (ws_migrator).
// The running application never uses this URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: process.env.DATABASE_URL_MIGRATE ?? "postgresql://ws_migrator@localhost:54329/websekolah" },
});
