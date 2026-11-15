import { describe, expect, it } from "vitest";
import { snapshot } from "../../domain/snapshot";
import { applyOp } from "../../domain/ops/apply";
import { NOW, fixtureProposal, fixtureState, op } from "../../domain/test-fixtures";
import { fetchSnapshot, isSnapshot, postOps, type Fetcher } from "./api";

const snap = snapshot(fixtureState(), NOW);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const answering = (response: () => Response, seen: RequestInit[] = []): Fetcher => async (_url, init) => {
  seen.push(init ?? {});
  return response();
};

describe("api", () => {
  it("reads a network failure as offline", async () => {
    expect(await fetchSnapshot(async () => { throw new TypeError("Failed to fetch"); })).toEqual({ kind: "offline" });
  });

  it("reads an Access redirect, a 401 or 403, and an HTML page as a lapsed login (spec §8.3)", async () => {
    const lapsed = [
      () => new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } }),
      () => json({ ok: false, error: "unauthorized" }, 401),
      () => new Response("forbidden", { status: 403 }),
      () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
    ];
    for (const response of lapsed) expect(await fetchSnapshot(answering(response))).toEqual({ kind: "reauth" });
  });

  it("reads a 5xx page, a JSON 4xx and an incomplete answer as a server failure, never as a login", async () => {
    expect(await fetchSnapshot(answering(() => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } })))).toEqual({ kind: "server", status: 502 });
    expect(await postOps(answering(() => json({ ok: false, error: "too_many_ops" }, 413)), [])).toEqual({ kind: "server", status: 413 });
    expect(await fetchSnapshot(answering(() => json({ menu: {} })))).toEqual({ kind: "server", status: 200 });
    expect(await postOps(answering(() => json({ results: [], snapshot: snap })), [])).toEqual({ kind: "server", status: 200 });
    expect(await fetchSnapshot(answering(() => new Response("{", { headers: { "content-type": "application/json" } })))).toEqual({ kind: "server", status: 200 });
  });

  // Regression: 5a86852 — a snapshot from a stale Worker missing a section replaced the stored one and broke the screens
  it("reads a snapshot missing a section the screens read as a server failure", async () => {
    const broken = [
      { ...snap, menu: { ...snap.menu, recentlyCooked: undefined } },
      { ...snap, menu: { ...snap.menu, envies: undefined } },
      { ...snap, lastTrip: undefined },
      { ...snap, lastTrip: "2026-10-01" },
      { ...snap, calibration: undefined },
      { ...snap, calibration: null },
    ];
    for (const body of broken) expect(await fetchSnapshot(answering(() => json(body)))).toEqual({ kind: "server", status: 200 });
    expect(isSnapshot({ ...snap, lastTrip: null })).toBe(true);
  });

  // a snapshot stored or served by the previous build has no `nutrition` on its pool meals; requiring it
  // would read that snapshot as broken during a deploy window, or throw away the one stored on the phone
  it("takes a snapshot whose pool meals have no nutrition, as the previous build served it", async () => {
    const planned = snapshot(applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state, NOW);
    const older = { ...planned, menu: { ...planned.menu, pool: planned.menu.pool.map(({ nutrition: _, ...m }) => m) } };
    expect(older.menu.pool.length).toBeGreaterThan(0);
    expect(older.menu.pool.every((m) => !("nutrition" in m))).toBe(true);
    expect(isSnapshot(older)).toBe(true);
    expect(await fetchSnapshot(answering(() => json(older)))).toEqual({ kind: "ok", body: older });
  });

  it("returns a complete snapshot, and an ops answer whose snapshot is null when D1 could not be read back", async () => {
    expect(await fetchSnapshot(answering(() => json(snap)))).toEqual({ kind: "ok", body: snap });
    const body = { results: [{ opId: "a", status: "refused", reason: "erreur interne : D1" }], unrecorded: ["a"], snapshot: null };
    expect(await postOps(answering(() => json(body)), [])).toEqual({ kind: "ok", body });
  });

  it("posts the ops as JSON and never follows a redirect", async () => {
    const seen: RequestInit[] = [];
    const op = { opId: "00000000-0000-4000-8000-000000000001", type: "shopping.buy", at: "2026-10-12T09:00:00.000Z", payload: { itemId: 3 } };
    await postOps(answering(() => json({ results: [], unrecorded: [], snapshot: null }), seen), [op]);
    expect(seen[0]).toMatchObject({ method: "POST", redirect: "manual", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ ops: [op] });
  });
});
