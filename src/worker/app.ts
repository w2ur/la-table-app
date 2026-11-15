import { parseEnvelope } from "../domain/ops/apply";
import { MALFORMED, MAX_OPS } from "../domain/ops/helpers";
import { snapshot, undoWindowStart } from "../domain/snapshot";
import type { AuthEnv, Verifier } from "./auth";
import { applyOpsAndPersist, loadState } from "./d1-store";

export interface Env extends AuthEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  /** wrangler.jsonc `version_metadata`: the running version, its tag the deployed commit (scripts/deploy-ci.ts). */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function createApp(deps: { verify: Verifier; now?: () => string }) {
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (pathname === "/api/health" && request.method === "GET") {
        // the version marker the live probe waits for after a deploy (the edge answers as the old version for a while)
        return json({ ok: true, version: env.CF_VERSION_METADATA?.id ?? null, tag: env.CF_VERSION_METADATA?.tag || null });
      }
      if (!(await deps.verify(request, env))) return json({ ok: false, error: "unauthorized" }, 401);

      if (pathname === "/api/state" && request.method === "GET") {
        const at = now();
        return json(snapshot(await loadState(env.DB, [], undoWindowStart(at)), at));
      }
      if (pathname === "/api/history" && request.method === "GET") {
        const { appliedOps: _ops, ...state } = await loadState(env.DB, []);
        return json(state);
      }
      if (pathname === "/api/ops" && request.method === "POST") {
        // a cross-site form can post text/plain with the Access cookie but cannot send application/json without a preflight
        const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (contentType !== "application/json") return json({ ok: false, error: "json_expected" }, 415);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        const ops = (body as { ops?: unknown } | null)?.ops;
        if (!Array.isArray(ops)) return json({ ok: false, error: "ops_expected" }, 400);
        if (ops.length > MAX_OPS) return json({ ok: false, error: "too_many_ops" }, 413);
        const at = now();
        const opIds = ops.map((raw) => (typeof (raw as { opId?: unknown } | null)?.opId === "string" ? (raw as { opId: string }).opId : null));
        // a malformed op is refused the same way however often it is resent, so its answer is final though nothing records it
        const malformed = ops.map((raw) => parseEnvelope(raw) === null);
        // ops answered without a stored record: the answer is not final, and a resend under the same id is evaluated again
        const unrecorded = (recorded: (i: number) => boolean) => opIds.filter((id, i): id is string => id !== null && !malformed[i] && !recorded(i));
        try {
          const { results, state, recorded } = await applyOpsAndPersist(env.DB, ops, at, { recentSince: undoWindowStart(at) });
          // after a successful write the applied state is what D1 now holds; only an exhausted retry reads it again
          return json({
            results: results.map((r, i) => ({ opId: opIds[i], ...r })),
            unrecorded: unrecorded((i) => recorded[i]!),
            snapshot: snapshot(state ?? (await loadState(env.DB, [], undoWindowStart(at))), at),
          });
        } catch (error) {
          // a D1 failure may come after the batch committed (a connection lost on the way back): an op D1 holds a record
          // for is answered with that record, every other op is refused unrecorded so a resend tries it again
          const reason = `erreur interne : ${error instanceof Error ? error.message : String(error)}`;
          let fresh = null;
          let stored: Record<string, { status: string; reason: string | null }> = {};
          try {
            const state = await loadState(env.DB, opIds.filter((id): id is string => id !== null), undoWindowStart(at));
            stored = state.appliedOps;
            fresh = snapshot(state, at);
          } catch {
            // D1 is still unreachable: nothing can be confirmed, so every op is refused and stays in the outbox
          }
          return json({
            results: opIds.map((opId, i) => {
              if (malformed[i]) return { opId, ...MALFORMED };
              const rec = opId !== null && Object.hasOwn(stored, opId) ? stored[opId]! : null;
              return rec ? { opId, status: rec.status, reason: rec.reason } : { opId, status: "refused", reason };
            }),
            unrecorded: unrecorded((i) => Object.hasOwn(stored, opIds[i]!)),
            snapshot: fresh,
          });
        }
      }
      return json({ ok: false, error: "not_found" }, 404);
    },
  };
}
