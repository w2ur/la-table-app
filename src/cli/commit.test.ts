import { describe, expect, it } from "vitest";
import { applyOp } from "../domain/ops/apply";
import { snapshot } from "../domain/snapshot";
import type { State } from "../domain/types";
import { NOW, fixtureProposal, fixtureState } from "../domain/test-fixtures";
import type { FetchLike } from "./client";
import { proposalKey, commitText, renderCourses, type CommitJournal } from "./commit";

const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

/** An in-memory Worker: serves /api/history and applies /api/ops with the real applyOp, op records kept, so replay is the domain's. */
/**
 * `unconfirmed` answers the next posts as the Worker does when it cannot stand behind its answer (§8.2): refused and
 * listed in `unrecorded`, after applying the op (`applied: true`, a D1 failure on the way back) or not (a conflict).
 */
function fakeServer(initial: State, opts: { loseAnswers?: number; unconfirmed?: { count: number; applied: boolean } } = {}) {
  let state = initial;
  let toLose = opts.loseAnswers ?? 0;
  let toLeaveUnconfirmed = opts.unconfirmed?.count ?? 0;
  const posted: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/api/history")) { const { appliedOps: _o, ...rest } = state; return json(rest); }
    const ops = JSON.parse(String(init?.body)).ops as { opId: string }[];
    if (toLeaveUnconfirmed > 0) {
      toLeaveUnconfirmed -= 1;
      for (const o of ops) { posted.push(o.opId); if (opts.unconfirmed!.applied) state = applyOp(state, o, NOW).state; }
      const reason = opts.unconfirmed!.applied ? "erreur interne : D1 injoignable" : "trop de modifications simultanées, réessayez";
      return json({ results: ops.map((o) => ({ opId: o.opId, status: "refused", reason })), unrecorded: ops.map((o) => o.opId), snapshot: null });
    }
    const results = ops.map((o) => { posted.push(o.opId); const r = applyOp(state, o, NOW); state = r.state; return { opId: o.opId, ...r.result }; });
    if (toLose > 0) { toLose -= 1; throw new TypeError("fetch failed"); } // applied, but the answer never comes back
    return json({ results, unrecorded: [], snapshot: snapshot(state, NOW) });
  };
  return { fetch, posted, get state() { return state; } };
}

const snapshotCourses = (state: State) => renderCourses(snapshot(state, NOW));

function memoryJournal(): CommitJournal & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return { entries, get: (k) => entries.get(k) ?? null, set: (k, v) => void entries.set(k, v), delete: (k) => void entries.delete(k) };
}

function deps(fetch: FetchLike, journal = memoryJournal()) {
  let n = 0;
  return { cfg: { baseUrl: "https://t", headers: {} }, fetch, now: () => NOW, uuid: () => `u${++n}`, journal };
}

describe("commit", () => {
  it("prints a product left on two lines (one per planning) as one row, quantities and prices summed", () => {
    // Regression: 2026-10-14 replacement planning — Courses printed citron, gingembre, coriandre and crème fraîche twice
    const s = applyOp(fixtureState(), { opId: "c", type: "planning.commit", at: NOW, payload: fixtureProposal() }, NOW).state;
    const poireau = s.shoppingItems.find((l) => l.label === "poireau")!;
    s.shoppingItems.push({ ...poireau, id: 99, qty: 300, estPriceCents: 120, planningId: 2 });
    const text = renderCourses(snapshot(s, NOW));
    expect(text.match(/poireau/g)).toHaveLength(1);
    expect(text).toContain(`  - poireau · 1 kg · ${((poireau.estPriceCents! + 120) / 100).toLocaleString("fr-FR")} €`);
  });

  it("commits a clean proposal once and prints Courses by category", async () => {
    const server = fakeServer(fixtureState());
    const r = await commitText(JSON.stringify(fixtureProposal()), deps(server.fetch));
    expect(r.exitCode).toBe(0);
    expect(server.state.plannings).toHaveLength(1);
    expect(server.posted).toEqual(["commit-u1"]);
    expect(r.output).toMatch(/Planification enregistrée/);
    expect(r.output).toMatch(/Courses\n Fruits et légumes\n  - poireau · 700 g · 2,80 €/);
    expect(r.output.indexOf(" Fruits et légumes")).toBeLessThan(r.output.indexOf(" Poissonnerie"));
    expect(r.output.indexOf(" Poissonnerie")).toBeLessThan(r.output.indexOf(" Crèmerie"));
    expect(r.output).toMatch(/Total estimé 18,80 € · budget 30 €/);
  });

  it("a rerun after a lost answer resends the same op id, gets the stored result and plans once", async () => {
    const server = fakeServer(fixtureState(), { loseAnswers: 1 });
    const journal = memoryJournal();
    const text = JSON.stringify(fixtureProposal());
    await expect(commitText(text, deps(server.fetch, journal))).rejects.toMatchObject({ exitCode: 2 });
    expect(server.state.plannings).toHaveLength(1); // the Worker did apply it

    // Regression: 97e72b8 — a replayed success said "Planification enregistrée." as if a new planning had been created
    const r = await commitText(text, deps(server.fetch, journal));
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/Planification déjà enregistrée \(renvoi du même identifiant\)/);
    expect(r.output).not.toMatch(/Planification enregistrée/);
    expect(server.posted).toEqual(["commit-u1", "commit-u1"]);
    expect(server.state.plannings).toHaveLength(1);
  });

  it("a rerun after an attempt that never reached the Worker applies the planning and does not claim it was already there", async () => {
    // Regression: 6dfbf8b — a journal entry was read as proof of a prior application, so a first real application after an expired-token 302 said « déjà »
    const server = fakeServer(fixtureState());
    let failNextOp = true;
    const flaky: FetchLike = async (url, init) => {
      if (url.endsWith("/api/ops") && failNextOp) { failNextOp = false; return new Response("", { status: 302, headers: { location: "https://access.example/login" } }); }
      return server.fetch(url, init);
    };
    const journal = memoryJournal();
    const text = JSON.stringify(fixtureProposal());
    await expect(commitText(text, deps(flaky, journal))).rejects.toMatchObject({ exitCode: 2 });
    expect(server.state.plannings).toHaveLength(0);
    expect(journal.entries.size).toBe(1);

    const r = await commitText(text, deps(flaky, journal));
    expect(r.exitCode).toBe(0);
    expect(server.state.plannings).toHaveLength(1);
    expect(r.output).toMatch(/Planification enregistrée\./);
    expect(r.output).not.toMatch(/déjà/);
    expect(server.posted).toEqual(["commit-u1"]);
  });

  // Regression: e00dbcb — a refusal the Worker did not record (conflict, erreur interne) was read as final: journal dropped, exit 1, a rerun sent a fresh id
  it("treats a refusal the server did not record as not final: exit 2, the op id kept, the rerun resends it and plans once", async () => {
    for (const applied of [false, true]) {
      const server = fakeServer(fixtureState(), { unconfirmed: { count: 1, applied } });
      const journal = memoryJournal();
      const text = JSON.stringify(fixtureProposal());
      await expect(commitText(text, deps(server.fetch, journal)), `applied: ${applied}`).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/non définitive/) });
      expect([...journal.entries.values()]).toEqual(["commit-u1"]);
      expect(server.state.plannings).toHaveLength(applied ? 1 : 0);

      const r = await commitText(text, deps(server.fetch, journal));
      expect(r.exitCode).toBe(0);
      expect(server.posted).toEqual(["commit-u1", "commit-u1"]);
      expect(server.state.plannings).toHaveLength(1);
    }
  });

  // Regression: a01f68e — the journal kept a committed proposal's op id, so the same content sent later replayed it and said « déjà enregistrée »
  it("forgets the op id once the answer is final, so the same content later is a new proposal checked against the planning", async () => {
    const server = fakeServer(fixtureState());
    const journal = memoryJournal();
    const text = JSON.stringify(fixtureProposal());
    expect((await commitText(text, deps(server.fetch, journal))).exitCode).toBe(0);
    expect(journal.entries.size).toBe(0);

    const again = await commitText(text, { ...deps(server.fetch, journal), uuid: () => "later" });
    expect(again.exitCode).toBe(1);
    expect(again.output).toMatch(/Rien n'est envoyé/);
    expect(again.output).not.toMatch(/déjà enregistrée/);
    expect(server.posted).toEqual(["commit-u1"]);
    expect(server.state.plannings).toHaveLength(1);
  });

  // Regression: a0ddb4b — the op id was forgotten before the reply was built, so a throw there sent the rerun a fresh id the local check stopped
  it("keeps the op id when building the reply throws, so the rerun replays the planning instead of being stopped locally", async () => {
    const server = fakeServer(fixtureState());
    let malformNext = true;
    const malformed: FetchLike = async (url, init) => {
      const res = await server.fetch(url, init);
      if (!url.endsWith("/api/ops") || !malformNext) return res;
      malformNext = false;
      const body = await res.json() as { snapshot: { courses: { lines: unknown[] } } };
      body.snapshot.courses.lines = [null]; // passes the snapshot shape check, breaks the Courses rendering
      return json(body);
    };
    const journal = memoryJournal();
    const text = JSON.stringify(fixtureProposal());
    await expect(commitText(text, deps(malformed, journal))).rejects.toThrow(TypeError);
    expect(server.state.plannings).toHaveLength(1);
    expect([...journal.entries.values()]).toEqual(["commit-u1"]);

    const r = await commitText(text, deps(malformed, journal));
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/Planification déjà enregistrée/);
    expect(server.posted).toEqual(["commit-u1", "commit-u1"]);
    expect(server.state.plannings).toHaveLength(1);
    expect(journal.entries.size).toBe(0);
  });

  it("reads the state once, and prints Courses from the snapshot the commit answer carries", async () => {
    const server = fakeServer(fixtureState());
    const urls: string[] = [];
    const counting: FetchLike = async (url, init) => { urls.push(url.replace("https://t", "")); return server.fetch(url, init); };
    const r = await commitText(JSON.stringify(fixtureProposal()), deps(counting));
    expect(r.exitCode).toBe(0);
    expect(urls).toEqual(["/api/history", "/api/ops"]);
    expect(r.output).toContain(snapshotCourses(server.state));
  });

  it("records the op id in the journal before the op leaves", async () => {
    const journal = memoryJournal();
    const server = fakeServer(fixtureState());
    let journaledAtSend: string[] = [];
    const spying: FetchLike = async (url, init) => {
      if (url.endsWith("/api/ops")) journaledAtSend = [...journal.entries.values()];
      return server.fetch(url, init);
    };
    await commitText(JSON.stringify(fixtureProposal()), deps(spying, journal));
    expect(journaledAtSend).toEqual(["commit-u1"]);
  });

  it("keys the journal by content, not by key order or whitespace", async () => {
    const a = await proposalKey({ a: 1, b: [2, 3] });
    expect(await proposalKey(JSON.parse('{ "b": [2,3], "a": 1 }'))).toBe(a);
    expect(await proposalKey({ a: 1, b: [3, 2] })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses to send a proposal with blocks (exit 1, nothing posted, nothing journaled)", async () => {
    const server = fakeServer(fixtureState());
    const journal = memoryJournal();
    const r = await commitText(JSON.stringify({ meals: [] }), deps(server.fetch, journal));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("[schema]");
    expect(server.posted).toEqual([]);
    expect(journal.entries.size).toBe(0);
  });

  it("prints the server's refusal, exits 1 and forgets the op id when the state moved after the local check", async () => {
    const posted: string[] = [];
    const refusing: FetchLike = async (url, init) => {
      if (url.endsWith("/api/history")) { const { appliedOps: _o, ...rest } = fixtureState(); return json(rest); }
      const [op] = JSON.parse(String(init?.body)).ops as { opId: string }[];
      posted.push(op!.opId);
      return json({ results: [{ opId: op!.opId, status: "refused", reason: "Gratin de poireaux au comté : déjà au menu dans les 4 dernières planifications" }], unrecorded: [], snapshot: snapshot(fixtureState(), NOW) });
    };
    const journal = memoryJournal();
    const r = await commitText(JSON.stringify(fixtureProposal()), deps(refusing, journal));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("déjà au menu");
    expect(journal.entries.size).toBe(0);
    await commitText(JSON.stringify(fixtureProposal()), { ...deps(refusing, journal), uuid: () => "second" });
    expect(posted).toEqual(["commit-u1", "commit-second"]); // a stored refusal is never replayed onto a later try
  });
});
