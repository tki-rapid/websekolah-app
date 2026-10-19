import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-env.ts"],
    include: ["tests/**/*.test.ts"],
    fileParallelism: false, // all suites share one real PostgreSQL database
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
