import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CI_ACCESS_ID_VAR, CI_ACCESS_SECRET_VAR, PROBE_ENV_REFUSED, runDeploy, WORKSPACE_PARENT } from "./deploy-ci";
import { ACCOUNT, BUILD_TOKEN, HOSTILE_NAMES, INSTALLED, LOCKFILE, OWNED, READY, TOKEN, URL_OK, toolName, world } from "./deploy-ci.fake";
import { readDeployConfig } from "./deploy-config";
import { BUILD_ENV_PINS, spawnExec, SYSTEM_TOOLS, WRANGLER_ALLOWED, WRANGLER_BIN, type Call, type Exec } from "./deploy-target";

/**
 * Files a laptop or a build machine may hold beside the checked-out tree, each written to steer wrangler elsewhere.
 * `ignored` ones are gitignored, so the clean-tree check cannot see them: only the pinning keeps them inert, or, for
 * the `refused` ones, a refusal of its own.
 */
const STRAY: Record<string, { content: string; ignored: boolean; refused?: true }> = {
  ".env": { content: "CLOUDFLARE_ENV=staging\nCLOUDFLARE_ACCOUNT_ID=fedcba9876543210fedcba9876543210\nWRANGLER_CI_OVERRIDE_NAME=la-table-2\n", ignored: true },
  ".env.local": { content: "CLOUDFLARE_API_BASE_URL=https://evil.test/client/v4\n", ignored: true },
  ".dev.vars": { content: "DEV_SKIP_ACCESS=1\n", ignored: true },
  ".wrangler/deploy/config.json": { content: '{ "configPath": "../other.jsonc" }', ignored: true },
  ".wrangler/other.jsonc": { content: '{ "name": "la-table-2", "main": "../src/worker/index.ts", "workers_dev": true }', ignored: true },
  "node_modules/.cache/wrangler/wrangler-account.json": { content: '{ "account": { "id": "fedcba9876543210fedcba9876543210", "name": "autre" } }', ignored: true },
  "dist/index.html": { content: "<!doctype html><title>une autre branche</title>", ignored: true },
  "wrangler.toml": { content: 'name = "la-table-2"\nmain = "src/worker/index.ts"\n', ignored: false },
  "wrangler.json": { content: '{ "name": "la-table-2", "main": "src/worker/index.ts" }', ignored: false },
  "other.jsonc": { content: '{ "name": "la-table-2" }', ignored: false },
  // Node finds it before the repository's own node_modules when the deploy script imports wrangler (its configuration
  // reader) and resolves the wrangler it runs: refused, though git status cannot show it
  "scripts/node_modules/wrangler/package.json": { content: '{ "name": "wrangler", "version": "4.149.0", "main": "evil.js" }', ignored: true, refused: true },
};

/**
 * Files a machine may hold in a directory above the export, each one a tool of the build reads from there: a TypeScript
 * configuration remapping the Worker's jose, a package manifest, a dependency the export does not hold.
 */
const ABOVE: Record<string, string | null> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { jose: ["./evil-jose.js"] } } }),
  "jsconfig.json": JSON.stringify({ compilerOptions: { paths: { jose: ["./evil-jose.js"] } } }),
  "package.json": JSON.stringify({ type: "commonjs", imports: { "#jose": "./evil-jose.js" } }),
  // a directory: node_modules/jose/index.js
  node_modules: null,
};

/** "" and the memory setting are the NODE_OPTIONS values the deploy accepts; every other one makes it refuse. */
const NODE_OPTIONS_ACCEPTED = ["", "--max-old-space-size=4096"];
const HOSTILE_VALUES = ["--max-old-space-size=4096", "la-table-2", "staging", "fedcba9876543210fedcba9876543210", "/tmp/hostile", "https://evil.test", "1", "false", "--require=/tmp/hostile.js", ""];

const git = (cwd: string, ...args: string[]) => {
  // the test sets its scenes up with git as the shell runs it, replace refs honoured, even when the suite runs under the deploy's environment
  const { GIT_NO_REPLACE_OBJECTS: _noReplace, ...env } = process.env;
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

let tmp = "";
let origin = "";
let repo = "";
let sha = "";
/** Where the deploy exports the checked commit: the same path every run, so the calls of two runs compare; under WORKSPACE_PARENT, as the deploy's own. */
let exportDir = "";
/** The checked commit as files, read from the directory it was committed from. */
let committed: Record<string, string> = {};

/** A fresh clone of a ready repository at the same path every time, so a clean run's calls are the baseline. */
function freshClone(): void {
  rmSync(repo, { recursive: true, force: true });
  git(tmp, "clone", "-q", origin, repo);
  // installed from the commit's lockfile, as `npm ci` leaves it
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules/.package-lock.json"), INSTALLED);
}

const ciEnv = () => ({ WORKERS_CI: "1", WORKERS_CI_COMMIT_SHA: sha, WORKERS_CI_BRANCH: "main", CLOUDFLARE_API_TOKEN: BUILD_TOKEN, [CI_ACCESS_ID_VAR]: TOKEN.id, [CI_ACCESS_SECRET_VAR]: TOKEN.secret });

/** Every file under `dir` but git's own and the linked dependencies, as path → content. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name).slice(dir.length + 1);
    if (e.isDirectory() || path.split("/").some((p) => p === ".git" || p === "node_modules")) continue;
    out[path] = readFileSync(join(dir, path), "utf8");
  }
  return out;
}

async function deployIn(env: Record<string, string | undefined>) {
  const w = world({
    env, root: repo, local: spawnExec, readConfig: readDeployConfig, rounds: 2, mainRemote: origin,
    readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    workspace: { make: () => { rmSync(exportDir, { recursive: true, force: true }); mkdirSync(exportDir); return exportDir; }, remove: (dir) => rmSync(dir, { recursive: true, force: true }) },
    listDir: (dir) => { try { return readdirSync(dir); } catch { return null; } },
  });
  // what the build and each wrangler step find in the directory they run from, at the moment they run
  const seen: Record<string, string>[] = [];
  const exec: Exec = (call) => {
    if (!(SYSTEM_TOOLS as readonly string[]).includes(toolName(call.cmd))) seen.push(files(call.cwd));
    return w.deps.exec(call);
  };
  const code = await runDeploy({ ...w.deps, exec });
  return { code, calls: w.calls, log: w.log, seen };
}

const baseline: Record<"ci" | "laptop", Call[]> = { ci: [], laptop: [] };

beforeAll(async () => {
  tmp = mkdtempSync(join(realpathSync.native(WORKSPACE_PARENT), "la-table-deploy-prop-"));
  origin = join(tmp, "origin.git");
  repo = join(tmp, "repo");
  exportDir = join(tmp, "export");
  git(tmp, "init", "-q", "--bare", origin);
  const seed = join(tmp, "seed");
  git(tmp, "init", "-q", seed);
  copyFileSync(".gitignore", join(seed, ".gitignore"));
  mkdirSync(join(seed, "src/worker"), { recursive: true });
  writeFileSync(join(seed, "src/worker/index.ts"), "export default {};\n");
  mkdirSync(join(seed, "migrations"));
  writeFileSync(join(seed, "migrations/0001_init.sql"), "CREATE TABLE t (id INTEGER);\n");
  writeFileSync(join(seed, "package-lock.json"), LOCKFILE);
  // the deploy script as the commit holds it: what it imports, and the files it runs by
  mkdirSync(join(seed, "scripts"));
  writeFileSync(join(seed, "scripts/deploy-ci.ts"), 'import { DEFAULT_URL } from "../src/cli/client.ts";\n');
  mkdirSync(join(seed, "src/cli"), { recursive: true });
  writeFileSync(join(seed, "src/cli/client.ts"), `export const DEFAULT_URL = "${URL_OK}";\n`);
  writeFileSync(join(seed, "package.json"), '{ "name": "la-table" }\n');
  // tsx reads tsconfig.json, then the file it extends
  writeFileSync(join(seed, "tsconfig.json"), '{ "extends": "./tsconfig.base.json" }\n');
  writeFileSync(join(seed, "tsconfig.base.json"), "{}\n");
  const { routes: _r, ...cfg } = READY;
  writeFileSync(join(seed, "wrangler.jsonc"), JSON.stringify({ ...cfg, main: "src/worker/index.ts", compatibility_date: "2026-10-01", assets: { directory: "./dist", binding: "ASSETS" } }, null, 2));
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "ready");
  git(seed, "push", "-q", origin, "HEAD:main");
  sha = git(seed, "rev-parse", "HEAD");
  committed = files(seed);
  for (const mode of ["ci", "laptop"] as const) {
    freshClone();
    const run = await deployIn(mode === "ci" ? ciEnv() : {});
    expect({ mode, code: run.code, log: run.log.at(-1) }).toEqual({ mode, code: 0, log: expect.stringMatching(/^déployé et vu derrière Access/) });
    baseline[mode] = run.calls;
  }
}, 30_000);

afterAll(() => {
  vi.unstubAllEnvs();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("the deploy path under a hostile environment and stray files", () => {
  it("baselines: the clean runs pin the account, the Worker, the configuration and the rebuilt assets, all in the export", () => {
    const tree = join(exportDir, "tree");
    for (const calls of Object.values(baseline)) {
      const wrangler = calls.filter((c) => c.args[0] === WRANGLER_BIN);
      expect(wrangler.map((c) => c.args.slice(1, 3).join(" "))).toEqual(["auth token", "secret list", "d1 time-travel", "d1 migrations", "d1 migrations", "secret list", "deploy --name"]);
      for (const c of wrangler) {
        expect(c.args.slice(-4)).toEqual(["--config", join(tree, "wrangler.jsonc"), "--env=", "--env-file=/dev/null"]);
        expect(c.cwd).toBe(tree);
        expect(c.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
        for (const k of Object.keys(c.env)) expect(WRANGLER_ALLOWED).toContain(k);
      }
      const deploy = wrangler.at(-1)!;
      expect(deploy.args.slice(1, 6)).toEqual(["deploy", "--name", "la-table", "--assets", join(tree, "dist")]);
      const build = calls.find((c) => c.args.join(" ") === "run build:ci")!;
      expect(build.cwd).toBe(tree);
      // npm reads no configuration file from outside the commit, and the log carries no colour codes (deploy-target.test.ts runs both)
      expect(build.env).toEqual(expect.objectContaining(BUILD_ENV_PINS));
      expect(calls.indexOf(build)).toBeLessThan(calls.indexOf(deploy));
    }
  });

  // Regression: 9d650d0 — the gate checked one input while wrangler deployed from another (an ambient variable of the
  // shell or of Workers Builds, a stray configuration, .env or cache, a stale dist/), and each fix closed one case only
  it("calls wrangler with the same target and environment as a clean run, or refuses (exit 1 or 2), never deploys elsewhere", async () => {
    const numRuns = 100;
    // runs that got as far as wrangler: a refusal before it proves nothing about wrangler's environment
    let reached = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          ci: fc.boolean(),
          // drawn rarely, so that most runs get past the clean-tree and branch checks and reach wrangler
          otherBranch: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
          ignored: fc.subarray(Object.keys(STRAY).filter((f) => STRAY[f]!.ignored && !STRAY[f]!.refused)),
          // gitignored, yet refused: drawn on their own and rarely, so that a run holding one alone shows a missing refusal
          hidden: fc.oneof({ weight: 5, arbitrary: fc.constant<string[]>([]) }, { weight: 1, arbitrary: fc.subarray(Object.keys(STRAY).filter((f) => STRAY[f]!.refused), { minLength: 1 }) }),
          shown: fc.oneof({ weight: 3, arbitrary: fc.constant<string[]>([]) }, { weight: 1, arbitrary: fc.subarray(Object.keys(STRAY).filter((f) => !STRAY[f]!.ignored), { minLength: 1 }) }),
          // in the export's parent directory: drawn rarely, as the files git status shows
          above: fc.oneof({ weight: 3, arbitrary: fc.constant<string[]>([]) }, { weight: 1, arbitrary: fc.subarray(Object.keys(ABOVE), { minLength: 1 }) }),
          hostile: fc.dictionary(fc.constantFrom(...HOSTILE_NAMES), fc.constantFrom(...HOSTILE_VALUES)),
          noise: fc.dictionary(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,15}$/).filter((n) => !OWNED.has(n)), fc.string({ maxLength: 20 })),
        }),
        async ({ ci, otherBranch, ignored, hidden, shown, above, hostile, noise }) => {
          const files = [...ignored, ...hidden, ...shown];
          freshClone();
          for (const name of Object.keys(ABOVE)) rmSync(join(tmp, name), { recursive: true, force: true });
          for (const name of above) {
            const content = ABOVE[name];
            if (content === null || content === undefined) {
              mkdirSync(join(tmp, name, "jose"), { recursive: true });
              writeFileSync(join(tmp, name, "jose/index.js"), "export const jwtVerify = async () => ({ payload: {} });\n");
            } else {
              writeFileSync(join(tmp, name), content);
            }
          }
          for (const f of files) {
            mkdirSync(dirname(join(repo, f)), { recursive: true });
            writeFileSync(join(repo, f), STRAY[f]!.content);
          }
          // the laptop on another branch; Workers Builds building another branch
          if (otherBranch && !ci) {
            git(repo, "checkout", "-q", "-b", "other");
            git(repo, "commit", "-q", "--allow-empty", "-m", "other");
          }
          const env = { ...noise, ...hostile, ...(ci ? ciEnv() : {}), ...(ci && otherBranch ? { WORKERS_CI_BRANCH: "feature/x" } : {}) };
          for (const [k, v] of Object.entries({ ...noise, ...hostile })) vi.stubEnv(k, v);
          let run;
          try {
            run = await deployIn(env);
          } finally {
            vi.unstubAllEnvs();
            for (const name of above) rmSync(join(tmp, name), { recursive: true, force: true });
          }
          const expected = baseline[ci ? "ci" : "laptop"];
          // every call made is the clean run's call at the same place: same command, arguments, environment, directory
          expect(run.calls).toEqual(expected.slice(0, run.calls.length));
          const mustRefuse = otherBranch || files.some((f) => !STRAY[f]!.ignored || STRAY[f]!.refused) || above.length > 0;
          // a proxy or a TLS setting for the probe, a tsx or esbuild setting or another NODE_OPTIONS stop the deploy before anything else
          const refusedProcess = Object.keys(env).some((n) => n in PROBE_ENV_REFUSED || /^(TSX|ESBUILD)_/.test(n)) || ![undefined, ...NODE_OPTIONS_ACCEPTED].includes((env as Record<string, string | undefined>).NODE_OPTIONS);
          if (refusedProcess) expect({ code: run.code, calls: run.calls }).toEqual({ code: 2, calls: [] });
          else if (mustRefuse) expect(run.code).toBe(1);
          else expect({ code: run.code, log: run.log.at(-1) }).toEqual({ code: 0, log: expect.stringMatching(/^déployé et vu derrière Access/) });
          // nothing built or deployed from under a parent holding what the build reads
          if (above.length > 0) expect(run.seen).toEqual([]);
          if (run.code === 0) expect(run.calls).toEqual(expected);
          if (run.calls.some((c) => c.args[0] === WRANGLER_BIN)) reached++;
        },
      ),
      { numRuns },
    );
    // about a fifth of the runs reach wrangler (17.7 on average over six measured runs); the draws are unseeded, so the floor sits where
    // chance alone fails it about once in 30,000 runs (a tenth failed about once in 100), and a draw that stops reaching it
    // still fails it
    expect(reached).toBeGreaterThanOrEqual(numRuns / 20);
  }, 180_000);
});

/** The deploy's last line when its own code differs from the commit's. */
const GATE_REFUSED = /^le script de déploiement en cours n'est pas celui du commit [0-9a-f]{40} \(/;

/**
 * Ways a laptop's tree can differ from its HEAD: the first two git status shows, the rest git has been told to hide
 * (`showUntrackedFiles`, skip-worktree, assume-unchanged, info/exclude) or to rewrite on the way out (a local filter).
 * `refused`: hidden from git status, but refused all the same (it changes the deploy script), with that last log line.
 */
const TREE_STATES: Record<string, { set: () => void; shown: boolean; refused?: RegExp }> = {
  "an untracked migration": { set: () => writeFileSync(join(repo, "migrations/0099_evil.sql"), "DROP TABLE t;\n"), shown: true },
  "a modified Worker": { set: () => writeFileSync(join(repo, "src/worker/index.ts"), "export default { evil: true };\n"), shown: true },
  "showUntrackedFiles=no and an untracked migration": {
    set: () => { git(repo, "config", "status.showUntrackedFiles", "no"); writeFileSync(join(repo, "migrations/0099_evil.sql"), "DROP TABLE t;\n"); },
    shown: false,
  },
  "a skip-worktree Worker, modified": {
    set: () => { git(repo, "update-index", "--skip-worktree", "src/worker/index.ts"); writeFileSync(join(repo, "src/worker/index.ts"), "export default { evil: true };\n"); },
    shown: false,
  },
  "an assume-unchanged migration, modified": {
    set: () => { git(repo, "update-index", "--assume-unchanged", "migrations/0001_init.sql"); writeFileSync(join(repo, "migrations/0001_init.sql"), "DROP TABLE t;\n"); },
    shown: false,
  },
  "a migration listed in info/exclude": {
    set: () => { writeFileSync(join(repo, ".git/info/exclude"), "migrations/0099_evil.sql\n"); writeFileSync(join(repo, "migrations/0099_evil.sql"), "DROP TABLE t;\n"); },
    shown: false,
  },
  // Regression: b94ca0a — git honoured refs/replace/*: main replaced locally by an unpushed commit and the index
  // reset to it left git status clean and HEAD named as main, while the export and its proof both read the replacement
  "main replaced locally by another commit, index reset to it": {
    set: () => {
      git(repo, "checkout", "-q", "--detach");
      writeFileSync(join(repo, "migrations/0002_evil.sql"), "DROP TABLE t;\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "unpushed");
      const evil = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "main");
      git(repo, "replace", sha, evil);
      git(repo, "reset", "-q", "--hard");
    },
    shown: true,
  },
  // Regression: 105945a — the deploy script ran from the working tree, never compared with the commit: a change to
  // it, to what it imports or to what it runs by, that git status does not show, ran unseen
  "a skip-worktree deploy script, modified": {
    set: () => { git(repo, "update-index", "--skip-worktree", "scripts/deploy-ci.ts"); writeFileSync(join(repo, "scripts/deploy-ci.ts"), "process.exit(0);\n"); },
    shown: false,
    refused: GATE_REFUSED,
  },
  "an assume-unchanged module of the deploy script, another address in it": {
    set: () => { git(repo, "update-index", "--assume-unchanged", "src/cli/client.ts"); writeFileSync(join(repo, "src/cli/client.ts"), 'export const DEFAULT_URL = "https://la-table.autre.workers.dev";\n'); },
    shown: false,
    refused: GATE_REFUSED,
  },
  "an assume-unchanged tsconfig.json, remapping the deploy script's imports": {
    set: () => { git(repo, "update-index", "--assume-unchanged", "tsconfig.json"); writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { wrangler: ["./evil.ts"] } } })); },
    shown: false,
    refused: GATE_REFUSED,
  },
  // Regression: df00a65 — gateFiles compared tsconfig.json with the commit, never the file it extends, whose
  // `paths` tsx honours as well: a hidden remap there pointed the script's wrangler import at code outside the repository
  "a skip-worktree tsconfig.base.json, remapping the deploy script's imports outside the repository": {
    set: () => { git(repo, "update-index", "--skip-worktree", "tsconfig.base.json"); writeFileSync(join(repo, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { paths: { wrangler: [join(tmp, "evil.ts")] } } })); },
    shown: false,
    refused: GATE_REFUSED,
  },
};

describe("the deploy path on a tree that is not its commit", () => {
  // Regression: 18ec210 — the build and every wrangler step ran in the working tree, and the clean-tree check
  // (git status) missed what git was told to hide: a laptop deployed and migrated content that was not the checked
  // commit, tagged and seen live as that commit
  it.each(Object.entries(TREE_STATES))("%s: refused when git status shows it or it changes the deploy script, otherwise the commit itself is built and deployed", async (_name, state) => {
    freshClone();
    state.set();
    const run = await deployIn({});
    if (state.shown || state.refused) {
      expect(run.code).toBe(1);
      expect(run.seen).toEqual([]);
      if (state.refused) expect(run.log.at(-1)).toMatch(state.refused);
      return;
    }
    expect({ code: run.code, log: run.log.at(-1) }).toEqual({ code: 0, log: expect.stringMatching(/^déployé et vu derrière Access/) });
    expect(run.calls).toEqual(baseline.laptop);
    // the credential and the secrets read, the build, the four wrangler steps and the secrets read again before the upload
    expect(run.seen).toHaveLength(8);
    for (const tree of run.seen) expect(tree).toEqual(committed);
  });

  it("refuses (exit 1) an export a local git setting rewrites (a filter in info/attributes), before anything runs from it", async () => {
    freshClone();
    git(repo, "config", "filter.evil.smudge", "sed s/TABLE/VIEW/");
    writeFileSync(join(repo, ".git/info/attributes"), "*.sql filter=evil\n");
    const run = await deployIn({});
    expect(run.code).toBe(1);
    expect(run.seen).toEqual([]);
    expect(run.log.at(-1)).toMatch(/^l'export ne reproduit pas le commit .*migrations\/0001_init\.sql/);
  });

  // Regression: ae1daa7 — node_modules installed on another branch and never reinstalled was linked into the export
  // unchecked: its dependencies were bundled, built with and deployed by, under the tag of a commit that names others
  it("refuses (exit 1) a node_modules installed from another lockfile, before anything runs from the export", async () => {
    freshClone();
    const other = JSON.parse(INSTALLED) as { packages: Record<string, { version: string; integrity: string }> };
    other.packages["node_modules/jose"] = { version: "5.9.0", integrity: "sha512-synthetic-jose-5" };
    writeFileSync(join(repo, "node_modules/.package-lock.json"), JSON.stringify(other));
    const run = await deployIn({});
    expect(run.code).toBe(1);
    expect(run.seen).toEqual([]);
    expect(run.log.at(-1)).toMatch(/^node_modules n'est pas installé depuis le package-lock\.json du commit [0-9a-f]{40} \(node_modules\/jose\)/);
  });

  it("removes the export afterwards, and never the linked dependencies", async () => {
    freshClone();
    mkdirSync(join(repo, "node_modules/kept"), { recursive: true });
    writeFileSync(join(repo, "node_modules/kept/index.js"), "");
    expect((await deployIn({})).code).toBe(0);
    expect(() => readdirSync(exportDir)).toThrow(/ENOENT/);
    expect(readdirSync(join(repo, "node_modules/kept"))).toEqual(["index.js"]);
  });
});

describe("the laptop's view of main", () => {
  // Regression: 5880204 — « pushed main » was whatever the local origin resolved to: an origin pointing at another
  // repository whose main was the laptop's HEAD let an unpushed commit deploy
  it("refuses an unpushed HEAD even when origin names another repository whose main is that HEAD (exit 1)", async () => {
    freshClone();
    git(repo, "commit", "-q", "--allow-empty", "-m", "unpushed");
    const other = join(tmp, "other.git");
    rmSync(other, { recursive: true, force: true });
    git(tmp, "init", "-q", "--bare", other);
    git(repo, "push", "-q", other, "HEAD:main");
    git(repo, "remote", "set-url", "origin", other);
    const run = await deployIn({});
    expect(run.code).toBe(1);
    expect(run.seen).toEqual([]);
    expect(run.log.at(-1)).toBe("HEAD n'est pas le main de GitHub : seul main, poussé, se déploie");
  });
});

describe("spawnExec", () => {
  it("gives the child exactly the call's environment, never the caller's", () => {
    vi.stubEnv("CLOUDFLARE_ENV", "staging");
    vi.stubEnv("WRANGLER_CI_OVERRIDE_NAME", "la-table-2");
    try {
      const r = spawnExec({ cmd: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"], env: { PATH: "/usr/bin:/bin", ONLY: "this" }, cwd: tmpdir() });
      const seen = JSON.parse(r.stdout) as Record<string, string>;
      // macOS adds __CF_USER_TEXT_ENCODING to every process it starts
      expect(Object.fromEntries(Object.entries(seen).filter(([k]) => !k.startsWith("__CF")))).toEqual({ PATH: "/usr/bin:/bin", ONLY: "this" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
