// The Worker for Playwright and the design review: a fresh local D1 (never .wrangler/state), migrations applied, and
// the Access bypass passed on the command line, so no .dev.vars is ever written (one left behind breaks npm test).
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const PERSIST = ".wrangler/e2e";
const PORT = process.env.E2E_PORT ?? "8789";
const env = { ...process.env, CI: "1" }; // wrangler asks no question in CI mode

function run(args: string[]): void {
  const result = spawnSync("npx", args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 2);
}

rmSync(PERSIST, { recursive: true, force: true });
run(["vite", "build"]);
run(["wrangler", "d1", "migrations", "apply", "la-table", "--local", "--persist-to", PERSIST]);
const dev = spawn("npx", ["wrangler", "dev", "--port", PORT, "--persist-to", PERSIST, "--var", "DEV_SKIP_ACCESS:1"], { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => dev.kill(signal));
dev.on("exit", (code) => process.exit(code ?? 0));
