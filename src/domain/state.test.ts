import { describe, expect, it } from "vitest";
import { cloneState, diffStates, emptyState, nextId, recordIssuedIds, stableStringify } from "./state";
import type { Envie, Row } from "./types";

const envie = (id: number, text: string): Envie => ({
  id, text, url: null, createdAt: "2026-10-12T10:00:00Z", status: "ouverte", mealId: null,
});

const row = (id: number): Row => ({ id });

describe("state helpers", () => {
  it("nextId is max + 1, and 1 on an empty table", () => {
    const s = emptyState();
    expect(nextId(s, "envies")).toBe(1);
    s.envies = [envie(3, "a"), envie(7, "b")];
    expect(nextId(s, "envies")).toBe(8);
  });

  it("nextId stays above every id the table issued, rows deleted since included, and recordIssuedIds only raises it", () => {
    const s = emptyState();
    s.envies = [envie(3, "a")];
    recordIssuedIds(s, [{ table: "envies", id: 9, before: null, after: row(9) }]);
    expect(nextId(s, "envies")).toBe(10);
    recordIssuedIds(s, [{ table: "envies", id: 4, before: null, after: row(4) }, { table: "envies", id: 12, before: row(12), after: null }]);
    expect(s.lastIds).toEqual({ envies: 9 });
    expect(nextId(s, "trips")).toBe(1);
  });

  it("stableStringify ignores key order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: null }] })).toBe(
      stableStringify({ a: [2, { c: null, d: 1 }], b: 1 }),
    );
  });

  it("diffStates reports inserts, updates and deletes per row", () => {
    const a = emptyState();
    a.envies.push(envie(1, "poireaux"), envie(2, "curry"));
    const b = cloneState(a);
    b.envies[0]!.status = "placee";
    b.envies.splice(1, 1);
    b.envies.push(envie(3, "soupe"));
    const changes = diffStates(a, b);
    expect(changes.map((c) => [c.table, c.id, c.before === null, c.after === null])).toEqual([
      ["envies", 1, false, false],
      ["envies", 3, true, false],
      ["envies", 2, false, true],
    ]);
  });

  it("cloneState does not share rows with the original", () => {
    const a = emptyState();
    a.envies.push(envie(1, "x"));
    const b = cloneState(a);
    b.envies[0]!.text = "y";
    expect(a.envies[0]!.text).toBe("x");
  });
});
