import { isEntry } from "../src/cli/entry.ts";
import { WIDEST_BATCH, WORST_CALLS } from "../src/worker/d1-budget.ts";

/**
 * Asks the throwaway Worker of probes/d1-limit what Workers Free counts against its D1 budget per invocation, and
 * compares la-table's worst request (src/worker/d1-budget.ts) with it.
 */
export const MEASURES = [
  ["serial", 50], ["serial", 51], ["serial", 1000], ["serial", 1001], ["batches", 50], ["batches", 51], ["wide", 250],
] as const;

export type Measure = (typeof MEASURES)[number];
export interface Answer { ok: boolean; done?: number; error?: string }
export interface Verdict { exit: 0 | 1 | 2; lines: string[]; limitError: string | null }

const key = ([mode, n]: Measure) => `${mode}?n=${n}`;

export function verdict(answers: Map<string, Answer | null>): Verdict {
  const get = (m: Measure) => answers.get(key(m)) ?? null;
  const unread = MEASURES.filter((m) => get(m) === null).map(key);
  if (unread.length > 0) return { exit: 2, lines: [`sans réponse lisible : ${unread.join(", ")}`], limitError: null };
  const ok = (m: Measure) => get(m)!.ok;
  // the limit must be seen failing once, or nothing says the probe can see it at all
  const limit = ok(["serial", 50]) && !ok(["serial", 51]) ? 50 : ok(["serial", 1000]) && !ok(["serial", 1001]) ? 1000 : null;
  if (limit === null) {
    return { exit: 2, lines: ["aucune limite observée entre 50 et 1001 appels : la mesure ne prouve rien"], limitError: null };
  }
  // a refusal is the limit only when it came right after the last allowed call: an earlier failure is something else
  const refusedAfter = (m: Measure, done: number) => !ok(m) && get(m)!.done === done;
  const over = limit === 50 ? (["serial", 51] as const) : (["serial", 1001] as const);
  if (!refusedAfter(over, limit)) {
    return { exit: 2, lines: [`${key(over)} a échoué après ${get(over)!.done ?? "?"} appels, pas ${limit} : ce n'est pas la limite`], limitError: null };
  }
  const limitError = get(over)!.error ?? null;
  // a failure is a finding only when it carries the limit's own message; any other one is something else, so unknown
  const notTheLimit = (m: Measure) => ({ exit: 2 as const, lines: [`${key(m)} a échoué autrement que par la limite (${get(m)!.error ?? "sans message"}) : ce n'est pas une mesure`], limitError: null });
  const isLimit = (m: Measure) => get(m)!.error === limitError;
  if (limit === 50) {
    if (ok(["serial", 1000])) {
      return { exit: 2, lines: ["serial?n=1000 passe alors que serial?n=51 est refusé : mesures incohérentes"], limitError: null };
    }
    if (!ok(["batches", 51]) && !(refusedAfter(["batches", 51], 50) && isLimit(["batches", 51]))) return notTheLimit(["batches", 51]);
    if (!ok(["batches", 50]) && !isLimit(["batches", 50])) return notTheLimit(["batches", 50]);
  }
  if (!ok(["wide", 250]) && !isLimit(["wide", 250])) return notTheLimit(["wide", 250]);
  const batchIsOneCall = limit !== 50 || (ok(["batches", 50]) && !ok(["batches", 51]));
  const wideIsOneCall = ok(["wide", 250]);
  const lines = [
    `limite observée : ${limit} appels D1 par invocation (erreur : ${limitError ?? "sans message"})`,
    `un batch compte pour un appel : ${batchIsOneCall ? "oui" : "non"}`,
    `un batch de 250 requêtes passe : ${wideIsOneCall ? "oui" : "non"} (le plus large de la-table : ${WIDEST_BATCH})`,
    `pire requête de la-table : ${WORST_CALLS} appels`,
  ];
  const fits = batchIsOneCall && wideIsOneCall && WORST_CALLS <= limit;
  lines.push(fits ? "verdict : dans le budget" : "verdict : HORS BUDGET, ne pas déployer");
  return { exit: fits ? 0 : 1, lines, limitError };
}

if (isEntry(import.meta.url)) {
  const base = process.argv[2];
  if (!base?.startsWith("https://")) {
    console.error("usage : tsx scripts/d1-limit-probe.ts https://la-table-d1-probe.<sous-domaine>.workers.dev");
    process.exit(2);
  }
  const answers = new Map<string, Answer | null>();
  for (const m of MEASURES) {
    try {
      const res = await fetch(`${base}/${key(m)}`, { signal: AbortSignal.timeout(30_000) });
      const body = (await res.json()) as Answer;
      answers.set(key(m), typeof body?.ok === "boolean" ? body : null);
      console.error(`${key(m)} → ${JSON.stringify(body)}`);
    } catch (error) {
      answers.set(key(m), null);
      console.error(`${key(m)} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const v = verdict(answers);
  for (const line of v.lines) console.log(line);
  process.exit(v.exit);
}
