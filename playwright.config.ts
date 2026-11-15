import { defineConfig } from "@playwright/test";
import { BASE_URL, PHONE } from "./e2e/phone";

export default defineConfig({
  testDir: "e2e",
  // one database for every spec, and a checkout attaches every bought line: specs run one at a time
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: "list",
  use: PHONE,
  projects: [
    { name: "seed", testMatch: /seed\.setup\.ts/ },
    { name: "phone", testMatch: /.*\.spec\.ts/, dependencies: ["seed"] },
  ],
  webServer: {
    command: "node scripts/e2e-server.ts",
    url: `${BASE_URL}/api/health`,
    // a stale server would test an old build: reuse only when asked (the design review keeps one running)
    reuseExistingServer: process.env.E2E_REUSE === "1",
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
