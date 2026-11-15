import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./vitest.workers.config.ts",
      {
        test: {
          name: "node",
          environment: "node",
          // property runs and wrangler-spawning tests take seconds alone and many times that on a loaded machine
          // (a busy build host included): a timeout is not a finding here, the assertions are
          testTimeout: 120_000,
          include: [
            "src/domain/**/*.test.ts",
            "src/cli/**/*.test.ts",
            "src/app/**/*.test.ts",
            "data/**/*.test.ts",
            "scripts/**/*.test.ts",
            "probes/placeholder/*.test.ts",
            "src/worker/auth.test.ts",
            "src/worker/config.test.ts",
            "src/worker/schema.test.ts",
            "src/worker/index.test.ts",
          ],
          exclude: [...configDefaults.exclude, "src/cli/**/*.workers.test.ts"],
        },
      },
    ],
  },
});
