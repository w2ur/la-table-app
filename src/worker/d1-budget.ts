/**
 * la-table's worst request against Workers Free's D1 budget per invocation, as « costs 7 D1 calls at worst… » in
 * api.workers.test.ts measures it: a 100-op request carrying an undo whose 3 attempts all conflict, then the reload
 * that answers it. scripts/d1-limit-probe.ts compares these with what Cloudflare actually counts.
 */
export const WORST_CALLS = 7;
/** The most statements one of those calls carries (a write batch of 100 ops). */
export const WIDEST_BATCH = 207;
