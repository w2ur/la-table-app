import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, loadConfigFromFile, type Rollup } from "vite";
import { DEMO_WATCH_PATHS, watched } from "./demo-watch-paths.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A module id that is a file of this repository (not a virtual module, not a dependency), relative to it. */
function repoFile(id: string): string | null {
  const path = id.split("?")[0]!;
  if (!isAbsolute(path) || !existsSync(path)) return null;
  const rel = relative(ROOT, path);
  return rel.startsWith("..") || rel.startsWith("node_modules/") ? null : rel;
}

/** The repository files a script imports by a relative path, followed through. */
function localImports(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(file), m[1]!);
      if (existsSync(target)) visit(target);
    }
  };
  visit(join(ROOT, entry));
  return [...seen].map((p) => relative(ROOT, p));
}

let tmp = "";
/** Every repository file the demo build loaded (tree-shaken or not), its Vite configuration imported, or the gate imports. */
let read: string[] = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "la-table-watch-"));
  const loaded: string[] = [];
  const plugins = [{ name: "loaded-ids", buildEnd(this: Rollup.PluginContext) { loaded.push(...this.getModuleIds()); } }];
  await build({ configFile: join(ROOT, "vite.config.ts"), mode: "demo", logLevel: "silent", plugins, build: { outDir: tmp, emptyOutDir: true } });
  const config = await loadConfigFromFile({ command: "build", mode: "demo" }, join(ROOT, "vite.config.ts"), ROOT, "silent");
  read = [...new Set([
    ...loaded.flatMap((id) => repoFile(id) ?? []),
    ...(config?.dependencies ?? []).flatMap((d) => repoFile(resolve(ROOT, d)) ?? []),
    ...localImports("scripts/deploy-demo.ts"),
  ])].sort();
}, 120_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the demo's build watch paths", () => {
  // Regression: de865a1 — the list was hand-typed in four docs and missed src/cli/entry.ts, which scripts/deploy-demo.ts
  // imports: a change there would not have rebuilt the demo.
  it("cover every file the demo build, its Vite configuration and the deploy gate read", () => {
    expect(read.filter((path) => !watched(path))).toEqual([]);
  });

  it("control: each source was read, so an empty walk cannot pass as covered", () => {
    for (const known of ["src/app/main.tsx", "src/app/demo/boot.ts", "data/products.seed.json", "scripts/icons.ts", "src/cli/entry.ts"]) {
      expect(read, known).toContain(known);
    }
  });

  it("control: a file outside the demo's reach is not watched, nor one that only shares a watched folder's prefix", () => {
    for (const path of ["src/worker/app.ts", "src/cli/plan.ts", "scripts/deploy-ci.ts", "src/apps/x.ts"]) expect(watched(path), path).toBe(false);
    expect(watched("src/app/demo/boot.ts")).toBe(true);
    expect(DEMO_WATCH_PATHS).toContain("src/cli/entry.ts");
  });
});
