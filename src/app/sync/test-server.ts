import { applyOp } from "../../domain/ops/apply";
import { snapshot } from "../../domain/snapshot";
import { storedOp } from "../../domain/state";
import { NOW, doubledFixtureProposal, fixtureState, op } from "../../domain/test-fixtures";
import type { State } from "../../domain/types";
import type { Fetcher } from "./api";
import { localServer } from "./local-server";
import type { Op } from "./types";

/**
 * ok · no network · an Access redirect · every op answered unrecorded (§8.2) · applied on the server, answer lost on the
 * way back · applied, then answered unrecorded with no snapshot (the batch committed, D1 failed before it could confirm) ·
 * the first op of the request throws: refused alone and recorded nowhere, the others applied (d1-store.ts) · applied and
 * answered, with no snapshot (D1 could not be read back) · the same answer, then every read of the state cut by the network
 * (the read that follows an answer with no snapshot fails) · every op applied, and the answer gives the last op of the
 * request no result at all (« sans réponse »: a stale Worker or a mangled answer) · every request answered 503 with an
 * HTML page, before the server applies anything (the Worker or Cloudflare down) · every POST cut by the network while reads
 * still land · every POST refused with a 400 (a deterministic client error, nothing applied).
 */
export type ServerMode =
  | "ok" | "offline" | "reauth" | "unrecorded" | "lose-answer" | "blind" | "throw-first" | "no-snapshot" | "no-read" | "no-result" | "unavailable" | "post-down" | "bad-request";

/**
 * What the phones start from in the sync property: the fixture planning with the saumon doubled, so every op the phone
 * sends has something to aim at: lines to tick, comté shared by the gratin and the salade once bought (the cheese story),
 * a first round whose cook makes the plat cuisiné its second round holds, and a second round to cook after it.
 */
export function plannedForPhones(): State {
  return applyOp(fixtureState(), op("planning.commit", doubledFixtureProposal()), NOW).state;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });

/**
 * The Worker's answers computed by the real domain over an in-memory state, with the failures spec §8.2 and §8.3 name.
 * « ok » is the demo's own server (local-server.ts), so the sync tests and the demo answer alike.
 */
export function fakeServer(initial: State) {
  let state = initial;
  let inFlight = 0;
  let maxInFlight = 0;
  // the ops the server stored a first record of, in the order it stored them
  const ok = localServer({
    load: () => state,
    save: (next) => {
      const fresh = Object.values(next.appliedOps).filter((r) => storedOp(state.appliedOps, r.opId) === undefined).sort((a, b) => a.seq - b.seq);
      server.landed.push(...fresh.map((r) => r.opId));
      state = next;
    },
  }, () => NOW);
  const server = {
    mode: "ok" as ServerMode,
    requests: 0,
    posts: [] as Op[][],
    /** Op ids in the order their first record was stored: the order the server applied them in. */
    landed: [] as string[],
    get state(): State {
      return state;
    },
    maxInFlight: (): number => maxInFlight,
    /** Another phone's op, applied at once whatever the mode: it has its own network. */
    elsewhere: (op: Op): void => {
      const fresh = storedOp(state.appliedOps, op.opId) === undefined;
      state = applyOp(state, op, NOW).state;
      if (fresh && storedOp(state.appliedOps, op.opId) !== undefined) server.landed.push(op.opId);
    },
    fetch: (async (url, init): Promise<Response> => {
      server.requests += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0)); // a round trip: other calls may start meanwhile
        if (server.mode === "offline") throw new TypeError("Failed to fetch");
        if (server.mode === "unavailable") return new Response("<html>503</html>", { status: 503, headers: { "content-type": "text/html" } });
        if (server.mode === "reauth") {
          return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/table" } });
        }
        if (url === "/api/state") {
          if (server.mode === "no-read") throw new TypeError("Failed to fetch");
          return await ok(url, init);
        }
        if (server.mode === "post-down") throw new TypeError("Failed to fetch");
        if (server.mode === "bad-request") return new Response(JSON.stringify({ error: "ops_expected" }), { status: 400, headers: { "content-type": "application/json" } });
        const ops = (JSON.parse(String(init?.body)) as { ops: Op[] }).ops;
        server.posts.push(ops);
        if (server.mode === "ok") return await ok(url, init);
        if (server.mode === "unrecorded") {
          return json({
            results: ops.map((op) => ({ opId: op.opId, status: "refused", reason: "erreur interne : panne simulée" })),
            unrecorded: ops.map((op) => op.opId),
            snapshot: snapshot(state, NOW),
          });
        }
        const results = ops.map((op, i) => {
          if (server.mode === "throw-first" && i === 0) return { opId: op.opId, status: "refused", reason: "erreur interne : panne simulée" };
          const fresh = storedOp(state.appliedOps, op.opId) === undefined;
          const applied = applyOp(state, op, NOW);
          state = applied.state;
          if (fresh && storedOp(state.appliedOps, op.opId) !== undefined) server.landed.push(op.opId);
          return { opId: op.opId, ...applied.result };
        });
        if (server.mode === "lose-answer") throw new TypeError("The network connection was lost.");
        if (server.mode === "blind") {
          return json({
            results: ops.map((op) => ({ opId: op.opId, status: "refused", reason: "erreur interne : D1 injoignable" })),
            unrecorded: ops.map((op) => op.opId),
            snapshot: null,
          });
        }
        const thrown: string[] = server.mode === "throw-first" ? ops.slice(0, 1).map((op) => op.opId) : [];
        if (server.mode === "no-result") return json({ results: results.slice(0, -1), unrecorded: [], snapshot: snapshot(state, NOW) });
        return json({ results, unrecorded: thrown, snapshot: server.mode === "no-snapshot" || server.mode === "no-read" ? null : snapshot(state, NOW) });
      } finally {
        inFlight -= 1;
      }
    }) satisfies Fetcher,
  };
  return server;
}
