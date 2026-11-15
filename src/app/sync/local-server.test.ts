import { describe, expect, it } from "vitest";
import { MAX_OPS } from "../../domain/ops/helpers";
import { NOW, fixtureProposal, fixtureState, op } from "../../domain/test-fixtures";
import { localServer, memoryStateStore } from "./local-server";

const post = (body: unknown, contentType = "application/json") =>
  ({ method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("localServer", () => {
  it("answers GET /api/state with the snapshot of the stored state", async () => {
    const store = memoryStateStore(fixtureState());
    const res = await localServer(store, () => NOW)("/api/state", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ today: "2026-10-12", courses: { lines: [] } });
  });

  it("applies POST /api/ops in order through the domain, stores the result, and answers with the new snapshot", async () => {
    const store = memoryStateStore(fixtureState());
    const commit = op("planning.commit", fixtureProposal());
    const res = await localServer(store, () => NOW)("/api/ops", post({ ops: [commit] }));
    const answer = (await res.json()) as { results: unknown[]; unrecorded: string[]; snapshot: { courses: { lines: unknown[] } } };
    expect(answer.results).toEqual([{ opId: commit.opId, status: "applied", reason: null }]);
    expect(answer.unrecorded).toEqual([]);
    expect(answer.snapshot.courses.lines.length).toBeGreaterThan(0);
    expect(store.state.plannings).toHaveLength(1);
  });

  it("reads and writes the store on every request, so two servers over one store never diverge", async () => {
    const store = memoryStateStore(fixtureState());
    const a = localServer(store, () => NOW);
    const b = localServer(store, () => NOW);
    await a("/api/ops", post({ ops: [op("planning.commit", fixtureProposal())] }));
    const seen = (await (await b("/api/state", { method: "GET" })).json()) as { courses: { lines: unknown[] } };
    expect(seen.courses.lines.length).toBeGreaterThan(0);
  });

  it("refuses what src/worker/app.ts refuses, with its statuses and error codes", async () => {
    const server = localServer(memoryStateStore(fixtureState()), () => NOW);
    const answer = async (url: string, init: RequestInit) => {
      const res = await server(url, init);
      return [res.status, ((await res.json()) as { error?: string }).error];
    };
    expect(await answer("/api/ops", post({ ops: [] }, "text/plain"))).toEqual([415, "json_expected"]);
    expect(await answer("/api/ops", post("{not json"))).toEqual([400, "invalid_json"]);
    expect(await answer("/api/ops", post({ op: [] }))).toEqual([400, "ops_expected"]);
    expect(await answer("/api/ops", post({ ops: Array.from({ length: MAX_OPS + 1 }, (_, i) => ({ opId: `x${i}` })) }))).toEqual([413, "too_many_ops"]);
    expect(await answer("/api/history", { method: "GET" })).toEqual([404, "not_found"]);
    expect(await answer("/api/state", post({ ops: [] }))).toEqual([404, "not_found"]);
    expect(await answer("/api/ops", { method: "GET" })).toEqual([404, "not_found"]);
  });

  it("control: exactly MAX_OPS ops are taken", async () => {
    const ops = Array.from({ length: MAX_OPS }, (_, i) => op("envie.add", { text: `envie ${i}` }));
    const res = await localServer(memoryStateStore(fixtureState()), () => NOW)("/api/ops", post({ ops }));
    expect(res.status).toBe(200);
  });

  it("refuses a malformed op as final: never listed unrecorded", async () => {
    const store = memoryStateStore(fixtureState());
    const answer = (await (await localServer(store, () => NOW)("/api/ops", post({ ops: [{ opId: "bad" }, { opId: 7, type: "x", at: NOW }] }))).json()) as {
      results: { opId: string | null; status: string; reason: string }[]; unrecorded: string[];
    };
    expect(answer.results).toEqual([
      { opId: "bad", status: "refused", reason: "opération mal formée" },
      { opId: null, status: "refused", reason: "opération mal formée" },
    ]);
    expect(answer.unrecorded).toEqual([]);
    expect(store.state.appliedOps).toEqual({});
  });
});
