import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_URL } from "../src/cli/client";
import { ACCESS_TIMEOUT_MS, accessInFront, tokenAccepted, ANCESTOR_REFUSED, CI_ACCESS_ID_VAR, CLIENT_PATH, declaredDefaultUrl, GATE_ENTRY, GATE_EXTRA, gateFiles, GATE_TSCONFIG, extendedConfigs, parseJsonc, CI_ACCESS_SECRET_VAR, deployedAddresses, entryDeps, GATE_PATHS, installMismatch, liveHealth, MAIN_REMOTE, NODE_OPTIONS_ALLOWED, nodeTrustStore, PROBE_ENV_REFUSED, processRefusal, relativeImports, runDeploy, shadowingModules, versionTag, widenedTrust, WORKSPACE_PARENT, type AccessAnswer } from "./deploy-ci";
import { ACCOUNT, ALLOWED_NODE_OPTIONS, API, BUILD_TOKEN, OAUTH_TOKEN, SUBDOMAIN, type Account, CI_ENV, COMMIT_FILES, COMMIT_PATHS, HOSTILE_NAMES, INSTALLED, LOCKFILE, ok, READY, ROOT, SHA, TAG, TEAM, TOKEN, TREE, URL_OK, WORKSPACE, world } from "./deploy-ci.fake";
import { DEPLOY_CONFIG_PATH } from "./deploy-config";
import { baseEnv, BUILD_ENV_PINS, WRANGLER_DROPPED, type Call, type Exec } from "./deploy-target";

const BASE = URL_OK;
const FRONT: AccessAnswer[] = GATE_PATHS.map((path) => ({ path, front: true, detail: `302 vers ${TEAM}` }));
const FETCH = `git fetch ${MAIN_REMOTE} refs/heads/main`;
const LAPTOP_GIT = ["git status --porcelain", FETCH, "git rev-parse HEAD", "git rev-parse FETCH_HEAD"];
/** The export of the checked commit, proved equal to it, which the build and every wrangler step run from. */
const EXPORT = [
  `git archive --format=tar --prefix=tree/ -o ${WORKSPACE}/commit.tar ${SHA}`,
  `tar -x -f ${WORKSPACE}/commit.tar -C ${WORKSPACE}`,
  `git ls-tree -r -z --full-tree ${SHA}`,
  `find ${TREE} ! -type d -print0`,
  `git hash-object --no-filters -- ${COMMIT_PATHS.map((p) => `${TREE}/${p}`).join(" ")}`,
  // the deploy's own files, in the working tree
  `git hash-object --no-filters -- ${COMMIT_PATHS.map((p) => `${ROOT}/${p}`).join(" ")}`,
  `ln -s ${ROOT}/node_modules ${TREE}/node_modules`,
];
const PINS = `--config ${TREE}/${DEPLOY_CONFIG_PATH} --env= --env-file=/dev/null`;
/** What the deploy reads with wrangler once the target is printed, before asking Access: nothing it writes. */
const READS = [`wrangler auth token --json ${PINS}`, `wrangler secret list --name la-table --format json ${PINS}`];
/** The wrangler steps that write: after Access, the build and its checks. */
const WRANGLER_STEPS = [
  `wrangler d1 time-travel info la-table --json ${PINS}`,
  `wrangler d1 migrations apply la-table --remote ${PINS}`,
  `wrangler d1 migrations list la-table --remote ${PINS}`,
  `wrangler deploy --name la-table --assets ${TREE}/dist --tag ${TAG} --message commit ${TAG} ${PINS}`,
];
/** The secrets read again just before the upload, after the migrations: the deploy's wrangler calls in order. */
const DEPLOY_STEPS = [...WRANGLER_STEPS.slice(0, 3), READS[1]!, WRANGLER_STEPS[3]!];
/** The two paths Access is asked on that no application could name: fresh hex under the API and at the root. */
const FRESH = [/^\/api\/[0-9a-f]{16}$/, /^\/[0-9a-f]{16}$/];
const remote = (lines: string[]) => lines.filter((l) => l.startsWith("wrangler") || l.startsWith("npm"));

/** Node's own directory, where `npm i -g` puts every global package's bins beside node and npm. */
const NODE_DIR = dirname(process.execPath);
/** System tools a global package could ship a bin of the same name for, planted in NODE_DIR by the tests below. */
const PLANTED = new Set(["git", "tar", "find", "ln", "sh"].map((name) => join(NODE_DIR, name)));
/** Where a call's command resolves, as the system's execvp does: itself when it names a path, else the first directory of its PATH holding it, PLANTED included. */
const resolvedCommand = (call: Call) => (call.cmd.includes("/") ? call.cmd : (call.env.PATH ?? "").split(":").map((dir) => join(dir, call.cmd)).find((p) => PLANTED.has(p) || existsSync(p)) ?? null);
/** The calls whose command would run a bin planted in node's directory: none, or a global install replaces git's proof. */
const plantedRuns = (calls: readonly Call[]) => calls.map(resolvedCommand).filter((p) => p !== null && PLANTED.has(p));

describe("versionTag", () => {
  it("is the first 12 hex digits of a full commit hash, and nothing else", () => {
    expect(versionTag(SHA)).toBe(TAG);
    for (const bad of ["", "86225a9", SHA.toUpperCase(), `${SHA}0`, "main"]) expect(versionTag(bad)).toBeNull();
  });
});

describe("accessInFront", () => {
  /** Cloudflare with Access in front (a 302 to the team's login), or the placeholder Worker answering by itself. */
  const site = (front: boolean) => async (input: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("accept")).toBe("text/html");
    expect(init?.redirect).toBe("manual");
    return front
      ? new Response(null, { status: 302, headers: { location: `https://${TEAM}/cdn-cgi/access/login/la-table.w2ur.workers.dev?kid=k&redirect_url=${encodeURIComponent(new URL(input).pathname)}` } })
      : Response.json({ ok: false, placeholder: true }, { status: 503 });
  };

  /** The named paths only: what each answer is read as, whatever path it was asked on. */
  const ask = (f: Parameters<typeof accessInFront>[0], timeoutMs = ACCESS_TIMEOUT_MS) => accessInFront(f, BASE, TEAM, timeoutMs, GATE_PATHS);

  it("sees Access's login on the page and on the API", async () => {
    expect(await ask(site(true))).toEqual(FRONT);
  });

  it("sees the Worker answering by itself, or a redirect anywhere but the team (the control)", async () => {
    expect((await ask(site(false))).map((a) => [a.path, a.front, a.detail])).toEqual([["/", false, "503 vers rien"], ["/api/health", false, "503 vers rien"]]);
    const elsewhere = async () => new Response(null, { status: 302, headers: { location: "https://evil.test/cdn-cgi/access/login" } });
    expect((await ask(elsewhere)).every((a) => a.front === false)).toBe(true);
    for (const status of [200, 301, 307]) {
      const notA302 = async () => new Response(null, { status, headers: { location: `https://${TEAM}/cdn-cgi/access/login` } });
      expect((await ask(notA302)).map((a) => a.front)).toEqual([false, false]);
    }
    const pageOnly = async (input: string, init?: RequestInit) => (input.endsWith("/api/health") ? Response.json({ ok: true }) : site(true)(input, init));
    expect((await ask(pageOnly)).map((a) => a.front)).toEqual([true, false]);
  });

  it("reports an unreachable address as unknown, not as Access missing", async () => {
    expect((await ask(async () => { throw new Error("ENOTFOUND"); })).map((a) => a.front)).toEqual([null, null]);
  });

  // Regression: 60cf2db — only / and /api/health were asked: Access scoped to those two paths (a path-scoped
  // application, a mis-scoped bypass) passed the gate and the closing check while every other path was served without it
  it("also asks, by default, a fresh path under the API and one at the root, which no application names", async () => {
    const seen: string[] = [];
    const named = async (input: string, init?: RequestInit) => {
      seen.push(new URL(input).pathname);
      return (GATE_PATHS as readonly string[]).includes(new URL(input).pathname) ? site(true)(input, init) : new Response("<!doctype html>", { status: 200 });
    };
    const first = await accessInFront(named, BASE, TEAM);
    expect(first.map((a) => a.front)).toEqual([true, true, false, false]);
    expect(first.slice(0, 2).map((a) => a.path)).toEqual([...GATE_PATHS]);
    first.slice(2).forEach((a, i) => expect(a.path).toMatch(FRESH[i]!));
    expect(seen).toEqual(first.map((a) => a.path));
    // fresh every time: an application cannot be scoped to them in advance
    const second = await accessInFront(site(true), BASE, TEAM);
    expect(second.map((a) => a.front)).toEqual([true, true, true, true]);
    expect(second.slice(2).map((a) => a.path)).not.toEqual(first.slice(2).map((a) => a.path));
  });

  // Regression: 1a563fb — the probe waited on the live address with no time limit: an address that never answered
  // left deploy:ci hanging until Workers Builds killed it, instead of exiting 2 at once
  it("gives up on an address that never answers, as unknown", async () => {
    const hung = (_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const answers = await ask(hung, 20);
    expect(answers.map((a) => a.front)).toEqual([null, null]);
    for (const a of answers) expect(a.detail).toMatch(/^injoignable : /);
  }, 2000);
});

describe("liveHealth", () => {
  const headers = { "CF-Access-Client-Id": TOKEN.id, "CF-Access-Client-Secret": TOKEN.secret };

  it("reads the running version's tag through Access with the service token", async () => {
    const w = world({ live: { tag: TAG } });
    expect(await liveHealth(w.deps.fetch, BASE, headers)).toEqual({ reached: true, tag: TAG, detail: `version ${TAG}` });
  });

  it("reaches no Worker when Access refuses the token, redirects, or nobody answers (the controls)", async () => {
    expect(await liveHealth(world({ live: { tokenAccepted: false } }).deps.fetch, BASE, headers)).toEqual({ reached: false, tag: null, detail: "jeton Access refusé (403)" });
    expect(await liveHealth(world().deps.fetch, BASE, {})).toEqual({ reached: false, tag: null, detail: "redirigé vers la connexion Access, jeton refusé (302)" });
    expect((await liveHealth(world({ live: { access: "unreachable" } }).deps.fetch, BASE, headers)).reached).toBe(false);
    expect(await liveHealth(async () => new Response("<html>", { status: 200 }), BASE, headers)).toEqual({ reached: false, tag: null, detail: "réponse illisible (200)" });
    expect(await liveHealth(async () => Response.json({ ok: true, tag: null }), BASE, headers)).toEqual({ reached: true, tag: null, detail: "version sans étiquette" });
  });
});

describe("tokenAccepted", () => {
  const headers = { "CF-Access-Client-Id": TOKEN.id, "CF-Access-Client-Secret": TOKEN.secret };

  it("is true when anything but Access's refusal answers, the placeholder's 503 and the Worker's own 401 included", async () => {
    for (const status of [200, 404, 500, 503]) expect({ status, ...(await tokenAccepted(async () => new Response(null, { status }), BASE, headers)) }).toEqual({ status, accepted: true, detail: String(status) });
    expect((await tokenAccepted(world().deps.fetch, BASE, headers)).accepted).toBe(true);
  });

  it("is false for a redirect to the login, a 401 or a 403, and null when nothing answers (the controls)", async () => {
    for (const status of [302, 307, 401, 403]) expect({ status, ...(await tokenAccepted(async () => new Response(null, { status }), BASE, headers)) }).toEqual({ status, accepted: false, detail: String(status) });
    expect((await tokenAccepted(world({ live: { tokenAccepted: false } }).deps.fetch, BASE, headers)).accepted).toBe(false);
    expect(await tokenAccepted(async () => { throw new Error("ENOTFOUND"); }, BASE, headers)).toEqual({ accepted: null, detail: "injoignable : ENOTFOUND" });
  });
});

describe("runDeploy", () => {
  it("in Workers Builds: prints the target, sees Access, rebuilds, then bookmark, migrations, the tagged deploy, and sees it live", async () => {
    const w = world({ env: CI_ENV });
    expect(await runDeploy(w.deps)).toBe(0);
    expect(w.lines()).toEqual(["git status --porcelain", "git rev-parse HEAD", ...EXPORT, ...READS, "npm run build:ci", ...DEPLOY_STEPS]);
    expect(w.log).toEqual([
      `cible : Worker la-table, compte ${ACCOUNT}, ${URL_OK}, base la-table`,
      `cible : configuration ${TREE}/wrangler.jsonc, ressources ${TREE}/dist, commit ${SHA} (version ${TAG})`,
      `sous-domaine workers.dev du compte ${ACCOUNT} : ${SUBDOMAIN}, celui de ${URL_OK}`,
      "routes et domaines du Worker la-table : aucun, seule son adresse workers.dev",
      "secrets du Worker la-table : aucun",
      `Access devant / : oui (302 vers ${TEAM})`,
      `Access devant /api/health : oui (302 vers ${TEAM})`,
      expect.stringMatching(/^Access devant \/api\/[0-9a-f]{16} : oui \(302 vers /),
      expect.stringMatching(/^Access devant \/[0-9a-f]{16} : oui \(302 vers /),
      `jeton Access accepté par ${URL_OK} (200)`,
      'point de restauration D1 : {"bookmark":"00000085-0000024c"}',
      expect.stringMatching(/^migrations restantes : [^]*✅ No migrations to apply!$/),
      `Access devant / avant l'envoi : oui (302 vers ${TEAM})`,
      `Access devant /api/health avant l'envoi : oui (302 vers ${TEAM})`,
      expect.stringMatching(/^Access devant \/api\/[0-9a-f]{16} avant l'envoi : oui \(302 vers /),
      expect.stringMatching(/^Access devant \/[0-9a-f]{16} avant l'envoi : oui \(302 vers /),
      "routes et domaines du Worker la-table avant l'envoi : aucun, seule son adresse workers.dev",
      "secrets du Worker la-table avant l'envoi : aucun",
      `déploiement : Uploaded la-table (1.20 sec)\nDeployed la-table triggers (0.40 sec)\n  ${URL_OK}\nCurrent Version ID: 0b7c3d4e-0000`,
      `déployé : version ${TAG}`,
      `après déploiement, tour 1 : version ${TAG} (attendue)`,
      `Access devant / après déploiement : oui (302 vers ${TEAM})`,
      `Access devant /api/health après déploiement : oui (302 vers ${TEAM})`,
      expect.stringMatching(/^Access devant \/api\/[0-9a-f]{16} après déploiement : oui \(302 vers /),
      expect.stringMatching(/^Access devant \/[0-9a-f]{16} après déploiement : oui \(302 vers /),
      `déployé et vu derrière Access : version ${TAG} sur ${URL_OK}`,
    ]);
  });

  it("refuses a configuration with a problem before asking Access or running anything (exit 1)", async () => {
    let asked = false;
    const w = world({ env: CI_ENV, config: { name: "la-table" } });
    const fetch = w.deps.fetch;
    expect(await runDeploy({ ...w.deps, fetch: (i, init) => { asked = true; return fetch(i, init); } })).toBe(1);
    expect(asked).toBe(false);
    expect(w.calls).toEqual([]);
    expect(w.log[0]).toMatch(/^configuration refusée : account_id doit nommer le compte Cloudflare/);
  });

  it("refuses to deploy when Access is not in front of the live address (exit 1), or cannot be read (exit 2)", async () => {
    const open = world({ env: CI_ENV, live: { access: "open" } });
    expect(await runDeploy(open.deps)).toBe(1);
    expect(remote(open.lines())).toEqual(READS);
    expect(open.log.at(-1)).toBe("Access n'est pas devant l'adresse de l'app : déploiement refusé");
    const unknown = world({ env: CI_ENV, live: { access: "unreachable" } });
    expect(await runDeploy(unknown.deps)).toBe(2);
    expect(remote(unknown.lines())).toEqual(READS);
    expect(unknown.log.at(-1)).toBe("Access n'a pas pu être vérifié : déploiement refusé");
  });

  // Regression: 60cf2db — Access in front of / and /api/health only let the deploy through, and passed its closing check
  it("refuses (exit 1) Access in front of the named paths only, before the deploy and after it", async () => {
    const before = world({ env: CI_ENV, live: { access: "named" } });
    expect(await runDeploy(before.deps)).toBe(1);
    expect(remote(before.lines())).toEqual(READS);
    expect(before.log.at(-1)).toBe("Access n'est pas devant l'adresse de l'app : déploiement refusé");
    const after = world({ env: CI_ENV });
    const exec = after.deps.exec;
    const deps = { ...after.deps, exec: (c: Parameters<typeof exec>[0]) => { const r = exec(c); if (c.args[1] === "deploy") after.live.access = "named"; return r; } };
    expect(await runDeploy(deps)).toBe(1);
    expect(after.log.at(-1)).toBe(`Access n'est plus devant ${URL_OK} : la version ${TAG} répond sans lui`);
  });

  it("stops at the first failing step (exit 2): no deploy when the migrations fail", async () => {
    const w = world({ env: CI_ENV, answers: { "wrangler d1 migrations": { status: 1, stdout: "", stderr: "D1_ERROR" } } });
    expect(await runDeploy(w.deps)).toBe(2);
    expect(w.lines().some((c) => c.startsWith("wrangler deploy"))).toBe(false);
    expect(w.log.at(-1)).toBe("migrations impossible (wrangler 1) : D1_ERROR");
  });

  it("from a laptop, deploys only a clean tree at GitHub's main and tags it with HEAD", async () => {
    const clean = world();
    expect(await runDeploy(clean.deps)).toBe(0);
    expect(clean.lines()).toEqual([...LAPTOP_GIT, ...EXPORT, ...READS, "npm run build:ci", ...DEPLOY_STEPS]);

    const dirty = world({ answers: { "git status": ok(" M wrangler.jsonc\n?? wrangler.toml\n") } });
    expect(await runDeploy(dirty.deps)).toBe(1);
    expect(remote(dirty.lines())).toEqual([]);
    expect(dirty.log.at(-1)).toBe("arbre de travail modifié : committez et poussez avant de déployer (M wrangler.jsonc, ?? wrangler.toml)");

    const ahead = world({ answers: { "git rev-parse FETCH_HEAD": ok(`${"0".repeat(40)}\n`) } });
    expect(await runDeploy(ahead.deps)).toBe(1);
    expect(remote(ahead.lines())).toEqual([]);
  });

  it("cannot name the commit (exit 2): git unreadable, or a claimed sha that is not one", async () => {
    expect(await runDeploy(world({ answers: { "git status": { status: 128, stdout: "", stderr: "not a git repository" } } }).deps)).toBe(2);
    const short = world({ env: { ...CI_ENV, WORKERS_CI_COMMIT_SHA: "86225a9" } });
    expect(await runDeploy(short.deps)).toBe(2);
    expect(short.calls).toEqual([]);
  });

  it("in Workers Builds, refuses a tree that is not the commit it says it built (exit 1)", async () => {
    const w = world({ env: CI_ENV, answers: { "git rev-parse HEAD": ok(`${"1".repeat(40)}\n`) } });
    expect(await runDeploy(w.deps)).toBe(1);
    expect(remote(w.lines())).toEqual([]);
    expect(w.log.at(-1)).toBe(`Workers Builds annonce le commit ${SHA}, l'arbre est à ${"1".repeat(40)} : déploiement refusé`);
  });

  // Regression: 5e77caf — the gate read wrangler.jsonc by path, which skips wrangler's .wrangler/deploy/config.json
  // redirect, while the wrangler steps passed no -c and followed it: a stray redirect deployed a configuration never checked
  it("runs every wrangler step on the configuration the gate checked, never on a redirect", async () => {
    const read: string[] = [];
    const w = world({ env: CI_ENV });
    expect(await runDeploy({ ...w.deps, readConfig: (path, env) => { read.push(path); return w.deps.readConfig(path, env); } })).toBe(0);
    // the working tree's, for an early refusal, then the commit's, which wrangler is given
    expect(read).toEqual([`${ROOT}/wrangler.jsonc`, `${TREE}/wrangler.jsonc`]);
    const wrangler = w.lines().filter((c) => c.startsWith("wrangler"));
    expect(wrangler).toHaveLength(READS.length + DEPLOY_STEPS.length);
    for (const c of wrangler) expect(c).toContain(` --config ${read[1]} `);
  });

  // Regression: 393698b — from a laptop, deploy:ci uploaded whatever dist/ was on disk (gitignored, so a feature
  // branch's build passed the clean-tree check) under origin/main's tag
  it("rebuilds dist/ from the checked commit before any wrangler step, and deploys exactly that directory", async () => {
    for (const env of [{}, CI_ENV]) {
      const w = world({ env });
      expect(await runDeploy(w.deps)).toBe(0);
      const lines = w.lines();
      expect(lines.indexOf("npm run build:ci")).toBeGreaterThan(lines.indexOf("git rev-parse HEAD"));
      expect(lines.indexOf("npm run build:ci")).toBeLessThan(lines.findIndex((c) => WRANGLER_STEPS.includes(c)));
      expect(lines.at(-1)).toContain(` --assets ${TREE}/dist `);
    }
    const broken = world({ answers: { "npm run build:ci": { status: 1, stdout: "", stderr: "vite: error" } } });
    expect(await runDeploy(broken.deps)).toBe(2);
    expect(broken.lines().filter((c) => c.startsWith("wrangler"))).toEqual(READS);

    const dirty = world({ answers: { "git status": ok(" M src/app/main.tsx\n") } });
    expect(await runDeploy(dirty.deps)).toBe(1);
    expect(dirty.lines()).not.toContain("npm run build:ci");
  });
});

describe("runDeploy, the migrations applied", () => {
  // Regression: 3d0cde9 — wrangler 4.149 exits 0 when a migration's API result reports failure without an error
  // note, so the deploy shipped new code against an unmigrated schema, and /api/health, which reads no table, saw it live
  it("deploys nothing (exit 2) while wrangler still lists a pending migration after applying them", async () => {
    for (const stdout of ["Migrations to be applied:\n┌──────────────┐\n│ Name │\n│ 0003_new.sql │", "", "No migrations"]) {
      const w = world({ env: CI_ENV, answers: { "wrangler d1 migrations list": ok(stdout) } });
      expect({ stdout, code: await runDeploy(w.deps) }).toEqual({ stdout, code: 2 });
      expect(w.lines().filter((c) => c.startsWith("wrangler"))).toEqual([...READS, ...WRANGLER_STEPS.slice(0, 3)]);
      expect(w.log.at(-1)).toBe("migrations encore en attente après leur application : déploiement refusé");
    }
    const listFails = world({ env: CI_ENV, answers: { "wrangler d1 migrations list": { status: 1, stdout: "", stderr: "D1_ERROR" } } });
    expect(await runDeploy(listFails.deps)).toBe(2);
    expect(listFails.lines().some((c) => c.startsWith("wrangler deploy"))).toBe(false);
  });
});

describe("runDeploy, the commit's own suite", () => {
  // Regression: 06cb158 — typecheck and tests ran only in the working tree (npm run deploy's build:ci), which git can
  // hide changes in: a skip-worktree fix there gave a green suite, and the commit, whose suite was red, deployed
  it("typechecks, tests and builds in the export before any wrangler step: a red suite there deploys nothing (exit 2)", async () => {
    for (const env of [{}, CI_ENV]) {
      const red = world({ env, answers: { "npm run build:ci": { status: 1, stdout: "", stderr: "1 failed" } } });
      expect(await runDeploy(red.deps)).toBe(2);
      expect(red.lines().filter((c) => c.startsWith("wrangler"))).toEqual(READS);
      expect(red.calls.find((c) => c.cmd === "npm")).toMatchObject({ args: ["run", "build:ci"], cwd: TREE });
      expect(red.log.at(-1)).toBe("typecheck, tests et build impossible (npm 1) : 1 failed");
    }
    // the laptop's script runs nothing in the working tree before the deploy
    const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.deploy).toBe("npm run deploy:ci");
  });
});

describe("runDeploy, the restore point", () => {
  // Regression: 90bfce8 — the bookmark step counted as done whenever wrangler exited 0, so an empty or bookmark-less
  // answer let the migrations run with no restore point printed
  it("runs no migration when wrangler exits 0 without a bookmark (exit 2)", async () => {
    for (const stdout of ["", "{}", '{"bookmark":""}', '{"bookmark":42}', "not json", "null"]) {
      const w = world({ env: CI_ENV, answers: { "wrangler d1 time-travel": ok(stdout) } });
      expect({ stdout, code: await runDeploy(w.deps) }).toEqual({ stdout, code: 2 });
      expect(w.lines().filter((c) => c.startsWith("wrangler"))).toEqual([...READS, WRANGLER_STEPS[0]]);
      expect(w.log.at(-1)).toBe("aucun point de restauration D1 lu : migrations refusées");
    }
  });
});

describe("runDeploy, the laptop's view of main", () => {
  // Regression: da884e2 — the laptop compared HEAD with the local origin/main ref and never fetched: a stale
  // origin/main equal to an old HEAD let the laptop deploy, and migrate from, a commit older than the one deployed
  it("fetches GitHub's main before comparing HEAD with it, and stops when it cannot (exit 2)", async () => {
    const fresh = world();
    expect(await runDeploy(fresh.deps)).toBe(0);
    const lines = fresh.lines();
    expect(lines.indexOf(FETCH)).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(FETCH)).toBeLessThan(lines.indexOf("git rev-parse FETCH_HEAD"));

    const offline = world({ answers: { "git fetch": { status: 128, stdout: "", stderr: "Could not resolve host: github.com" } } });
    expect(await runDeploy(offline.deps)).toBe(2);
    expect(remote(offline.lines())).toEqual([]);
    expect(offline.log.at(-1)).toBe("GitHub injoignable : impossible de vérifier que HEAD est le main poussé (Could not resolve host: github.com)");

    const ci = world({ env: CI_ENV });
    expect(await runDeploy(ci.deps)).toBe(0);
    expect(ci.lines()).not.toContain(FETCH);
  });

  it("refuses half of Workers Builds' claim (a commit without WORKERS_CI=1) before reading any token or running anything (exit 1)", async () => {
    const { WORKERS_CI: _ci, ...half } = CI_ENV;
    for (const env of [half, { ...CI_ENV, WORKERS_CI: "0" }]) {
      const w = world({ env, keychain: false });
      expect(await runDeploy(w.deps)).toBe(1);
      expect(w.calls).toEqual([]);
      expect(w.log).toEqual(["WORKERS_CI_COMMIT_SHA sans WORKERS_CI=1 : ni Workers Builds ni un laptop, déploiement refusé"]);
    }
  });
});

describe("runDeploy, a configuration wrangler cannot read", () => {
  // Regression: a6baa23 — a configuration wrangler could not read (malformed jsonc, a validation error) threw out of
  // the entry point, and tsx exited 1, a finding, where the convention says 2, could not run
  it("answers 2 (could not run), in French, when the configuration cannot be read", async () => {
    const unreadable = world({ env: CI_ENV, config: () => { throw new Error("wrangler.jsonc: Unexpected token"); } });
    expect(await runDeploy(unreadable.deps)).toBe(2);
    expect(unreadable.log).toEqual(["déploiement impossible : wrangler.jsonc: Unexpected token"]);
    expect(unreadable.calls).toEqual([]);

    const notAnError = world({ config: () => { throw "jsonc"; } });
    expect(await runDeploy(notAnError.deps)).toBe(2);
    expect(notAnError.log).toEqual(["déploiement impossible : jsonc"]);
  });
});

describe("runDeploy, wrangler's own environment", () => {
  // Regression: cf565ce — wrangler loads a gitignored .env into its environment, which the gate never read: a stray
  // CLOUDFLARE_ENV deployed a second Worker, la-table-<env>, outside Access, and a CLOUDFLARE_ACCOUNT_ID another account
  it("gives every wrangler step the top level, no .env file, and an environment without the caller's CLOUDFLARE_ENV", async () => {
    const env = { ...CI_ENV, CLOUDFLARE_ENV: "staging" };
    const w = world({ env });
    const read: Record<string, string>[] = [];
    expect(await runDeploy({ ...w.deps, readConfig: (path, e) => { read.push(e); return w.deps.readConfig(path, e); } })).toBe(0);
    expect(read).toEqual([baseEnv(), baseEnv()]);
    const wrangler = w.calls.filter((c) => c.cmd === process.execPath);
    expect(wrangler).toHaveLength(READS.length + DEPLOY_STEPS.length);
    for (const c of wrangler) {
      expect(c.args.slice(-4)).toEqual(["--config", `${TREE}/wrangler.jsonc`, "--env=", "--env-file=/dev/null"]);
      expect(c.env).toEqual({ ...baseEnv(), CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: BUILD_TOKEN });
    }
  });

  // every name the deploy must keep from its subprocesses, one at a time: the property test draws them at random and
  // can miss a single one; this asks each, in both modes, every time. HOME and PATH are baseEnv's own names: its values
  // must not come from the caller's, so the expected environment is read before the caller's is set
  // Regression: 20706d6 — HOME and PATH were never set in this process's own environment here, so a baseEnv that
  // read process.env.HOME passed every deterministic test; only some property runs caught it
  const DROPPED = [...Object.keys(WRANGLER_DROPPED), "http_proxy", "HTTP_PROXY", "GIT_WORK_TREE", "XDG_CACHE_HOME", "HOME", "PATH"];
  /** Each subprocess's environment: baseEnv as read before any caller's variable is set, plus wrangler's own two. */
  const expectFixedEnv = (calls: readonly Call[], fixed: Readonly<Record<string, string>>, ci: boolean) => {
    const wrangler = calls.filter((c) => c.cmd === process.execPath);
    expect(wrangler).toHaveLength(READS.length + DEPLOY_STEPS.length);
    for (const c of wrangler) expect(c.env).toEqual({ ...fixed, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ...(ci ? { CLOUDFLARE_API_TOKEN: BUILD_TOKEN } : {}) });
    // the build: npm with no configuration file read from outside the commit, and no colour
    for (const c of calls.filter((c) => c.cmd !== process.execPath)) expect(c.env).toEqual(c.cmd === "npm" ? { ...fixed, ...BUILD_ENV_PINS } : fixed);
    expect(plantedRuns(calls)).toEqual([]);
  };
  describe.each(["ci", "laptop"] as const)("in %s mode", (mode) => {
    it.each(DROPPED)("keeps the caller's %s from every subprocess", async (name) => {
      // NODE_OPTIONS with any other token stops the deploy (below): an accepted one must still reach no subprocess
      const value = mode === "ci" && name === "WORKERS_CI_BRANCH" ? "main" : name === "NODE_OPTIONS" ? ALLOWED_NODE_OPTIONS : "https://evil.test/la-table-2";
      const env = mode === "ci" ? { ...CI_ENV, [name]: value } : { [name]: value };
      const fixed = baseEnv();
      vi.stubEnv(name, value);
      try {
        const w = world({ env });
        // the probe's own network settings: refused outright (below), so nothing runs to leak them to
        if (name in PROBE_ENV_REFUSED) {
          expect(await runDeploy(w.deps)).toBe(2);
          expect(w.calls).toEqual([]);
          return;
        }
        expect(await runDeploy(w.deps)).toBe(0);
        expectFixedEnv(w.calls, fixed, mode === "ci");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("keeps every hostile name at once from every subprocess", async () => {
      // the probe's network settings, tsx's and esbuild's own: refused outright, so nothing runs to leak them to
      const names = HOSTILE_NAMES.filter((n) => !(n in PROBE_ENV_REFUSED) && !/^(TSX|ESBUILD)_/.test(n));
      const hostile = Object.fromEntries(names.map((n) => [n, n === "NODE_OPTIONS" ? ALLOWED_NODE_OPTIONS : "https://evil.test/la-table-2"]));
      const fixed = baseEnv();
      for (const [k, v] of Object.entries(hostile)) vi.stubEnv(k, v);
      try {
        const w = world({ env: mode === "ci" ? { ...hostile, ...CI_ENV } : hostile });
        expect(await runDeploy(w.deps)).toBe(0);
        expectFixedEnv(w.calls, fixed, mode === "ci");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("runs git and the export in the repository, the build and wrangler in the export, from the fixed environment, whatever the caller's", async () => {
    const w = world({ env: { GIT_DIR: "/elsewhere/.git", PATH: "/hostile/bin", HOME: "/hostile", npm_config_registry: "https://evil.test" } });
    expect(await runDeploy(w.deps)).toBe(0);
    for (const c of w.calls.filter((c) => c.cmd !== process.execPath)) expect({ c: c.cmd, env: c.env, cwd: c.cwd }).toEqual({ c: c.cmd, env: c.cmd === "npm" ? { ...baseEnv(), ...BUILD_ENV_PINS } : baseEnv(), cwd: c.cmd === "npm" ? TREE : ROOT });
    for (const c of w.calls.filter((c) => c.cmd === process.execPath)) expect({ env: c.env, cwd: c.cwd }).toEqual({ env: { ...baseEnv(), CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, cwd: TREE });
  });

  // Regression: 7a2d5b6 — baseEnv's PATH puts node's own directory first, where `npm i -g` installs every global
  // bin: a package shipping a `git`, `tar`, `find` or `ln` replaced the tools the export's proof relies on
  it.each(["ci", "laptop"] as const)("in %s mode, runs git, tar, find and ln from the system's directories, never a bin planted beside node", async (mode) => {
    const w = world({ env: mode === "ci" ? CI_ENV : {} });
    expect(await runDeploy(w.deps)).toBe(0);
    expect(plantedRuns(w.calls)).toEqual([]);
    const ran = w.calls.map(resolvedCommand);
    for (const tool of ["git", "tar", "find", "ln"]) expect({ tool, system: ran.some((p) => p === `/usr/bin/${tool}` || p === `/bin/${tool}`) }).toEqual({ tool, system: true });
  });

  it.each(["ci", "laptop"] as const)("in %s mode, does not run (exit 2), before any call or request, when a system tool is in neither /usr/bin nor /bin", async (mode) => {
    let asked = false;
    const w = world({ env: mode === "ci" ? CI_ENV : {}, executable: (p) => !p.endsWith("/tar") && (p.startsWith("/usr/bin/") || p.startsWith("/bin/") || p.startsWith(NODE_DIR)) });
    const fetch = w.deps.fetch;
    expect(await runDeploy({ ...w.deps, fetch: (i, init) => { asked = true; return fetch(i, init); } })).toBe(2);
    expect({ asked, calls: w.calls, log: w.log }).toEqual({ asked: false, calls: [], log: ["tar introuvable dans /usr/bin et /bin : la preuve de l'export ne s'appuie que sur les outils du système, déploiement impossible"] });
  });
});

describe("runDeploy, the code this process runs", () => {
  // Regression: ff4c05c — this process runs the gate from the working tree, and nothing refused what loads or resolves
  // other code into it: a TSX_ setting (TSX_TSCONFIG_PATH remapping the wrangler import), a NODE_OPTIONS --import or
  // --require, or a run from a directory whose tsconfig.json tsx would read
  it("refuses to run (exit 2), in either mode, before any call or request, with a tsx setting, another NODE_OPTIONS or another directory", async () => {
    const cases: [Record<string, string>, string | null, string][] = [
      [{ TSX_TSCONFIG_PATH: "/tmp/evil.json" }, null, "TSX_TSCONFIG_PATH est défini : tsx résoudrait les imports du script de déploiement autrement que le commit, déploiement refusé"],
      [{ TSX_DISABLE_CACHE: "1" }, null, "TSX_DISABLE_CACHE est défini : tsx résoudrait les imports du script de déploiement autrement que le commit, déploiement refusé"],
      ...["--import=./evil.mjs", "--require", "--openssl-config=/tmp/x.cnf", "--use-env-proxy", "--use-system-ca", "--max-old-space-size=4096 --import ./evil.mjs", "--max-old-space-size"].map((v): [Record<string, string>, null, string] => [
        { NODE_OPTIONS: v }, null, `NODE_OPTIONS porte ${v.split(" ").find((t) => !t.startsWith("--max-old-space-size=")) ?? v} : ce processus chargerait ou réglerait autre chose que le commit (seules la mémoire et les avertissements se règlent), déploiement refusé`,
      ]),
      [{}, "/elsewhere", `lancé depuis /elsewhere, pas depuis le dépôt ${ROOT} : tsx y chercherait un autre tsconfig.json pour résoudre les imports du script, déploiement refusé`],
    ];
    for (const [extra, cwd, line] of cases) {
      for (const env of [extra, { ...CI_ENV, ...extra }]) {
        let asked = false;
        const w = world({ env });
        const fetch = w.deps.fetch;
        expect(await runDeploy({ ...w.deps, ...(cwd ? { cwd } : {}), fetch: (i, init) => { asked = true; return fetch(i, init); } })).toBe(2);
        expect({ asked, calls: w.calls, log: w.log }).toEqual({ asked: false, calls: [], log: [line] });
      }
    }
  });

  // Regression: fa309e0 — an ESBUILD_ variable was not refused, though tsx's esbuild reads ESBUILD_BINARY_PATH
  // to pick the binary that transpiles the deploy script itself
  it("refuses to run (exit 2), in either mode, before any call or request, with an esbuild setting", async () => {
    for (const name of ["ESBUILD_BINARY_PATH", "ESBUILD_WORKER_THREADS", "ESBUILD_MAX_BUFFER"]) {
      for (const env of [{ [name]: "/tmp/esbuild" }, { ...CI_ENV, [name]: "" }]) {
        let asked = false;
        const w = world({ env });
        const fetch = w.deps.fetch;
        expect(await runDeploy({ ...w.deps, fetch: (i, init) => { asked = true; return fetch(i, init); } })).toBe(2);
        expect({ asked, calls: w.calls, log: w.log }).toEqual({ asked: false, calls: [], log: [`${name} est défini : tsx transpilerait le script de déploiement avec un autre esbuild que celui du dépôt, déploiement refusé`] });
      }
    }
  });

  it("runs with NODE_OPTIONS made only of accepted tokens, blank or unset, from the repository", async () => {
    for (const value of [undefined, "", "  ", ALLOWED_NODE_OPTIONS, "--no-warnings --enable-source-maps --max-semi-space-size=64 --no-deprecation"]) {
      expect(processRefusal(value === undefined ? {} : { NODE_OPTIONS: value }, ROOT, ROOT)).toBeNull();
      const w = world({ env: { ...CI_ENV, ...(value === undefined ? {} : { NODE_OPTIONS: value }) } });
      expect(await runDeploy(w.deps)).toBe(0);
    }
    expect(NODE_OPTIONS_ALLOWED.some((ok) => ok.test("--max-old-space-size=4096x"))).toBe(false);
  });
});

describe("runDeploy, the probe's own network", () => {
  // Regression: e76d0d8 — the Access probe ran with the caller's network settings: with NODE_USE_ENV_PROXY and a
  // proxy, and a CA or TLS check switched off, a local proxy could answer the team's 302 and the tagged health for
  // an address with no Access in front
  it.each(Object.keys(PROBE_ENV_REFUSED))("refuses to run (exit 2), in either mode, before any call or request, when %s is set", async (name) => {
    for (const env of [{ [name]: "1" }, { ...CI_ENV, [name]: "" }]) {
      let asked = false;
      const w = world({ env });
      const fetch = w.deps.fetch;
      expect(await runDeploy({ ...w.deps, fetch: (i, init) => { asked = true; return fetch(i, init); } })).toBe(2);
      expect({ asked, calls: w.calls }).toEqual({ asked: false, calls: [] });
      expect(w.log).toEqual([`${name} est défini : la vérification d'Access passerait par un autre chemin (${PROBE_ENV_REFUSED[name]}), déploiement refusé`]);
    }
  });

  // Regression: 6e0eff9 — only NODE_EXTRA_CA_CERTS was refused: NODE_USE_SYSTEM_CA=1 or NODE_OPTIONS=--use-system-ca
  // (Node 24.19: 122 roots instead of 120 here), or --use-openssl-ca with SSL_CERT_FILE, SSL_CERT_DIR or OPENSSL_CONF,
  // let the probe trust a root that could sign for the address, so an interceptor could answer the team's 302
  it.each(["NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENSSL_CONF"])("refuses %s, which widens the authorities the probe trusts", async (name) => {
    const w = world({ env: { ...CI_ENV, [name]: "1" } });
    expect(await runDeploy(w.deps)).toBe(2);
    expect(w.calls).toEqual([]);
    expect(w.log[0]).toMatch(new RegExp(`^${name} est défini : `));
  });

  /** A self-signed root made for this test only (its key was never kept): one authority Node does not ship. */
  const SYNTHETIC_ROOT = [
    "-----BEGIN CERTIFICATE-----",
    "MIIBgTCCASigAwIBAgIUNUNyeBqHK6Gn09/9HWSC3plQyNcwCgYIKoZIzj0EAwIw",
    "JzElMCMGA1UEAwwcbGEtdGFibGUgdGVzdCBDQSAoc3ludGhldGljKTAeFw0yNjEw",
    "MTMxMTE2MzlaFw0zNjEwMTAxMTE2MzlaMCcxJTAjBgNVBAMMHGxhLXRhYmxlIHRl",
    "c3QgQ0EgKHN5bnRoZXRpYykwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATvaFO9",
    "BXa1fI13kNXLN9pZSvayUijt/wMEyog+7tgRS9Y810q844zSdV6/nSMmTrYHff1M",
    "2+zsVsE+DbmHp2xBozIwMDAdBgNVHQ4EFgQUvvO2r6ILO0WvjCrc0nI8vMHQ+Sgw",
    "DwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBJD0tCdDovdnGiw7ka",
    "FAZuRJ/oPbQ3zaOtgQ7+vI7pXAIgH0CW+wp15MEXmDjLtcsdR1cnFTdn0X4jmxQF",
    "BokEsqA=",
    "-----END CERTIFICATE-----",
  ].join("\n");

  // Regression: 6e0eff9 — a trust store widened by a flag (NODE_OPTIONS=--use-system-ca) rather than a refused name
  // passed: the gate read variable names, not the authorities the process actually trusts
  it("refuses to run (exit 2), before any call or request, when the process trusts other authorities than Node's own", async () => {
    const bundled = ["root A", "root B"];
    for (const [trusted, why] of [[[...bundled, "system root"], "1 de plus, 0 de moins"], [[], "0 de plus, 2 de moins"], [["root A", "other"], "1 de plus, 1 de moins"]] as const) {
      let asked = false;
      const w = world({ env: CI_ENV, caCertificates: (kind) => (kind === "bundled" ? bundled : trusted) });
      const fetch = w.deps.fetch;
      expect(await runDeploy({ ...w.deps, fetch: (i, init) => { asked = true; return fetch(i, init); } })).toBe(2);
      expect({ asked, calls: w.calls }).toEqual({ asked: false, calls: [] });
      expect(w.log).toEqual([`ce processus ne fait pas confiance aux seules autorités de certification de Node (${why}) : une autre pourrait signer pour l'adresse et répondre à la place d'Access, déploiement refusé`]);
    }
    // the same list in another order is the same store
    expect(widenedTrust((kind) => (kind === "bundled" ? bundled : [...bundled].reverse()))).toBeNull();
  });

  it("reads the store Node really uses: one root added to it at run time is refused (the control: none added, none refused)", async () => {
    const before = getCACertificates("default");
    expect(widenedTrust(nodeTrustStore)).toBeNull();
    try {
      setDefaultCACertificates([...getCACertificates("bundled"), SYNTHETIC_ROOT]);
      const w = world({ env: CI_ENV, caCertificates: nodeTrustStore });
      expect(await runDeploy(w.deps)).toBe(2);
      expect(w.calls).toEqual([]);
      expect(w.log[0]).toMatch(/\(1 de plus, 0 de moins\)/);
    } finally {
      setDefaultCACertificates(before);
    }
    expect(widenedTrust(nodeTrustStore)).toBeNull();
  });
});

describe("runDeploy, the branch Workers Builds built", () => {
  // Regression: 5518851 — any commit Workers Builds named deployed, whatever its branch: a feature branch given
  // deploy:ci as its command would migrate and deploy production; only main deploys
  it("refuses any branch but main before running any command (exit 1)", async () => {
    for (const branch of ["feature/x", "Main", "", undefined]) {
      const w = world({ env: { ...CI_ENV, WORKERS_CI_BRANCH: branch } });
      expect({ branch, code: await runDeploy(w.deps) }).toEqual({ branch, code: 1 });
      expect(w.calls).toEqual([]);
      expect(w.log.at(-1)).toBe(`branche ${branch ?? "inconnue"} : seul main se déploie`);
    }
  });
});

describe("runDeploy, the Worker wrangler deploys", () => {
  // Regression: 954f03d — wrangler deploys under WRANGLER_CI_OVERRIDE_NAME whenever it is set (Workers Builds sets
  // it to the Worker the repo is connected to): another name passed the gate and the probe of la-table, migrated the
  // real database, and uploaded the app as a second Worker on its own workers.dev address, outside Access
  it("never hands wrangler an override name: whatever the caller sets, the deploy names la-table", async () => {
    for (const name of ["la-table-2", "", "la-table", undefined]) {
      const w = world({ env: { ...CI_ENV, WRANGLER_CI_OVERRIDE_NAME: name } });
      expect(await runDeploy(w.deps)).toBe(0);
      const deploy = w.calls.at(-1)!;
      expect(deploy.args.slice(1, 4)).toEqual(["deploy", "--name", "la-table"]);
      for (const c of w.calls) expect(Object.keys(c.env)).not.toContain("WRANGLER_CI_OVERRIDE_NAME");
    }
  });
});

describe("runDeploy, the account wrangler deploys to", () => {
  // Regression: 9dd2b14 — a CLOUDFLARE_ACCOUNT_ID exported in a laptop shell reached every wrangler step: the
  // probe checked la-table on this account while the migrations and the deploy went to the other one, outside Access
  it("gives wrangler the configuration's account, never the shell's", async () => {
    for (const variable of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"]) {
      const w = world({ env: { [variable]: "fedcba9876543210fedcba9876543210" } });
      expect(await runDeploy(w.deps)).toBe(0);
      for (const c of w.calls.filter((c) => c.cmd === process.execPath)) {
        expect(c.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
        expect(c.env.CF_ACCOUNT_ID).toBeUndefined();
      }
    }
  });
});

describe("runDeploy, Access asked again before the upload", () => {
  // Regression: 0acda1d — Access was asked once, before the export's build (about 50 s locally, longer in Workers
  // Builds), the bookmark and the migrations: Access switched off, or the Worker recreated without it, in those minutes
  // still let the upload run, and the closing check saw it only once the app was live
  it("uploads nothing (exit 1) when Access stops answering during the build, the bookmark or the migrations", async () => {
    for (const step of ["npm", "time-travel", "migrations apply", "migrations list"]) {
      const w = world({ env: CI_ENV });
      const exec = w.deps.exec;
      const deps = { ...w.deps, exec: (c: Parameters<typeof exec>[0]) => { const r = exec(c); if (c.cmd === step || c.args.join(" ").includes(step)) w.live.access = "open"; return r; } };
      expect({ step, code: await runDeploy(deps) }).toEqual({ step, code: 1 });
      expect(w.lines().some((c) => c.startsWith("wrangler deploy"))).toBe(false);
      expect(w.log.at(-1)).toBe("Access n'est pas devant l'adresse de l'app avant l'envoi : déploiement refusé");
    }
  });

  it("uploads nothing (exit 1 or 2) when the second probe sees Access on named paths only, or cannot reach the address", async () => {
    for (const [access, code, last] of [["named", 1, "Access n'est pas devant l'adresse de l'app avant l'envoi : déploiement refusé"], ["unreachable", 2, "Access n'a pas pu être vérifié avant l'envoi : déploiement refusé"]] as const) {
      const w = world({ env: CI_ENV });
      const exec = w.deps.exec;
      const deps = { ...w.deps, exec: (c: Parameters<typeof exec>[0]) => { const r = exec(c); if (c.cmd === "npm") w.live.access = access; return r; } };
      expect({ access, code: await runDeploy(deps) }).toEqual({ access, code });
      expect(w.lines().filter((c) => c.startsWith("wrangler"))).toEqual([...READS, ...WRANGLER_STEPS.slice(0, 3)]);
      expect(w.log.at(-1)).toBe(last);
    }
  });
});

describe("runDeploy, the Worker's addresses and secrets read again before the upload", () => {
  type Hook = (w: ReturnType<typeof world>) => void;
  /** Runs `hook` once the build has finished, as the dashboard would change the Worker in those minutes. */
  const afterBuild = (w: ReturnType<typeof world>, hook: Hook, answers?: (c: Parameters<Exec>[0]) => ReturnType<Exec> | null) => {
    const exec = w.deps.exec;
    let built = false;
    return { ...w.deps, exec: (c: Parameters<typeof exec>[0]) => { const r = exec(c); if (c.cmd === "npm") { built = true; hook(w); } return (built ? answers?.(c) : null) ?? r; } };
  };

  // Regression: ea915ac — the routes, custom domains and secrets were read once, before the build, the bookmark and the migrations (minutes), and only Access was asked again before the upload: a domain, a route or a secret added in those minutes shipped the app
  it("uploads nothing (exit 1) when a custom domain or a route is attached during the build", async () => {
    for (const [attach, named] of [[(w: ReturnType<typeof world>) => w.account.domains.push("table.example.test"), "table.example.test"], [(w: ReturnType<typeof world>) => w.account.routes.push("table.example.test/*"), "table.example.test/*"]] as const) {
      const w = world({ env: CI_ENV });
      expect({ named, code: await runDeploy(afterBuild(w, attach)) }).toEqual({ named, code: 1 });
      expect(w.lines().some((c) => c.startsWith("wrangler deploy"))).toBe(false);
      expect(w.log.at(-1)).toBe(`le Worker la-table répond aussi sur ${named}, attaché dans le tableau de bord : l'app n'a que son adresse workers.dev, que les sondes regardent ; retirez-le, puis redéployez (vu avant l'envoi)`);
    }
  });

  it("uploads nothing (exit 1) when a secret is put on the Worker during the build", async () => {
    const w = world({ env: CI_ENV });
    const deps = afterBuild(w, () => {}, (c) => (c.args.includes("secret") ? ok('[{"name":"DEV_SKIP_ACCESS","type":"secret_text"}]') : null));
    expect(await runDeploy(deps)).toBe(1);
    expect(w.lines().some((c) => c.startsWith("wrangler deploy"))).toBe(false);
    expect(w.log.at(-1)).toMatch(/^le Worker la-table porte des secrets \(DEV_SKIP_ACCESS\).*\(vu avant l'envoi\)$/);
  });

  it("cannot check (exit 2) when the API stops listing them during the build, and uploads nothing", async () => {
    const w = world({ env: CI_ENV });
    expect(await runDeploy(afterBuild(w, (x) => { x.account.api = "down"; }))).toBe(2);
    expect(w.lines().some((c) => c.startsWith("wrangler deploy"))).toBe(false);
    expect(w.log.at(-1)).toMatch(/^routes et domaines du Worker la-table illisibles .*\(vu avant l'envoi\)$/);
  });
});

describe("runDeploy, the build's own token tried before anything is written", () => {
  // Regression: b47553d — whether Access took the build's token was first tested after the migrations and the upload: a token missing from the CLI policy, or an ID and a secret pasted swapped, deployed the app and only then exited 2 after every round, as « injoignable »
  it("exits 2 naming the refused token, before the build, the bookmark or the upload, when Access does not take it", async () => {
    const swapped = { ...CI_ENV, [CI_ACCESS_ID_VAR]: CI_ENV[CI_ACCESS_SECRET_VAR]!, [CI_ACCESS_SECRET_VAR]: CI_ENV[CI_ACCESS_ID_VAR]! };
    for (const [what, w] of [["a token outside the policy", world({ env: CI_ENV, live: { tokenAccepted: false } })], ["an ID and a secret swapped", world({ env: swapped })]] as const) {
      expect({ what, code: await runDeploy(w.deps) }).toEqual({ what, code: 2 });
      expect(w.lines().filter((c) => c.startsWith("npm") || WRANGLER_STEPS.includes(c))).toEqual([]);
      expect(w.log.at(-1)).toBe("jeton Access refusé (403) : absent de la politique CLI, ou identifiant et secret intervertis, déploiement refusé");
    }
  });

  it("sends the token only after the address is proved to be the account's, and exits 2 when nothing answers it", async () => {
    const other = world({ env: CI_ENV, account: { subdomain: "another-account" } });
    const seen: Record<string, string>[] = [];
    const fetch = other.deps.fetch;
    expect(await runDeploy({ ...other.deps, fetch: (i, init) => { seen.push(Object.fromEntries(new Headers(init?.headers))); return fetch(i, init); } })).toBe(1);
    expect(seen.some((h) => "cf-access-client-id" in h)).toBe(false);
    const mute = world({ env: CI_ENV });
    const ask = mute.deps.fetch;
    // Access answers its visitors, then nothing answers the token's request
    expect(await runDeploy({ ...mute.deps, fetch: (i, init) => (new Headers(init?.headers).has("CF-Access-Client-Id") ? Promise.reject(new Error("ECONNRESET")) : ask(i, init)) })).toBe(2);
    expect(mute.log.at(-1)).toBe("jeton Access non vérifiable (injoignable : ECONNRESET) : déploiement refusé");
    expect(mute.lines().filter((c) => c.startsWith("npm") || WRANGLER_STEPS.includes(c))).toEqual([]);
  });
});

describe("runDeploy, the account DEFAULT_URL belongs to", () => {
  // Regression: a4b93ff — DEFAULT_URL's subdomain was tied to account_id's account only by the address wrangler deploy printed, after the upload: with another account's workers.dev in DEFAULT_URL, Access was probed there (that account's Access), and the app went live at this account's address before the mismatch was seen
  it("refuses (exit 1) a DEFAULT_URL on another account's subdomain before asking Access, building or deploying", async () => {
    for (const env of [CI_ENV, {}]) {
      const w = world({ env, account: { subdomain: "another-account" } });
      let asked = false;
      const fetch = w.deps.fetch;
      expect(await runDeploy({ ...w.deps, fetch: (i, init) => { if (new URL(i).origin === URL_OK) asked = true; return fetch(i, init); } })).toBe(1);
      expect(asked).toBe(false);
      expect(w.lines().filter((c) => c.startsWith("npm") || WRANGLER_STEPS.includes(c))).toEqual([]);
      expect(w.log.at(-1)).toBe(`le compte ${ACCOUNT} a le sous-domaine workers.dev another-account, pas ${SUBDOMAIN} : ${URL_OK} (DEFAULT_URL) est l'adresse d'un autre compte, Access y serait sondé à la place de l'app, déploiement refusé`);
    }
  });

  it("cannot check it (exit 2) when the API does not answer, refuses the token, or wrangler names no credential", async () => {
    for (const api of ["down", "refused"] as const) {
      const w = world({ env: CI_ENV, account: { api } });
      expect({ api, code: await runDeploy(w.deps) }).toEqual({ api, code: 2 });
      expect(w.lines().filter((c) => c.startsWith("npm") || WRANGLER_STEPS.includes(c))).toEqual([]);
      expect(w.log.at(-1)).toMatch(new RegExp(`^sous-domaine workers\\.dev du compte ${ACCOUNT} illisible \\(${api === "down" ? "injoignable" : "403"}`));
    }
    for (const answer of [{ status: 1, stdout: "", stderr: "Not logged in." }, ok('{"type":"api_key","key":"k","email":"e"}'), ok("⛅️ wrangler")]) {
      const w = world({ env: CI_ENV, answers: { "wrangler auth token": answer } });
      expect({ answer, code: await runDeploy(w.deps) }).toEqual({ answer, code: 2 });
      expect(w.api).toEqual([]);
      expect(w.log.at(-1)).toMatch(/^identifiant Cloudflare de wrangler illisible/);
    }
  });

  // Regression: a4b93ff — a { success: false } answer with status 200 must not pass the attached-hosts or subdomain reads (pinned in 5b4a660)
  it("cannot check it (exit 2, before Access is asked) when the API answers 200 with success false", async () => {
    for (const unsuccessful of ["subdomain", "routes", "domains"] as const) {
      const w = world({ env: CI_ENV, account: { unsuccessful } });
      expect({ unsuccessful, code: await runDeploy(w.deps) }).toEqual({ unsuccessful, code: 2 });
      expect(w.lines().filter((c) => c.startsWith("npm") || WRANGLER_STEPS.includes(c))).toEqual([]);
      expect(w.log.some((l) => l.startsWith("Access devant"))).toBe(false);
      expect(w.log.at(-1)).toMatch(unsuccessful === "subdomain" ? /^sous-domaine workers\.dev du compte / : /^routes et domaines du Worker la-table illisibles /);
    }
  });

  it("reads it with wrangler's own credential (Workers Builds' token, the laptop's login), through pinnedWrangler, and never logs it (the control: the right subdomain goes on)", async () => {
    for (const [env, token] of [[CI_ENV, BUILD_TOKEN], [{}, OAUTH_TOKEN]] as const) {
      const w = world({ env });
      expect(await runDeploy(w.deps)).toBe(0);
      expect(w.lines()).toContain(`wrangler auth token --json ${PINS}`);
      expect(w.api[0]).toEqual({ path: `/accounts/${ACCOUNT}/workers/subdomain`, token });
      expect(w.log).toContain(`sous-domaine workers.dev du compte ${ACCOUNT} : ${SUBDOMAIN}, celui de ${URL_OK}`);
      expect(w.log.join("\n")).not.toContain(token);
    }
  });
});

describe("runDeploy, the addresses attached in the dashboard", () => {
  // Regression: a1f26bf — the gate read routes from wrangler.jsonc only: a route or a custom domain attached to la-table in the dashboard served the app on a host the probes never asked
  it("refuses (exit 1) a route or a custom domain attached to the Worker, before asking Access or building", async () => {
    const cases: [Partial<Account>, string][] = [[{ routes: ["table.example.test/*"] }, "table.example.test/*"], [{ domains: ["table.example.test"] }, "table.example.test"]];
    for (const [attached, named] of cases) {
      const w = world({ env: CI_ENV, account: attached });
      let asked = false;
      const fetch = w.deps.fetch;
      expect({ attached, code: await runDeploy({ ...w.deps, fetch: (i, init) => { if (new URL(i).origin === URL_OK) asked = true; return fetch(i, init); } }) }).toEqual({ attached, code: 1 });
      expect(asked).toBe(false);
      expect(w.lines()).not.toContain("npm run build:ci");
      expect(w.log.at(-1)).toBe(`le Worker la-table répond aussi sur ${named}, attaché dans le tableau de bord : l'app n'a que son adresse workers.dev, que les sondes regardent ; retirez-le, puis redéployez`);
    }
  });

  // Regression: e1c23e0 — a custom domain entry without a readable service was dropped by the service filter: the gate logged « aucun » and passed without having read the answer
  it("cannot check (exit 2) when a custom domain entry names no readable service, and drops only entries naming another Worker", async () => {
    for (const rawDomains of [[{ hostname: "x" }], [{ hostname: "x", service: "" }], [{ hostname: "x", service: 3 }], [null], [{ hostname: "ok.example.test", service: "la-table" }, { hostname: "x" }]]) {
      const w = world({ env: CI_ENV, account: { rawDomains } });
      expect({ rawDomains, code: await runDeploy(w.deps) }).toEqual({ rawDomains, code: 2 });
      expect(w.lines()).not.toContain("npm run build:ci");
      expect(w.log.at(-1)).toMatch(/^routes et domaines du Worker la-table illisibles \(domaine sans service lisible\)/);
    }
    // the control: an entry naming another Worker is dropped, and the deploy goes on
    const other = world({ env: CI_ENV, account: { rawDomains: [{ hostname: "other.example.test", service: "another-worker" }] } });
    expect(await runDeploy(other.deps)).toBe(0);
  });

  it("cannot check (exit 2) when the API cannot list them", async () => {
    const w = world({ env: CI_ENV });
    const fetch = w.deps.fetch;
    const deps = { ...w.deps, fetch: (i: string, init?: RequestInit) => (i.includes("/routes") ? Promise.reject(new Error("ECONNRESET")) : fetch(i, init)) };
    expect(await runDeploy(deps)).toBe(2);
    expect(w.lines()).not.toContain("npm run build:ci");
    expect(w.log.at(-1)).toMatch(/^routes et domaines du Worker la-table illisibles \(injoignable : ECONNRESET\)/);
  });

  it("lists the Worker's routes and custom domains with wrangler's credential (the control: none, the deploy goes on)", async () => {
    const w = world({ env: CI_ENV });
    expect(await runDeploy(w.deps)).toBe(0);
    expect(w.api.map((a) => a.path)).toEqual(expect.arrayContaining([`/accounts/${ACCOUNT}/workers/services/la-table/environments/production/routes`, `/accounts/${ACCOUNT}/workers/domains?service=la-table`]));
    expect(w.api.every((a) => a.token === BUILD_TOKEN)).toBe(true);
    expect(w.log).toContain("routes et domaines du Worker la-table : aucun, seule son adresse workers.dev");
  });
});

describe("runDeploy, the Worker's secrets", () => {
  // Regression: 4867886 — a Worker secret survives every deploy (keep_vars spares only plain variables) and the gate never listed them: a DEV_SKIP_ACCESS put as a secret stayed on the deployed Worker unseen
  it("refuses (exit 1) a Worker that holds any secret, before asking Access or running the build", async () => {
    for (const listed of ['[{"name":"DEV_SKIP_ACCESS","type":"secret_text"}]', '[\n  {\n    "name": "OTHER",\n    "type": "secret_text"\n  }\n]']) {
      const w = world({ env: CI_ENV, answers: { "wrangler secret list": ok(listed) } });
      let asked = false;
      const fetch = w.deps.fetch;
      expect({ listed, code: await runDeploy({ ...w.deps, fetch: (i, init) => { if (new URL(i).origin === URL_OK) asked = true; return fetch(i, init); } }) }).toEqual({ listed, code: 1 });
      expect(asked).toBe(false);
      expect(w.lines()).not.toContain("npm run build:ci");
      expect(w.log.at(-1)).toMatch(/^le Worker la-table porte des secrets \((DEV_SKIP_ACCESS|OTHER)\)/);
    }
  });

  it("cannot check (exit 2) when wrangler cannot list them, or answers something else than the list", async () => {
    for (const answer of [{ status: 1, stdout: "", stderr: "Authentication error [code: 10000]" }, ok("⛅️ wrangler 4.149.0"), ok('{"name":"x"}'), ok('[{"type":"secret_text"}]')]) {
      const w = world({ env: CI_ENV, answers: { "wrangler secret list": answer } });
      expect({ answer, code: await runDeploy(w.deps) }).toEqual({ answer, code: 2 });
      expect(w.lines()).not.toContain("npm run build:ci");
      expect(w.log.at(-1)).toMatch(/^liste des secrets du Worker la-table illisible/);
    }
  });

  it("lists them on the target's Worker and configuration, through pinnedWrangler (the control: none, the deploy goes on)", async () => {
    const w = world({ env: CI_ENV });
    expect(await runDeploy(w.deps)).toBe(0);
    expect(w.lines()).toContain(`wrangler secret list --name la-table --format json ${PINS}`);
    expect(w.log).toContain("secrets du Worker la-table : aucun");
  });
});

describe("runDeploy, the address wrangler deployed to", () => {
  // Regression: b9574f4 — nothing tied DEFAULT_URL's subdomain to account_id's account: with the two naming
  // different accounts, Access was probed on one workers.dev address while wrangler uploaded to the other account's,
  // and the closing check saw it only after 30 rounds, the static shell already public there
  it("stops (exit 1) at once when wrangler names another workers.dev address than the target's, before asking it", async () => {
    const other = "https://la-table.another-account.workers.dev";
    for (const printed of [other, `${other}/`, `${URL_OK}\n  ${other}`]) {
      const w = world({ env: CI_ENV, answers: { "wrangler deploy": ok(`Deployed la-table triggers (0.40 sec)\n  ${printed}\nCurrent Version ID: 0b7c3d4e\n`) } });
      let asked = 0;
      const fetch = w.deps.fetch;
      let deployed = false;
      const exec = w.deps.exec;
      const deps = { ...w.deps, exec: (c: Parameters<typeof exec>[0]) => { const r = exec(c); if (c.args[1] === "deploy") deployed = true; return r; }, fetch: (i: string, init?: RequestInit) => { if (deployed) asked++; return fetch(i, init); } };
      expect({ printed, code: await runDeploy(deps) }).toEqual({ printed, code: 1 });
      expect(asked).toBe(0);
      expect(w.log.at(-1)).toBe(`wrangler a déployé sur ${other}, pas sur ${URL_OK} : le sous-domaine de DEFAULT_URL n'est pas celui du compte ${ACCOUNT}, et l'app y répond peut-être sans Access`);
    }
  });

  it("cannot tell (exit 2) where it went when wrangler names no workers.dev address", async () => {
    for (const stdout of ["", "No targets deployed for la-table (0.40 sec)\n", "Deployed la-table triggers (0.40 sec)\n  la-table.w2ur.workers.dev\n"]) {
      const w = world({ env: CI_ENV, answers: { "wrangler deploy": ok(stdout) } });
      expect({ stdout, code: await runDeploy(w.deps) }).toEqual({ stdout, code: 2 });
      expect(w.log.at(-1)).toBe("wrangler n'a nommé aucune adresse workers.dev : l'adresse du déploiement n'est pas vérifiable");
    }
  });

  it("reads the address as wrangler prints it (the control: the target's, with or without a final slash, passes)", () => {
    expect(deployedAddresses(`Uploaded la-table (1.20 sec)\nDeployed la-table triggers (0.40 sec)\n  ${URL_OK}\nCurrent Version ID: 0b7c3d4e\n`)).toEqual([URL_OK]);
    expect(deployedAddresses(`  ${URL_OK}/\n`)).toEqual([URL_OK]);
    expect(deployedAddresses("  la-table.w2ur.workers.dev\n  https://table.example.test\n")).toEqual([]);
  });
});

describe("runDeploy, the deploy seen live", () => {
  it("needs the service token before running anything remote (exit 2): the build secrets, or the laptop's keychain", async () => {
    for (const missing of [CI_ACCESS_ID_VAR, CI_ACCESS_SECRET_VAR]) {
      const w = world({ env: { ...CI_ENV, [missing]: undefined } });
      expect(await runDeploy(w.deps)).toBe(2);
      expect(w.calls).toEqual([]);
      expect(w.log).toEqual([`jeton Access absent (${missing}) : sans lui, le déploiement ne pourrait pas être vu derrière Access`]);
    }
    const laptop = world({ keychain: false });
    expect(await runDeploy(laptop.deps)).toBe(2);
    expect(laptop.calls).toEqual([]);
    expect(laptop.log).toEqual(["jeton Access absent (la-table-access-client-id dans le trousseau) : sans lui, le déploiement ne pourrait pas être vu derrière Access"]);
  });

  it("never gives the probe's token to a subprocess", async () => {
    const w = world({ env: CI_ENV });
    expect(await runDeploy(w.deps)).toBe(0);
    for (const c of w.calls) expect(JSON.stringify(c)).not.toContain(TOKEN.secret);
  });

  it("asks again, in rounds, while the edge answers the old version", async () => {
    const w = world({ env: CI_ENV, deployLands: false, rounds: 4 });
    let round = 0;
    const fetch = w.deps.fetch;
    // the new version reaches the edge at the third round
    const deps = { ...w.deps, sleep: async () => { if (++round === 2) w.live.tag = TAG; }, fetch };
    expect(await runDeploy(deps)).toBe(0);
    expect(w.log.filter((l) => l.startsWith("après déploiement"))).toEqual([
      "après déploiement, tour 1 : version 000000000000",
      "après déploiement, tour 2 : version 000000000000",
      `après déploiement, tour 3 : version ${TAG} (attendue)`,
    ]);
  });

  it("fails (exit 1) when the address keeps answering another version, or answers without Access after the deploy", async () => {
    const stale = world({ env: CI_ENV, deployLands: false, rounds: 3 });
    expect(await runDeploy(stale.deps)).toBe(1);
    expect(stale.sleeps).toEqual([10_000, 10_000]);
    expect(stale.log.at(-1)).toBe(`${URL_OK} ne répond pas la version ${TAG} après 3 tours : déploiement non vu`);

    const opened = world({ env: CI_ENV });
    const exec = opened.deps.exec;
    // Access switched off while the deploy ran
    const deps = { ...opened.deps, exec: (c: Parameters<typeof exec>[0]) => { const r = exec(c); if (c.args[1] === "deploy") opened.live.access = "open"; return r; } };
    expect(await runDeploy(deps)).toBe(1);
    expect(opened.log.at(-1)).toBe(`Access n'est plus devant ${URL_OK} : la version ${TAG} répond sans lui`);
  });

  it("cannot tell (exit 2) when the address stops answering, or Access refuses the token, after the deploy", async () => {
    for (const after of [{ access: "unreachable" as const }, { tokenAccepted: false }]) {
      const w = world({ env: CI_ENV, rounds: 2 });
      const exec = w.deps.exec;
      const deps = { ...w.deps, exec: (c: Parameters<typeof exec>[0]) => { const r = exec(c); if (c.args[1] === "deploy") Object.assign(w.live, after); return r; } };
      expect(await runDeploy(deps)).toBe(2);
      expect(w.log.at(-1)).toBe(`${URL_OK} injoignable derrière Access après 2 tours : déploiement non vérifié`);
    }
  });
});

describe("runDeploy, the dependencies linked into the export", () => {
  const lock = JSON.parse(LOCKFILE) as { packages: Record<string, Record<string, unknown>> };
  const hidden = (packages: Record<string, Record<string, unknown>>) => JSON.stringify({ name: "la-table", lockfileVersion: 3, requires: true, packages });
  const installed = JSON.parse(INSTALLED) as { packages: Record<string, Record<string, unknown>> };
  const stale: Record<string, [string, string]> = {
    "another jose installed": [hidden({ ...installed.packages, "node_modules/jose": { version: "5.9.0", integrity: "sha512-synthetic-jose-5" } }), "node_modules/jose"],
    "the same version from other bytes": [hidden({ ...installed.packages, "node_modules/jose": { ...installed.packages["node_modules/jose"], integrity: "sha512-synthetic-other" } }), "node_modules/jose"],
    "a package the lockfile does not name": [hidden({ ...installed.packages, "node_modules/evil": { version: "1.0.0", integrity: "sha512-synthetic-evil" } }), "node_modules/evil"],
    "a locked package not installed": [hidden(Object.fromEntries(Object.entries(installed.packages).filter(([k]) => k !== "node_modules/vite"))), "node_modules/vite"],
  };

  // Regression: ae1daa7 — the export linked the repository's node_modules as installed: installed on another branch
  // and never reinstalled, it supplied the bundled dependencies (jose, which checks the JWT), the build and the
  // wrangler that ran the steps, while the Worker was tagged as the commit whose lockfile names other ones
  it.each(Object.entries(stale))("refuses (exit 1) %s, before linking it or running anything from the export", async (_name, [text, pkg]) => {
    for (const env of [{}, CI_ENV]) {
      const w = world({ env, installed: text });
      expect(await runDeploy(w.deps)).toBe(1);
      expect(w.lines().filter((c) => c.startsWith("ln") || c.startsWith("npm") || c.startsWith("wrangler"))).toEqual([]);
      expect(w.log.at(-1)).toBe(`node_modules n'est pas installé depuis le package-lock.json du commit ${SHA} (${pkg}) : lancez npm ci, puis déployez`);
    }
  });

  it("accepts an install that skipped only optional packages (another platform's), the control", async () => {
    expect(lock.packages["node_modules/@esbuild/linux-x64"]?.optional).toBe(true);
    expect(installed.packages["node_modules/@esbuild/linux-x64"]).toBeUndefined();
    const w = world({ env: CI_ENV });
    expect(await runDeploy(w.deps)).toBe(0);
    expect(w.lines()).toContain(`ln -s ${ROOT}/node_modules ${TREE}/node_modules`);
  });

  it("cannot check (exit 2) without an installed lockfile, or a commit without package-lock.json", async () => {
    for (const [o, last] of [
      [{ installed: null }, `${ROOT}/node_modules/.package-lock.json illisible : impossible de vérifier que node_modules est installé depuis le commit (npm ci l'écrit)`],
      [{ lockfile: null }, `${TREE}/package-lock.json illisible : impossible de vérifier que node_modules est installé depuis le commit (npm ci l'écrit)`],
      [{ installed: "{" }, `${ROOT}/node_modules/.package-lock.json illisible : impossible de vérifier que node_modules est installé depuis le commit (npm ci l'écrit)`],
      [{ lockfile: "[]" }, `${TREE}/package-lock.json illisible : impossible de vérifier que node_modules est installé depuis le commit (npm ci l'écrit)`],
    ] as const) {
      const w = world({ env: CI_ENV, ...o });
      expect(await runDeploy(w.deps)).toBe(2);
      expect(remote(w.lines())).toEqual([]);
      expect(w.log.at(-1)).toBe(last);
    }
  });

  it("finds this repository's own install equal to its lockfile (real npm output, the control for the rule)", () => {
    expect(installMismatch(readFileSync("node_modules/.package-lock.json", "utf8"), readFileSync("package-lock.json", "utf8"))).toEqual([]);
  });
});

describe("runDeploy, the export of the checked commit", () => {
  it("removes the export whatever happens after it is made, and makes none before the commit is checked", async () => {
    for (const answers of [{}, { "npm run build:ci": { status: 1, stdout: "", stderr: "vite: error" } }, { "wrangler deploy": { status: 1, stdout: "", stderr: "boom" } }] as Record<string, ReturnType<Exec>>[]) {
      const w = world({ env: CI_ENV, answers });
      await runDeploy(w.deps);
      expect(w.workspaces).toEqual({ made: [WORKSPACE], removed: [WORKSPACE] });
    }
    const dirty = world({ answers: { "git status": ok(" M src/app/main.tsx\n") } });
    expect(await runDeploy(dirty.deps)).toBe(1);
    expect(dirty.workspaces).toEqual({ made: [], removed: [] });
  });

  it("cannot export (exit 2): git archive or tar fails, or the commit holds something other than plain files", async () => {
    const archive = world({ env: CI_ENV, answers: { "git archive": { status: 128, stdout: "", stderr: "fatal: not a valid object name" } } });
    expect(await runDeploy(archive.deps)).toBe(2);
    expect(remote(archive.lines())).toEqual([]);
    expect(archive.log.at(-1)).toBe("export du commit impossible (git 128) : fatal: not a valid object name");
    const tar = world({ env: CI_ENV, answers: { tar: { status: 1, stdout: "", stderr: "tar: Error opening archive" } } });
    expect(await runDeploy(tar.deps)).toBe(2);
    expect(tar.log.at(-1)).toBe("export du commit impossible (tar 1) : tar: Error opening archive");
    const link = world({ env: CI_ENV, answers: { "git ls-tree": ok(`120000 blob ${"a".repeat(40)}\tmigrations\0`) } });
    expect(await runDeploy(link.deps)).toBe(2);
    expect(remote(link.lines())).toEqual([]);
    expect(link.log.at(-1)).toBe("le commit contient migrations (120000 blob) : seul un fichier ordinaire s'exporte, export non vérifiable");
  });

  it("refuses (exit 1) an export with a file the commit does not hold, or without one it holds, before Access or anything remote", async () => {
    const extra = world({ env: CI_ENV, answers: { find: ok([...COMMIT_PATHS, "migrations/0099_evil.sql"].map((p) => `${TREE}/${p}\0`).join("")) } });
    expect(await runDeploy(extra.deps)).toBe(1);
    expect(remote(extra.lines())).toEqual([]);
    expect(extra.log.at(-1)).toBe(`l'export ne reproduit pas le commit ${SHA} (migrations/0099_evil.sql) : un réglage git local (filtre, attributs) le transforme`);
    const listed = COMMIT_PATHS.map((p) => `100644 blob ${COMMIT_FILES[p]!.oid}\t${p}\0`).join("");
    const missing = world({ env: CI_ENV, answers: { "git ls-tree": ok(`${listed}100644 blob ${"c".repeat(40)}\tmigrations/0001_init.sql\0`) } });
    expect(await runDeploy(missing.deps)).toBe(1);
    expect(missing.log.at(-1)).toMatch(/\(migrations\/0001_init\.sql\)/);
  });

  // Regression: 5b607a4 — the build looked above the export, whose parents nothing checked: a tsconfig.json there
  // remapped jose in the Worker and recompiled the app, deployed under the checked commit's tag
  it("refuses (exit 1) an export under a directory holding what the build looks for above it, before anything runs", async () => {
    for (const [dir, name] of [["/", "tsconfig.json"], [WORKSPACE, "package.json"], ["/", "node_modules"], ["/", "jsconfig.json"]] as const) {
      const w = world({ env: CI_ENV, listDir: (d) => (d === dir ? ["autre", name] : []) });
      expect(await runDeploy(w.deps)).toBe(1);
      expect(w.lines().filter((l) => !l.startsWith("git status") && !l.startsWith("git rev-parse"))).toEqual([]);
      expect(w.log.at(-1)).toBe(`${join(dir, name)} au-dessus de l'export : ${ANCESTOR_REFUSED[name]}, hors du commit, déploiement refusé`);
      expect(w.workspaces).toEqual({ made: [WORKSPACE], removed: [WORKSPACE] });
    }
    const asked: string[] = [];
    const clean = world({ env: CI_ENV, listDir: (d) => { asked.push(d); return ["la-table-deploy-x", "autre.json"]; } });
    expect(await runDeploy(clean.deps)).toBe(0);
    // above the export, then each directory between the deploy script's files and the repository (shadowingModules)
    expect(asked).toEqual([WORKSPACE, "/", `${ROOT}/scripts`, `${ROOT}/src`, `${ROOT}/src/cli`]);
    const unreadable = world({ env: CI_ENV, listDir: (d) => (d === "/" ? null : []) });
    expect(await runDeploy(unreadable.deps)).toBe(2);
    expect(unreadable.log.at(-1)).toBe("/ illisible : impossible de vérifier que rien au-dessus de l'export ne change le build");
  });

  it("refuses (exit 1) a commit whose configuration fails the gate though the working tree's passed", async () => {
    const w = world({ env: CI_ENV, config: (() => { let n = 0; return () => (n++ === 0 ? READY : { ...READY, preview_urls: true }); })() });
    expect(await runDeploy(w.deps)).toBe(1);
    expect(remote(w.lines())).toEqual([]);
    expect(w.log.at(-1)).toBe("configuration du commit refusée : preview_urls doit valoir false : une adresse de version est publique dès qu'elle existe");
  });
});

describe("shadowingModules, a node_modules found before the repository's", () => {
  const gate = ["package.json", "scripts/deploy-ci.ts", "scripts/deploy-config.ts", "src/cli/client.ts", "tsconfig.json"];

  it("asks each directory between a gate file and the root once, never the root, and names each node_modules found", () => {
    const asked: string[] = [];
    expect(shadowingModules(gate, (dir) => { asked.push(dir); return ["x.ts"]; })).toEqual([]);
    expect(asked).toEqual(["scripts", "src", "src/cli"]);
    expect(shadowingModules(gate, (dir) => (dir === "src" ? ["cli", "node_modules"] : dir === "scripts" ? ["node_modules"] : []))).toEqual(["scripts/node_modules", "src/node_modules"]);
    expect(shadowingModules(gate, (dir) => (dir === "src/cli" ? null : []))).toBe("src/cli");
  });

  // Regression: 9f8a0dc — Node resolved the deploy script's `wrangler` import, and WRANGLER_BIN, from scripts/
  // upward: a gitignored scripts/node_modules/wrangler replaced the configuration reader the gate trusts and the binary
  // that deploys, unseen by git status and by the installed-lockfile check
  it("refuses (exit 1) a node_modules beside the deploy script's files, before the build or wrangler runs", async () => {
    for (const dir of [`${ROOT}/scripts`, `${ROOT}/src`]) {
      const w = world({ env: CI_ENV, listDir: (d) => (d === dir ? ["node_modules", "x.ts"] : []) });
      expect(await runDeploy(w.deps)).toBe(1);
      expect(remote(w.lines())).toEqual([]);
      expect(w.log.at(-1)).toBe(`${dir.slice(ROOT.length + 1)}/node_modules : Node y trouverait wrangler, et tout paquet que le script de déploiement importe, avant le node_modules du dépôt, hors du commit et invisible à git status, déploiement refusé`);
    }
    const unreadable = world({ env: CI_ENV, listDir: (d) => (d === `${ROOT}/src/cli` ? null : []) });
    expect(await runDeploy(unreadable.deps)).toBe(2);
    expect(unreadable.log.at(-1)).toBe(`${ROOT}/src/cli illisible : impossible de vérifier qu'aucun node_modules n'y passe avant celui du dépôt`);
  });
});

describe("gateFiles, the files the deploy script runs from", () => {
  it("reads every relative import and re-export, on one line or several, and nothing else", () => {
    const source = [
      'import { a } from "./a.ts";',
      "import {\n  b,\n  type C,\n} from '../b';",
      'export type { D } from "./d";',
      'import "./side-effect";',
      'const lazy = await import("./lazy.ts");',
      'import { spawnSync } from "node:child_process";',
      'import { unstable_readConfig } from "wrangler";',
      'import { a } from "./a.ts";',
      '/** not code: from "./in-a-block-comment" */',
      '  // nor this: import "./in-a-line-comment"',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./a.ts", "../b", "./d", "./side-effect", "./lazy.ts"]);
  });

  it("follows the imports from the deploy script, as tsx resolves them, then adds GATE_EXTRA; an import to no file is named", () => {
    const tree: Record<string, string> = {
      [GATE_ENTRY]: 'import "./config.ts";\nimport { x } from "../src/lib";\n',
      "scripts/config.ts": 'export * from "./config.ts";\n',
      "src/lib/index.ts": 'import type { Y } from "./types";\n',
      "src/lib/types.ts": "export type Y = 1;\n",
      "tsconfig.json": "{}\n",
    };
    const read = (p: string) => tree[p] ?? null;
    expect(gateFiles(read)).toEqual([...Object.keys(GATE_EXTRA), GATE_ENTRY, "scripts/config.ts", "src/lib/index.ts", "src/lib/types.ts"].sort());
    expect(gateFiles((p) => (p === "src/lib/types.ts" ? null : read(p)))).toBe("./types (importé par src/lib/index.ts)");
    expect(gateFiles(() => null)).toBe(GATE_ENTRY);
    expect(gateFiles((p) => (p === GATE_ENTRY ? 'import "../../outside";\n' : read(p)))).toBe("../../outside (importé par scripts/deploy-ci.ts)");
  });

  // Regression: df00a65 — gateFiles compared tsconfig.json with the commit, never the file it extends, whose
  // `paths` tsx honours as well: a hidden remap there pointed the script's wrangler import at code outside the repository
  it("adds every file tsconfig.json extends, transitively, as tsx resolves them; one it cannot follow inside the repository is named", () => {
    const tree: Record<string, string> = {
      [GATE_ENTRY]: "export {};\n",
      [GATE_TSCONFIG]: '{\n  // the base options\n  "extends": "./config/base",\n}\n',
      "config/base.json": '{ /* two at once */ "extends": ["./strict.json", "../tsconfig.json"] }',
      "config/strict.json": '{ "compilerOptions": { "strict": true, "paths": { "a": ["./b//c"] } } }',
    };
    const read = (p: string) => tree[p] ?? null;
    expect(extendedConfigs(read)).toEqual(["config/base.json", "config/strict.json"]);
    expect(gateFiles(read)).toEqual([...Object.keys(GATE_EXTRA), GATE_ENTRY, "config/base.json", "config/strict.json"].sort());
    const refused = (tsconfig: string | null, extra: Record<string, string> = {}) => gateFiles((p) => (p === GATE_TSCONFIG ? tsconfig : extra[p] ?? read(p)));
    expect(refused(null)).toBe("tsconfig.json (configuration illisible)");
    expect(refused("{ not json")).toBe("tsconfig.json (configuration illisible)");
    expect(refused('{ "extends": "./missing.json" }')).toBe("./missing.json (étendu par tsconfig.json)");
    expect(refused('{ "extends": "/elsewhere/evil.json" }')).toBe("/elsewhere/evil.json (étendu par tsconfig.json, hors du dépôt)");
    expect(refused('{ "extends": "@tsconfig/node24/tsconfig.json" }')).toBe("@tsconfig/node24/tsconfig.json (étendu par tsconfig.json, hors du dépôt)");
    expect(refused('{ "extends": "./../outside.json" }')).toBe("./../outside.json (étendu par tsconfig.json, hors du dépôt)");
    expect(refused('{ "extends": ["./config/base.json", 1] }')).toBe("1 (étendu par tsconfig.json, hors du dépôt)");
    expect(refused('{ "extends": "./a" }', { "a.json": '{ "extends": "/elsewhere/evil.json" }' })).toBe("/elsewhere/evil.json (étendu par a.json, hors du dépôt)");
  });

  it("reads a tsconfig.json as JSON with comments and trailing commas, never a comment marker inside a string", () => {
    expect(parseJsonc('{\n  // a\n  "x": "http://a.test/*not*/", /* b */ "y": [1, 2,],\n}')).toEqual({ x: "http://a.test/*not*/", y: [1, 2] });
    expect(parseJsonc('{ "x": "a\\"b" }')).toEqual({ x: 'a"b' });
    expect(parseJsonc("{ /* open")).toBeNull();
    expect(parseJsonc('{ "x": "open }')).toBeNull();
    expect(parseJsonc(readFileSync(GATE_TSCONFIG, "utf8"))).toEqual({ extends: "./tsconfig.base.json" });
  });

  it("finds this repository's deploy script, every module it imports, and the files it runs by", () => {
    const files = gateFiles((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } });
    expect(Array.isArray(files)).toBe(true);
    for (const f of [GATE_ENTRY, "scripts/deploy-config.ts", "scripts/deploy-target.ts", CLIENT_PATH, "src/cli/entry.ts", "src/cli/keychain.ts", "tsconfig.base.json", ...Object.keys(GATE_EXTRA)]) expect(files).toContain(f);
  });

  it("reads DEFAULT_URL as src/cli/client.ts declares it (the control: this repository's own)", () => {
    expect(declaredDefaultUrl(readFileSync(CLIENT_PATH, "utf8"))).toBe(DEFAULT_URL);
    expect(declaredDefaultUrl('export const DEFAULT_URL = process.env.X ?? "https://a.test";\n')).toBeNull();
    expect(declaredDefaultUrl("")).toBeNull();
  });
});

describe("runDeploy, the deploy script itself", () => {
  const gateHash = `git hash-object --no-filters -- ${COMMIT_PATHS.map((p) => `${ROOT}/${p}`).join(" ")}`;

  // Regression: 105945a — deploy-ci.ts, the modules it imports and the files it runs by ran from the working tree,
  // never compared with the commit: a change git status does not show (skip-worktree, assume-unchanged) ran unseen
  it("refuses (exit 1) a deploy script whose working-tree files differ from the commit's, before Access or anything remote", async () => {
    const oids = COMMIT_PATHS.map((p) => (p === GATE_ENTRY ? "e".repeat(40) : COMMIT_FILES[p]!.oid));
    const w = world({ env: CI_ENV, answers: { [gateHash]: ok(`${oids.join("\n")}\n`) } });
    expect(await runDeploy(w.deps)).toBe(1);
    expect(remote(w.lines())).toEqual([]);
    expect(w.log.at(-1)).toBe(`le script de déploiement en cours n'est pas celui du commit ${SHA} (${GATE_ENTRY}) : une modification que git status ne montre pas (skip-worktree, assume-unchanged), déploiement refusé`);
    expect(w.workspaces.removed).toEqual([WORKSPACE]);
  });

  it("cannot check it (exit 2): an import of the commit's script reads no file, or git cannot hash the running files", async () => {
    const cut = world({ env: CI_ENV, readText: (p) => (p === `${TREE}/${GATE_ENTRY}` ? 'import "./absent.ts";\n' : p.startsWith(`${TREE}/`) ? (COMMIT_FILES[p.slice(TREE.length + 1)]?.text ?? null) : p.endsWith("package-lock.json") ? LOCKFILE : INSTALLED) });
    expect(await runDeploy(cut.deps)).toBe(2);
    expect(cut.log.at(-1)).toBe("le script de déploiement du commit ne se lit pas jusqu'au bout (./absent.ts (importé par scripts/deploy-ci.ts)) : impossible de vérifier le script en cours");
    const unhashed = world({ env: CI_ENV, answers: { [gateHash]: { status: 128, stdout: "", stderr: "fatal: could not open 'scripts/deploy-ci.ts'" } } });
    expect(await runDeploy(unhashed.deps)).toBe(2);
    expect(remote(unhashed.lines())).toEqual([]);
    expect(unhashed.log.at(-1)).toBe("script de déploiement en cours illisible (git 128) : fatal: could not open 'scripts/deploy-ci.ts'");
  });

  // Regression: 105945a — the probes asked d.url, the working tree's DEFAULT_URL, never compared with the commit's
  it("refuses (exit 1) to probe an address that is not the commit's DEFAULT_URL; exit 2 when the commit declares none", async () => {
    const other = world({ env: CI_ENV });
    expect(await runDeploy({ ...other.deps, url: "https://la-table.autre.workers.dev" })).toBe(1);
    expect(remote(other.lines())).toEqual([]);
    expect(other.log.at(-1)).toBe(`l'adresse sondée https://la-table.autre.workers.dev n'est pas le DEFAULT_URL du commit (${URL_OK}) : déploiement refusé`);
    const undeclared = world({ env: CI_ENV, readText: (p) => (p === `${TREE}/${CLIENT_PATH}` ? "export const DEFAULT_URL = URL;\n" : p.startsWith(`${TREE}/`) ? (COMMIT_FILES[p.slice(TREE.length + 1)]?.text ?? null) : p.endsWith("package-lock.json") ? LOCKFILE : INSTALLED) });
    expect(await runDeploy(undeclared.deps)).toBe(2);
    expect(undeclared.log.at(-1)).toBe(`${CLIENT_PATH} du commit ne déclare pas DEFAULT_URL comme attendu : impossible de vérifier l'adresse sondée`);
  });
});

describe("entryDeps, what the script runs with", () => {
  // Regression: 5b607a4 — the export was made under os.tmpdir(), which reads the caller's TMPDIR, TMP and TEMP: the
  // shell chose the directories above the export, where the build looks for its configuration
  it("makes the export under the system's /tmp, whatever TMPDIR, TMP and TEMP name, and removes it", () => {
    const hostile = mkdtempSync(join(tmpdir(), "la-table-hostile-tmp-"));
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, hostile);
    try {
      const d = entryDeps();
      const made = d.workspace.make();
      try {
        expect(dirname(made)).toBe(realpathSync.native(WORKSPACE_PARENT));
        expect(realpathSync.native(made)).toBe(made);
        expect(readdirSync(made)).toEqual([]);
        expect(readdirSync(hostile)).toEqual([]);
      } finally {
        d.workspace.remove(made);
      }
      expect(existsSync(made)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(hostile, { recursive: true, force: true });
    }
  });

  it("reads this repository, DEFAULT_URL and the real directories", () => {
    const d = entryDeps();
    expect({ root: d.root, cwd: d.cwd, url: d.url, mainRemote: d.mainRemote, env: d.env }).toEqual({ root: realpathSync.native("."), cwd: realpathSync.native("."), url: DEFAULT_URL, mainRemote: MAIN_REMOTE, env: process.env });
    expect(d.listDir(resolve("."))).toContain("package.json");
    expect(d.listDir(join(resolve("."), "absent"))).toBeNull();
  });
});

describe("deploy-ci.ts run as a script", () => {
  // Regression: 0dcde21 — run through a symlinked path, the script compared that path as typed with its real one,
  // did nothing, and exited 0: a deploy that never ran looked healthy
  it("runs, and refuses (exit 1), when started through a symlinked directory, with half of Workers Builds' claim", () => {
    const dir = mkdtempSync(join(tmpdir(), "la-table-entry-"));
    try {
      symlinkSync(resolve("scripts"), join(dir, "scripts"));
      // the placeholder configuration, or the half claim once the account's values fill it: refused either way before git or network
      const r = spawnSync(resolve("node_modules/.bin/tsx"), [join(dir, "scripts", "deploy-ci.ts")], {
        env: { PATH: baseEnv().PATH, HOME: baseEnv().HOME, WORKERS_CI_COMMIT_SHA: SHA },
        encoding: "utf8",
      });
      expect({ status: r.status, refused: /configuration refusée|sans WORKERS_CI=1/.test(r.stderr) }).toEqual({ status: 1, refused: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
