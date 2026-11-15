import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../worker/app";
import { fetchState, postOp, type FetchLike } from "./client";

const app = createApp({ verify: async () => true, now: () => "2026-10-12T10:00:00Z" });
const viaApp: FetchLike = (url, init) => app.fetch(new Request(url, init), env as never);
const cfg = { baseUrl: "https://table.test", headers: {} };

describe("CLI client against the real app", () => {
  it("reads a full state from /api/history", async () => {
    const state = await fetchState(cfg, viaApp);
    expect(state.products.length).toBeGreaterThan(0); // migration 0002 seeds products
    expect(state.appliedOps).toEqual({});
  });

  it("posts an op the app accepts, and a resend returns the stored result", async () => {
    const op = { opId: "cli-w1", type: "envie.add", at: "2026-10-12T09:00:00.000Z", payload: { text: "un curry", url: null } };
    expect((await postOp(cfg, viaApp, op)).result.status).toBe("applied");
    const again = await postOp(cfg, viaApp, op);
    expect(again.result.status).toBe("applied");
    expect(again.snapshot.menu.envies.filter((e) => e.text === "un curry")).toHaveLength(1);
    expect((await fetchState(cfg, viaApp)).envies.filter((e) => e.text === "un curry")).toHaveLength(1);
  });

  // Regression: b9957d8, e00dbcb — the Worker's unrecorded list and postOp's reading of it were only tested apart, so a drift between them stayed green
  it("rejects as non final when the D1 write fails, then a resend under the same id is applied once", async () => {
    const writes = new WeakSet<D1PreparedStatement>();
    let thrown = false;
    const failingOnce = {
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (!/INSERT INTO applied_ops/i.test(sql)) return statement;
        writes.add(statement);
        const bind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) => { const bound = bind(...values); writes.add(bound); return bound; };
        return statement;
      },
      batch: async (statements: D1PreparedStatement[]) => {
        // The first batch that records an op fails; loads and every later call pass, however many batches the load makes.
        if (!thrown && statements.some((s) => writes.has(s))) { thrown = true; throw new Error("D1 indisponible"); }
        return env.DB.batch(statements);
      },
    };
    const viaFlaky: FetchLike = (url, init) => app.fetch(new Request(url, init), { ...env, DB: failingOnce } as never);
    const op = { opId: "cli-w2", type: "envie.add", at: "2026-10-12T09:00:00.000Z", payload: { text: "une garbure", url: null } };

    const failed = postOp(cfg, viaFlaky, op);
    await expect(failed).rejects.toMatchObject({ exitCode: 2 });
    await expect(failed).rejects.toThrow(/non définitive/);
    expect(thrown).toBe(true);
    expect((await fetchState(cfg, viaApp)).envies.filter((e) => e.text === "une garbure")).toHaveLength(0);

    expect((await postOp(cfg, viaFlaky, op)).result.status).toBe("applied");
    expect((await fetchState(cfg, viaApp)).envies.filter((e) => e.text === "une garbure")).toHaveLength(1);
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = ?").bind(op.opId).first<{ n: number }>();
    expect(stored?.n).toBe(1);
  });
});
