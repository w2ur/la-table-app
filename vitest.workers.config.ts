import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityDate: "2026-08-22",
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            // Regression: 3c4e35c — a .dev.vars with DEV_SKIP_ACCESS=1 (wrangler dev) bypassed Access inside the pool and failed api.workers.test.ts
            DEV_SKIP_ACCESS: "0",
          },
        },
      }),
    ],
    test: {
      name: "workers",
      include: ["src/worker/**/*.workers.test.ts", "src/cli/**/*.workers.test.ts", "src/worker/d1-store.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
