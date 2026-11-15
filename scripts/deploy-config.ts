import { dirname, normalize, relative, resolve } from "node:path";
import { unstable_readConfig } from "wrangler";
import { DEFAULT_URL, PLACEHOLDER_SUBDOMAIN } from "../src/cli/client.ts";

/** The parts of wrangler's resolved configuration a deploy depends on. */
export interface DeployConfig {
  name?: string;
  /** Relative to the configuration's directory, as written there (`readDeployConfig` reads it back so). */
  tsconfig?: string;
  account_id?: string;
  assets?: { directory?: string };
  workers_dev?: boolean;
  preview_urls?: boolean;
  keep_vars?: boolean;
  version_metadata?: { binding: string };
  vars?: Record<string, unknown>;
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
  /** wrangler keeps the singular form as its own key, beside `routes`: both must be checked. */
  route?: unknown;
  routes?: unknown[];
}

/** The Worker's name, which is also the first label of its workers.dev address and what Access protects. */
export const WORKER_NAME = "la-table";
/** The D1 database the Worker binds as DB, which the deploy migrates and scripts/backup.ts exports. */
export const DATABASE_NAME = "la-table";
/** The tsconfig wrangler hands esbuild for the Worker, beside wrangler.jsonc: named, so esbuild looks for no other. */
export const WORKER_TSCONFIG = "tsconfig.worker.json";
export { PLACEHOLDER_SUBDOMAIN };

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
/** An Access team domain as the gate and the live probe accept it: lowercase, as a URL's hostname is compared. */
export const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
/** An Access application's AUD tag. */
export const AUD = /^[0-9a-f]{64}$/;
const WORKERS_DEV = new RegExp(`^${WORKER_NAME}\\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\\.workers\\.dev$`);

/** The configuration the gate checks, and the one every wrangler step of the deploy is given (scripts/deploy-target.ts). */
export const DEPLOY_CONFIG_PATH = "wrangler.jsonc";

/**
 * wrangler.jsonc as `wrangler deploy` reads it (comments, defaults and validation are wrangler's own), under `env`: the
 * reader takes some keys from process.env, so it reads with the environment the wrangler steps get, never the caller's.
 */
export function readDeployConfig(path = DEPLOY_CONFIG_PATH, env: Record<string, string> = {}): DeployConfig {
  const caller = process.env;
  process.env = { ...env };
  try {
    // env "": the top level, as every wrangler step is told with `--env=`
    const cfg = unstable_readConfig({ config: path, env: "" }, { hideWarnings: true }) as DeployConfig;
    // wrangler resolves `tsconfig` against the configuration's directory, then gives it relative to this process's
    // working directory: read back relative to the configuration, wherever the deploy was started from
    return cfg.tsconfig === undefined ? cfg : { ...cfg, tsconfig: relative(dirname(resolve(path)), resolve(cfg.tsconfig)) };
  } finally {
    process.env = caller;
  }
}

/** The account subdomain of `https://la-table.<subdomain>.workers.dev`, or null when the URL is not exactly that. */
export function workersDevSubdomain(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || u.port !== "" || u.pathname !== "/" || u.search !== "" || u.username !== "") return null;
  return WORKERS_DEV.exec(u.hostname)?.[1] ?? null;
}

/**
 * Why this configuration must not be deployed, in French for the build log; empty when it may. Each line is a way the
 * deployed Worker would answer on an address the probes do not watch, or answer with the local bypass, or answer
 * without a version marker, or bind to a database or an Access application that does not exist.
 */
export function deployConfigProblems(cfg: DeployConfig, url = DEFAULT_URL): string[] {
  const problems: string[] = [];
  if (cfg.vars && Object.hasOwn(cfg.vars, "DEV_SKIP_ACCESS")) problems.push("vars porte DEV_SKIP_ACCESS : le contournement d'Access ne se déploie jamais");
  if (typeof cfg.account_id !== "string" || !ACCOUNT_ID.test(cfg.account_id)) problems.push(`account_id doit nommer le compte Cloudflare (32 caractères hexadécimaux) : wrangler le lit avant tout le reste (${String(cfg.account_id)})`);
  if (cfg.name !== WORKER_NAME) problems.push(`name doit valoir ${WORKER_NAME} : l'adresse workers.dev et la protection Access en dépendent (${String(cfg.name)})`);
  if (cfg.workers_dev !== true) problems.push("workers_dev doit valoir true : l'adresse workers.dev, derrière Access, est la seule de l'app");
  if (cfg.preview_urls !== false) problems.push("preview_urls doit valoir false : une adresse de version est publique dès qu'elle existe");
  if (cfg.keep_vars === true) problems.push("keep_vars garderait des variables posées dans le tableau de bord");
  // a route (`route` or `routes`) would serve the app on a host the probes do not watch, and make wrangler dev rewrite
  // request.url to it, which switches the local Access bypass off (measured 2026-10-13); one attached in the dashboard
  // is outside this file: deploy-ci.ts lists those (`attachedHosts`)
  if (cfg.route !== undefined || (cfg.routes ?? []).length > 0) {
    problems.push(`routes doit rester vide et route absent : l'app n'a que son adresse workers.dev (${JSON.stringify({ route: cfg.route, routes: cfg.routes })})`);
  }
  const assets = cfg.assets?.directory;
  if (typeof assets !== "string" || normalize(assets).replace(/\/$/, "") !== "dist") problems.push(`assets.directory doit valoir ./dist, la sortie de npm run build (${String(assets)})`);
  if (cfg.version_metadata?.binding !== "CF_VERSION_METADATA") problems.push("version_metadata.binding doit valoir CF_VERSION_METADATA (GET /api/health)");
  // unnamed, esbuild looks for a tsconfig.json in every directory above the Worker's sources, the export's parents
  // included: one there could remap an import (jose, which checks the JWT) in a bundle tagged as the checked commit
  if (cfg.tsconfig !== WORKER_TSCONFIG) problems.push(`tsconfig doit valoir ./${WORKER_TSCONFIG} : sans lui, esbuild cherche un tsconfig.json au-dessus des sources du Worker, hors du commit (${String(cfg.tsconfig)})`);
  const team = cfg.vars?.ACCESS_TEAM_DOMAIN;
  if (typeof team !== "string" || !TEAM_DOMAIN.test(team)) problems.push(`ACCESS_TEAM_DOMAIN n'est pas un domaine d'équipe Access (${String(team)})`);
  const aud = cfg.vars?.ACCESS_AUD;
  if (typeof aud !== "string" || !AUD.test(aud)) problems.push(`ACCESS_AUD n'est pas une étiquette AUD (64 caractères hexadécimaux) : ${String(aud)}`);
  // the bookmark and the migrations name the database, and wrangler takes the first entry whose database_name OR
  // binding equals that name: with one entry only, it is the one the Worker binds as DB
  if ((cfg.d1_databases ?? []).length > 1) {
    problems.push(`d1_databases doit tenir la seule base DB : le point de restauration et les migrations iraient à la première nommée ${DATABASE_NAME} (${(cfg.d1_databases ?? []).map((d) => d.binding).join(", ")})`);
  }
  const db = cfg.d1_databases?.find((d) => d.binding === "DB");
  if (db?.database_name !== DATABASE_NAME) problems.push(`la base DB doit s'appeler ${DATABASE_NAME} (scripts/backup.ts l'exporte sous ce nom)`);
  if (!db?.database_id || !UUID.test(db.database_id) || db.database_id === PLACEHOLDER_ID) problems.push(`database_id n'est pas l'identifiant d'une base créée : ${String(db?.database_id)}`);
  const subdomain = workersDevSubdomain(url);
  if (subdomain === null) problems.push(`DEFAULT_URL (src/cli/client.ts) n'est pas https://${WORKER_NAME}.<sous-domaine>.workers.dev : ${url}`);
  else if (subdomain === PLACEHOLDER_SUBDOMAIN) problems.push(`DEFAULT_URL (src/cli/client.ts) porte encore le sous-domaine provisoire : ${url}`);
  return problems;
}
