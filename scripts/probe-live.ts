import { fileURLToPath } from "node:url";
import { isEntry } from "../src/cli/entry.ts";
import { CliError, clientConfig, DEFAULT_URL, onPlaceholder, placeholderRefusal, tokenAddressRefusal, type FetchLike } from "../src/cli/client.ts";
import { readKeychain } from "../src/cli/keychain.ts";
import { accessLoginRefusal, versionTag } from "./deploy-ci.ts";
import { AUD, DEPLOY_CONFIG_PATH, readDeployConfig, TEAM_DOMAIN, WORKER_NAME, workersDevSubdomain, type DeployConfig } from "./deploy-config.ts";

/** The repository's wrangler.jsonc, wherever the probe was started from. */
export const PROBE_CONFIG_PATH = fileURLToPath(new URL(`../${DEPLOY_CONFIG_PATH}`, import.meta.url));

/**
 * The Access team domain and AUD tag of wrangler.jsonc, or why they cannot be used: the probe then could not run (exit 2).
 * Unfilled (`REPLACE_ME`) or malformed, every Access check would fail and report a finding (exit 1) about nothing; a team
 * domain in uppercase would never equal the hostname of Access's redirect, which the URL parser lowercases.
 */
export function accessConfig(read: () => DeployConfig): { team: string; aud: string } | { error: string } {
  let vars: Record<string, unknown>;
  try {
    vars = read().vars ?? {};
  } catch (error) {
    return { error: `wrangler.jsonc illisible : ${error instanceof Error ? error.message : String(error)}` };
  }
  const team = vars.ACCESS_TEAM_DOMAIN;
  const aud = vars.ACCESS_AUD;
  if (typeof team !== "string" || typeof aud !== "string") return { error: "ACCESS_TEAM_DOMAIN ou ACCESS_AUD absent de wrangler.jsonc" };
  if (!TEAM_DOMAIN.test(team)) return { error: `ACCESS_TEAM_DOMAIN de wrangler.jsonc n'est pas un domaine d'équipe Access (<équipe>.cloudflareaccess.com, en minuscules) : ${team}` };
  if (!AUD.test(aud)) return { error: `ACCESS_AUD de wrangler.jsonc n'est pas une étiquette AUD (64 caractères hexadécimaux) : ${aud}` };
  return { team, aud };
}

/** `unreached`: the request never got an answer (DNS, TLS, network), so the check could not be made: unknown, not failed. */
export interface Check { name: string; ok: boolean; detail: string; unreached?: boolean }

/** What a phone fetches for the home screen, maybe outside the Access session: the icon, the manifest and its icons. */
export const ICON_PATHS = ["/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"] as const;
/** `public`: the « La Table — icônes » bypass application exists (created by the owner in the Zero Trust dashboard); `access`: they are behind Access like the rest. */
export type IconMode = "public" | "access";

function json(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

/** The address of a Worker version, `<first 8 of the version id>-la-table.<subdomain>.workers.dev`, or null. */
export function versionUrl(base: string, version: string | null): string | null {
  const sub = workersDevSubdomain(base);
  return sub && version && /^[0-9a-f]{8}/.test(version) ? `https://${version.slice(0, 8)}-${WORKER_NAME}.${sub}.workers.dev` : null;
}

function prober(f: FetchLike, checks: Check[]) {
  const check = async (name: string, url: string, headers: Record<string, string>, judge: (res: Response, body: string) => string | null) => {
    try {
      const res = await f(url, { headers, redirect: "manual" });
      const body = await res.text();
      const problem = judge(res, body);
      checks.push({ name, ok: problem === null, detail: problem ?? `${res.status}` });
    } catch (error) {
      checks.push({ name, ok: false, unreached: true, detail: `injoignable : ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  return check;
}

/** null when Cloudflare Access answered with its login (`accessLoginRefusal`, the deploy's own reading), else what did. */
const toAccess = (base: string, team: string) => (res: Response): string | null => accessLoginRefusal(res, base, team);

/**
 * null when Access stopped a request that was not asked like a browser: its login redirect (a 302 to the team), or its own
 * 401/403, never the Worker's (whose only refusal is a 401 `error: "unauthorized"`), else what answered. Anything else,
 * a 500 or a 404 included, is not Access.
 */
const toAccessApi = (base: string, team: string) => (res: Response, body: string): string | null => {
  if (res.status === 302) return toAccess(base, team)(res);
  if ((res.status === 401 || res.status === 403) && json(body)?.error !== "unauthorized") return null;
  return `${res.status} ${body.slice(0, 80)}`;
};

/** Asked like a browser, so Access answers with its login redirect as it does to a phone. */
const BROWSER = { accept: "text/html" };

/**
 * Every answer the deployed app must give, each with the opposite answer it must not: Access in front of the page and of
 * the API, the icons as the owner set them (public, or behind Access), the Worker answering the service token (so the
 * AUD tag and team domain are right), a 404 from the Worker (so a 200 everywhere would show), a wrong token refused by Access itself, and
 * no other address of the Worker (a version URL) serving the app without Access.
 */
export async function liveChecks(
  f: FetchLike,
  o: { base: string; team: string; headers: Record<string, string>; icons: IconMode; others: string[] },
): Promise<Check[]> {
  const checks: Check[] = [];
  const check = prober(f, checks);
  const access = toAccess(o.base, o.team);
  const served = (path: string) => (res: Response, body: string): string | null => {
    if (res.status !== 200) return `${res.status}`;
    if (path.endsWith(".png")) return (res.headers.get("content-type") ?? "").includes("image/png") ? null : `type ${res.headers.get("content-type")}`;
    return json(body)?.name === "La Table" ? null : `manifeste illisible : ${body.slice(0, 80)}`;
  };

  await check("sans jeton, / → connexion Access", `${o.base}/`, BROWSER, access);
  await check("sans jeton, /api/state → arrêté par Access, pas par le Worker", `${o.base}/api/state`, {}, toAccessApi(o.base, o.team));
  for (const path of ICON_PATHS) {
    if (o.icons === "public") await check(`sans jeton, ${path} → public`, `${o.base}${path}`, {}, served(path));
    else await check(`sans jeton, ${path} → connexion Access`, `${o.base}${path}`, BROWSER, access);
    await check(`jeton, ${path} → servi`, `${o.base}${path}`, o.headers, served(path));
  }
  await check("jeton, /api/health → la version en cours", `${o.base}/api/health`, o.headers, (res, body) => {
    const b = json(body);
    return res.status === 200 && b?.ok === true && typeof b.version === "string" ? null : `${res.status} ${body.slice(0, 80)}`;
  });
  await check("jeton, /api/state → le Worker accepte le JWT d'Access", `${o.base}/api/state`, o.headers, (res, body) => {
    const b = json(body) as { menu?: { pool?: unknown } } | null;
    return res.status === 200 && Array.isArray(b?.menu?.pool) ? null : `${res.status} ${body.slice(0, 80)}`;
  });
  await check("jeton, /api/inexistant → 404 du Worker (témoin)", `${o.base}/api/inexistant`, o.headers, (res, body) =>
    res.status === 404 && json(body)?.error === "not_found" ? null : `${res.status} ${body.slice(0, 80)}`);
  // Access's own refusal, never the Worker's: a wrong token the Worker refuses has got past Access, which then checks no token
  await check("jeton faux, /api/state → refusé par Access (témoin)", `${o.base}/api/state`, { ...o.headers, "CF-Access-Client-Secret": "faux" }, toAccessApi(o.base, o.team));
  await check("jeton, / → la page de l'app", `${o.base}/`, o.headers, (res, body) =>
    res.status === 200 && body.includes('rel="manifest"') && body.includes('rel="apple-touch-icon"') ? null : `${res.status} ${body.slice(0, 80)}`);
  await check("jeton, /sw.js → le service worker", `${o.base}/sw.js`, o.headers, (res) =>
    res.status === 200 && (res.headers.get("content-type") ?? "").includes("javascript") ? null : `${res.status} ${res.headers.get("content-type")}`);
  for (const url of o.others) {
    await check(`${url} ne sert pas l'app sans Access`, `${url}/api/health`, {}, (res, body) =>
      res.status === 200 && json(body)?.ok === true ? `200 ${body.slice(0, 80)}` : null);
  }
  return checks;
}

/**
 * The checks on the inert placeholder Worker (probes/placeholder), before the app is ever deployed: Access answers the
 * page and the API without a session, lets the service token through to the Worker, hands the Worker a JWT for the AUD
 * tag of wrangler.jsonc (what the app's check will compare), refuses a wrong token itself, and leaves the icons as the owner set
 * them. Run before Access is turned on, the first two and the JWT checks fail: that is their control.
 */
export async function placeholderChecks(
  f: FetchLike,
  o: { base: string; team: string; aud: string; headers: Record<string, string>; icons: IconMode },
): Promise<Check[]> {
  const checks: Check[] = [];
  const check = prober(f, checks);
  const access = toAccess(o.base, o.team);
  const placeholder = (body: string) => json(body)?.placeholder === true;
  await check("sans jeton, / → connexion Access", `${o.base}/`, BROWSER, access);
  await check("sans jeton, /api/health → connexion Access", `${o.base}/api/health`, BROWSER, access);
  for (const path of ICON_PATHS) {
    if (o.icons === "public") {
      await check(`sans jeton, ${path} → laissé passer par Access`, `${o.base}${path}`, BROWSER, (res, body) =>
        res.status === 503 && placeholder(body) ? null : `${res.status} vers ${res.headers.get("location") ?? "rien"}`);
    } else {
      await check(`sans jeton, ${path} → connexion Access`, `${o.base}${path}`, BROWSER, access);
    }
  }
  await check("jeton, /api/health → le bouche-trou répond (Access laisse passer le jeton)", `${o.base}/api/health`, o.headers, (res, body) =>
    res.status === 503 && placeholder(body) ? null : `${res.status} ${body.slice(0, 80)}`);
  await check("jeton, /api/health → Access passe au Worker un JWT pour l'AUD de wrangler.jsonc", `${o.base}/api/health`, o.headers, (res, body) => {
    const b = json(body) as { jwt?: unknown; aud?: unknown } | null;
    if (b?.jwt !== true) return "aucun JWT reçu par le Worker";
    return Array.isArray(b.aud) && b.aud.includes(o.aud) ? null : `JWT pour une autre AUD : ${JSON.stringify(b.aud)}`;
  });
  await check("jeton faux, /api/health → refusé par Access avant le Worker (témoin)", `${o.base}/api/health`, { ...o.headers, "CF-Access-Client-Secret": "faux" }, (res, body) =>
    placeholder(body) ? `${res.status} : un jeton faux atteint le Worker` : toAccessApi(o.base, o.team)(res, body));
  return checks;
}

/**
 * Asks for the running version until it is `expected`, in rounds: right after a deploy the edge keeps answering as the
 * old version for a while. Every round is logged, so a probe that never saw the old version says so too.
 */
export async function waitForTag(
  read: () => Promise<string | null>, expected: string,
  o: { rounds: number; intervalMs: number; sleep: (ms: number) => Promise<void>; log: (s: string) => void },
): Promise<boolean> {
  for (let round = 1; round <= o.rounds; round++) {
    let tag: string | null = null;
    try { tag = await read(); } catch { tag = null; }
    o.log(`tour ${round} : version ${tag ?? "illisible"}${tag === expected ? " (attendue)" : ""}`);
    if (tag === expected) return true;
    if (round < o.rounds) await o.sleep(o.intervalMs);
  }
  return false;
}

export interface LiveArgs { placeholder: boolean; icons: IconMode; expect: string | undefined; rounds: number; anyBase: boolean }

const VALUED = ["--icons", "--expect", "--rounds"] as const;

/**
 * The probe's arguments, or why they are refused. A flag that takes a value and has none (last, or followed by another
 * flag) is refused rather than read as absent: `--expect $(…)` whose substitution came out empty must not turn the
 * version rounds off and pass against whatever version is live. `--expect` and `--rounds` are refused with
 * `--placeholder`, which waits for no version: ignored, they would let the operator believe one was waited for.
 */
export function liveArgs(argv: string[]): LiveArgs | { error: string } {
  const values: Partial<Record<(typeof VALUED)[number], string>> = {};
  let placeholder = false;
  let anyBase = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--placeholder") { placeholder = true; continue; }
    if (a === "--any-base") { anyBase = true; continue; }
    const flag = VALUED.find((f) => f === a);
    if (flag === undefined) return { error: `argument inconnu : ${a}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} sans valeur` };
    if (values[flag] !== undefined) return { error: `${flag} donné deux fois` };
    values[flag] = value;
    i++;
  }
  if (placeholder) {
    const unused = (["--expect", "--rounds"] as const).filter((f) => values[f] !== undefined);
    if (unused.length > 0) return { error: `${unused.join(" et ")} sans effet avec --placeholder, qui n'attend aucune version` };
  }
  const icons = values["--icons"] ?? "access";
  if (icons !== "public" && icons !== "access") return { error: `--icons vaut public ou access : ${icons}` };
  // --rounds: 30 rounds of 10 s fit a laptop deploy; a Workers Builds build (install, build:ci, deploy) needs more
  const rounds = values["--rounds"] === undefined ? 30 : Number(values["--rounds"]);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 360) return { error: `--rounds n'est pas un nombre de tours (1 à 360) : ${values["--rounds"]}` };
  return { placeholder, icons, expect: values["--expect"], rounds, anyBase };
}

/**
 * Why `base` is not the Worker's own address, or null. That address is DEFAULT_URL exactly: the shape
 * `la-table.<subdomain>.workers.dev` names any account's Worker, and the provisional subdomain is anyone's to claim, so
 * neither is enough to send the service token there.
 */
export function workerAddressRefusal(base: string, url = DEFAULT_URL): string | null {
  if (onPlaceholder(base)) return placeholderRefusal(base);
  return base === url ? null : `${base} n'est pas l'adresse de ${WORKER_NAME}, ${url} (DEFAULT_URL) : un LA_TABLE_URL laissé d'un essai local ?`;
}

/**
 * Why `base` is not an address this probe may vouch for and send the service token to, or null. Only the Worker's own
 * (`workerAddressRefusal`), unless `--any-base` says otherwise, and then what the CLI accepts (`tokenAddressRefusal`:
 * never the provisional subdomain nor a cleartext address off this machine; `clientConfig` already refuses everything but DEFAULT_URL and loopback, so in practice `--any-base` opens only a local wrangler dev): an `LA_TABLE_URL` left set from a local
 * test would otherwise pass every check silently.
 */
export function baseRefusal(base: string, anyBase: boolean, url = DEFAULT_URL): string | null {
  if (!anyBase) {
    const refusal = workerAddressRefusal(base, url);
    return refusal === null ? null : `${refusal} ; --any-base pour sonder un wrangler dev local (http:// vers cette machine)`;
  }
  return tokenAddressRefusal(base);
}

/**
 * The lines to print and the exit: 1 when a check got a wrong answer; 2 when nothing was checked or a check could not be
 * made (`unverified`, or an address that never answered), each named; 0 otherwise.
 */
export function liveReport(checks: Check[], unverified: string[] = []): { lines: string[]; exit: 0 | 1 | 2 } {
  const mark = (c: Check) => (c.ok ? "ok    " : c.unreached ? "NON VÉRIFIÉ" : "ÉCHEC ");
  const lines = [...checks.map((c) => `${mark(c)} ${c.name} (${c.detail})`), ...unverified.map((u) => `NON VÉRIFIÉ ${u}`)];
  if (checks.some((c) => !c.ok && !c.unreached)) return { lines, exit: 1 };
  return { lines, exit: checks.length === 0 || unverified.length > 0 || checks.some((c) => c.unreached) ? 2 : 0 };
}

if (isEntry(import.meta.url)) {
  const log = (s: string) => console.error(s);
  const args = liveArgs(process.argv.slice(2));
  if ("error" in args) { log(args.error); process.exit(2); }
  const { icons, rounds, expect } = args;
  let cfg;
  try {
    cfg = clientConfig({ local: false, env: process.env, readSecret: readKeychain });
  } catch (error) {
    log(error instanceof CliError ? error.message : String(error));
    process.exit(2);
  }
  const access = accessConfig(() => readDeployConfig(PROBE_CONFIG_PATH));
  if ("error" in access) { log(access.error); process.exit(2); }
  const { team, aud } = access;
  const refusal = baseRefusal(cfg.baseUrl, args.anyBase);
  if (refusal !== null) { log(refusal); process.exit(2); }
  // first, on the output the checks go to: which address every line below is about
  console.log(`adresse sondée : ${cfg.baseUrl}`);
  const print = (checks: Check[], unverified: string[] = []) => {
    const r = liveReport(checks, unverified);
    for (const l of r.lines) console.log(l);
    process.exit(r.exit);
  };
  if (args.placeholder) print(await placeholderChecks(fetch, { base: cfg.baseUrl, team, aud, headers: cfg.headers, icons }));
  const health = async () => {
    const res = await fetch(`${cfg.baseUrl}/api/health`, { headers: cfg.headers, redirect: "manual" });
    return res.status === 200 ? ((await res.json()) as { version?: string | null; tag?: string | null }) : null;
  };
  if (expect !== undefined) {
    const tag = versionTag(expect) ?? (/^[0-9a-f]{12}$/.test(expect) ? expect : null);
    if (!tag) { log(`--expect n'est pas un commit : ${expect}`); process.exit(2); }
    const reached = await waitForTag(async () => (await health())?.tag ?? null, tag, { rounds, intervalMs: 10_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log });
    if (!reached) { log(`la version ${tag} ne répond pas après ${rounds} tours : déploiement inconnu`); process.exit(2); }
  }
  // the running version's own URL: with preview_urls false it must not serve the app, and Access covers it anyway
  const version = await health().then((h) => h?.version ?? null, () => null);
  const other = versionUrl(cfg.baseUrl, version);
  // under --any-base (a local wrangler dev) the address has no version URL to derive: accepted with the address itself
  const unverified = other === null && !args.anyBase ? [`l'adresse de la version en cours (version ${version ?? "illisible"})`] : [];
  if (other === null && args.anyBase) log(`adresse de version non vérifiée (version ${version ?? "illisible"})`);
  print(await liveChecks(fetch, { base: cfg.baseUrl, team, headers: cfg.headers, icons, others: other ? [other] : [] }), unverified);
}
