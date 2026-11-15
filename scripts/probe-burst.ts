import { randomUUID } from "node:crypto";
import { isEntry } from "../src/cli/entry.ts";
import { CliError, clientConfig, DEFAULT_URL, type FetchLike } from "../src/cli/client.ts";
import { readKeychain } from "../src/cli/keychain.ts";
import { workerAddressRefusal } from "./probe-live.ts";

/**
 * The worst request of src/worker/d1-budget.ts, sent for real: `parallel` requests at once, each a 100-op outbox whose
 * first op undoes a buy, so they conflict with each other and retry. WRITES TO THE DEPLOYED DATABASE: run it only
 * between a D1 Time Travel bookmark and the restore to it.
 */
export interface BurstAnswer {
  status: number;
  results: { opId: string | null; status: string; reason: string | null }[];
  unrecorded: string[];
  lines?: { id: number; label: string }[];
}

export function burstOps(tag: string, buyOpId: string, at: string): unknown[] {
  return [
    { opId: `${tag}-undo`, type: "undo", at, payload: { targetOpId: buyOpId } },
    ...Array.from({ length: 99 }, (_, i) => ({ opId: `${tag}-envie-${i}`, type: "envie.add", at, payload: { text: `sonde ${tag} ${i}`, url: null } })),
  ];
}

/**
 * Exit 1 when a request was answered with anything but a 200, or with an internal error, naming the reasons; else 2
 * when the burst measured nothing or not all of it (no request sent, a request that never got an answer, or none that
 * used up its three attempts, so the worst case of src/worker/d1-budget.ts never happened); else 0. `null` is a request
 * that got no answer at all (the fetch threw): unknown, never a finding.
 */
export function burstVerdict(answers: (BurstAnswer | null)[]): { exit: 0 | 1 | 2; lines: string[] } {
  const lines: string[] = [];
  const unreached = answers.filter((a) => a === null).length;
  const wrong = answers.filter((a) => a !== null && a.status !== 200).length;
  const internal = answers.flatMap((a) => a?.results ?? []).filter((r) => r.reason?.startsWith("erreur interne") ?? false);
  const exhausted = answers.filter((a) => (a?.unrecorded.length ?? 0) > 0).length;
  lines.push(`requêtes : ${answers.length}, sans réponse 200 : ${unreached + wrong}`);
  lines.push(`requêtes dont les tentatives se sont toutes heurtées (« trop de modifications simultanées ») : ${exhausted}`);
  for (const reason of new Set(internal.map((r) => r.reason!))) lines.push(reason);
  if (unreached > 0) lines.push(`requêtes sans réponse (réseau, DNS, TLS) : ${unreached}, la mesure n'est pas complète`);
  if (wrong > 0 || internal.length > 0) return { exit: 1, lines };
  if (unreached > 0) return { exit: 2, lines };
  if (answers.length === 0) return { exit: 2, lines: [...lines, "aucune requête envoyée : rien n'a été mesuré"] };
  if (exhausted === 0) {
    return { exit: 2, lines: [...lines, "aucune requête n'a épuisé ses trois tentatives : le pire cas n'a pas eu lieu, le budget D1 n'est pas mesuré (relancer avec plus de requêtes)"] };
  }
  return { exit: 0, lines };
}

/**
 * The most requests sent at once: each is a worst-case 100-op write to the deployed Worker and D1 under the service token,
 * all fired together, so a typo (`800`) must not reach production. 50 is D1's per-invocation call budget on Workers Free.
 */
export const MAX_PARALLEL = 50;

/** The number of requests to send at once (8 unless one is given, 1 to MAX_PARALLEL) and `--local`, or why the arguments are refused. */
export function burstArgs(argv: string[]): { parallel: number; local: boolean } | { error: string } {
  let parallel: number | undefined;
  let local = false;
  for (const a of argv) {
    if (a === "--local") { local = true; continue; }
    if (parallel !== undefined || !/^\d+$/.test(a) || Number(a) < 1 || Number(a) > MAX_PARALLEL) return { error: `argument refusé : ${a} (attendu : un nombre de requêtes de 1 à ${MAX_PARALLEL}, et --local)` };
    parallel = Number(a);
  }
  return { parallel: parallel ?? 8, local };
}

/**
 * Why the burst must not write to `base`, or null. Outside `--local` only the Worker's own address, DEFAULT_URL exactly
 * (`workerAddressRefusal`): an `LA_TABLE_URL` left at a local wrangler dev, which enforces no D1 limit, would get the
 * service token and pass with Cloudflare never measured.
 */
export function burstBaseRefusal(base: string, local: boolean, url = DEFAULT_URL): string | null {
  return local ? null : workerAddressRefusal(base, url);
}

async function post(f: FetchLike, base: string, headers: Record<string, string>, ops: unknown[]): Promise<BurstAnswer | null> {
  try {
    const res = await f(`${base}/api/ops`, { method: "POST", redirect: "manual", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ops }) });
    if (res.status !== 200) return { status: res.status, results: [], unrecorded: [] };
    const body = (await res.json()) as { results?: BurstAnswer["results"]; unrecorded?: string[]; snapshot?: { courses?: { lines?: BurstAnswer["lines"] } } };
    return { status: 200, results: body.results ?? [], unrecorded: body.unrecorded ?? [], lines: body.snapshot?.courses?.lines ?? [] };
  } catch {
    return null;
  }
}

if (isEntry(import.meta.url)) {
  // refused before anything is written: a burst of 0 would set up the line and the buy, then measure nothing
  const args = burstArgs(process.argv.slice(2));
  if ("error" in args) { console.error(args.error); process.exit(2); }
  const { parallel } = args;
  let cfg;
  try {
    // --local: wrangler dev (LA_TABLE_LOCAL_URL, default localhost:8787), to try the probe before it writes anywhere real
    cfg = clientConfig({ local: args.local, env: process.env, readSecret: readKeychain });
  } catch (error) {
    console.error(error instanceof CliError ? error.message : String(error));
    process.exit(2);
  }
  // refused before the setup writes, and named first: every line below is about this address
  const refusal = burstBaseRefusal(cfg.baseUrl, args.local);
  if (refusal !== null) { console.error(refusal); process.exit(2); }
  console.log(`adresse sondée : ${cfg.baseUrl}`);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const run = randomUUID().slice(0, 8);
  // a line to buy, so every request carries an undo (the row-undo and later-writes statements of the load)
  const added = await post(fetch, cfg.baseUrl, cfg.headers, [{ opId: `${run}-add`, type: "shopping.add", at, payload: { label: `sonde ${run}`, isFood: false } }]);
  const line = added?.lines?.find((l) => l.label === `sonde ${run}`);
  if (!line) { console.error("préparation impossible : la ligne de sonde n'apparaît pas"); process.exit(2); }
  const bought = await post(fetch, cfg.baseUrl, cfg.headers, [{ opId: `${run}-buy`, type: "shopping.buy", at, payload: { itemId: line.id } }]);
  if (bought?.results[0]?.status !== "applied") { console.error(`préparation impossible : achat ${JSON.stringify(bought)}`); process.exit(2); }
  const answers = await Promise.all(Array.from({ length: parallel }, (_, i) => post(fetch, cfg.baseUrl, cfg.headers, burstOps(`${run}-${i}`, `${run}-buy`, at))));
  const v = burstVerdict(answers);
  for (const l of v.lines) console.log(l);
  process.exit(v.exit);
}
