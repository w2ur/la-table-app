import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { WORKSPACE_PARENT } from "./deploy-ci";
import { baseEnv, WRANGLER_BIN } from "./deploy-target";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_BIN = join(ROOT, "node_modules/vite/bin/vite.js");
/** What the copy leaves out: git, the dependencies (linked instead), and what builds, tests and tools write. */
const LEFT_OUT = new Set([".git", "node_modules", "dist", "dist-demo", ".wrangler", ".claude", "coverage", "test-results", "playwright-report", "blob-report", "backups", "exports"]);

/** A file a machine may hold above the export: it remaps `jose` (the Worker's JWT check) and changes how classes compile. */
const HOSTILE_TSCONFIG = JSON.stringify({ compilerOptions: { paths: { jose: ["./evil-jose.js"] }, useDefineForClassFields: false } });
const EVIL_JOSE = 'export const MARK = "evil-jose";\nexport async function jwtVerify() { return { payload: { email: MARK } }; }\nexport function createRemoteJWKSet() { return () => MARK; }\n';

const parents: string[] = [];
afterAll(() => {
  for (const p of parents) rmSync(p, { recursive: true, force: true });
});

/** Every file under `dir`, as path → its SHA-256: a difference names the file without printing it. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out[relative(dir, join(e.parentPath, e.name))] = createHash("sha256").update(readFileSync(join(e.parentPath, e.name))).digest("hex");
  }
  return out;
}

/**
 * The repository copied to `<parent>/tree` (node_modules linked), under a parent holding the hostile tsconfig.json or
 * nothing, then built as the deploy builds it: `vite build` (dist/), and the Worker bundled by the installed wrangler
 * (`deploy --dry-run --outdir`, nothing sent anywhere). `unstopped`: the copy without its own stop, the control.
 */
function build(o: { hostile: boolean; unstopped?: boolean }): { dist: Record<string, string>; worker: string } {
  const parent = mkdtempSync(join(realpathSync.native(WORKSPACE_PARENT), "la-table-build-"));
  parents.push(parent);
  const tree = join(parent, "tree");
  cpSync(ROOT, tree, { recursive: true, filter: (src) => src === ROOT || !LEFT_OUT.has(relative(ROOT, src).split("/")[0]!) });
  symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
  if (o.hostile) {
    writeFileSync(join(parent, "tsconfig.json"), HOSTILE_TSCONFIG);
    writeFileSync(join(parent, "evil-jose.js"), EVIL_JOSE);
  }
  if (o.unstopped) {
    rmSync(join(tree, "tsconfig.json"), { force: true });
    const config = readFileSync(join(tree, "wrangler.jsonc"), "utf8");
    writeFileSync(join(tree, "wrangler.jsonc"), config.replace(/^\s*"tsconfig": .*\n/m, ""));
  }
  const env = { ...baseEnv(), WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(parent, "logs") };
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, args, { cwd: tree, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${args.slice(1).join(" ")}: ${r.stderr}${r.stdout}`);
  };
  run([VITE_BIN, "build"]);
  run([WRANGLER_BIN, "deploy", "--dry-run", "--outdir", join(parent, "out"), "--config", join(tree, "wrangler.jsonc"), "--env=", "--env-file=/dev/null"]);
  return { dist: files(join(tree, "dist")), worker: readFileSync(join(parent, "out/index.js"), "utf8") };
}

describe("the build of an export, whatever lies above it", () => {
  // Regression: 2a9b251 — with no tsconfig.json at the root and none named in wrangler.jsonc, esbuild (wrangler) and
  // Vite looked for one in every directory above the export: a file there swapped the Worker's jose for a stub and
  // recompiled the app, deployed under the checked commit's tag
  it("builds the same Worker and the same dist/ under a parent holding a hostile tsconfig.json", () => {
    const clean = build({ hostile: false });
    const hostile = build({ hostile: true });
    // compared as booleans: a failure would otherwise print the whole bundle
    expect({ stub: hostile.worker.includes("evil-jose"), same: hostile.worker === clean.worker }).toEqual({ stub: false, same: true });
    expect(hostile.dist).toEqual(clean.dist);
    // the control: the same parent, with the stop taken out of the copy, reaches both builds
    const unstopped = build({ hostile: true, unstopped: true });
    expect(unstopped.worker.includes("evil-jose")).toBe(true);
    expect(unstopped.dist).not.toEqual(clean.dist);
  }, 120_000);
});
