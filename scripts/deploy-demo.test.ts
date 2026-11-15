import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { demoConfigProblems, demoDeployProblems, demoEnvProblems, normalisedConfigProblems, readRawConfig, runDemoGate } from "./deploy-demo.ts";

const appText = readFileSync("wrangler.jsonc", "utf8");
const demoText = readFileSync("wrangler.demo.jsonc", "utf8");
const app = readRawConfig("wrangler.jsonc");
const demo = readRawConfig("wrangler.demo.jsonc");
const appAccountId = app.account_id as string;

/** runDemoGate on a repository holding this demo configuration text beside the app's real one. */
function gateOn(text: string, env: Record<string, string> = BUILDS, extra: Record<string, string> = {}): { code: number; log: string } {
  const root = mkdtempSync(join(tmpdir(), "deploy-demo-"));
  try {
    writeFileSync(join(root, "wrangler.demo.jsonc"), text);
    writeFileSync(join(root, "wrangler.jsonc"), appText);
    for (const [name, content] of Object.entries(extra)) writeFileSync(join(root, name), content);
    const lines: string[] = [];
    const code = runDemoGate(env, root, (l) => lines.push(l));
    return { code, log: lines.join("\n") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** What Workers Builds sets on the demo's own entry, the one environment the deploy may run in. */
const BUILDS = { WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", WRANGLER_CI_OVERRIDE_NAME: "la-table-demo" };

// each of these must be refused, or the allowlist checks nothing
const CONTROLS: [string, Record<string, unknown>][] = [
  ["main", { main: "src/worker/index.ts" }],
  ["d1_databases", { d1_databases: [{ binding: "DB", database_id: "x" }] }],
  ["vars", { vars: { ACCESS_AUD: "x" } }],
  ["routes", { routes: ["demo.example.com/*"] }],
  ["route", { route: "demo.example.com/*" }],
  ["a binding on assets", { assets: { directory: "./dist-demo", binding: "ASSETS" } }],
  ["run_worker_first on assets", { assets: { directory: "./dist-demo", run_worker_first: ["/api/*"] } }],
  ["the production assets directory", { assets: { directory: "./dist" } }],
  ["the production name", { name: "la-table" }],
  ["another account", { account_id: "0".repeat(32) }],
  ["workers_dev off", { workers_dev: false }],
  ["previews on", { preview_urls: true }],
];

describe("wrangler.demo.jsonc", () => {
  it("is an assets-only Worker named la-table-demo on the app's account", () => {
    expect(demoConfigProblems(demo, appAccountId)).toEqual([]);
  });

  it("reads the app's configuration too (its comments included)", () => {
    expect(appAccountId).toMatch(/^[0-9a-f]{32}$/);
    expect(app.name).toBe("la-table");
  });

  it.each(CONTROLS)("refuses %s", (_label, change) => {
    expect(demoConfigProblems({ ...demo, ...change }, appAccountId).length).toBeGreaterThan(0);
  });

  it("refuses a missing key it requires", () => {
    const { name: _n, ...rest } = demo;
    expect(demoConfigProblems(rest, appAccountId).length).toBeGreaterThan(0);
  });
});

// Regression (review round 1, Task 9): the allowlist ran only in npm test, after the demo entry had deployed, and
// nothing stopped deploy:demo under the app's Builds entry, where WRANGLER_CI_OVERRIDE_NAME=la-table makes wrangler
// publish the static demo over the production Worker. The gate now runs inside deploy:demo, before the build.
describe("the deploy:demo gate", () => {
  it("lets the demo's own Builds entry deploy the real configuration", () => {
    expect(demoDeployProblems(BUILDS, demo, app)).toEqual([]);
    const { WRANGLER_CI_OVERRIDE_NAME: _o, ...noOverride } = BUILDS;
    expect(demoDeployProblems(noOverride, demo, app)).toEqual([]);
    expect(gateOn(demoText)).toEqual({ code: 0, log: "" });
  });

  it.each(CONTROLS)("refuses a configuration with %s", (_label, change) => {
    expect(gateOn(JSON.stringify({ ...demo, ...change })).code).toBe(1);
  });

  it.each([
    ["the app's Builds entry", { ...BUILDS, WRANGLER_CI_OVERRIDE_NAME: "la-table" }],
    ["any other Worker", { ...BUILDS, WRANGLER_CI_OVERRIDE_NAME: "something-else" }],
    ["an empty override", { ...BUILDS, WRANGLER_CI_OVERRIDE_NAME: "" }],
    ["a shell", {}],
    ["a shell with WORKERS_CI=0", { WORKERS_CI: "0", WORKERS_CI_BRANCH: "main" }],
    ["another branch", { ...BUILDS, WORKERS_CI_BRANCH: "feature/x" }],
    ["no branch", { WORKERS_CI: "1", WRANGLER_CI_OVERRIDE_NAME: "la-table-demo" }],
  ])("refuses %s", (_label, env) => {
    expect(demoEnvProblems(env).length).toBeGreaterThan(0);
  });

  it("refuses the app's Builds entry and passes the demo's, as npm run deploy:demo runs it", () => {
    const run = (extra: Record<string, string>) => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...BUILDS, ...extra };
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/deploy-demo.ts"], { env, encoding: "utf8" });
      return { status: r.status, stderr: r.stderr };
    };
    const refused = run({ WRANGLER_CI_OVERRIDE_NAME: "la-table" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("WRANGLER_CI_OVERRIDE_NAME=la-table");
    expect(run({}).status).toBe(0);
  });

  it("runs before the build and the upload in the deploy:demo script", () => {
    const script = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts["deploy:demo"];
    expect(script).toBe("tsx scripts/deploy-demo.ts && npm run build:demo && wrangler deploy --config wrangler.demo.jsonc --env-file=/dev/null");
  });
});

// Regression (review rounds 2 and 3, Task 9): the gate had its own JSONC parser, and wherever it disagreed with wrangler's
// the gate checked one configuration while wrangler deployed another. Round 2: an unterminated string or block comment
// sent it into an endless loop, and its trailing-comma rewrite ran over string values. Round 3: it ended a `//` comment
// only at \n, while wrangler's scanner also ends one at a lone \r, so a D1 binding and variables written after a `// x\r`
// were a comment to the gate (exit 0) and bindings to `wrangler deploy`. The gate now reads the file with wrangler's own
// raw reader, the same parse `wrangler deploy --config` runs.
describe("the gate reads the configuration as wrangler does", () => {
  const loneCr = demoText.replace(
    '"name": "la-table-demo",',
    '"name": "la-table-demo", // note\r  "d1_databases": [{"binding":"DB","database_name":"la-table","database_id":"x"}], "vars": {"X":"y"},',
  );

  it("refuses a binding and variables hidden after a comment ended by a lone carriage return", () => {
    expect(loneCr).not.toBe(demoText);
    // the control: wrangler's full reader sees them, so a gate that passes this would let wrangler publish them
    const root = mkdtempSync(join(tmpdir(), "deploy-demo-"));
    try {
      writeFileSync(join(root, "wrangler.demo.jsonc"), loneCr);
      const seen = unstable_readConfig({ config: join(root, "wrangler.demo.jsonc"), env: "" }, { hideWarnings: true });
      expect(seen.d1_databases.map((d: { binding: string }) => d.binding)).toEqual(["DB"]);
      expect(seen.vars).toEqual({ X: "y" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const r = gateOn(loneCr);
    expect(r.code).toBe(1);
    expect(r.log).toContain("key not allowed: d1_databases");
    expect(r.log).toContain("key not allowed: vars");
  });

  it.each([
    ["an unterminated string", '{"name": "la-table-demo'],
    ["an unterminated block comment", '{"a":1 /* unterminated'],
    ["a string ending on a backslash", '{"a": "x\\'],
    ["a doubled comma", '{"a": 1,, }'],
    ["an array", "[]"],
  ])("exits 2 on %s", (_label, text) => {
    const r = gateOn(text);
    expect(r.code).toBe(2);
    expect(r.log).toContain("cannot read");
  }, 5000);

  it("exits 2 when a configuration is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-demo-"));
    try {
      writeFileSync(join(root, "wrangler.jsonc"), appText);
      const lines: string[] = [];
      expect(runDemoGate(BUILDS, root, (l) => lines.push(l))).toBe(2);
      expect(lines.join("\n")).toContain("wrangler.demo.jsonc not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps string contents and drops real trailing commas, as wrangler does", () => {
    const text = '{"s":"a, ]", "u": "http://a.test/*not*/", "v": "//no", "e": "a\\"b,}", "t": [1, 2, /* c */ ], // x\n}';
    const root = mkdtempSync(join(tmpdir(), "deploy-demo-"));
    try {
      writeFileSync(join(root, "c.jsonc"), text);
      expect(readRawConfig(join(root, "c.jsonc"))).toEqual({ s: "a, ]", u: "http://a.test/*not*/", v: "//no", e: 'a"b,}', t: [1, 2] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Regression (review round 5, Task 9): wrangler's raw reader turns a "__proto__" key into the parsed object's prototype.
// The allowlist walked Object.keys, which skips it, and then read `cfg.x`, which follows it, so a configuration whose own
// keys were exactly the allowed ones exited 0 while wrangler deployed the main, the D1 binding and the variables its
// "__proto__" held; the same held inside "assets" for a binding and run_worker_first. The gate now refuses any parsed
// object that is not a plain object or array, reads own properties only, and checks wrangler's normalised configuration
// as well, against the one an allowed configuration normalises to.
describe("the gate refuses what a __proto__ key hides", () => {
  const protoAssets = demoText.replace(
    '"directory": "./dist-demo"',
    '"directory": "./dist-demo", "__proto__": {"binding": "ASSETS", "run_worker_first": ["/api/*"]}',
  );

  /** What `wrangler deploy --config` would read from this text, after normalisation. */
  function normalised(text: string): Record<string, unknown> {
    const root = mkdtempSync(join(tmpdir(), "deploy-demo-"));
    try {
      writeFileSync(join(root, "wrangler.demo.jsonc"), text);
      return unstable_readConfig({ config: join(root, "wrangler.demo.jsonc"), env: "" }, { hideWarnings: true }) as unknown as Record<string, unknown>;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("refuses a main, a D1 binding and variables held by a top-level __proto__", () => {
    // written as text: an object literal's __proto__ sets a prototype, which JSON.stringify drops
    const text = demoText.replace(
      '"name": "la-table-demo",',
      '"name": "la-table-demo", "__proto__": {"main": "src/worker/index.ts", "d1_databases": [{"binding":"DB","database_name":"la-table","database_id":"x"}], "vars": {"X":"y"}},',
    );
    expect(text).not.toBe(demoText);
    // the control: wrangler's own reader, and so the upload, sees them
    const seen = normalised(text) as { main?: string; d1_databases: { binding: string }[]; vars: Record<string, string> };
    expect(seen.main).toMatch(/src\/worker\/index\.ts$/);
    expect(seen.d1_databases.map((d) => d.binding)).toEqual(["DB"]);
    expect(seen.vars).toEqual({ X: "y" });
    // and the raw object's own keys are exactly the allowed ones, which is why Object.keys missed them
    const root = mkdtempSync(join(tmpdir(), "deploy-demo-"));
    try {
      writeFileSync(join(root, "c.jsonc"), text);
      expect(Object.keys(readRawConfig(join(root, "c.jsonc"))).sort()).toEqual(Object.keys(demo).sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const r = gateOn(text);
    expect(r.code).toBe(1);
    // each layer on its own: the raw walk, and wrangler's normalised reading against an allowed one
    expect(r.log).toContain("not a plain object or array at $:");
    expect(r.log).toContain("wrangler reads d1_databases =");
    expect(r.log).toContain("wrangler reads main =");
    expect(r.log).toContain("wrangler reads vars =");
  });

  it("refuses a binding and run_worker_first held by a __proto__ inside assets", () => {
    expect(protoAssets).not.toBe(demoText);
    const seen = normalised(protoAssets) as { assets: { binding?: string; run_worker_first?: unknown } };
    expect(seen.assets.binding).toBe("ASSETS");
    expect(seen.assets.run_worker_first).toEqual(["/api/*"]);
    const r = gateOn(protoAssets);
    expect(r.code).toBe(1);
    expect(r.log).toContain("not a plain object or array at $.assets:");
    expect(r.log).toContain("wrangler reads a value that is not a plain object or array at assets");
  });

  it("refuses an inherited key in demoConfigProblems, whatever the parser", () => {
    const inherited = Object.assign(Object.create({ d1_databases: [{ binding: "DB" }] }) as Record<string, unknown>, demo);
    expect(demoConfigProblems(inherited, appAccountId).length).toBeGreaterThan(0);
    const assetsInherited = { ...demo, assets: Object.assign(Object.create({ binding: "ASSETS" }) as object, { directory: "./dist-demo" }) };
    expect(demoConfigProblems(assetsInherited, appAccountId).length).toBeGreaterThan(0);
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, demo);
    expect(demoConfigProblems(nullProto, appAccountId).length).toBeGreaterThan(0);
  });

  it("checks wrangler's normalised configuration on its own, with no help from the raw allowlist", () => {
    const reference = normalised(demoText);
    expect(normalisedConfigProblems(reference, reference)).toEqual([]);
    for (const text of [
      demoText.replace('"name": "la-table-demo",', '"name": "la-table-demo", "__proto__": {"d1_databases": [{"binding":"DB","database_name":"la-table","database_id":"x"}]},'),
      demoText.replace('"name": "la-table-demo",', '"name": "la-table-demo", "__proto__": {"main": "src/worker/index.ts"},'),
      demoText.replace('"name": "la-table-demo",', '"name": "la-table-demo", "__proto__": {"routes": ["demo.example.com/*"]},'),
      demoText.replace('"name": "la-table-demo",', '"name": "la-table-demo", "kv_namespaces": [{"binding":"K","id":"x"}],'),
      protoAssets,
    ]) {
      expect(normalisedConfigProblems(normalised(text), reference).length).toBeGreaterThan(0);
    }
  });
});

// Regression (review round 6, Task 9): wrangler loads .env and .env.local from its working directory into process.env
// on every command, after this gate read process.env, and then takes WRANGLER_CI_OVERRIDE_NAME over the configuration's
// name. A root .env holding WRANGLER_CI_OVERRIDE_NAME=la-table passed the gate (exit 0) and made the demo's upload target
// the app's Worker. deploy:demo now passes --env-file=/dev/null, and the gate refuses any root dotenv file as well.
describe("the gate and the upload ignore dotenv files", () => {
  const HIJACK = "WRANGLER_CI_OVERRIDE_NAME=la-table\n";
  const { WRANGLER_CI_OVERRIDE_NAME: _o, ...noOverride } = BUILDS;

  it.each([".env", ".env.local", ".env.production", ".env.demo.local"])("refuses a root %s", (name) => {
    const r = gateOn(demoText, noOverride, { [name]: HIJACK });
    expect(r.code).toBe(1);
    expect(r.log).toContain(`${name} at the repository root`);
  });

  it("passes without one, and with the .env.example .gitignore lets in", () => {
    expect(gateOn(demoText, noOverride)).toEqual({ code: 0, log: "" });
    expect(gateOn(demoText, noOverride, { ".env.example": "" })).toEqual({ code: 0, log: "" });
  });

  it("keeps wrangler from reading a root .env when run with deploy:demo's flags", () => {
    const script = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts["deploy:demo"];
    const upload = (script ?? "").split(" && ").at(-1)!.split(" ");
    expect(upload.slice(0, 2)).toEqual(["wrangler", "deploy"]);
    const root = mkdtempSync(join(tmpdir(), "deploy-demo-"));
    try {
      writeFileSync(join(root, "wrangler.demo.jsonc"), demoText);
      writeFileSync(join(root, "wrangler.jsonc"), appText);
      mkdirSync(join(root, "dist-demo"));
      writeFileSync(join(root, "dist-demo", "index.html"), "<p>demo</p>");
      writeFileSync(join(root, ".env"), HIJACK);
      const dryRun = (args: string[]) => {
        const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...noOverride };
        const r = spawnSync(join(process.cwd(), "node_modules", ".bin", "wrangler"), [...args, "--dry-run"], { cwd: root, env, encoding: "utf8" });
        return `${r.stdout}${r.stderr}`;
      };
      // the control: without the flag, wrangler reads the .env and retargets the upload to the app's Worker
      expect(dryRun(["deploy", "--config", "wrangler.demo.jsonc"])).toContain('expected "la-table"');
      expect(dryRun(upload.slice(1))).not.toContain('expected "la-table"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
