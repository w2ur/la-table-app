import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deployConfigProblems, readDeployConfig, WORKER_TSCONFIG, workersDevSubdomain, type DeployConfig } from "./deploy-config";

const URL_OK = "https://la-table.w2ur.workers.dev";
const READY: DeployConfig = {
  name: "la-table",
  tsconfig: "tsconfig.worker.json",
  account_id: "0123456789abcdef0123456789abcdef",
  workers_dev: true,
  assets: { directory: "./dist" },
  preview_urls: false,
  version_metadata: { binding: "CF_VERSION_METADATA" },
  vars: { ACCESS_TEAM_DOMAIN: "revah.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64) },
  d1_databases: [{ binding: "DB", database_name: "la-table", database_id: "f57f7831-d014-4be5-8edc-0edd1a812c64" }],
  routes: [],
};
const keys = (problems: string[]) => problems.map((p) => p.split(" ")[0]);

describe("workersDevSubdomain", () => {
  it("reads the account subdomain of the app's workers.dev address, and nothing else", () => {
    expect(workersDevSubdomain(URL_OK)).toBe("w2ur");
    expect(workersDevSubdomain(`${URL_OK}/`)).toBe("w2ur");
    for (const bad of ["http://la-table.w2ur.workers.dev", "https://autre.w2ur.workers.dev", "https://la-table.w2ur.workers.dev/app", "https://la-table.w2ur.workers.dev:8443",
      "https://0b7c3d4e-la-table.w2ur.workers.dev", "https://la-table.a.b.workers.dev", "https://la-table.w2ur.workers.dev.evil.test", "https://table.revah.paris", "pas une adresse"]) {
      expect({ bad, sub: workersDevSubdomain(bad) }).toEqual({ bad, sub: null });
    }
  });
});

describe("deployConfigProblems", () => {
  it("passes a configuration served only on its workers.dev address, with a version marker and real ids", () => {
    expect(deployConfigProblems(READY, URL_OK)).toEqual([]);
    const { routes: _r, ...noRoutes } = READY;
    expect(deployConfigProblems(noRoutes, URL_OK)).toEqual([]);
  });

  it("refuses the local Access bypass in vars, whatever its value", () => {
    for (const value of ["1", "0", ""]) {
      expect(deployConfigProblems({ ...READY, vars: { ...READY.vars, DEV_SKIP_ACCESS: value } }, URL_OK)).toEqual([
        "vars porte DEV_SKIP_ACCESS : le contournement d'Access ne se déploie jamais",
      ]);
    }
  });

  it("requires workers.dev explicitly on and version URLs explicitly off (unset leaves Cloudflare's setting as it was)", () => {
    const { workers_dev: _w, preview_urls: _p, ...unset } = READY;
    expect(deployConfigProblems(unset, URL_OK)).toEqual([
      "workers_dev doit valoir true : l'adresse workers.dev, derrière Access, est la seule de l'app",
      "preview_urls doit valoir false : une adresse de version est publique dès qu'elle existe",
    ]);
    expect(keys(deployConfigProblems({ ...READY, workers_dev: false, preview_urls: true, keep_vars: true }, URL_OK))).toEqual(["workers_dev", "preview_urls", "keep_vars"]);
  });

  it("refuses any route: the app has one address, the one the probes watch", () => {
    for (const routes of [["la-table.revah.paris/*"], [{ pattern: "table.revah.paris", custom_domain: true }]]) {
      expect(keys(deployConfigProblems({ ...READY, routes }, URL_OK))).toEqual(["routes"]);
    }
  });

  // Regression: c4654ad — wrangler keeps the singular `route` as its own key, which the gate never read: a config
  // with `route` and no `routes` passed, serving the app on a host the probes never watch
  it("refuses the singular route too, as wrangler resolves it", () => {
    expect(keys(deployConfigProblems({ ...READY, route: "x.example/*" }, URL_OK))).toEqual(["routes"]);
    expect(keys(deployConfigProblems({ ...READY, route: { pattern: "table.revah.paris", custom_domain: true } }, URL_OK))).toEqual(["routes"]);
    const dir = mkdtempSync(join(tmpdir(), "la-table-route-"));
    try {
      const src = readFileSync("wrangler.jsonc", "utf8").replace('"main": "src/worker/index.ts"', `"main": ${JSON.stringify(resolve("src/worker/index.ts"))}`);
      const withRoute = src.replace('"name": "la-table",', '"name": "la-table",\n  "route": "table.revah.paris/*",');
      expect(withRoute).not.toBe(src);
      writeFileSync(join(dir, "wrangler.jsonc"), withRoute);
      const cfg = readDeployConfig(join(dir, "wrangler.jsonc"));
      expect(cfg.route).toBe("table.revah.paris/*");
      expect(keys(deployConfigProblems(cfg))).toContain("routes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: cf565ce — the gate read whichever environment CLOUDFLARE_ENV named, while the wrangler steps now
  // read the top level: both must read the same one
  it("reads the top level, whatever CLOUDFLARE_ENV names", () => {
    const dir = mkdtempSync(join(tmpdir(), "la-table-env-"));
    vi.stubEnv("CLOUDFLARE_ENV", "staging");
    try {
      const src = readFileSync("wrangler.jsonc", "utf8").replace('"main": "src/worker/index.ts"', `"main": ${JSON.stringify(resolve("src/worker/index.ts"))}`);
      const withEnv = src.replace('"name": "la-table",', '"name": "la-table",\n  "env": { "staging": { "workers_dev": true } },');
      expect(withEnv).not.toBe(src);
      writeFileSync(join(dir, "wrangler.jsonc"), withEnv);
      expect(readDeployConfig(join(dir, "wrangler.jsonc")).name).toBe("la-table");
      // read under the environment it is given, and the caller's put back after, even when the read throws
      expect(process.env.CLOUDFLARE_ENV).toBe("staging");
      expect(() => readDeployConfig(join(dir, "absent.jsonc"))).toThrow();
      expect(process.env.CLOUDFLARE_ENV).toBe("staging");
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires the account wrangler deploys to, named in the configuration (wrangler reads it before any variable or cache)", () => {
    const { account_id: _a, ...unset } = READY;
    expect(deployConfigProblems(unset, URL_OK)).toEqual([
      "account_id doit nommer le compte Cloudflare (32 caractères hexadécimaux) : wrangler le lit avant tout le reste (undefined)",
    ]);
    for (const bad of ["", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", "${CLOUDFLARE_ACCOUNT_ID}"]) {
      expect(keys(deployConfigProblems({ ...READY, account_id: bad }, URL_OK))).toEqual(["account_id"]);
    }
  });

  it("requires the assets to be the build's output, which the deploy rebuilds", () => {
    for (const directory of ["dist", "./dist", "dist/", "./dist/"]) expect(deployConfigProblems({ ...READY, assets: { directory } }, URL_OK)).toEqual([]);
    for (const assets of [undefined, {}, { directory: "./public" }, { directory: "../dist" }, { directory: "src/app/dist" }]) {
      expect(keys(deployConfigProblems({ ...READY, assets }, URL_OK))).toEqual(["assets.directory"]);
    }
  });

  // Regression: 2a9b251 — wrangler.jsonc named no tsconfig, so esbuild looked for a tsconfig.json in every directory
  // above the Worker's sources, the export's parents included: one there remapped jose in a bundle tagged as the commit
  it("requires the Worker's own tsconfig, named beside the configuration, so esbuild looks for no other", () => {
    const { tsconfig: _t, ...unnamed } = READY;
    expect(deployConfigProblems(unnamed, URL_OK)).toEqual([
      "tsconfig doit valoir ./tsconfig.worker.json : sans lui, esbuild cherche un tsconfig.json au-dessus des sources du Worker, hors du commit (undefined)",
    ]);
    for (const tsconfig of ["tsconfig.json", "../tsconfig.worker.json", "/tmp/tsconfig.worker.json", "src/tsconfig.worker.json"]) {
      expect(keys(deployConfigProblems({ ...READY, tsconfig }, URL_OK))).toEqual(["tsconfig"]);
    }
    // read back relative to the configuration, whatever the working directory of the process reading it
    const dir = mkdtempSync(join(tmpdir(), "la-table-tsconfig-"));
    const cwd = process.cwd();
    try {
      const src = readFileSync("wrangler.jsonc", "utf8").replace('"main": "src/worker/index.ts"', `"main": ${JSON.stringify(resolve("src/worker/index.ts"))}`);
      writeFileSync(join(dir, "wrangler.jsonc"), src);
      expect(readDeployConfig(join(dir, "wrangler.jsonc")).tsconfig).toBe(WORKER_TSCONFIG);
      process.chdir(tmpdir());
      expect(readDeployConfig(join(dir, "wrangler.jsonc")).tsconfig).toBe(WORKER_TSCONFIG);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses another Worker name and a missing version marker", () => {
    expect(keys(deployConfigProblems({ ...READY, name: "la-table-preview", version_metadata: undefined }, URL_OK))).toEqual(["name", "version_metadata.binding"]);
  });

  it("refuses the placeholders, a malformed team domain or AUD tag, and another database name", () => {
    const problems = deployConfigProblems({
      ...READY,
      vars: { ACCESS_TEAM_DOMAIN: "REPLACE_ME.cloudflareaccess.com", ACCESS_AUD: "REPLACE_ME" },
      d1_databases: [{ binding: "DB", database_name: "la-table", database_id: "00000000-0000-0000-0000-000000000000" }],
    }, URL_OK);
    expect(keys(problems)).toEqual(["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "database_id"]);
    expect(deployConfigProblems({ ...READY, vars: { ...READY.vars, ACCESS_TEAM_DOMAIN: "https://revah.cloudflareaccess.com" } }, URL_OK)).toHaveLength(1);
    expect(deployConfigProblems({ ...READY, vars: { ...READY.vars, ACCESS_AUD: "A".repeat(64) } }, URL_OK)).toHaveLength(1);
    expect(deployConfigProblems({ ...READY, d1_databases: [{ ...READY.d1_databases![0]!, database_name: "sttew" }] }, URL_OK)).toHaveLength(1);
  });

  // Regression: 745d97c — the gate checked the DB entry only, while the bookmark and the migrations name the database
  // la-table, which wrangler resolves to the first entry whose database_name or binding is la-table: an earlier entry
  // sent the restore point and the migrations to another database than the one the Worker reads
  it("refuses any second D1 database: wrangler would pick the first named la-table for the bookmark and the migrations", () => {
    const db = READY.d1_databases![0]!;
    const other = "0b7c3d4e-0000-4000-8000-000000000001";
    for (const d1_databases of [
      [{ binding: "OLD", database_name: "la-table", database_id: other }, db],
      [db, { binding: "la-table", database_name: "autre", database_id: other }],
      [db, { binding: "CACHE", database_name: "cache", database_id: other }],
    ]) {
      expect(keys(deployConfigProblems({ ...READY, d1_databases }, URL_OK))).toEqual(["d1_databases"]);
    }
  });

  it("refuses a CLI address that is not the Worker's workers.dev one, or still the placeholder", () => {
    expect(deployConfigProblems(READY, "https://la-table.replace-me.workers.dev")).toEqual([
      "DEFAULT_URL (src/cli/client.ts) porte encore le sous-domaine provisoire : https://la-table.replace-me.workers.dev",
    ]);
    expect(keys(deployConfigProblems(READY, "https://table.revah.paris"))).toEqual(["DEFAULT_URL"]);
  });
});

describe("wrangler.jsonc and DEFAULT_URL as the deploy reads them", () => {
  it("are ready to deploy: every guard holds and every value is Cloudflare's", () => {
    expect(deployConfigProblems(readDeployConfig())).toEqual([]);
  });

  // Regression: 96143bd — the probe Workers deployed by hand named no account, so plain `wrangler deploy` took one from the shell, a .env or its cache
  it("pin the probe Workers deployed by hand to the app's account, as wrangler reads it before the shell or its cache", () => {
    const app = readDeployConfig().account_id;
    expect(app).toMatch(/^[0-9a-f]{32}$/);
    for (const probe of ["probes/placeholder/wrangler.jsonc", "probes/d1-limit/wrangler.jsonc"]) {
      expect({ probe, account: readDeployConfig(probe).account_id }).toEqual({ probe, account: app });
    }
  });
});
