import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { getCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { ACCESS_ID_SERVICE, ACCESS_SECRET_SERVICE, DEFAULT_URL, type FetchLike, type SecretReader } from "../src/cli/client.ts";
import { isEntry } from "../src/cli/entry.ts";
import { readKeychain } from "../src/cli/keychain.ts";
import { DEPLOY_CONFIG_PATH, deployConfigProblems, readDeployConfig, workersDevSubdomain, type DeployConfig } from "./deploy-config.ts";
import { baseEnv, buildCall, deployTarget, isExecutable, localCall, NO_PENDING_MIGRATIONS, pinnedWrangler, spawnExec, SYSTEM_DIRS, systemTools, type Call, type DeployTarget, type Exec, type SystemTool, type SystemTools, type WranglerStep } from "./deploy-target.ts";

export type { Call, Exec } from "./deploy-target.ts";

/** What Access answered a visitor without a session on one path: `front` true (its login), false (anything else), null (no answer). */
export interface AccessAnswer { path: string; front: boolean | null; detail: string }

/** The named paths asked without a session: the page and the API, which must both answer Access's login, never the Worker. */
export const GATE_PATHS = ["/", "/api/health"] as const;

/**
 * Every path the probe asks: GATE_PATHS, then a path under the API and one at the root drawn fresh each time, which no
 * Access application can name in advance: Access scoped to the named paths only (a path-scoped application, a bypass
 * scoped too wide) would leave every other path served without it.
 */
export function probedPaths(): string[] {
  const fresh = () => randomBytes(8).toString("hex");
  return [...GATE_PATHS, `/api/${fresh()}`, `/${fresh()}`];
}

/**
 * Workers Builds' build secrets holding the build's own service token (`la-table-build`, kept nowhere else), so the
 * build can see its deploy behind Access; a laptop reads the CLI's token (`la-table-cli`) from the keychain instead.
 * Read for the probe only: no subprocess ever gets them.
 */
export const CI_ACCESS_ID_VAR = "LA_TABLE_ACCESS_CLIENT_ID";
export const CI_ACCESS_SECRET_VAR = "LA_TABLE_ACCESS_CLIENT_SECRET";

/**
 * The repository whose main is the only one a laptop deploys, fetched by URL: never `origin`, which is whatever the
 * local configuration says (another URL, a fetch refspec that leaves origin/main stale). A url.insteadOf rule in the
 * owner's git configuration still rewrites it.
 */
export const MAIN_REMOTE = "https://github.com/w2ur/la-table.git";

/**
 * Variables that change how this process itself reaches the live address, so what the Access probe and the closing
 * check see: set, whatever their value, the deploy does not run. wrangler never gets them (WRANGLER_DROPPED); the
 * probe runs in this process and would. The trust store is also checked as it is (`widenedTrust`), whatever widened it.
 */
export const PROBE_ENV_REFUSED: Readonly<Record<string, string>> = Object.freeze({
  NODE_USE_ENV_PROXY: "fetch suit alors HTTP(S)_PROXY",
  HTTP_PROXY: "un mandataire entre la sonde et l'adresse",
  HTTPS_PROXY: "un mandataire entre la sonde et l'adresse",
  http_proxy: "un mandataire entre la sonde et l'adresse",
  https_proxy: "un mandataire entre la sonde et l'adresse",
  NODE_TLS_REJECT_UNAUTHORIZED: "le certificat de l'adresse ne serait plus vérifié",
  NODE_EXTRA_CA_CERTS: "une autorité de certification de plus, qui peut signer pour l'adresse",
  NODE_USE_SYSTEM_CA: "les autorités du système en plus de celles de Node, qui peuvent signer pour l'adresse",
  SSL_CERT_FILE: "les autorités d'un fichier choisi, avec --use-openssl-ca",
  SSL_CERT_DIR: "les autorités d'un répertoire choisi, avec --use-openssl-ca",
  OPENSSL_CONF: "une configuration OpenSSL choisie, qui peut changer les autorités et la vérification",
});

/**
 * The NODE_OPTIONS tokens this process may run with: they size memory or quiet warnings, and load or change no code.
 * Any other (`--import`, `--require`, `--openssl-config`, `--use-env-proxy`, `--use-system-ca`…) and the deploy does
 * not run: this process runs the gate and the probe, and wrangler and the build never get the variable (baseEnv).
 */
export const NODE_OPTIONS_ALLOWED: readonly RegExp[] = Object.freeze([/^--max-old-space-size=\d+$/, /^--max-semi-space-size=\d+$/, /^--enable-source-maps$/, /^--no-warnings$/, /^--no-deprecation$/]);

/**
 * The variable prefixes this process refuses, each with why: the settings of the tools that load the deploy script.
 * tsx's own (TSX_TSCONFIG_PATH remaps the script's imports, `wrangler` among them), and esbuild's, which tsx runs to
 * transpile the script (ESBUILD_BINARY_PATH picks that binary).
 */
export const PROCESS_PREFIXES_REFUSED: Readonly<Record<string, string>> = Object.freeze({
  TSX_: "tsx résoudrait les imports du script de déploiement autrement que le commit",
  ESBUILD_: "tsx transpilerait le script de déploiement avec un autre esbuild que celui du dépôt",
});

/**
 * Why this process could run or resolve code other than the commit's, or null when nothing in its own settings says so:
 * a variable under PROCESS_PREFIXES_REFUSED, a NODE_OPTIONS token outside NODE_OPTIONS_ALLOWED, or a working directory
 * other than the repository (tsx reads the first tsconfig.json found from there up, which gateFiles checks only at the
 * repository's root). `cwd` and `root` are real paths. These catch an honest misconfiguration of the deploy's own
 * environment, not a hostile one: they run once every module has loaded, so code an option has already loaded could
 * have removed what they read. The environment and the user's files that launch `deploy:ci` are trusted, as the
 * contents of node_modules are.
 */
export function processRefusal(env: Record<string, string | undefined>, cwd: string, root: string): string | null {
  const prefixOf = (name: string) => Object.keys(PROCESS_PREFIXES_REFUSED).find((p) => name.startsWith(p));
  const setting = Object.keys(env).filter((n) => prefixOf(n) !== undefined).sort()[0];
  if (setting !== undefined) return `${setting} est défini : ${PROCESS_PREFIXES_REFUSED[prefixOf(setting)!]}`;
  const token = (env.NODE_OPTIONS ?? "").split(/\s+/).find((t) => t !== "" && !NODE_OPTIONS_ALLOWED.some((ok) => ok.test(t)));
  if (token !== undefined) return `NODE_OPTIONS porte ${token} : ce processus chargerait ou réglerait autre chose que le commit (seules la mémoire et les avertissements se règlent)`;
  if (cwd !== root) return `lancé depuis ${cwd}, pas depuis le dépôt ${root} : tsx y chercherait un autre tsconfig.json pour résoudre les imports du script`;
  return null;
}

/**
 * Why the certificate authorities this process trusts are not exactly those built into Node, or null when they are.
 * The probe's fetch accepts any certificate one of them signs: an added root (the system's store, an OpenSSL file or
 * directory, an extra file) could sign for the address and let an interceptor answer for Access; `--use-openssl-ca`
 * empties the list Node reports, which is refused as well, since what OpenSSL then trusts is not known.
 */
export function widenedTrust(store: (kind: "default" | "bundled") => readonly string[]): string | null {
  const trusted = new Set(store("default"));
  const bundled = new Set(store("bundled"));
  const added = [...trusted].filter((c) => !bundled.has(c)).length;
  const missing = [...bundled].filter((c) => !trusted.has(c)).length;
  return added === 0 && missing === 0 ? null : `${added} de plus, ${missing} de moins`;
}

/**
 * The authorities this process trusts (`default`) or those built into Node (`bundled`), each as its certificate's SHA-256
 * fingerprint: Node re-encodes a certificate it is given, so the PEM text of one root differs between the two lists.
 */
export function nodeTrustStore(kind: "default" | "bundled"): string[] {
  return getCACertificates(kind).map((pem) => new X509Certificate(pem).fingerprint256);
}

/** The Worker version tag for a commit: its first 12 hex digits, or null for anything that is not a full commit hash. */
export function versionTag(sha: string): string | null {
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : null;
}

/** The D1 Time Travel bookmark in `wrangler d1 time-travel info --json` output, or null when there is none. */
export function d1Bookmark(stdout: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const bookmark = (parsed as { bookmark?: unknown }).bookmark;
  return typeof bookmark === "string" && bookmark !== "" ? bookmark : null;
}

/**
 * The workers.dev addresses `wrangler deploy` printed, each as an origin: the lines under « Deployed <name> triggers »,
 * which wrangler 4.149 prints as `https://<name>.<the account's subdomain>.workers.dev` (wrangler-dist/cli.js,
 * triggersDeploy). The subdomain is the uploading account's own: the second look, after the upload, at what the API's
 * subdomain showed before Access was asked (that DEFAULT_URL's subdomain is account_id's).
 */
export function deployedAddresses(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim()).filter((l) => /^https:\/\/[^\s/]+\.workers\.dev\/?$/.test(l)).map((l) => new URL(l).origin);
}

/**
 * Where the export of the checked commit is made: the system's /tmp, resolved to its real path. Never `os.tmpdir()`,
 * which reads the caller's TMPDIR, TMP and TEMP: the build looks above the export (`ANCESTOR_REFUSED`), so the export's
 * parents are chosen here, not by the shell.
 */
export const WORKSPACE_PARENT = "/tmp";

/**
 * What the build's tools look for in every directory above the one they run in, and why none may be above the export:
 * the export is the checked commit, everything above it is not. Each was seen read from a parent or is how Node
 * resolves (a postcss, babel or browserslist file in a parent was measured not read by this build).
 */
export const ANCESTOR_REFUSED: Readonly<Record<string, string>> = Object.freeze({
  "tsconfig.json": "esbuild et Vite y lisent des options de compilation et des chemins d'import",
  "jsconfig.json": "esbuild et Vite le lisent à défaut de tsconfig.json",
  "package.json": "Node et les outils du build y lisent le type des modules et leurs imports",
  node_modules: "Node y cherche tout paquet que l'export ne contient pas",
});

/** `dir`, then every directory above it, up to the root. */
function selfAndAncestors(dir: string): string[] {
  const out = [dir];
  while (dirname(out.at(-1)!) !== out.at(-1)) out.push(dirname(out.at(-1)!));
  return out;
}

/** The deploy script, relative to the repository: where `gateFiles` starts. */
export const GATE_ENTRY = "scripts/deploy-ci.ts";

/** The TypeScript configuration tsx reads beside the deploy script, relative to the repository: where `extendedConfigs` starts. */
export const GATE_TSCONFIG = "tsconfig.json";

/** Files the deploy script depends on without importing them, each with why: compared with the commit like its imports. */
export const GATE_EXTRA: Readonly<Record<string, string>> = Object.freeze({
  "package.json": "npm run deploy:ci y lit la commande lancée",
  [GATE_TSCONFIG]: "tsx y lit comment résoudre les imports du script, comme dans chaque fichier qu'il étend",
});

/** Where DEFAULT_URL is declared, relative to the repository. */
export const CLIENT_PATH = "src/cli/client.ts";

/**
 * The relative specifiers a TypeScript source imports or re-exports (`from`, a bare `import`, `import()`), outside its
 * block comments and its whole-line comments.
 */
export function relativeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g);
  return [...new Set([...found].map((m) => m[1]!))];
}

/** The text of a JSON-with-comments file (tsconfig.json) as a value: comments and trailing commas dropped. Null when it is not one. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(i));
      if (end === null) return null;
      out += end[0];
      i += end[0].length - 1;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return null;
      i = close + 1;
      out += " ";
    } else out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
}

/**
 * The files GATE_TSCONFIG extends, relative to the repository, transitively, as tsx resolves them (as written, then with
 * `.json`): tsx honours their options too, `paths` included, which can remap the script's imports. A string names what
 * cannot be followed inside the repository: an unreadable configuration, an `extends` to no file, or one outside the
 * repository (an absolute path, a parent, a package), whose content the commit does not hold.
 */
export function extendedConfigs(read: (path: string) => string | null): string[] | string {
  const found: string[] = [];
  const todo = [GATE_TSCONFIG];
  while (todo.length > 0) {
    const file = todo.pop()!;
    const text = read(file);
    const parsed = text === null ? null : parseJsonc(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return `${file} (configuration illisible)`;
    const extended = (parsed as { extends?: unknown }).extends;
    const specs = extended === undefined ? [] : Array.isArray(extended) ? extended : [extended];
    for (const spec of specs) {
      if (typeof spec !== "string" || !/^\.{1,2}\//.test(spec)) return `${String(spec)} (étendu par ${file}, hors du dépôt)`;
      const base = normalize(join(dirname(file), spec));
      if (base === ".." || base.startsWith("../")) return `${spec} (étendu par ${file}, hors du dépôt)`;
      const target = [base, `${base}.json`].find((p) => read(p) !== null);
      if (target === undefined) return `${spec} (étendu par ${file})`;
      if (target !== GATE_TSCONFIG && !found.includes(target)) { found.push(target); todo.push(target); }
    }
  }
  return found.sort();
}

/**
 * The files the deploy script runs from, relative to the repository and sorted: GATE_ENTRY, every file it imports by a
 * relative path, transitively (resolved as tsx resolves them: as written, then with `.ts`, `.tsx` or `/index.ts`), and
 * GATE_EXTRA, with every file GATE_TSCONFIG extends (`extendedConfigs`). `read` gives a file's text, or null. A string
 * names an import that resolves to no file, or an `extends` that cannot be followed inside the repository.
 */
export function gateFiles(read: (path: string) => string | null): string[] | string {
  const files = new Set<string>();
  const todo = [GATE_ENTRY];
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    const text = read(file);
    if (text === null) return file;
    files.add(file);
    for (const spec of relativeImports(text)) {
      const base = normalize(join(dirname(file), spec));
      const target = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((p) => !p.startsWith("..") && read(p) !== null);
      if (target === undefined) return `${spec} (importé par ${file})`;
      todo.push(target);
    }
  }
  for (const extra of Object.keys(GATE_EXTRA)) files.add(extra);
  const configs = extendedConfigs(read);
  if (typeof configs === "string") return configs;
  for (const config of configs) files.add(config);
  return [...files].sort();
}

/**
 * The `node_modules` directories, relative to the repository, that Node searches before the repository's own when a
 * file of the deploy script imports a package: one in any directory between a `gateFiles` file and the root (its own
 * directory included, the root excluded). Such a directory decides which `wrangler` deploy-config.ts imports (the
 * configuration reader the gate trusts) and which one WRANGLER_BIN names (the binary that deploys), and git status never
 * shows it (`node_modules/` is gitignored at any depth). `entries` lists a directory of the repository, or null when it
 * cannot be read; a string names a directory that could not.
 */
export function shadowingModules(gate: readonly string[], entries: (dir: string) => readonly string[] | null): string[] | string {
  const dirs = new Set<string>();
  for (const file of gate) for (let dir = dirname(file); dir !== "." && dir !== "/"; dir = dirname(dir)) dirs.add(dir);
  const found: string[] = [];
  for (const dir of [...dirs].sort()) {
    const names = entries(dir);
    if (names === null) return dir;
    if (names.includes("node_modules")) found.push(join(dir, "node_modules"));
  }
  return found;
}

/** DEFAULT_URL as `src/cli/client.ts` declares it (`export const DEFAULT_URL = "…";`), or null when it is not declared so. */
export function declaredDefaultUrl(source: string): string | null {
  return /^export const DEFAULT_URL = "([^"\\]*)";$/m.exec(source)?.[1] ?? null;
}

/** How long the probe waits for each answer: a hung address is unknown (exit 2) in seconds, not a deploy left hanging. */
export const ACCESS_TIMEOUT_MS = 15_000;

/**
 * null when `res` is Cloudflare Access's login (a 302 to the team's domain, which the Worker never sends), else what
 * answered instead. The one reading of Access's redirect, for the deploy's probe and scripts/probe-live.ts alike.
 */
export function accessLoginRefusal(res: Response, base: string, team: string): string | null {
  const location = res.headers.get("location");
  let target: string | null = null;
  try { target = location === null ? null : new URL(location, base).hostname; } catch { target = null; }
  return res.status === 302 && target === team ? null : `${res.status} vers ${location ?? "rien"}`;
}

/**
 * Asks the live address like a browser with no session (`accept: text/html`, no cookie, no token) and reads whether
 * Cloudflare Access answered (`accessLoginRefusal`).
 */
export async function accessInFront(f: FetchLike, base: string, team: string, timeoutMs = ACCESS_TIMEOUT_MS, paths: readonly string[] = probedPaths()): Promise<AccessAnswer[]> {
  const answers: AccessAnswer[] = [];
  for (const path of paths) {
    try {
      const res = await f(`${base}${path}`, { headers: { accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
      const refusal = accessLoginRefusal(res, base, team);
      answers.push({ path, front: refusal === null, detail: refusal ?? `302 vers ${team}` });
    } catch (error) {
      answers.push({ path, front: null, detail: `injoignable : ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return answers;
}

/**
 * The secret names in `wrangler secret list --format json` output (wrangler 4.149: a JSON array of `{ name, type }`), or
 * null when it is not that list.
 */
export function secretNames(stdout: string): string[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const names = parsed.map((s) => (s as { name?: unknown } | null)?.name);
  return names.every((n): n is string => typeof n === "string" && n !== "") ? names : null;
}

/** Cloudflare's API, which the deploy reads (never writes) with the credential wrangler uses (`apiToken`). */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * The credential in `wrangler auth token --json` output: Workers Builds' API token or the laptop's OAuth token, the one
 * every wrangler step uses; null for anything else (a global key, which the deploy never passes, or no JSON).
 */
export function apiToken(stdout: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const { type, token } = (parsed ?? {}) as { type?: unknown; token?: unknown };
  return (type === "api_token" || type === "oauth") && typeof token === "string" && token !== "" ? token : null;
}

/**
 * GET one path of Cloudflare's API with `token`: its `result` once the API says it succeeded, or why it was not read
 * (no answer, a status, the API's own errors). The token is sent only to CLOUDFLARE_API and never appears in the answer.
 */
export async function cloudflareGet(f: FetchLike, token: string, path: string, timeoutMs = ACCESS_TIMEOUT_MS): Promise<{ result: unknown } | { error: string }> {
  let res: Response;
  try {
    res = await f(`${CLOUDFLARE_API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { error: `injoignable : ${error instanceof Error ? error.message : String(error)}` };
  }
  let body: { success?: unknown; result?: unknown; errors?: unknown } | null;
  try { body = (await res.json()) as typeof body; } catch { return { error: `${res.status}, réponse illisible` }; }
  if (res.status !== 200 || body?.success !== true) {
    const errors = Array.isArray(body?.errors) ? body.errors.map((e) => `${(e as { code?: unknown }).code} ${(e as { message?: unknown }).message}`).join(" ; ") : "";
    return { error: `${res.status}${errors ? ` : ${errors}` : ""}` };
  }
  return { result: body.result };
}

/**
 * The hosts a Worker answers on besides its workers.dev address, as Cloudflare's API lists them: the routes of its
 * default environment (`/workers/services/<name>`, then its `/routes`, as wrangler reads a dashboard Worker) and its
 * custom domains (`/workers/domains?service=<name>`); or why they could not be read. A route or a domain attached in the
 * dashboard is outside wrangler.jsonc, which the gate's own check (`deployConfigProblems`) reads.
 */
export async function attachedHosts(f: FetchLike, token: string, account: string, worker: string, timeoutMs = ACCESS_TIMEOUT_MS): Promise<{ hosts: string[] } | { error: string }> {
  const service = await cloudflareGet(f, token, `/accounts/${account}/workers/services/${worker}`, timeoutMs);
  if ("error" in service) return service;
  const environment = (service.result as { default_environment?: { environment?: unknown } } | null)?.default_environment?.environment;
  if (typeof environment !== "string" || environment === "") return { error: "environnement du Worker illisible" };
  const routes = await cloudflareGet(f, token, `/accounts/${account}/workers/services/${worker}/environments/${environment}/routes`, timeoutMs);
  if ("error" in routes) return routes;
  const domains = await cloudflareGet(f, token, `/accounts/${account}/workers/domains?service=${worker}`, timeoutMs);
  if ("error" in domains) return domains;
  if (!Array.isArray(routes.result) || !Array.isArray(domains.result)) return { error: "liste illisible" };
  const patterns = routes.result.map((r) => (r as { pattern?: unknown } | null)?.pattern);
  // the API filters by service; the answer is filtered again, never trusted to have done it. An entry whose service
  // cannot be read is not one to drop: it could be this Worker's (a renamed or partial field), so the answer is unreadable
  const services = domains.result.map((d) => (d as { service?: unknown } | null)?.service);
  if (!services.every((s) => typeof s === "string" && s !== "")) return { error: "domaine sans service lisible" };
  const hostnames = domains.result.filter((_, i) => services[i] === worker).map((d) => (d as { hostname?: unknown }).hostname);
  const hosts = [...patterns, ...hostnames];
  return hosts.every((h): h is string => typeof h === "string" && h !== "") ? { hosts } : { error: "route ou domaine sans nom" };
}

/** What `/api/health` answered through Access with the service token: the Worker's tag, or why there is none. */
export interface HealthAnswer { reached: boolean; tag: string | null; detail: string }

/** Asks the running version, through Access, with the service token. `reached`: the Worker itself answered. */
export async function liveHealth(f: FetchLike, base: string, headers: Record<string, string>, timeoutMs = ACCESS_TIMEOUT_MS): Promise<HealthAnswer> {
  let res: Response;
  try {
    res = await f(`${base}/api/health`, { headers: { ...headers, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { reached: false, tag: null, detail: `injoignable : ${error instanceof Error ? error.message : String(error)}` };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    const why = res.status >= 300 && res.status < 400 ? "redirigé vers la connexion Access, jeton refusé" : res.status === 401 || res.status === 403 ? "jeton Access refusé" : "pas de réponse du Worker";
    return { reached: false, tag: null, detail: `${why} (${res.status})` };
  }
  let body: unknown;
  try { body = await res.json(); } catch { return { reached: false, tag: null, detail: "réponse illisible (200)" }; }
  const tag = (body as { tag?: unknown } | null)?.tag;
  return typeof tag === "string" && tag !== "" ? { reached: true, tag, detail: `version ${tag}` } : { reached: true, tag: null, detail: "version sans étiquette" };
}

/**
 * Whether Access lets the service token through to the Worker, asked on `/api/health`: `accepted` false when Access
 * redirects it to the login or answers 401/403 (the token is not in the policy, or its ID and secret are swapped), true
 * for any other answer (the Worker's own, the placeholder's 503 included: Access let the request reach it), null when
 * nothing answered.
 */
export async function tokenAccepted(f: FetchLike, base: string, headers: Record<string, string>, timeoutMs = ACCESS_TIMEOUT_MS): Promise<{ accepted: boolean | null; detail: string }> {
  let res: Response;
  try {
    res = await f(`${base}/api/health`, { headers: { ...headers, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { accepted: null, detail: `injoignable : ${error instanceof Error ? error.message : String(error)}` };
  }
  await res.body?.cancel();
  const refused = (res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403;
  return { accepted: !refused, detail: String(res.status) };
}

/** Everything the deploy reads from outside itself, so a test can stand in for each. */
export interface DeployDeps {
  /** The caller's environment: read for Workers Builds' claims (commit, branch), its API token and the probe's token, nothing else. */
  env: Record<string, string | undefined>;
  /** The repository, as a real path: where the configuration is read and every step runs. */
  root: string;
  /** This process's working directory, as a real path: the repository's, or the deploy does not run (`processRefusal`). */
  cwd: string;
  /** MAIN_REMOTE: where a laptop reads main. */
  mainRemote: string;
  /** The app's address, DEFAULT_URL; never the caller's LA_TABLE_URL. */
  url: string;
  readConfig: (path: string, env: Record<string, string>) => DeployConfig;
  /**
   * A fresh empty directory for the export of the checked commit (`make`, a real path: no symlink in it), removed after
   * the deploy whatever happened. Under WORKSPACE_PARENT.
   */
  workspace: { make: () => string; remove: (dir: string) => void };
  /** A directory's entries, or null when it cannot be read: the export's parents, checked for ANCESTOR_REFUSED. */
  listDir: (dir: string) => readonly string[] | null;
  /** The keychain, on a laptop. */
  readSecret: SecretReader;
  /** A file's text, or null when it cannot be read: the lockfiles compared before node_modules is linked into the export. */
  readText: (path: string) => string | null;
  /** Whether a path is a file this process may run: how `systemTools` finds git, tar, find and ln in SYSTEM_DIRS. */
  executable: (path: string) => boolean;
  /** The certificate authorities this process trusts (`default`) and those built into Node (`bundled`): nodeTrustStore. */
  caCertificates: (kind: "default" | "bundled") => readonly string[];
  fetch: FetchLike;
  exec: Exec;
  log: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** After the deploy: how many times, how far apart, the live address is asked for the new tag. */
  rounds: number;
  intervalMs: number;
  timeoutMs: number;
}

/** The service token tokenAccepted tries before the build and the closing probe sends: Workers Builds' build secrets, or a laptop's keychain; a string names what is missing. */
function probeHeaders(d: DeployDeps, ci: boolean): Record<string, string> | string {
  const id = ci ? d.env[CI_ACCESS_ID_VAR] : d.readSecret(ACCESS_ID_SERVICE);
  const secret = ci ? d.env[CI_ACCESS_SECRET_VAR] : d.readSecret(ACCESS_SECRET_SERVICE);
  if (!id || !secret) {
    const missing = ci ? (!id ? CI_ACCESS_ID_VAR : CI_ACCESS_SECRET_VAR) : `${!id ? ACCESS_ID_SERVICE : ACCESS_SECRET_SERVICE} dans le trousseau`;
    return `jeton Access absent (${missing}) : sans lui, le déploiement ne pourrait pas être vu derrière Access`;
  }
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/**
 * The commit the tree holds, checked: a clean tree as git status shows it, whose HEAD is what Workers Builds says it
 * built on main, or, from a laptop, main as GitHub holds it now (fetched from MAIN_REMOTE into FETCH_HEAD: neither a
 * stale local ref nor an origin pointing elsewhere can stand in for it). A number is an exit code.
 */
function checkedCommit(d: DeployDeps, ci: boolean, tools: SystemTools): string | 1 | 2 {
  const git = (...args: string[]) => d.exec(localCall(d.root, tools.git, args));
  const claimed = d.env.WORKERS_CI_COMMIT_SHA ?? "";
  if (ci) {
    // Workers Builds names the branch it built: only main deploys, whichever branch the dashboard sends here
    if (d.env.WORKERS_CI_BRANCH !== "main") { d.log(`branche ${d.env.WORKERS_CI_BRANCH ?? "inconnue"} : seul main se déploie`); return 1; }
    if (versionTag(claimed) === null) { d.log(`commit illisible : ${claimed}`); return 2; }
  }
  const status = git("status", "--porcelain");
  if (status.status !== 0) { d.log("git illisible : impossible de nommer le commit déployé"); return 2; }
  if (status.stdout.trim() !== "") {
    d.log(`arbre de travail modifié : committez et poussez avant de déployer (${status.stdout.trim().split("\n").join(", ")})`);
    return 1;
  }
  if (!ci) {
    const fetched = git("fetch", d.mainRemote, "refs/heads/main");
    if (fetched.status !== 0) { d.log(`GitHub injoignable : impossible de vérifier que HEAD est le main poussé (${fetched.stderr.trim()})`); return 2; }
  }
  const head = git("rev-parse", "HEAD");
  const main = ci ? { status: 0, stdout: claimed } : git("rev-parse", "FETCH_HEAD");
  if (head.status !== 0 || main.status !== 0) { d.log("git illisible : impossible de nommer le commit déployé"); return 2; }
  const sha = head.stdout.trim();
  if (sha !== main.stdout.trim()) {
    d.log(ci ? `Workers Builds annonce le commit ${claimed}, l'arbre est à ${sha} : déploiement refusé` : "HEAD n'est pas le main de GitHub : seul main, poussé, se déploie");
    return 1;
  }
  return sha;
}

/** A commit's files as `git ls-tree -r -z` lists them: path → blob id, or the first entry that is not a plain file. */
function commitBlobs(listing: string): Map<string, string> | string {
  const blobs = new Map<string, string>();
  for (const entry of listing.split("\0").filter((e) => e !== "")) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !oid) return `${path} (${mode} ${type})`;
    blobs.set(path, oid);
  }
  return blobs;
}

/** A lockfile's `packages`, or null when the text is not a lockfile. */
function lockedPackages(text: string | null): Record<string, { version?: unknown; integrity?: unknown; optional?: unknown; devOptional?: unknown }> | null {
  if (text === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const packages = (parsed as { packages?: unknown } | null)?.packages;
  return typeof packages === "object" && packages !== null && !Array.isArray(packages) ? (packages as ReturnType<typeof lockedPackages> & object) : null;
}

/**
 * The packages where `node_modules/.package-lock.json` (what npm installed) and the commit's `package-lock.json` differ:
 * one installed that the lockfile does not name, or under another version or integrity, or one it names that is not
 * installed, unless optional (npm skips another platform's packages). Null when either text is not a lockfile. npm
 * rewrites the hidden lockfile on every install; a file edited by hand under node_modules is not seen here.
 */
export function installMismatch(installedText: string | null, lockText: string | null): string[] | null {
  const installed = lockedPackages(installedText);
  const locked = lockedPackages(lockText);
  if (installed === null || locked === null) return null;
  const differ = Object.entries(installed).filter(([path, p]) => path !== "" && (locked[path]?.version !== p.version || locked[path]?.integrity !== p.integrity)).map(([path]) => path);
  const missing = Object.entries(locked).filter(([path, p]) => path !== "" && !(path in installed) && p.optional !== true && p.devOptional !== true).map(([path]) => path);
  return [...differ, ...missing].sort();
}

/**
 * Writes the checked commit into `workspace/tree` and proves it is that commit: every file there hashed raw (no
 * filter, no attribute) equals the commit's blob, and nothing else is there. The build and every wrangler step then run
 * from this directory, never from the working tree, whose content git may hide (skip-worktree, assume-unchanged, a `git replace`,
 * info/exclude, showUntrackedFiles) and whose export a local filter or attribute may rewrite. The repository's
 * node_modules is linked in once its installed lockfile is the commit's (`installMismatch`). A string is the tree's
 * path; a number is an exit code.
 */
function exportCommit(d: DeployDeps, sha: string, workspace: string, tools: SystemTools): string | 1 | 2 {
  const run = (tool: SystemTool, args: string[]) => d.exec(localCall(d.root, tools[tool], args));
  // the build's tools look above the export: what they would find there is not the commit's
  for (const dir of selfAndAncestors(workspace)) {
    const names = d.listDir(dir);
    if (names === null) { d.log(`${dir} illisible : impossible de vérifier que rien au-dessus de l'export ne change le build`); return 2; }
    const found = names.filter((n) => Object.hasOwn(ANCESTOR_REFUSED, n)).sort();
    if (found.length > 0) {
      d.log(`${found.map((n) => join(dir, n)).join(", ")} au-dessus de l'export : ${found.map((n) => ANCESTOR_REFUSED[n]).join(" ; ")}, hors du commit, déploiement refusé`);
      return 1;
    }
  }
  const tree = join(workspace, "tree");
  const archive = join(workspace, "commit.tar");
  const steps: [SystemTool, string[]][] = [
    ["git", ["archive", "--format=tar", "--prefix=tree/", "-o", archive, sha]],
    ["tar", ["-x", "-f", archive, "-C", workspace]],
  ];
  for (const [cmd, args] of steps) {
    const r = run(cmd, args);
    if (r.status !== 0) { d.log(`export du commit impossible (${cmd} ${r.status}) : ${r.stderr.trim()}`); return 2; }
  }
  const listed = run("git", ["ls-tree", "-r", "-z", "--full-tree", sha]);
  const found = run("find", [tree, "!", "-type", "d", "-print0"]);
  if (listed.status !== 0 || found.status !== 0) { d.log("export du commit illisible : impossible de le comparer au commit"); return 2; }
  const expected = commitBlobs(listed.stdout);
  if (typeof expected === "string") { d.log(`le commit contient ${expected} : seul un fichier ordinaire s'exporte, export non vérifiable`); return 2; }
  const paths = found.stdout.split("\0").filter((p) => p !== "").map((p) => p.slice(tree.length + 1)).sort();
  const hashed = run("git", ["hash-object", "--no-filters", "--", ...paths.map((p) => join(tree, p))]);
  const oids = hashed.stdout.split("\n").filter((l) => l !== "");
  if (hashed.status !== 0 || oids.length !== paths.length) { d.log(`export du commit illisible (git ${hashed.status}) : ${hashed.stderr.trim()}`); return 2; }
  const exported = new Map(paths.map((p, i) => [p, oids[i]!]));
  const differ = [...new Set([...expected.keys(), ...exported.keys()])].filter((p) => expected.get(p) !== exported.get(p)).sort();
  if (differ.length > 0) {
    d.log(`l'export ne reproduit pas le commit ${sha} (${differ.slice(0, 5).join(", ")}${differ.length > 5 ? ", …" : ""}) : un réglage git local (filtre, attributs) le transforme`);
    return 1;
  }
  // the deploy's own code runs from the working tree, whose changes git status may not show: it must be the commit's
  const gate = gateFiles((p) => d.readText(join(tree, p)));
  if (typeof gate === "string") { d.log(`le script de déploiement du commit ne se lit pas jusqu'au bout (${gate}) : impossible de vérifier le script en cours`); return 2; }
  const running = run("git", ["hash-object", "--no-filters", "--", ...gate.map((p) => join(d.root, p))]);
  const runningOids = running.stdout.split("\n").filter((l) => l !== "");
  if (running.status !== 0 || runningOids.length !== gate.length) { d.log(`script de déploiement en cours illisible (git ${running.status}) : ${running.stderr.trim()}`); return 2; }
  const altered = gate.filter((p, i) => runningOids[i] !== expected.get(p));
  if (altered.length > 0) {
    d.log(`le script de déploiement en cours n'est pas celui du commit ${sha} (${altered.slice(0, 5).join(", ")}${altered.length > 5 ? ", …" : ""}) : une modification que git status ne montre pas (skip-worktree, assume-unchanged), déploiement refusé`);
    return 1;
  }
  // the packages it imports, wrangler among them, must come from the repository's node_modules, checked below
  const shadowing = shadowingModules(gate, (dir) => d.listDir(join(d.root, dir)));
  if (typeof shadowing === "string") { d.log(`${join(d.root, shadowing)} illisible : impossible de vérifier qu'aucun node_modules n'y passe avant celui du dépôt`); return 2; }
  if (shadowing.length > 0) {
    d.log(`${shadowing.join(", ")} : Node y trouverait wrangler, et tout paquet que le script de déploiement importe, avant le node_modules du dépôt, hors du commit et invisible à git status, déploiement refusé`);
    return 1;
  }
  // the probes ask d.url, the running DEFAULT_URL: the commit's own
  const declared = declaredDefaultUrl(d.readText(join(tree, CLIENT_PATH)) ?? "");
  if (declared === null) { d.log(`${CLIENT_PATH} du commit ne déclare pas DEFAULT_URL comme attendu : impossible de vérifier l'adresse sondée`); return 2; }
  if (declared !== d.url) { d.log(`l'adresse sondée ${d.url} n'est pas le DEFAULT_URL du commit (${declared}) : déploiement refusé`); return 1; }
  // the dependencies bundled into the Worker (jose checks the JWT), the build and wrangler all come from this
  // node_modules: it must be the commit's lockfile installed, not another branch's install left in place
  const installedPath = join(d.root, "node_modules", ".package-lock.json");
  const lockPath = join(tree, "package-lock.json");
  const installed = d.readText(installedPath);
  const locked = d.readText(lockPath);
  const mismatch = installMismatch(installed, locked);
  if (mismatch === null) {
    d.log(`${lockedPackages(installed) === null ? installedPath : lockPath} illisible : impossible de vérifier que node_modules est installé depuis le commit (npm ci l'écrit)`);
    return 2;
  }
  if (mismatch.length > 0) {
    d.log(`node_modules n'est pas installé depuis le package-lock.json du commit ${sha} (${mismatch.slice(0, 5).join(", ")}${mismatch.length > 5 ? ", …" : ""}) : lancez npm ci, puis déployez`);
    return 1;
  }
  const linked = run("ln",["-s", join(d.root, "node_modules"), join(tree, "node_modules")]);
  if (linked.status !== 0) { d.log(`export du commit impossible (ln ${linked.status}) : ${linked.stderr.trim()}`); return 2; }
  return tree;
}

/**
 * After the deploy: asks the target's address through Access, in rounds (the edge answers as the old version for a
 * while), until `/api/health` names the new tag, then checks Access still answers a visitor without a session.
 * 0 seen behind Access; 1 the Worker answered, but never with the new tag, or Access is no longer in front; 2 never reached.
 */
async function confirmLive(d: DeployDeps, target: DeployTarget, headers: Record<string, string>): Promise<number> {
  let reached = false;
  for (let round = 1; round <= d.rounds; round++) {
    const answer = await liveHealth(d.fetch, target.url, headers, d.timeoutMs);
    d.log(`après déploiement, tour ${round} : ${answer.detail}${answer.tag === target.tag ? " (attendue)" : ""}`);
    reached ||= answer.reached;
    if (answer.tag === target.tag) {
      const answers = await accessInFront(d.fetch, target.url, target.team, d.timeoutMs);
      for (const a of answers) d.log(`Access devant ${a.path} après déploiement : ${a.front === true ? "oui" : a.front === false ? "NON" : "inconnu"} (${a.detail})`);
      if (answers.some((a) => a.front === false)) { d.log(`Access n'est plus devant ${target.url} : la version ${target.tag} répond sans lui`); return 1; }
      if (answers.length === 0 || answers.some((a) => a.front === null)) { d.log("Access n'a pas pu être revérifié après le déploiement"); return 2; }
      d.log(`déployé et vu derrière Access : version ${target.tag} sur ${target.url}`);
      return 0;
    }
    if (round < d.rounds) await d.sleep(d.intervalMs);
  }
  if (reached) { d.log(`${target.url} ne répond pas la version ${target.tag} après ${d.rounds} tours : déploiement non vu`); return 1; }
  d.log(`${target.url} injoignable derrière Access après ${d.rounds} tours : déploiement non vérifié`);
  return 2;
}

async function deploy(d: DeployDeps): Promise<number> {
  const { log } = d;
  // the probe is this process's own fetch: a proxy or a loosened TLS check here could answer for Access
  const steered = Object.keys(PROBE_ENV_REFUSED).find((name) => d.env[name] !== undefined);
  if (steered) { log(`${steered} est défini : la vérification d'Access passerait par un autre chemin (${PROBE_ENV_REFUSED[steered]}), déploiement refusé`); return 2; }
  // this process runs the gate from the working tree: its own settings must not say it loads or resolves other code
  // (an honest misconfiguration; a hostile environment is out of reach from inside, see processRefusal)
  const loaded = processRefusal(d.env, d.cwd, d.root);
  if (loaded) { log(`${loaded}, déploiement refusé`); return 2; }
  // whatever widened it (a name not listed above, a setting of the machine), the store the probe's fetch trusts is Node's own
  const widened = widenedTrust(d.caCertificates);
  if (widened) { log(`ce processus ne fait pas confiance aux seules autorités de certification de Node (${widened}) : une autre pourrait signer pour l'adresse et répondre à la place d'Access, déploiement refusé`); return 2; }
  // the export's proof runs git, tar, find and ln: the system's own, never a bin of that name met earlier on PATH
  const tools = systemTools(d.executable);
  if (typeof tools === "string") { log(`${tools} introuvable dans ${SYSTEM_DIRS.join(" et ")} : la preuve de l'export ne s'appuie que sur les outils du système, déploiement impossible`); return 2; }
  const configPath = resolve(d.root, DEPLOY_CONFIG_PATH);
  const cfg = d.readConfig(configPath, { ...baseEnv() });
  const problems = deployConfigProblems(cfg, d.url);
  if (problems.length > 0) {
    for (const p of problems) log(`configuration refusée : ${p}`);
    return 1;
  }
  // Workers Builds names the commit it built; without that claim, this is a laptop. The claim is self-declared (any
  // shell can set these variables): only a laptop checks main against GitHub, so half a claim is refused outright
  const ci = d.env.WORKERS_CI_COMMIT_SHA !== undefined;
  if (ci && d.env.WORKERS_CI !== "1") { log("WORKERS_CI_COMMIT_SHA sans WORKERS_CI=1 : ni Workers Builds ni un laptop, déploiement refusé"); return 1; }
  const headers = probeHeaders(d, ci);
  if (typeof headers === "string") { log(headers); return 2; }
  const commit = checkedCommit(d, ci, tools);
  if (typeof commit === "number") return commit;
  const tag = versionTag(commit);
  if (!tag) { log(`commit illisible : ${commit}`); return 2; }
  const workspace = d.workspace.make();
  try {
    return await deployExport(d, commit, tag, workspace, headers, tools);
  } finally {
    d.workspace.remove(workspace);
  }
}

/**
 * Asks Access on the target's address (`accessInFront`) and logs each answer: null when it answered on every path, or
 * the exit code that refuses the deploy (1 a path served without it, 2 no answer read). `when` tells the two asks apart
 * in the log.
 */
async function accessRefusal(d: DeployDeps, target: DeployTarget, when: string): Promise<number | null> {
  const answers = await accessInFront(d.fetch, target.url, target.team, d.timeoutMs);
  for (const a of answers) d.log(`Access devant ${a.path}${when} : ${a.front === true ? "oui" : a.front === false ? "NON" : "inconnu"} (${a.detail})`);
  if (answers.length === 0) { d.log(`aucune réponse d'Access lue${when} : déploiement refusé`); return 2; }
  if (answers.some((a) => a.front === false)) { d.log(`Access n'est pas devant l'adresse de l'app${when} : déploiement refusé`); return 1; }
  if (answers.some((a) => a.front === null)) { d.log(`Access n'a pas pu être vérifié${when} : déploiement refusé`); return 2; }
  return null;
}

/**
 * Reads what the dashboard can change on the Worker without wrangler.jsonc showing it, and refuses the deploy on it: null
 * when the Worker has its workers.dev address only and no secret, or the exit code (1 one is attached or held, 2 it
 * cannot be read). Asked before Access, and again just before the upload (`when`), since the build and the migrations
 * take minutes in which either could be added.
 */
async function workerRefusal(d: DeployDeps, target: DeployTarget, token: string, wrangler: (step: WranglerStep) => Call, when: string): Promise<number | null> {
  const { log } = d;
  const seen = when === "" ? "" : ` (vu${when})`;
  // a route or a custom domain attached in the dashboard serves the app on a host the probes never ask (Worker-level
  // Access covers it too, but the app has its workers.dev address only): wrangler.jsonc cannot show one
  const attached = await attachedHosts(d.fetch, token, target.account, target.worker, d.timeoutMs);
  if ("error" in attached) { log(`routes et domaines du Worker ${target.worker} illisibles (${attached.error}) : impossible de vérifier qu'il n'a que son adresse workers.dev, déploiement refusé${seen}`); return 2; }
  if (attached.hosts.length > 0) {
    log(`le Worker ${target.worker} répond aussi sur ${attached.hosts.join(", ")}, attaché dans le tableau de bord : l'app n'a que son adresse workers.dev, que les sondes regardent ; retirez-le, puis redéployez${seen}`);
    return 1;
  }
  log(`routes et domaines du Worker ${target.worker}${when} : aucun, seule son adresse workers.dev`);

  // a Worker secret survives every deploy (keep_vars spares plain variables only; wrangler.jsonc cannot show one): the
  // Worker holds none, so any is refused, a DEV_SKIP_ACCESS above all
  const listed = d.exec(wrangler("secrets"));
  const secrets = listed.status === 0 ? secretNames(listed.stdout.trim()) : null;
  if (secrets === null) { log(`liste des secrets du Worker ${target.worker} illisible (wrangler ${listed.status}) : ${listed.stderr.trim() || listed.stdout.trim()}${seen}`); return 2; }
  if (secrets.length > 0) {
    log(`le Worker ${target.worker} porte des secrets (${secrets.join(", ")}) : il n'en a aucun, et chacun survit à tout déploiement (un DEV_SKIP_ACCESS, le contournement d'Access), déploiement refusé ; wrangler secret delete, puis redéployez${seen}`);
    return 1;
  }
  log(`secrets du Worker ${target.worker}${when} : aucun`);
  return null;
}

/** The deploy from the export of the checked commit: its configuration checked again, then the target, Access and the steps. */
async function deployExport(d: DeployDeps, commit: string, tag: string, workspace: string, headers: Record<string, string>, tools: SystemTools): Promise<number> {
  const { exec, log } = d;
  const root = exportCommit(d, commit, workspace, tools);
  if (typeof root === "number") return root;
  // the configuration wrangler is given is the commit's: checked again, in case the working tree's differed unseen
  const configPath = join(root, DEPLOY_CONFIG_PATH);
  const cfg = d.readConfig(configPath, { ...baseEnv() });
  const problems = deployConfigProblems(cfg, d.url);
  if (problems.length > 0) {
    for (const p of problems) log(`configuration du commit refusée : ${p}`);
    return 1;
  }
  const target = deployTarget({ root, configPath, cfg, url: d.url, commit, tag });
  log(`cible : Worker ${target.worker}, compte ${target.account}, ${target.url}, base ${target.database}`);
  log(`cible : configuration ${target.configPath}, ressources ${target.assetsDir}, commit ${target.commit} (version ${target.tag})`);
  const wrangler = pinnedWrangler(target, d.env);

  // the credential every wrangler step uses, to read Cloudflare's API as they would: never logged, never handed on
  const credential = exec(wrangler("token"));
  const token = credential.status === 0 ? apiToken(credential.stdout.trim()) : null;
  if (token === null) { log(`identifiant Cloudflare de wrangler illisible (wrangler ${credential.status}) : ${credential.stderr.trim()}`); return 2; }
  // DEFAULT_URL's subdomain must be account_id's own before Access is asked there: on another account's subdomain, the
  // probe would see that account's Worker and Access, while the deploy goes to this account's address
  const subdomain = await cloudflareGet(d.fetch, token, `/accounts/${target.account}/workers/subdomain`, d.timeoutMs);
  const own = "error" in subdomain ? null : (subdomain.result as { subdomain?: unknown } | null)?.subdomain;
  if (typeof own !== "string" || own === "") {
    log(`sous-domaine workers.dev du compte ${target.account} illisible (${"error" in subdomain ? subdomain.error : "réponse sans sous-domaine"}) : impossible de vérifier que ${target.url} est à ce compte, déploiement refusé`);
    return 2;
  }
  const probed = workersDevSubdomain(target.url);
  if (own !== probed) {
    log(`le compte ${target.account} a le sous-domaine workers.dev ${own}, pas ${probed} : ${target.url} (DEFAULT_URL) est l'adresse d'un autre compte, Access y serait sondé à la place de l'app, déploiement refusé`);
    return 1;
  }
  log(`sous-domaine workers.dev du compte ${target.account} : ${own}, celui de ${target.url}`);

  const standing = await workerRefusal(d, target, token, wrangler, "");
  if (standing !== null) return standing;

  const refused = await accessRefusal(d, target, "");
  if (refused !== null) return refused;

  // the build's own token, tried once before anything is written: a token missing from the policy, or an ID and a
  // secret pasted swapped, would otherwise deploy the app and only then fail to see it. Sent here only, to the address
  // proved above to be this account's
  const through = await tokenAccepted(d.fetch, target.url, headers, d.timeoutMs);
  if (through.accepted === null) { log(`jeton Access non vérifiable (${through.detail}) : déploiement refusé`); return 2; }
  if (!through.accepted) { log(`jeton Access refusé (${through.detail}) : absent de la politique CLI, ou identifiant et secret intervertis, déploiement refusé`); return 2; }
  log(`jeton Access accepté par ${target.url} (${through.detail})`);

  const BOOKMARK = "point de restauration D1";
  const PENDING = "migrations restantes";
  const BUILD = "typecheck, tests et build";
  const DEPLOY = "déploiement";
  // typecheck, tests and dist/ all run in the export, so on the commit just checked: the working tree's suite (whose
  // changes git may hide) and its dist/ (gitignored) are never what decides
  const steps = [
    { what: BUILD, call: buildCall(target.root) },
    { what: BOOKMARK, call: wrangler("bookmark") },
    { what: "migrations", call: wrangler("migrations") },
    { what: PENDING, call: wrangler("pending") },
    { what: DEPLOY, call: wrangler("deploy") },
  ];
  for (const { what, call } of steps) {
    // Access asked again, seconds before the upload, and the Worker's routes, domains and secrets read again: the build,
    // the bookmark and the migrations take minutes, during which Access could be switched off, the Worker recreated
    // without it, or a domain, a route or a secret added in the dashboard
    if (what === DEPLOY) {
      const again = await accessRefusal(d, target, " avant l'envoi");
      if (again !== null) return again;
      const standingAgain = await workerRefusal(d, target, token, wrangler, " avant l'envoi");
      if (standingAgain !== null) return standingAgain;
    }
    const r = exec(call);
    if (r.stdout.trim() !== "") log(`${what} : ${r.stdout.trim()}`);
    if (r.status !== 0) { log(`${what} impossible (${what === BUILD ? "npm" : "wrangler"} ${r.status}) : ${r.stderr.trim()}`); return 2; }
    // no migration without a restore point printed in the log, even when wrangler exits 0
    if (what === BOOKMARK && d1Bookmark(r.stdout) === null) { log("aucun point de restauration D1 lu : migrations refusées"); return 2; }
    // wrangler's apply can exit 0 with a migration it reports failed: no deploy unless the list shows none pending
    if (what === PENDING && !r.stdout.split("\n").some((l) => l.trim() === NO_PENDING_MIGRATIONS)) { log("migrations encore en attente après leur application : déploiement refusé"); return 2; }
    // the probes asked the target's address; wrangler uploaded to account_id's account, whose own subdomain it prints
    if (what === DEPLOY) {
      const addresses = deployedAddresses(r.stdout);
      if (addresses.length === 0) { log("wrangler n'a nommé aucune adresse workers.dev : l'adresse du déploiement n'est pas vérifiable"); return 2; }
      const elsewhere = addresses.find((a) => a !== new URL(target.url).origin);
      if (elsewhere) { log(`wrangler a déployé sur ${elsewhere}, pas sur ${target.url} : le sous-domaine de DEFAULT_URL n'est pas celui du compte ${target.account}, et l'app y répond peut-être sans Access`); return 1; }
    }
  }
  log(`déployé : version ${tag}`);
  return confirmLive(d, target, headers);
}

/**
 * The deploy, the one path for Workers Builds and the laptop:
 * refuse a configuration that could answer outside the probed address or with the bypass; derive the target once (the
 * Worker, the account, the address, the configuration, the assets and the checked commit), from an export of that commit
 * proved equal to it, and print it; read the account's workers.dev subdomain from Cloudflare's API with wrangler's own
 * credential and refuse a DEFAULT_URL on another (its Access would be the one probed); refuse a Worker holding any
 * secret; refuse unless Access answers the live address (so the app is never served without
 * it, not even for the first deploy); try the service token once on /api/health, which
 * Access must let through (exit 2 otherwise, before anything is written); typecheck, test and build dist/ in the export (`npm run build:ci`);
 * print the D1 Time Travel bookmark (the restore point before migrations); apply the pending migrations, then see wrangler
 * list none pending (its apply can exit 0 with one unapplied); ask Access again, as before the build, and read the Worker's routes, domains and secrets again; deploy tagged
 * with the commit, and see wrangler name the target's workers.dev address (DEFAULT_URL's subdomain account_id's, seen
 * again); then see that tag answer on the address, through Access. Every subprocess runs from a fixed
 * environment and every wrangler step from the target alone (scripts/deploy-target.ts), so neither the shell, nor
 * Workers Builds' variables, nor a stray file can point it elsewhere.
 * Exit 0 deployed and seen, 1 refused or not seen, 2 could not run (Access or Cloudflare's API unreachable, wrangler's credential or the secrets unreadable, git unreadable, a command failed,
 * a configuration wrangler cannot read, a proxy or TLS setting that would steer the probe, a trust store other than Node's,
 * a tsx or esbuild setting, a NODE_OPTIONS token or a working directory that would load or resolve other code into this process, a system tool missing from /usr/bin and /bin).
 */
export async function runDeploy(d: DeployDeps): Promise<number> {
  try {
    return await deploy(d);
  } catch (error) {
    d.log(`déploiement impossible : ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/** What the deploy reads when run as a script: this process, this machine, the repository this file belongs to. */
export function entryDeps(): DeployDeps {
  return {
    env: process.env,
    // the repository this script belongs to, which must be the working directory as well
    root: realpathSync.native(dirname(dirname(fileURLToPath(import.meta.url)))),
    cwd: realpathSync.native(process.cwd()),
    url: DEFAULT_URL,
    mainRemote: MAIN_REMOTE,
    readConfig: readDeployConfig,
    workspace: { make: () => mkdtempSync(join(realpathSync.native(WORKSPACE_PARENT), "la-table-deploy-")), remove: (dir) => rmSync(dir, { recursive: true, force: true }) },
    listDir: (dir) => { try { return readdirSync(dir); } catch { return null; } },
    readSecret: readKeychain,
    readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    executable: isExecutable,
    caCertificates: nodeTrustStore,
    fetch,
    exec: spawnExec,
    log: (s) => console.error(s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // 30 rounds of 10 s: the edge answers as the new version within seconds to a few minutes
    rounds: 30,
    intervalMs: 10_000,
    timeoutMs: ACCESS_TIMEOUT_MS,
  };
}

if (isEntry(import.meta.url)) process.exit(await runDeploy(entryDeps()));
