import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DATABASE_NAME, WORKER_NAME, type DeployConfig } from "./deploy-config.ts";

/** One subprocess of the deploy, fully described: what it runs, with which arguments, environment and directory. */
export interface Call { readonly cmd: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string }
export type Exec = (call: Call) => { status: number | null; stdout: string; stderr: string };

/**
 * The installed wrangler's entry, run by this Node: no `npx` lookup, so neither PATH nor an npm setting can put another
 * wrangler in its place.
 */
export const WRANGLER_BIN = resolve(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin/wrangler.js");

/** What every wrangler step is built from: the Worker, its account and database, where it runs, and the configuration read. */
export interface WranglerTarget {
  readonly worker: string;
  readonly account: string;
  readonly database: string;
  readonly root: string;
  readonly configPath: string;
}

/**
 * What the deploy acts on, derived once from the checked configuration and the checked commit, printed, then only read.
 * Every wrangler step is built from it alone (`pinnedWrangler`), and the live probes ask its `url`.
 */
export interface DeployTarget extends WranglerTarget {
  readonly url: string;
  readonly team: string;
  readonly assetsDir: string;
  readonly commit: string;
  readonly tag: string;
}

/** Freezes the target from a configuration that passed `deployConfigProblems` (so account, team and assets are set). */
export function deployTarget(o: { root: string; configPath: string; cfg: DeployConfig; url: string; commit: string; tag: string }): DeployTarget {
  return Object.freeze({
    worker: WORKER_NAME,
    account: String(o.cfg.account_id),
    url: o.url,
    team: String(o.cfg.vars?.ACCESS_TEAM_DOMAIN),
    database: DATABASE_NAME,
    root: o.root,
    configPath: o.configPath,
    // wrangler resolves a configured assets directory against the configuration's own directory
    assetsDir: resolve(dirname(o.configPath), String(o.cfg.assets?.directory)),
    commit: o.commit,
    tag: o.tag,
  });
}

/**
 * The environment every subprocess of the deploy starts from (git, the build, wrangler), built from nothing rather than
 * filtered from the caller's, so no variable of the shell or of Workers Builds reaches a step unless named here:
 * - `PATH`: this Node's own directory, then the system's; never the caller's. It finds `npm` for the build. The deploy's
 *   own git, tar, find and ln never go through it (`systemTools`): `npm i -g` puts global bins in Node's directory.
 * - `HOME`: the login's home from the user database (`os.userInfo`), never `$HOME`; wrangler's OAuth login lives under it.
 * - `CI`: `1`, so wrangler asks no question (the migrations prompt). It does not keep colour out of the build: picocolors
 *   (vite) turns colour ON when `CI` is set, so `buildCall` adds `NO_COLOR`.
 * - `GIT_NO_REPLACE_OBJECTS`: `1`, so git reads every object as stored, never through a `refs/replace/*` substitute: a
 *   local replace of main by another commit would otherwise leave git status clean and HEAD named as main, while the
 *   export and its proof both read the other commit.
 */
export function baseEnv(): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: userInfo().homedir,
    CI: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  });
}

/**
 * The only variables a wrangler step gets on top of `baseEnv`, each with its reason:
 * - `CLOUDFLARE_ACCOUNT_ID`: the target's account, set by the deploy, never passed through. wrangler.jsonc's
 *   `account_id` already wins over it; set as well, it leaves wrangler no other account to consider.
 * - `CLOUDFLARE_API_TOKEN`: passed through when set: the credential Workers Builds provides (a laptop uses its OAuth login
 *   under HOME instead). It names no Worker and no account: a token without rights on the pinned account fails.
 */
export const WRANGLER_ALLOWED = ["PATH", "HOME", "CI", "GIT_NO_REPLACE_OBJECTS", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;

/**
 * Variables wrangler 4.157 reads (`wrangler-dist/cli.js`: its `getEnvironmentVariableFactory` names and its direct
 * `process.env` reads) that could steer what it deploys, where, or with what, and which the deploy therefore never passes.
 * Everything else is dropped as well; these are the ones a reader might expect to be needed, with why they are not.
 */
export const WRANGLER_DROPPED: Readonly<Record<string, string>> = Object.freeze({
  CLOUDFLARE_ENV: "picks a named environment, so another Worker name (`la-table-<env>`): the steps pass `--env=`",
  CF_ACCOUNT_ID: "the old name of CLOUDFLARE_ACCOUNT_ID, which the deploy sets itself",
  WRANGLER_CI_OVERRIDE_NAME: "replaces the Worker name, even over `--name` (Workers Builds sets it to the connected Worker)",
  WRANGLER_CI_MATCH_TAG: "Workers Builds' own name check; the name and account are pinned here instead",
  WRANGLER_CI_GENERATE_PREVIEW_ALIAS: "makes `deploy` also publish a preview alias, an address outside the probes",
  WORKERS_CI_BRANCH: "names the preview alias; read by the deploy itself, never by wrangler",
  CLOUDFLARE_API_BASE_URL: "sends every API call to another host",
  WRANGLER_API_ENVIRONMENT: "switches to Cloudflare's staging API",
  CLOUDFLARE_COMPLIANCE_REGION: "switches to another API region",
  CLOUDFLARE_API_KEY: "a global key, with CLOUDFLARE_EMAIL: a second credential beside the token or the login",
  CLOUDFLARE_EMAIL: "goes with CLOUDFLARE_API_KEY",
  CF_API_TOKEN: "the old name of CLOUDFLARE_API_TOKEN: one credential, under one name",
  CLOUDFLARE_ACCESS_CLIENT_ID: "Access credentials wrangler sends to a protected host: the deploy's probe has its own",
  CLOUDFLARE_ACCESS_CLIENT_SECRET: "goes with CLOUDFLARE_ACCESS_CLIENT_ID",
  WRANGLER_AUTH_DOMAIN: "another OAuth server for the login",
  WRANGLER_AUTH_URL: "another OAuth server for the login",
  WRANGLER_TOKEN_URL: "another OAuth server for the login",
  WRANGLER_CLIENT_ID: "another OAuth client for the login",
  CLOUDFLARE_AUTH_USE_KEYRING: "another store for the login",
  XDG_CONFIG_HOME: "another directory for the login (HOME's Library/Preferences/.wrangler otherwise)",
  WRANGLER_CACHE_DIR: "another account cache (wrangler-account.json); the account is pinned anyway",
  WRANGLER_BUILD_CONDITIONS: "changes how the Worker's code is bundled",
  WRANGLER_BUILD_PLATFORM: "changes how the Worker's code is bundled",
  NODE_ENV: "changes what the bundle defines",
  NODE_OPTIONS: "loads code into wrangler's Node",
  npm_config_registry: "an npm setting (any npm_config_*): wrangler is run without npm",
  HTTPS_PROXY: "routes wrangler's API calls through another host (HTTP_PROXY and the lower-case names likewise)",
  TMPDIR: "where wrangler writes the bundle; the system default is used",
  WRANGLER_OUTPUT_FILE_PATH: "a file wrangler writes its result to (WRANGLER_OUTPUT_FILE_DIRECTORY likewise): nothing reads it here",
  GIT_DIR: "makes git read another repository (any GIT_*), so name another commit than the tree deployed",
  LA_TABLE_URL: "the CLI's address override: the probes ask the target's address only",
});

/**
 * The system's own directories, the only ones the deploy takes its git, tar, find and ln from. Never PATH, whose first
 * directory is this Node's: `npm i -g` puts every global package's bins there, and one named `git` would run the proof
 * that the export is the commit (archive, ls-tree, hash-object) and vouch for whatever it built.
 */
export const SYSTEM_DIRS = ["/usr/bin", "/bin"] as const;

/** The system tools the deploy runs: git reads and proves the commit, tar unpacks its export, find lists it, ln links node_modules in. */
export const SYSTEM_TOOLS = ["git", "tar", "find", "ln"] as const;
export type SystemTool = (typeof SYSTEM_TOOLS)[number];
export type SystemTools = Readonly<Record<SystemTool, string>>;

/** Each of SYSTEM_TOOLS by absolute path, the first in SYSTEM_DIRS that `executable` accepts; a string names one found in none. */
export function systemTools(executable: (path: string) => boolean): SystemTools | string {
  const found: Partial<Record<SystemTool, string>> = {};
  for (const tool of SYSTEM_TOOLS) {
    const path = SYSTEM_DIRS.map((dir) => join(dir, tool)).find(executable);
    if (path === undefined) return tool;
    found[tool] = path;
  }
  return Object.freeze(found as Record<SystemTool, string>);
}

/** Whether `path` is a file this process may run (a symlink to one counts). */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A local step (git, tar, find, ln): `baseEnv` only, in the repository. */
export function localCall(root: string, cmd: string, args: string[]): Call {
  return Object.freeze({ cmd, args: Object.freeze([...args]), env: baseEnv(), cwd: root });
}

/**
 * What the build's npm runs with on top of `baseEnv`: no user and no global configuration file. npm reads both from
 * outside the commit (`$HOME/.npmrc`, `etc/npmrc` beside this Node), and either one decides the build's verdict:
 * `node-options` loads code into typecheck, the tests and vite, `script-shell` replaces the shell that runs every script
 * (one that ignores its command makes `npm run build:ci` exit 0 having run nothing). npm passes both settings on to
 * the scripts it runs, so the `npm run` nested in build:ci reads neither either. Two paths, since npm refuses to load one
 * file as both: `/dev/null`, and a path under it, which can never exist (npm reads a missing file as empty).
 * deploy-target.test.ts runs them through the installed npm.
 */
export const NPM_CONFIG_PINS: Readonly<Record<string, string>> = Object.freeze({ npm_config_userconfig: "/dev/null", npm_config_globalconfig: "/dev/null/npmrc" });

/**
 * What the build runs with on top of `baseEnv`: NPM_CONFIG_PINS, and `NO_COLOR`. `CI` (from `baseEnv`) turns colour ON
 * in picocolors (vite) and tinyrainbow (vitest), so without `NO_COLOR` the build log carries raw escape codes between
 * the words a reader looks for (`Tests  … passed`). Both libraries let `NO_COLOR` win over `CI`; deploy-target.test.ts
 * reads their verdict under this environment.
 */
export const BUILD_ENV_PINS: Readonly<Record<string, string>> = Object.freeze({ ...NPM_CONFIG_PINS, NO_COLOR: "1" });

/** The build step, `npm run build:ci` in the export: `baseEnv` and BUILD_ENV_PINS. */
export function buildCall(root: string): Call {
  return Object.freeze({ cmd: "npm", args: Object.freeze(["run", "build:ci"]), env: Object.freeze({ ...baseEnv(), ...BUILD_ENV_PINS }), cwd: root });
}

/**
 * The flags every wrangler step ends with: `--config` (the file the gate read: no search for wrangler.json, .jsonc or
 * .toml, no `.wrangler/deploy/config.json` redirect), `--env=` (the top level, even when CLOUDFLARE_ENV is set),
 * `--env-file=/dev/null` (no `.env` or `.env.local` loaded into wrangler's environment). deploy-target.test.ts runs
 * them through the real wrangler.
 */
export function wranglerPins(configPath: string): string[] {
  return ["--config", configPath, "--env=", "--env-file=/dev/null"];
}

/**
 * The wrangler steps of a deploy. `token` and `secrets` read, before Access is asked: the credential wrangler uses
 * (Workers Builds' API token, or the laptop's OAuth login), which the deploy then reads Cloudflare's API with, and the
 * Worker's secrets. The rest write.
 */
export type WranglerStep = "token" | "secrets" | "bookmark" | "migrations" | "pending" | "deploy";

/**
 * The scratch local D1 the restore drill (scripts/restore-drill.ts) restores into, relative to the repository and wiped
 * first: never .wrangler/state (npm run dev) nor .wrangler/e2e.
 */
export const DRILL_DIR = ".wrangler/restore-drill";

/** The restore drill's steps, on DRILL_DIR only (`--local`): a backup restored from a file, then queried. */
export type DrillStep = { readonly drill: "restore"; readonly file: string } | { readonly drill: "query"; readonly sql: string };

/**
 * The line `wrangler d1 migrations list` prints when none is pending (wrangler-dist/cli.js; deploy-target.test.ts reads
 * it from the installed wrangler). `migrations apply` can exit 0 with a migration left unapplied, so the list decides.
 */
export const NO_PENDING_MIGRATIONS = "✅ No migrations to apply!";

/**
 * The one way anything here runs wrangler: the deploy's steps from a DeployTarget, the restore drill's (`DrillStep`,
 * local only) from a WranglerTarget. Every step is built from the target alone, with `--config` (the file the gate
 * read: wrangler then skips both its search for wrangler.json, .jsonc or .toml and its `.wrangler/deploy/config.json`
 * redirect), `--env=` (the top level), `--env-file=/dev/null` (wrangler otherwise loads `.env` and `.env.local` into its
 * own environment); `deploy` also names the Worker (`--name`) and the freshly built assets (`--assets`). The environment
 * is `baseEnv` plus `WRANGLER_ALLOWED`'s two, fixed here once: the caller's is read for the token and nothing else.
 */
export function pinnedWrangler(target: DeployTarget, caller: Record<string, string | undefined>): (step: WranglerStep) => Call;
export function pinnedWrangler(target: WranglerTarget, caller: Record<string, string | undefined>): (step: DrillStep) => Call;
export function pinnedWrangler(target: WranglerTarget, caller: Record<string, string | undefined>): (step: WranglerStep | DrillStep) => Call {
  const token = caller.CLOUDFLARE_API_TOKEN;
  const env = Object.freeze({ ...baseEnv(), CLOUDFLARE_ACCOUNT_ID: target.account, ...(token ? { CLOUDFLARE_API_TOKEN: token } : {}) });
  const pins = wranglerPins(target.configPath);
  const args = (step: WranglerStep | DrillStep): string[] => {
    if (typeof step === "object") {
      const local = ["d1", "execute", target.database, "--local", "--persist-to", join(target.root, DRILL_DIR)];
      return step.drill === "restore" ? [...local, "--file", step.file, "--yes"] : [...local, "--command", step.sql, "--json"];
    }
    // only the DeployTarget overload names these steps
    const deploy = target as DeployTarget;
    const steps: Record<WranglerStep, () => string[]> = {
      token: () => ["auth", "token", "--json"],
      secrets: () => ["secret", "list", "--name", target.worker, "--format", "json"],
      bookmark: () => ["d1", "time-travel", "info", target.database, "--json"],
      migrations: () => ["d1", "migrations", "apply", target.database, "--remote"],
      pending: () => ["d1", "migrations", "list", target.database, "--remote"],
      deploy: () => ["deploy", "--name", target.worker, "--assets", deploy.assetsDir, "--tag", deploy.tag, "--message", `commit ${deploy.tag}`],
    };
    return steps[step]();
  };
  return (step) => Object.freeze({ cmd: process.execPath, args: Object.freeze([WRANGLER_BIN, ...args(step), ...pins]), env, cwd: target.root });
}

/** Runs a call exactly as described: its environment replaces the caller's, it is never merged into it. */
export const spawnExec: Exec = (call) => {
  const r = spawnSync(call.cmd, [...call.args], { cwd: call.cwd, env: { ...call.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "" };
};
