import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { isEntry } from "../src/cli/entry.ts";

/**
 * The gate `npm run deploy:demo` runs before `build:demo` and `wrangler deploy --config wrangler.demo.jsonc`: it decides,
 * at deploy time, whether that deploy may publish. The demo has no Access, so the one thing it must never do is publish
 * the app's Worker or anything bound to the app's data. Exit 0 the deploy may go on, 1 refused, 2 could not read a file.
 */

export const DEMO_WORKER = "la-table-demo";
export const DEMO_CONFIG_PATH = "wrangler.demo.jsonc";
export const APP_CONFIG_PATH = "wrangler.jsonc";

/**
 * A configuration file as wrangler itself reads it: `experimental_readRawConfig` with an explicit path runs the same
 * file read and JSONC parse (`parseRawConfigFile`) that `wrangler deploy --config <path>` runs, before any
 * normalisation, so the allowlist sees the keys wrangler sees and no second parser can disagree with it on a line end or
 * a comment. Throws on a parse error, as wrangler does; runDemoGate then exits 2.
 */
export function readRawConfig(path: string): Record<string, unknown> {
  const raw: unknown = experimental_readRawConfig({ config: path }).rawConfig;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path} is not an object`);
  return raw as Record<string, unknown>;
}

const ALLOWED_KEYS = ["$schema", "name", "account_id", "compatibility_date", "workers_dev", "preview_urls", "assets"];
const ALLOWED_ASSET_KEYS = ["directory"];

/**
 * Where, in a parsed value, an object or array is not a plain one, named by its path. wrangler's raw reader turns a
 * `"__proto__"` key into the parsed object's prototype: `Object.keys` skips it while a property read and wrangler's
 * normalisation follow it, so a binding written there would pass an allowlist of own keys and reach the upload.
 */
export function nonPlainPaths(value: unknown, path = "$"): string[] {
  if (typeof value !== "object" || value === null) return [];
  const proto: unknown = Object.getPrototypeOf(value);
  const own = Reflect.ownKeys(value);
  const found: string[] = [];
  if ((Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype) || own.includes("__proto__") || own.some((k) => typeof k === "symbol")) {
    found.push(path);
  }
  for (const k of own) if (typeof k === "string" && k !== "length") found.push(...nonPlainPaths((value as Record<string, unknown>)[k], `${path}.${k}`));
  return found;
}

/** `obj[key]` when it is the object's own property, never one it inherits. */
function own(obj: object, key: string): unknown {
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Why this configuration must not deploy the demo; empty when it may. `appAccountId` is the app's account. */
export function demoConfigProblems(cfg: Record<string, unknown>, appAccountId: string): string[] {
  const problems: string[] = nonPlainPaths(cfg).map((p) => `not a plain object or array at ${p}: a "__proto__" key or an inherited value`);
  for (const key of Object.keys(cfg)) if (!ALLOWED_KEYS.includes(key)) problems.push(`key not allowed: ${key}`);
  if (own(cfg, "name") !== DEMO_WORKER) problems.push(`name must be ${DEMO_WORKER}, got ${String(own(cfg, "name"))}`);
  if (own(cfg, "account_id") !== appAccountId) problems.push("account_id must equal the app's");
  if (own(cfg, "workers_dev") !== true) problems.push("workers_dev must be true");
  if (own(cfg, "preview_urls") !== false) problems.push("preview_urls must be false");
  const assets = own(cfg, "assets");
  if (typeof assets !== "object" || assets === null || Array.isArray(assets)) problems.push("assets must be an object");
  else {
    for (const key of Object.keys(assets)) if (!ALLOWED_ASSET_KEYS.includes(key)) problems.push(`assets key not allowed: ${key}`);
    if (own(assets, "directory") !== "./dist-demo") problems.push("assets.directory must be ./dist-demo");
  }
  return problems;
}

/** Fields of a normalised configuration that name the file read, not what is deployed. */
const PATH_FIELDS = ["configPath", "userConfigPath"];

/**
 * Where wrangler's normalised reading of the demo configuration differs from `reference`, the normalised reading of an
 * allowed one: any `main`, binding of any kind, variable, route, or asset binding or `run_worker_first`, inherited or
 * not, and kinds of binding wrangler adds later too. A second check that does not depend on how the raw parse is read.
 * Any value that is not a plain object or array is refused as well: `isDeepStrictEqual` compares own properties only, so
 * an asset binding inherited through `"__proto__"` compares equal to none.
 */
export function normalisedConfigProblems(seen: Record<string, unknown>, reference: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(seen), ...Object.keys(reference)]);
  const problems: string[] = [];
  for (const k of keys) {
    if (PATH_FIELDS.includes(k)) continue;
    for (const p of nonPlainPaths(seen[k], k)) problems.push(`wrangler reads a value that is not a plain object or array at ${p}`);
    if (!isDeepStrictEqual(seen[k], reference[k])) problems.push(`wrangler reads ${k} = ${JSON.stringify(seen[k]) ?? "undefined"}, an allowed demo configuration ${JSON.stringify(reference[k]) ?? "undefined"}`);
  }
  return problems;
}

/** wrangler's normalised reading of a configuration file, as `wrangler deploy --config <path>` gets it. */
export function readNormalisedConfig(path: string): Record<string, unknown> {
  return unstable_readConfig({ config: path, env: "" }, { hideWarnings: true }) as unknown as Record<string, unknown>;
}

/** The normalised reading of the one demo configuration the gate allows, on this account and compatibility date. */
export function referenceNormalisedConfig(appAccountId: string, compatibilityDate: unknown): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "deploy-demo-reference-"));
  try {
    const path = join(dir, DEMO_CONFIG_PATH);
    const allowed = { name: DEMO_WORKER, account_id: appAccountId, compatibility_date: compatibilityDate, workers_dev: true, preview_urls: false, assets: { directory: "./dist-demo" } };
    writeFileSync(path, JSON.stringify(allowed));
    return readNormalisedConfig(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Why the environment must not run the demo deploy; empty when it may.
 * - `WRANGLER_CI_OVERRIDE_NAME`: Workers Builds sets it to the Worker its entry is connected to, and wrangler then
 *   deploys under that name whatever the configuration or `--name` says. Anything but `la-table-demo` (the app's entry,
 *   `la-table`, above all) would publish the static demo over that Worker, dropping its code, D1 binding and variables.
 * - `WORKERS_CI`: the demo deploys from its Workers Builds entry only, never from a shell.
 * - `WORKERS_CI_BRANCH`: `main` only. Non-production branch builds are off in the entry and their deploy command is set
 *   to `npm run deploy:demo` too, so a toggle left on reaches this check and fails closed. Left at its default, that
 *   command would never run this gate (see `docs/deploy.md`).
 */
export function demoEnvProblems(env: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  const override = env.WRANGLER_CI_OVERRIDE_NAME;
  if (override !== undefined && override !== DEMO_WORKER) problems.push(`WRANGLER_CI_OVERRIDE_NAME=${override}: this build targets another Worker than ${DEMO_WORKER}`);
  if (env.WORKERS_CI !== "1") problems.push("WORKERS_CI is not 1: the demo deploys from its Workers Builds entry only, never from a shell");
  else if (env.WORKERS_CI_BRANCH !== "main") problems.push(`branch ${env.WORKERS_CI_BRANCH ?? "unknown"}: only main deploys the demo`);
  return problems;
}

/**
 * Dotenv files at the repository root, which wrangler would load into its environment by default (`.env`, `.env.local`,
 * and `.env.<name>` / `.env.<name>.local` under an environment name) and Vite would load for `build:demo`. A
 * `WRANGLER_CI_OVERRIDE_NAME=la-table` there retargets the upload after this gate checked `process.env` only.
 * `deploy:demo` passes `--env-file=/dev/null`, so wrangler loads none of them; the gate refuses them too, so that a
 * command edited without the flag still fails closed. `.env.example`, the one name `.gitignore` lets in, holds no value.
 */
export function dotEnvProblems(root: string): string[] {
  return readdirSync(root)
    .filter((f) => /^\.env(\..*)?$/.test(f) && f !== ".env.example")
    .sort()
    .map((f) => `${f} at the repository root: wrangler and Vite load it into the environment, where WRANGLER_CI_OVERRIDE_NAME would retarget the deploy`);
}

/** Every reason to refuse, from the environment and the two configurations as wrangler reads them. */
export function demoDeployProblems(env: Readonly<Record<string, string | undefined>>, demo: Record<string, unknown>, app: Record<string, unknown>): string[] {
  return [...demoEnvProblems(env), ...demoConfigProblems(demo, String(own(app, "account_id")))];
}

/** Runs the gate against the repository's own two configurations; returns the exit code. */
export function runDemoGate(env: Readonly<Record<string, string | undefined>>, root: string, log: (line: string) => void): number {
  let demo: Record<string, unknown>;
  let app: Record<string, unknown>;
  let seen: Record<string, unknown>;
  let reference: Record<string, unknown>;
  let dotEnv: string[];
  try {
    dotEnv = dotEnvProblems(root);
    // existsSync first: wrangler reads a missing file as an error too, but say which one is missing
    for (const p of [DEMO_CONFIG_PATH, APP_CONFIG_PATH]) if (!existsSync(join(root, p))) throw new Error(`${p} not found`);
    demo = readRawConfig(join(root, DEMO_CONFIG_PATH));
    app = readRawConfig(join(root, APP_CONFIG_PATH));
    seen = readNormalisedConfig(join(root, DEMO_CONFIG_PATH));
    reference = referenceNormalisedConfig(String(own(app, "account_id")), seen.compatibility_date);
  } catch (e) {
    log(`deploy:demo: cannot read the configurations (${(e as Error).message})`);
    return 2;
  }
  const problems = [...demoDeployProblems(env, demo, app), ...dotEnv, ...normalisedConfigProblems(seen, reference)];
  for (const p of problems) log(`deploy:demo refused: ${p}`);
  return problems.length > 0 ? 1 : 0;
}

if (isEntry(import.meta.url)) {
  process.exit(runDemoGate(process.env, dirname(dirname(fileURLToPath(import.meta.url))), (line) => console.error(line)));
}
