import { applyOp, parseEnvelope } from "../../domain/ops/apply";
import { MALFORMED, MAX_OPS } from "../../domain/ops/helpers";
import { snapshot } from "../../domain/snapshot";
import { storedOp } from "../../domain/state";
import type { State } from "../../domain/types";
import type { Fetcher } from "./api";

/** Where the local server keeps its state: read at the start of every request and written at its end. */
export interface StateStore {
  load(): State;
  save(state: State): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const opIdOf = (raw: unknown): string | null =>
  typeof (raw as { opId?: unknown } | null)?.opId === "string" ? (raw as { opId: string }).opId : null;

/**
 * The Worker's `/api/state` and `/api/ops` (src/worker/app.ts) computed by the real domain over a state kept in `store`,
 * with no D1 and no Access: the sync tests' server, and the whole back end of the static demo. It answers what app.ts
 * answers to the same request (415, 400, 413, malformed ops refused and never listed, an op its handler threw on refused
 * unrecorded), and 404 to anything else. The state is read and written on every request, so two tabs over one
 * `localStorage` see one server.
 */
export function localServer(store: StateStore, now: () => string): Fetcher {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const { pathname } = new URL(input, "http://local.invalid");
    if (pathname === "/api/state" && method === "GET") return json(snapshot(store.load(), now()));
    if (pathname !== "/api/ops" || method !== "POST") return json({ ok: false, error: "not_found" }, 404);

    const contentType = new Headers(init?.headers).get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return json({ ok: false, error: "json_expected" }, 415);
    let body: unknown;
    try {
      body = JSON.parse(String(init?.body));
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    const ops = (body as { ops?: unknown } | null)?.ops;
    if (!Array.isArray(ops)) return json({ ok: false, error: "ops_expected" }, 400);
    if (ops.length > MAX_OPS) return json({ ok: false, error: "too_many_ops" }, 413);

    const at = now();
    let state = store.load();
    const results = ops.map((raw: unknown) => {
      if (parseEnvelope(raw) === null) return { opId: opIdOf(raw), ...MALFORMED };
      const applied = applyOp(state, raw, at);
      state = applied.state;
      return { opId: opIdOf(raw), ...applied.result };
    });
    store.save(state);
    // malformed ops are final though unrecorded; any other op without a stored record (its handler threw) is not
    const unrecorded = ops.flatMap((raw: unknown) => {
      const opId = opIdOf(raw);
      return opId !== null && parseEnvelope(raw) !== null && storedOp(state.appliedOps, opId) === undefined ? [opId] : [];
    });
    return json({ results, unrecorded, snapshot: snapshot(state, at) });
  };
}

/** A StateStore in memory (the tests'). */
export function memoryStateStore(initial: State): StateStore & { readonly state: State } {
  let state = initial;
  return {
    get state() {
      return state;
    },
    load: () => state,
    save: (next) => {
      state = next;
    },
  };
}
