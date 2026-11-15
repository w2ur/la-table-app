import type { Snapshot } from "../domain/snapshot";
import { isLoopbackHost } from "../domain/loopback";
import { TABLES } from "../domain/state";
import type { State } from "../domain/types";

export class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2 = 2) {
    super(message);
  }
}

/** The server recorded no answer for the op (§8.2): it may or may not have landed, and the message already says to rerun. */
export class NotFinal extends CliError {}

/** Access turned the request away before the Worker saw it: nothing landed, and a rerun answers the same until the token changes. */
export class AccessRefused extends CliError {}

/** Keychain service names; `keychain.ts` reads them, this file only names them (it must stay free of `node:` imports). */
export const ACCESS_ID_SERVICE = "la-table-access-client-id";
export const ACCESS_SECRET_SERVICE = "la-table-access-client-secret";

/**
 * The deployed app: the Worker `la-table` on the account's workers.dev subdomain, behind Cloudflare Access
 * (scripts/deploy-config.ts checks it is that address).
 */
export const DEFAULT_URL = "https://la-table.william-445.workers.dev";

/** DEFAULT_URL's subdomain until the deploy setup writes the account's own: any account can claim it. */
export const PLACEHOLDER_SUBDOMAIN = "replace-me";

/** Whether `base` is on the provisional subdomain (`<anything>.replace-me.workers.dev`, or the zone itself). */
export function onPlaceholder(base: string): boolean {
  let host: string;
  try { host = new URL(base).hostname; } catch { return false; }
  // a fully qualified name keeps its root dot (`x.workers.dev.`) and resolves to the same host
  if (host.endsWith(".")) host = host.slice(0, -1);
  const zone = `${PLACEHOLDER_SUBDOMAIN}.workers.dev`;
  return host === zone || host.endsWith(`.${zone}`);
}

export const placeholderRefusal = (base: string) =>
  `${base} porte le sous-domaine provisoire ${PLACEHOLDER_SUBDOMAIN}, que n'importe quel compte peut prendre : le jeton n'y part pas (DEFAULT_URL pas encore rempli)`;

/**
 * Why the service token must not be sent to `base`, or null: never to the provisional subdomain, and never in cleartext
 * off this machine. The CLI checks it before it reads the keychain; the probes check it too, then more (scripts/probe-live.ts).
 */
export function tokenAddressRefusal(base: string): string | null {
  let u: URL;
  try { u = new URL(base); } catch { return `${base} n'est pas une adresse`; }
  if (onPlaceholder(base)) return placeholderRefusal(base);
  if (u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname))) return null;
  return `${base} : ni https:// ni cette machine, le secret du jeton y passerait en clair`;
}

/**
 * Why a remote `base` is not the app's own address, or null. A local wrangler dev (http:// to loopback) is let through,
 * as `tokenAddressRefusal` does; any other address must be `url` (DEFAULT_URL) exactly, as `workerAddressRefusal` asks of
 * the probes.
 */
export function foreignAddressRefusal(base: string, url = DEFAULT_URL): string | null {
  let u: URL;
  try { u = new URL(base); } catch { return `${base} n'est pas une adresse`; }
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return null;
  return base === url ? null : `${base} n'est pas l'adresse de l'app, ${url} (DEFAULT_URL) : un LA_TABLE_URL laissé d'un autre compte ou d'un essai ?`;
}

export type SecretReader = (service: string) => string | null;
export interface ClientConfig { baseUrl: string; headers: Record<string, string> }
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface OpEnvelope { opId: string; type: string; at: string; payload: unknown }
export interface WireResult { opId: string | null; status: "applied" | "noop" | "refused"; reason: string | null }
/** A final answer and the state it left, as the snapshot `POST /api/ops` returns with it. */
export interface PostAnswer { result: WireResult; snapshot: Snapshot }

/** The planning CLI's own token variables: never the build's `LA_TABLE_ACCESS_CLIENT_*`, which belong to another token (Workers Builds' build secrets). */
export const CLI_ID_VAR = "LA_TABLE_CLI_ACCESS_CLIENT_ID";
export const CLI_SECRET_VAR = "LA_TABLE_CLI_ACCESS_CLIENT_SECRET";
const BUILD_ID_VAR = "LA_TABLE_ACCESS_CLIENT_ID";
const BUILD_SECRET_VAR = "LA_TABLE_ACCESS_CLIENT_SECRET";

/** Where the token may also come from: the platform (`process.platform`) and the environment, passed by the planning CLI only. */
export interface TokenFallback { platform: string; env: Record<string, string | undefined> }

/** The CLI token from `env`, or null when neither variable of the pair is set; exit 2 on one alone, or on the build's names alone. */
function tokenFromEnv(env: Record<string, string | undefined>): { id: string; secret: string } | null {
  const id = env[CLI_ID_VAR] || undefined;
  const secret = env[CLI_SECRET_VAR] || undefined;
  if (id && secret) return { id, secret };
  if (id || secret) throw new CliError(`jeton Access incomplet dans l'environnement : ${id ? CLI_ID_VAR : CLI_SECRET_VAR} est posée, pas ${id ? CLI_SECRET_VAR : CLI_ID_VAR}`, 2);
  if (env[BUILD_ID_VAR] || env[BUILD_SECRET_VAR]) {
    throw new CliError(`${BUILD_ID_VAR} et ${BUILD_SECRET_VAR} sont ceux du jeton de build, que le CLI n'utilise pas : posez ${CLI_ID_VAR} et ${CLI_SECRET_VAR} avec le jeton la-table-cli`, 2);
  }
  return null;
}

/**
 * Where the CLI sends its requests, and with which headers. Remote: LA_TABLE_URL, else `defaultUrl` (DEFAULT_URL), with
 * the service token, once the address passes `tokenAddressRefusal` and `foreignAddressRefusal`, checked before any token
 * source is read (exit 2). Beyond loopback, only `defaultUrl` itself passes, like the probes: no other account's Worker
 * gets the token from an `LA_TABLE_URL` left in the shell. `--local`: wrangler dev, with no token.
 *
 * The token comes from the macOS keychain. Only a caller that passes `fallback` (the planning CLI) may also take it from
 * `LA_TABLE_CLI_ACCESS_CLIENT_ID` / `_SECRET`: on darwin when the keychain holds neither entry, on any other platform
 * always (the keychain is not read there). The probes pass no `fallback`, so they stay keychain-only and never read
 * those variables.
 */
export function clientConfig(opts: { local: boolean; env: Record<string, string | undefined>; readSecret: SecretReader; defaultUrl?: string; fallback?: TokenFallback }): ClientConfig {
  if (opts.local) return { baseUrl: opts.env.LA_TABLE_LOCAL_URL ?? "http://localhost:8787", headers: {} };
  const baseUrl = opts.env.LA_TABLE_URL ?? opts.defaultUrl ?? DEFAULT_URL;
  const refusal = tokenAddressRefusal(baseUrl);
  if (refusal !== null) throw new CliError(refusal, 2);
  const foreign = foreignAddressRefusal(baseUrl, opts.defaultUrl ?? DEFAULT_URL);
  if (foreign !== null) throw new CliError(foreign, 2);
  // a local wrangler dev has no Access in front of it: nothing there turns the token into a JWT, so it is not sent at all
  const target = new URL(baseUrl);
  if (target.protocol === "http:" && isLoopbackHost(target.hostname)) return { baseUrl, headers: {} };
  const useKeychain = !opts.fallback || opts.fallback.platform === "darwin";
  const id = useKeychain ? opts.readSecret(ACCESS_ID_SERVICE) : null;
  const secret = useKeychain ? opts.readSecret(ACCESS_SECRET_SERVICE) : null;
  if (id && secret) return { baseUrl, headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } };
  if (opts.fallback && !id && !secret) {
    const fromEnv = tokenFromEnv(opts.fallback.env);
    if (fromEnv) return { baseUrl, headers: { "CF-Access-Client-Id": fromEnv.id, "CF-Access-Client-Secret": fromEnv.secret } };
    const where = useKeychain ? `ni dans le trousseau (${ACCESS_ID_SERVICE}, ${ACCESS_SECRET_SERVICE}) ni` : "pas";
    throw new CliError(`jeton Access absent : ${where} dans l'environnement (${CLI_ID_VAR}, ${CLI_SECRET_VAR}) ; voir la skill la-table-planning`, 2);
  }
  throw new CliError(`jeton Access absent du trousseau (${!id ? ACCESS_ID_SERVICE : ACCESS_SECRET_SERVICE}) : voir la skill la-table-planning`, 2);
}

async function call(fetchImpl: FetchLike, url: string, init: RequestInit, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, redirect: "manual" });
  } catch (error) {
    throw new CliError(`${what} : serveur injoignable (${error instanceof Error ? error.message : String(error)})`, 2);
  }
  if (res.status >= 300 && res.status < 400) throw new AccessRefused(`${what} : redirigé vers la connexion Access, jeton refusé ou expiré`, 2);
  if (res.status === 401 || res.status === 403) throw new AccessRefused(`${what} : accès refusé (${res.status}), vérifiez le jeton Access`, 2);
  // a status first: a 5xx error page is HTML too, and is a server failure, not a lapsed login
  if (!res.ok) throw new CliError(`${what} : erreur serveur ${res.status}`, 2);
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) throw new CliError(`${what} : réponse non JSON (${res.status}), reconnexion nécessaire ?`, 2);
  try {
    return await res.json();
  } catch {
    throw new CliError(`${what} : réponse JSON illisible`, 2);
  }
}

export async function fetchState(cfg: ClientConfig, fetchImpl: FetchLike): Promise<State> {
  const body = (await call(fetchImpl, `${cfg.baseUrl}/api/history`, { headers: cfg.headers }, "lecture de l'état")) as Record<string, unknown> | null;
  if (typeof body?.version !== "number" || !TABLES.every((t) => Array.isArray(body[t]))) {
    throw new CliError("lecture de l'état : réponse incomplète", 2);
  }
  // a server older than meta.last_ids sends none: the rows alone then bound the next ids, as they did
  const state = body as unknown as Omit<State, "appliedOps">;
  return { ...state, lastIds: state.lastIds ?? {}, appliedOps: {} };
}

/** The parts of a snapshot the CLI reads; anything less is an incomplete answer, not an empty state. */
function isSnapshot(value: unknown): value is Snapshot {
  const s = value as { menu?: { pool?: unknown }; courses?: { lines?: unknown; estimateCents?: unknown; budgetCents?: unknown } } | null;
  return Array.isArray(s?.menu?.pool) && s.menu.pool.every((m) => typeof (m as { id?: unknown } | null)?.id === "number")
    && Array.isArray(s.courses?.lines) && typeof s.courses.estimateCents === "number" && typeof s.courses.budgetCents === "number";
}

/**
 * A step of a run that sends one op per line: its exit 2 carries what already landed (`done`), the line it stopped on
 * and `hint` (why rerunning the same command is safe), instead of a bare network or Access message.
 */
export async function resumable<T>(done: readonly string[], label: string, hint: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(`${done.join("\n")}${done.length ? "\n" : ""}${label} : ${error.message}\n${hint}`, error.exitCode);
  }
}

export async function postOp(cfg: ClientConfig, fetchImpl: FetchLike, op: OpEnvelope): Promise<PostAnswer> {
  const body = (await call(
    fetchImpl,
    `${cfg.baseUrl}/api/ops`,
    { method: "POST", headers: { ...cfg.headers, "content-type": "application/json" }, body: JSON.stringify({ ops: [op] }) },
    op.type,
  )) as { results?: WireResult[]; unrecorded?: unknown; snapshot?: unknown } | null;
  const result = body?.results?.find((r) => r.opId === op.opId);
  if (!result) throw new CliError(`${op.type} : aucune réponse pour cette action`, 2);
  const unrecorded = body?.unrecorded;
  if (!Array.isArray(unrecorded) || !unrecorded.every((id) => typeof id === "string")) throw new CliError(`${op.type} : réponse incomplète (unrecorded)`, 2);
  // not stored on the server (a throw, a version conflict, a D1 failure): it may or may not have landed, only a resend under this id can tell (§8.2)
  if (unrecorded.includes(op.opId)) {
    throw new NotFinal(`${op.type} : réponse non définitive, rien n'est confirmé (${result.reason ?? "sans raison"}) ; relancez la même commande`, 2);
  }
  if (!["applied", "noop", "refused"].includes(result.status)) throw new CliError(`${op.type} : réponse inattendue (${String(result.status)})`, 2);
  if (!isSnapshot(body?.snapshot)) throw new CliError(`${op.type} : réponse incomplète (snapshot)`, 2);
  return { result: { opId: result.opId, status: result.status, reason: result.reason ?? null }, snapshot: body.snapshot };
}
