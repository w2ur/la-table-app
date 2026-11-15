import type { FetchLike } from "../src/cli/client.ts";
import type { DeployConfig } from "./deploy-config.ts";
import { CI_ACCESS_ID_VAR, CI_ACCESS_SECRET_VAR, GATE_PATHS, MAIN_REMOTE, type DeployDeps } from "./deploy-ci.ts";
import { basename, dirname } from "node:path";
import { isExecutable, SYSTEM_DIRS, SYSTEM_TOOLS, WRANGLER_BIN, WRANGLER_DROPPED, type Call, type Exec } from "./deploy-target.ts";

/** Synthetic values for the deploy's tests: no token, account or address of the owner's is needed to run them. */
export const SHA = "86225a9f00aa1122334455667788990011223344";
export const TAG = "86225a9f00aa";
export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const URL_OK = "https://la-table.w2ur.workers.dev";
export const TEAM = "revah.cloudflareaccess.com";
export const TOKEN = { id: "synthetic.id.access", secret: "synthetic.secret" };
export const BUILD_TOKEN = "synthetic.build.token";
/** The OAuth token `wrangler login` leaves on a laptop, as `wrangler auth token` reads it there. */
export const OAUTH_TOKEN = "synthetic.oauth.token";
/** URL_OK's subdomain: the test account's own. */
export const SUBDOMAIN = "w2ur";
/** Cloudflare's API, as the fake answers it. */
export const API = "https://api.cloudflare.com/client/v4";
export const ROOT = "/repo";
/** Where the fake workspace puts the export of the checked commit: nothing is written there. */
export const WORKSPACE = "/export";
export const TREE = `${WORKSPACE}/tree`;

/**
 * The checked commit as the fake git lists, exports and hashes it, the working tree holding the same: the deploy script,
 * the client it imports (DEFAULT_URL), and GATE_EXTRA's files.
 */
export const COMMIT_FILES: Readonly<Record<string, { oid: string; text: string }>> = {
  "package.json": { oid: "1".repeat(40), text: "{}\n" },
  "scripts/deploy-ci.ts": { oid: "2".repeat(40), text: 'import { DEFAULT_URL } from "../src/cli/client.ts";\n' },
  "src/cli/client.ts": { oid: "3".repeat(40), text: `export const DEFAULT_URL = "${URL_OK}";\n` },
  "tsconfig.json": { oid: "4".repeat(40), text: "{}\n" },
};
export const COMMIT_PATHS = Object.keys(COMMIT_FILES).sort();

/** wrangler.jsonc once the account's values fill it, with the test account. */
export const READY: DeployConfig = {
  name: "la-table",
  tsconfig: "tsconfig.worker.json",
  account_id: ACCOUNT,
  workers_dev: true,
  preview_urls: false,
  assets: { directory: "./dist" },
  version_metadata: { binding: "CF_VERSION_METADATA" },
  vars: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "a".repeat(64) },
  d1_databases: [{ binding: "DB", database_name: "la-table", database_id: "f57f7831-d014-4be5-8edc-0edd1a812c64" }],
  routes: [],
};

/** The commit's package-lock.json, synthetic: a dependency, a build tool, and an optional package for another platform. */
export const LOCKFILE = JSON.stringify({
  name: "la-table",
  version: "0.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "la-table", version: "0.0.0", dependencies: { jose: "^6.2.12" }, devDependencies: { vite: "^8.3.4" } },
    "node_modules/jose": { version: "6.2.12", resolved: "https://registry.npmjs.org/jose/-/jose-6.2.12.tgz", integrity: "sha512-synthetic-jose" },
    "node_modules/vite": { version: "8.3.4", resolved: "https://registry.npmjs.org/vite/-/vite-8.3.4.tgz", integrity: "sha512-synthetic-vite", dev: true },
    "node_modules/@esbuild/linux-x64": { version: "0.27.0", integrity: "sha512-synthetic-esbuild", cpu: ["x64"], os: ["linux"], dev: true, optional: true },
  },
});

/** node_modules/.package-lock.json as `npm ci` writes it from LOCKFILE on a Mac: no root entry, the other platform's package skipped. */
export const INSTALLED = JSON.stringify({
  name: "la-table",
  version: "0.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: Object.fromEntries(Object.entries((JSON.parse(LOCKFILE) as { packages: Record<string, unknown> }).packages).filter(([k]) => k !== "" && !k.includes("linux"))),
});

/** What Workers Builds sets for a build of main, with the probe's token in its build secrets. */
export const CI_ENV: Record<string, string> = {
  WORKERS_CI: "1",
  WORKERS_CI_COMMIT_SHA: SHA,
  WORKERS_CI_BRANCH: "main",
  CLOUDFLARE_API_TOKEN: BUILD_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  WRANGLER_CI_OVERRIDE_NAME: "la-table",
  [CI_ACCESS_ID_VAR]: TOKEN.id,
  [CI_ACCESS_SECRET_VAR]: TOKEN.secret,
};

/** Names Workers Builds, the shell or the deploy itself legitimately sets: varied by a scenario, never as hostile noise. */
export const OWNED = new Set(["WORKERS_CI", "WORKERS_CI_COMMIT_SHA", "WORKERS_CI_BRANCH", "CLOUDFLARE_API_TOKEN", CI_ACCESS_ID_VAR, CI_ACCESS_SECRET_VAR]);

/** Names a hostile shell or build machine may set to steer the deploy: the property test draws them, one test sets them all. */
export const HOSTILE_NAMES = [...Object.keys(WRANGLER_DROPPED), "HOME", "PATH", "XDG_CACHE_HOME", "HTTP_PROXY", "http_proxy", "GIT_WORK_TREE", "GIT_INDEX_FILE", "npm_config_userconfig", "CLOUDFLARE_ACCOUNT_ID", "TSX_TSCONFIG_PATH", "ESBUILD_BINARY_PATH", "TMP", "TEMP"]
  .filter((n) => !OWNED.has(n));

/** A NODE_OPTIONS value the deploy accepts: it must still reach no subprocess. */
export const ALLOWED_NODE_OPTIONS = "--max-old-space-size=4096";


/** A command's name: a system tool's (git, tar, find, ln) when it is one run from SYSTEM_DIRS, the command itself otherwise. */
export function toolName(cmd: string): string {
  return (SYSTEM_DIRS as readonly string[]).includes(dirname(cmd)) && (SYSTEM_TOOLS as readonly string[]).includes(basename(cmd)) ? basename(cmd) : cmd;
}

/** A call as one line: `wrangler <args>` for the pinned wrangler, `<tool> <args>` for a system tool, `<cmd> <args>` otherwise. */
export function line(call: Call): string {
  return call.cmd === process.execPath && call.args[0] === WRANGLER_BIN ? ["wrangler", ...call.args.slice(1)].join(" ") : [toolName(call.cmd), ...call.args].join(" ");
}

export const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

/** The commands the deploy runs on the machine itself, which `local` runs for real. */
const LOCAL_TOOLS = new Set(["git", "tar", "ln", "find"]);

/** The live address as Cloudflare would answer it: Access in front (or not, or unreachable), the Worker behind it. */
/** `named`: Access in front of GATE_PATHS only, as a path-scoped application would be. */
export interface Live { tag: string; access: "front" | "named" | "open" | "unreachable"; tokenAccepted: boolean }

/**
 * The account as Cloudflare's API answers it: its workers.dev subdomain, the routes (patterns) and custom domains
 * (hostnames) attached to la-table in the dashboard, and `api` `down` (no answer) or `refused`
 * (a 403 to the token, as a token without the right permission gets).
 */
export interface Account { subdomain: string; api: "up" | "down" | "refused"; routes: string[]; domains: string[]; /** The domains answer as sent, whatever its shape: replaces `domains`. */ rawDomains?: unknown; /** One endpoint answers 200 with `success: false` and its usual `result`, as an API error not carried by the status would. */ unsuccessful?: "subdomain" | "routes" | "domains" }

/**
 * A stand-in for Cloudflare and the subprocesses: wrangler is a stub that records its calls and, on `deploy`, makes
 * the live address answer the tag it was given; git and the export's tools answer from `answers` (or `local`, the real
 * ones); fetch answers as Live.
 */
export function world(o: {
  env?: Record<string, string | undefined>;
  config?: DeployConfig | (() => DeployConfig);
  readConfig?: DeployDeps["readConfig"];
  answers?: Record<string, ReturnType<Exec>>;
  /** git, tar, ln and find, for real. */
  local?: Exec;
  workspace?: DeployDeps["workspace"];
  /** The directories above the export: empty by default. */
  listDir?: DeployDeps["listDir"];
  live?: Partial<Live>;
  account?: Partial<Account>;
  /** false: wrangler deploy succeeds but the live address keeps the old version. */
  deployLands?: boolean;
  /** false: the keychain holds no token. */
  keychain?: boolean;
  /** node_modules/.package-lock.json in the repository (INSTALLED by default), and the export's package-lock.json (LOCKFILE); null: absent. */
  installed?: string | null;
  lockfile?: string | null;
  /** Files, read for real (the property test); otherwise the two lockfiles above. */
  readText?: DeployDeps["readText"];
  /** Which paths may run: the machine's own by default, where git, tar, find and ln are found. */
  executable?: DeployDeps["executable"];
  /** The trust store: Node's own by default (the same list for `default` and `bundled`). */
  caCertificates?: DeployDeps["caCertificates"];
  rounds?: number;
  root?: string;
  mainRemote?: string;
} = {}) {
  const calls: Call[] = [];
  const log: string[] = [];
  const sleeps: number[] = [];
  const live: Live = { tag: "000000000000", access: "front", tokenAccepted: true, ...o.live };
  const account: Account = { subdomain: SUBDOMAIN, api: "up", routes: [], domains: [], ...o.account };
  /** The API requests the deploy made, each with the token it sent. */
  const api: { path: string; token: string | null }[] = [];
  const answers: Record<string, ReturnType<Exec>> = {
    ...(o.local ? {} : {
      "git rev-parse": ok(`${SHA}\n`),
      "git ls-tree": ok(COMMIT_PATHS.map((p) => `100644 blob ${COMMIT_FILES[p]!.oid}\t${p}\0`).join("")),
      find: ok(COMMIT_PATHS.map((p) => `${TREE}/${p}\0`).join("")),
    }),
    // the Worker holds no secret: wrangler 4.149 prints its list as JSON
    "wrangler secret list": ok("[]\n"),
    "wrangler d1 time-travel": ok('{"bookmark":"00000085-0000024c"}'),
    "wrangler d1 migrations list": ok("\n ⛅️ wrangler 4.149.0\n─────────────\n✅ No migrations to apply!\n"),
    // wrangler 4.149's deploy output: the uploading account's workers.dev address under « Deployed … triggers »
    "wrangler deploy": ok(`Uploaded la-table (1.20 sec)\nDeployed la-table triggers (0.40 sec)\n  ${URL_OK}\nCurrent Version ID: 0b7c3d4e-0000\n`),
    ...o.answers,
  };
  const exec: Exec = (call) => {
    calls.push(call);
    const text = line(call);
    // the longest matching prefix: "git rev-parse origin/main" over "git rev-parse"
    const key = Object.keys(answers).filter((k) => text.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    // wrangler auth token: the API token in its environment (Workers Builds), else the laptop's OAuth login
    if (!key && text.startsWith("wrangler auth token")) {
      return ok(`${JSON.stringify(call.env.CLOUDFLARE_API_TOKEN ? { type: "api_token", token: call.env.CLOUDFLARE_API_TOKEN } : { type: "oauth", token: OAUTH_TOKEN }, null, 2)}\n`);
    }
    const r = key ? answers[key]! : LOCAL_TOOLS.has(toolName(call.cmd)) && o.local ? o.local(call) : toolName(call.cmd) === "git" && call.args[0] === "hash-object" ? hashed(call) : ok();
    if (r.status === 0 && text.startsWith("wrangler deploy ") && o.deployLands !== false) live.tag = call.args[call.args.indexOf("--tag") + 1]!;
    return r;
  };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (input.startsWith(`${API}/`)) {
      const path = input.slice(API.length);
      const auth = new Headers(init?.headers).get("authorization");
      api.push({ path, token: auth?.startsWith("Bearer ") ? auth.slice(7) : null });
      if (account.api === "down") throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
      const known = auth === `Bearer ${BUILD_TOKEN}` || auth === `Bearer ${OAUTH_TOKEN}`;
      if (account.api === "refused" || !known) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null }, { status: 403 });
      const answer = (result: unknown, endpoint?: Account["unsuccessful"]) => Response.json({ success: endpoint === undefined || endpoint !== account.unsuccessful, errors: [], messages: [], result });
      if (path === `/accounts/${ACCOUNT}/workers/subdomain`) return answer({ subdomain: account.subdomain }, "subdomain");
      if (path === `/accounts/${ACCOUNT}/workers/services/la-table`) return answer({ id: "la-table", default_environment: { environment: "production", script: { id: "la-table" } } });
      if (path === `/accounts/${ACCOUNT}/workers/services/la-table/environments/production/routes`) return answer(account.routes.map((pattern, i) => ({ id: `r${i}`, pattern, script: "la-table" })), "routes");
      if (path === `/accounts/${ACCOUNT}/workers/domains?service=la-table`) return answer(account.rawDomains ?? account.domains.map((hostname, i) => ({ id: `d${i}`, hostname, service: "la-table", environment: "production", zone_name: "example.test" })), "domains");
      return Response.json({ success: false, errors: [{ code: 7003, message: "Could not route to /client/v4" + path }], messages: [], result: null }, { status: 404 });
    }
    if (live.access === "unreachable" || url.origin !== URL_OK) throw new Error(`getaddrinfo ENOTFOUND ${url.host}`);
    const headers = new Headers(init?.headers);
    const id = headers.get("CF-Access-Client-Id");
    if (id !== null && (!live.tokenAccepted || id !== TOKEN.id || headers.get("CF-Access-Client-Secret") !== TOKEN.secret)) return new Response(null, { status: 403 });
    if (id === null && (live.access === "front" || (live.access === "named" && (GATE_PATHS as readonly string[]).includes(url.pathname)))) {
      return new Response(null, { status: 302, headers: { location: `https://${TEAM}/cdn-cgi/access/login/${url.host}?redirect_url=${encodeURIComponent(url.pathname)}` } });
    }
    if (url.pathname !== "/api/health") return new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
    // the Worker: without Access in front nothing hands it a JWT, and it refuses
    return id === null ? Response.json({ error: "accès refusé" }, { status: 401 }) : Response.json({ ok: true, version: "0b7c3d4e-0000", tag: live.tag });
  };
  // the export and the working tree both hold COMMIT_FILES: a path of either hashes to its file's blob
  const relative = (p: string) => [TREE, o.root ?? ROOT].map((dir) => `${dir}/`).filter((dir) => p.startsWith(dir)).map((dir) => p.slice(dir.length))[0] ?? p;
  const hashed = (call: Call) => ok(call.args.slice(call.args.indexOf("--") + 1).map((p) => `${COMMIT_FILES[relative(p)]?.oid ?? "f".repeat(40)}\n`).join(""));
  const config = o.config ?? READY;
  const workspaces: { made: string[]; removed: string[] } = { made: [], removed: [] };
  const deps: DeployDeps = {
    env: o.env ?? {},
    root: o.root ?? ROOT,
    cwd: o.root ?? ROOT,
    url: URL_OK,
    mainRemote: o.mainRemote ?? MAIN_REMOTE,
    readConfig: o.readConfig ?? (() => (typeof config === "function" ? config() : config)),
    readSecret: (service) => (o.keychain === false ? null : service.endsWith("-id") ? TOKEN.id : TOKEN.secret),
    readText: o.readText ?? ((path) => (path === `${o.root ?? ROOT}/node_modules/.package-lock.json` ? (o.installed === undefined ? INSTALLED : o.installed) : path.endsWith("/tree/package-lock.json") ? (o.lockfile === undefined ? LOCKFILE : o.lockfile) : path.startsWith(`${TREE}/`) ? (COMMIT_FILES[path.slice(TREE.length + 1)]?.text ?? null) : null)),
    executable: o.executable ?? isExecutable,
    caCertificates: o.caCertificates ?? (() => ["synthetic bundled root"]),
    listDir: o.listDir ?? (() => []),
    fetch,
    exec,
    log: (s) => log.push(s),
    sleep: async (ms) => { sleeps.push(ms); },
    rounds: o.rounds ?? 3,
    intervalMs: 10_000,
    timeoutMs: 1_000,
    workspace: {
      make: () => { const dir = o.workspace ? o.workspace.make() : WORKSPACE; workspaces.made.push(dir); return dir; },
      remove: (dir) => { workspaces.removed.push(dir); o.workspace?.remove(dir); },
    },
  };
  return { deps, calls, log, live, account, api, sleeps, workspaces, lines: () => calls.map(line) };
}
