import { describe, expect, it } from "vitest";
import { HANDLERS, applyOp } from "./apply";
import { NOW, P, fixtureProposal, fixtureState, op } from "../test-fixtures";

describe("applyOp envelope", () => {
  it("refuses a malformed envelope without recording it", () => {
    const r = applyOp(fixtureState(), { type: "envie.add" }, NOW);
    expect(r.result).toEqual({ status: "refused", reason: "opération mal formée" });
    expect(r.records).toEqual([]);
  });

  // Regression: 5498286 — a resent op always answered noop « déjà reçue », so a phone retrying its outbox never saw the refusal
  it("refuses an unknown type and records it, so a resend gives back the same refusal and changes nothing", () => {
    const o = op("menu.teleport", {});
    const first = applyOp(fixtureState(), o, NOW);
    expect(first.result).toEqual({ status: "refused", reason: "opération inconnue" });
    const again = applyOp(first.state, o, NOW);
    expect(again.result).toEqual({ status: "refused", reason: "opération inconnue" });
    expect(again.records).toEqual([]);
    expect(again.state).toBe(first.state);
  });

  it("answers a resent op with what it got the first time, applied or refused with its reason", () => {
    const add = op("envie.add", { text: "soupe", url: null });
    const s1 = applyOp(fixtureState(), add, NOW).state;
    expect(applyOp(s1, add, NOW).result).toEqual({ status: "applied", reason: null });
    expect(applyOp(s1, add, NOW).state.envies).toHaveLength(1);
    const target = op("undo", { targetOpId: add.opId });
    const s2 = applyOp(s1, target, NOW).state;
    const again = op("undo", { targetOpId: add.opId });
    const s3 = applyOp(s2, again, NOW).state;
    expect(applyOp(s3, again, NOW).result).toEqual({ status: "refused", reason: "déjà annulée" });
  });

  it("clamps a future client time to the server time", () => {
    const r = applyOp(fixtureState(), op("envie.add", { text: "x", url: null }, "2030-01-01T00:00:00Z"), NOW);
    expect(r.state.envies[0]!.createdAt).toBe(NOW);
  });
});

describe("a handler that throws", () => {
  // Regression: e53e00b — a throw inside a handler was recorded as refused « erreur interne », so every resend replayed the refusal even after the bug was fixed
  it("refuses the op without recording it, so a resend is applied once the handler works", () => {
    const add = op("envie.add", { text: "soupe", url: null });
    const real = HANDLERS["envie.add"]!;
    HANDLERS["envie.add"] = () => { throw new Error("boum"); };
    let thrown;
    try {
      thrown = applyOp(fixtureState(), add, NOW);
    } finally {
      HANDLERS["envie.add"] = real;
    }
    expect(thrown.result).toEqual({ status: "refused", reason: "erreur interne : boum" });
    expect(thrown.records).toEqual([]);
    expect(thrown.state.appliedOps[add.opId]).toBeUndefined();
    expect(applyOp(thrown.state, add, NOW).result).toEqual({ status: "applied", reason: null });
  });
});

describe("op time", () => {
  // Regression: b8b8ece — a client time was stored as sent, so an offset or a free-text date broke the string order of timestamps
  it("stores the client time as ISO UTC, so an offset time sorts by the instant it names", () => {
    const paris = applyOp(fixtureState(), op("envie.add", { text: "soupe", url: null }, "2026-10-12T11:30:00+02:00"), NOW);
    const utc = applyOp(paris.state, op("envie.add", { text: "curry", url: null }, "2026-10-12T09:45:00Z"), NOW);
    const [first, second] = utc.state.envies;
    expect(first!.createdAt).toBe("2026-10-12T09:30:00.000Z");
    expect(second!.createdAt).toBe("2026-10-12T09:45:00.000Z");
    expect(first!.createdAt < second!.createdAt).toBe(true);
  });

  // Regression: b8b8ece — a date-only or free-text « at » passed Date.parse and was stored as sent
  it("refuses an op whose time is not a full ISO-8601 date-time with an offset", () => {
    for (const at of ["2026-10-12", "Oct 12 2026", "2026-10-12T09:00:00", "2026-10-12 09:00:00Z", "2026-13-40T09:00:00Z"]) {
      const r = applyOp(fixtureState(), op("envie.add", { text: "x", url: null }, at), NOW);
      expect({ at, result: r.result, records: r.records }).toEqual({ at, result: { status: "refused", reason: "opération mal formée" }, records: [] });
    }
  });

  // Regression: fd3adfe — a year before 1000 passed the envelope, parisDate gave « 999-06-01 » and addDays threw, so the op was refused as « erreur interne » instead of malformed
  it("refuses as malformed a time outside a four-digit year or whose calendar fields do not exist as written", () => {
    for (const at of ["0999-06-01T00:00:00Z", "1999-12-31T23:00:00Z", "0000-01-01T00:00:00+14:00", "2026-10-12T24:00:00Z", "2026-02-31T09:00:00Z", "2026-02-29T09:00:00Z"]) {
      const r = applyOp(fixtureState(), op("envie.add", { text: "x", url: null }, at), NOW);
      expect({ at, result: r.result, records: r.records }).toEqual({ at, result: { status: "refused", reason: "opération mal formée" }, records: [] });
    }
  });

  it("still takes a real time near the edges: a leap day, an offset that crosses midnight", () => {
    for (const at of ["2024-02-29T09:00:00Z", "2026-10-12T00:30:00+02:00", "2000-01-01T00:00:00Z"]) {
      expect({ at, status: applyOp(fixtureState(), op("envie.add", { text: "x", url: null }, at), NOW).result.status }).toEqual({ at, status: "applied" });
    }
  });

  it("refuses as malformed a shopping.buy dated before year 1000 instead of failing inside the handler", () => {
    const s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    const line = s.shoppingItems.find((l) => l.productId === P.comte)!;
    const r = applyOp(s, op("shopping.buy", { itemId: line.id }, "0999-06-01T00:00:00Z"), NOW);
    expect({ result: r.result, records: r.records }).toEqual({ result: { status: "refused", reason: "opération mal formée" }, records: [] });
  });
});

describe("op type lookup", () => {
  // Regression: 25eb278 — an op type naming an Object.prototype member (« constructor », « toString ») was looked up as a handler
  it("refuses an op type that names an Object.prototype member as unknown", () => {
    for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const r = applyOp(fixtureState(), op(type, {}), NOW);
      expect({ type, result: r.result }).toEqual({ type, result: { status: "refused", reason: "opération inconnue" } });
    }
  });
});

describe("an op id that names an Object.prototype key", () => {
  // Regression: 8242232 — an op id of "constructor" was read off Object.prototype as a stored op, so it was never applied nor recorded
  it.each(["constructor", "toString", "__proto__"])("applies and records %s, and a resend replays it", (opId) => {
    const add = { ...op("envie.add", { text: `soupe ${opId}`, url: null }), opId };
    const first = applyOp(fixtureState(), add, NOW);
    expect(first.result).toEqual({ status: "applied", reason: null });
    expect(first.records.map((r) => r.opId)).toEqual([opId]);
    expect(Object.hasOwn(first.state.appliedOps, opId)).toBe(true);
    expect(Object.getPrototypeOf(first.state.appliedOps)).toBe(Object.prototype);
    const again = applyOp(first.state, add, NOW);
    expect(again.result).toEqual({ status: "applied", reason: null });
    expect(again.records).toEqual([]);
    expect(again.state.envies).toHaveLength(1);
    // a later op clones the state: the own key must survive the copy
    const later = applyOp(first.state, op("envie.add", { text: "autre", url: null }), NOW).state;
    expect(applyOp(later, add, NOW).records).toEqual([]);
  });

  it("undoes a target whose id is a prototype key, and refuses an unknown one as unknown", () => {
    const add = { ...op("envie.add", { text: "soupe", url: null }), opId: "constructor" };
    expect(applyOp(fixtureState(), op("undo", { targetOpId: "valueOf" }), NOW).result).toEqual({ status: "refused", reason: "action introuvable" });
    const s1 = applyOp(fixtureState(), add, NOW).state;
    const undone = applyOp(s1, op("undo", { targetOpId: "constructor" }), NOW);
    expect(undone.result).toEqual({ status: "applied", reason: null });
    expect(undone.state.envies).toHaveLength(0);
    expect(undone.records.map((r) => r.opId)).toContain("constructor");
  });
});
