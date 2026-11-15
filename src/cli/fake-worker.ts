import { applyOp } from "../domain/ops/apply";
import { snapshot } from "../domain/snapshot";
import type { State } from "../domain/types";
import { NOW } from "../domain/test-fixtures";
import type { FetchLike } from "./client";

const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

/**
 * Test helper: an in-memory Worker serving /api/history and applying /api/ops with the real applyOp.
 * `loseAnswerOnPost` drops the answer of that post (1-based, counted over the server's life), after applying it.
 */
export function fakeWorker(initial: State, opts: { loseAnswerOnPost?: number } = {}) {
  let state = initial;
  const posted: { type: string; payload: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/api/history")) { const { appliedOps: _o, ...rest } = state; return json(rest); }
    const ops = JSON.parse(String(init?.body)).ops as { opId: string; type: string; at: string; payload: unknown }[];
    const results = ops.map((o) => { posted.push({ type: o.type, payload: o.payload }); const r = applyOp(state, o, NOW); state = r.state; return { opId: o.opId, ...r.result }; });
    if (posted.length === opts.loseAnswerOnPost) throw new TypeError("fetch failed");
    return json({ results, unrecorded: [], snapshot: snapshot(state, NOW) });
  };
  return { fetch, posted, get state() { return state; } };
}

// one counter for every test: two runs sharing a server never reuse an op id, as crypto.randomUUID never does
let n = 0;
export function cliDeps(fetch: FetchLike) {
  return { cfg: { baseUrl: "https://t", headers: {} }, fetch, now: () => NOW, uuid: () => `u${++n}` };
}
