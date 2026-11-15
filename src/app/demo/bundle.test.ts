/**
 * What only a real build can prove, because it is about what the bundler kept: the app renders no module only the demo
 * reaches (checked on the modules each build rendered, since a domain module carries no demo string) and no fixture,
 * and the demo ships no path to the network (no reference to the page's fetch, called or captured, nor any other transport, no service worker,
 * no Access round trip).
 * Both builds go to a temporary folder, never dist/ or dist-demo/.
 *
 * Each check has its control in the other bundle: the demo markers must be IN the demo, the network paths IN the app,
 * so a build that silently emitted nothing, or a marker that drifted, cannot pass as clean.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, type Rollup } from "vite";
import seed from "../../../data/products.seed.json";
import { DEMO_RESET_KEY, DEMO_STATE_KEY } from "./boot";
import { demoRecipes } from "./fixtures";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Strings only demo code and its fixtures hold. */
const DEMO_MARKERS = ["Démo — données fictives", DEMO_STATE_KEY, DEMO_RESET_KEY, "Réinitialiser", demoRecipes()[1]!.title, seed.products[0]!.name, "deleteDatabase"];
/**
 * Modules only the demo reaches, so the real build must render none of them: the demo's own, its server, and the domain
 * it pulls in that the app does not (applying ops, the planning check and its season exceptions, the seed). Strings
 * cannot see the domain ones: a static import of the demo once kept `season-exceptions.json` and two `new Set(…)` of it
 * in the real bundle, dead but unprovably pure (measured 2026-11-15), with no demo string anywhere.
 */
const DEMO_ONLY_MODULES = [
  /^src\/app\/demo\//,
  /^src\/app\/sync\/local-server\.ts$/,
  /^src\/domain\/ops\/apply\.ts$/,
  /^src\/domain\/check\.ts$/,
  /^src\/domain\/catalogue-rules\.ts$/,
  /^data\/season-exceptions\.json$/,
  /^data\/products\.seed\.json$/,
];
/**
 * Any reference to the page's own fetch, bare or through `window`, `self` or `globalThis` by a dot or an optional chain
 * (`globalThis?.fetch`): a call, but also a capture (`window.fetch.bind(window)`, `const f=fetch`, `{fetch}`), which
 * keeps the real fetch alive past the demo's swap. A computed key (`globalThis["fetch"]`) is caught by the quoted name
 * itself, on any object: the pattern errs towards a finding there. Not one: a member called `fetch` on some other
 * object (`this.deps.fetch`), an object key (`{fetch:n}`), and the assignment that replaces it (`globalThis.fetch=`),
 * which is how the demo refuses the network.
 */
const GLOBAL_FETCH_REF = /(?<![\w$.])(?:(?:window|self|globalThis)\??\.)?fetch\b(?!\s*=(?!=))(?!(?<=[{,]\s*fetch)\s*:)/;
/** The page's other ways to the network: the demo bundle must hold none of them. */
const OTHER_TRANSPORTS = ["XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource"];
/** The real app's ways out of the page: the network, its service worker, and the way back through Access. */
const NETWORK_MARKERS = ["serviceWorker", "/sw.js", "Se reconnecter", "reconnexion"];

/** The repo-relative ids of the modules a build rendered code from (a module tree-shaken to nothing is not one). */
function renderedModules(output: Rollup.RollupOutput | Rollup.RollupOutput[] | unknown): string[] {
  const outputs = (Array.isArray(output) ? output : [output]) as Rollup.RollupOutput[];
  return outputs.flatMap((o) =>
    o.output.flatMap((c) => (c.type === "chunk" ? Object.entries(c.modules).filter(([, m]) => m.renderedLength > 0).map(([id]) => relative(ROOT, id)) : [])),
  );
}

function scripts(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|html)$/.test(e.name))
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");
}

let tmp = "";
let real = "";
let demo = "";
const modules: Record<"real" | "demo", string[]> = { real: [], demo: [] };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "la-table-bundle-"));
  for (const [mode, out] of [["production", "real"], ["demo", "demo"]] as const) {
    modules[out] = renderedModules(await build({ configFile: join(ROOT, "vite.config.ts"), mode, logLevel: "silent", build: { outDir: join(tmp, out), emptyOutDir: true } }));
  }
  real = scripts(join(tmp, "real"));
  demo = scripts(join(tmp, "demo"));
}, 120_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("bundles", () => {
  it("the app renders no module only the demo reaches", () => {
    expect(modules.real.length).toBeGreaterThan(0);
    for (const pattern of DEMO_ONLY_MODULES) expect(modules.real.filter((id) => pattern.test(id)), String(pattern)).toEqual([]);
  });

  it("control: the demo renders each of them", () => {
    for (const pattern of DEMO_ONLY_MODULES) expect(modules.demo.some((id) => pattern.test(id)), String(pattern)).toBe(true);
  });

  it("the app carries no demo string and no fixture", () => {
    for (const marker of DEMO_MARKERS) expect(real.includes(marker), marker).toBe(false);
  });

  it("control: every demo marker is in the demo", () => {
    for (const marker of DEMO_MARKERS) expect(demo.includes(marker), marker).toBe(true);
  });

  it("the demo calls no network: no global fetch, no service worker, no way back through Access", () => {
    expect(GLOBAL_FETCH_REF.exec(demo)?.[0] ?? null).toBeNull(); // the match, not the whole bundle, on a failure
    for (const transport of OTHER_TRANSPORTS) expect(demo.includes(transport), transport).toBe(false);
    for (const marker of NETWORK_MARKERS) expect(demo.includes(marker), marker).toBe(false);
    expect(readdirSync(join(tmp, "demo"))).not.toContain("sw.js");
  });

  it("control: the app does each of those", () => {
    expect(GLOBAL_FETCH_REF.exec(real)).not.toBeNull();
    for (const marker of NETWORK_MARKERS) expect(real.includes(marker), marker).toBe(true);
    expect(readdirSync(join(tmp, "real"))).toContain("sw.js");
  });

  it("control: the fetch pattern sees the page's fetch in every spelling, called or captured, and only it", () => {
    // Regression: 6045d86 — an optional chain (`globalThis?.fetch(u)`) passed: the `.` before `fetch` hid it from the
    // bare form and the prefix knew only `globalThis.`. Computed keys were already caught, through the quoted name;
    // their controls pin that.
    // Regression (review 2026-11-15): `network = window.fetch.bind(window)` in the demo passed the call-only pattern while
    // every sync request still reached the network.
    for (const ref of ["fetch(u)", ";window.fetch(`/x`)", "(globalThis.fetch(u))", " self.fetch(u)", "n=window.fetch.bind(window)", "const f=fetch", "{fetch}", "({fetch:fetch})", "a?fetch:b", "f===fetch", 'globalThis["fetch"](u)', "window['fetch'](u)", 'self["fetch"].bind(self)', "n=globalThis[`fetch`]", "window?.['fetch'](u)", "globalThis?.fetch(u)", "self?.fetch.bind(self)"]) {
      expect(ref, ref).toMatch(GLOBAL_FETCH_REF);
    }
    for (const other of ["this.deps.fetch(u)", "e.fetch(u)", "l.fetch,", "prefetch(u)", "globalThis.fetch=r", "globalThis.fetch = r", "{fetch:fc(e,t)", ",fetch:n,", "Chrome fetches a manifest", 'globalThis["fetcher"]', "this.deps?.fetch(u)"]) {
      expect(other, other).not.toMatch(GLOBAL_FETCH_REF);
    }
  });

  it("control: both answer the same API, the demo from inside the page", () => {
    for (const path of ["/api/state", "/api/ops"]) {
      expect(real.includes(path), path).toBe(true);
      expect(demo.includes(path), path).toBe(true);
    }
  });
});
