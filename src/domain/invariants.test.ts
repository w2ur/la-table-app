import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { invariantViolations, newViolations, removalCanLeaveShort, stapleSharesByMeal } from "./invariants";
import { applyOp } from "./ops/apply";
import { NOW, P, doubledFixtureProposal, fixtureProposal, fixtureState, op } from "./test-fixtures";
import type { State, StockItem } from "./types";

let s: State;
const run = (type: string, payload: unknown) => {
  const r = applyOp(s, op(type, payload), NOW);
  s = r.state;
  return r.result;
};
const line = (productId: number) => s.shoppingItems.find((l) => l.productId === productId)!;
const item = (productId: number) => s.stockItems.find((i) => i.productId === productId)!;
const codes = () => invariantViolations(s).map((v) => `${v.code} ${v.subject}`);
const plat = (id: number, sourceMealId: number): StockItem => ({
  id, productId: null, label: "plat", qty: null, unit: null, qtyText: null, isLow: false, useBy: null, openedAt: null,
  finishedAt: null, origin: "plat_cuisine", sourceShoppingItemId: null, sourceMealId, createdAt: NOW,
});

beforeEach(() => {
  s = fixtureState();
  run("planning.commit", fixtureProposal());
});

describe("invariantViolations", () => {
  it("finds nothing in a committed planning, after a buy, a cook and a drop", () => {
    expect(codes()).toEqual([]);
    run("shopping.buy", { itemId: line(P.comte).id });
    expect(codes()).toEqual([]);
    run("meal.cook", { mealId: 1, sheet: {} });
    run("meal.drop", { mealId: 2 });
    expect(codes()).toEqual([]);
  });

  it("flags reservations pointing at missing rows", () => {
    s.reservations.push({ id: 50, stockItemId: 99, mealId: 98, qty: 1, unit: "g", releasedAt: null, createdAt: NOW });
    expect(codes()).toEqual(expect.arrayContaining(["reservation_item_missing reservation:50", "reservation_meal_missing reservation:50"]));
  });

  it("flags a live reservation on a finished item, and one for a closed meal", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    const held = s.reservations.filter((r) => r.releasedAt === null);
    item(P.comte).finishedAt = NOW;
    expect(codes()).toEqual(expect.arrayContaining(held.map((r) => `reserved_finished_item reservation:${r.id}`)));
    item(P.comte).finishedAt = null;
    s.meals.find((m) => m.id === held[0]!.mealId)!.cookedAt = NOW;
    expect(codes()).toContain(`reserved_closed_meal reservation:${held[0]!.id}`);
  });

  it("flags an item reserved beyond its quantity, or twice when its quantity is unknown", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    item(P.comte).qty = 150;
    expect(codes()).toContain(`item_over_reserved stock:${item(P.comte).id}`);
    s.stockItems.push(plat(40, 1));
    s.reservations.push({ id: 60, stockItemId: 40, mealId: 1, qty: null, unit: null, releasedAt: null, createdAt: NOW },
      { id: 61, stockItemId: 40, mealId: 2, qty: null, unit: null, releasedAt: null, createdAt: NOW });
    expect(codes()).toContain("item_over_reserved stock:40");
  });

  it("flags an open meal covered short or over its need, per product and unit", () => {
    const comte = line(P.comte);
    comte.forMeals = comte.forMeals.map((f) => (f.mealId === 1 ? { ...f, qty: f.qty - 10 } : f.mealId === 2 ? { ...f, qty: f.qty + 10 } : f));
    expect(codes()).toEqual([`meal_under_covered meal:1|product:${P.comte}|g`, `meal_over_covered meal:2|product:${P.comte}|g`]);
  });

  it("ignores staples: their lines exist only when Reste lacks them", () => {
    line(P.lentilles).forMeals = [];
    expect(codes()).toEqual([]);
  });

  it("flags an open second round whose first round is closed and that holds no plat cuisiné", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = (p.meals as { recipe: number }[]).map((m, i) => (i === 2 ? { ...m, doubled: true } : m));
    run("planning.commit", p);
    s.meals.find((m) => m.id === 3)!.droppedAt = NOW;
    for (const l of s.shoppingItems) l.forMeals = l.forMeals.filter((f) => f.mealId !== 3);
    expect(codes()).toContain("second_round_without_plat meal:4");
    s.stockItems.push(plat(40, 3));
    s.reservations.push({ id: 60, stockItemId: 40, mealId: 4, qty: null, unit: null, releasedAt: null, createdAt: NOW });
    expect(codes()).not.toContain("second_round_without_plat meal:4");
  });

  it("flags a cooked second round whose first round is not cooked", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = (p.meals as { recipe: number }[]).map((m, i) => (i === 2 ? { ...m, doubled: true } : m));
    run("planning.commit", p);
    run("meal.cook", { mealId: 3, sheet: {} });
    run("meal.cook", { mealId: 4, sheet: {} });
    expect(codes()).toEqual([]);
    s.meals.find((m) => m.id === 3)!.cookedAt = null;
    expect(codes()).toContain("second_round_cooked_first meal:4");
  });

  it("flags a dropped meal's share left on an unbought line, but not a cooked meal's", () => {
    run("meal.cook", { mealId: 1, sheet: {} });
    expect(codes()).toEqual([]);
    const creme = line(P.creme);
    s.meals.find((m) => m.id === 1)!.droppedAt = NOW;
    s.meals.find((m) => m.id === 1)!.cookedAt = null;
    expect(codes()).toContain(`dropped_meal_share line:${creme.id}|meal:1`);
  });

  it("flags an open meal's share on a removed line, never a closed meal's", () => {
    run("meal.cook", { mealId: 1, sheet: {} });
    const comte = line(P.comte);
    expect(run("shopping.remove", { itemId: comte.id, reason: "pas_achete" }).status).toBe("applied");
    expect(line(P.comte).forMeals.map((f) => f.mealId)).toEqual([1]);
    expect(codes().filter((c) => !c.startsWith("meal_under_covered"))).toEqual([]);
    s.meals.find((m) => m.id === 1)!.cookedAt = null;
    expect(codes()).toContain(`removed_line_open_share line:${comte.id}|meal:1`);
  });

  // Regression: 91d4533 — a staple share on a removed line was flagged, so a staple line removed after a cook blocked the uncook, though a staple never leaves a meal short
  // since be5d537 a removed staple line keeps no share, so no op leaves one there: the share is put back by hand
  it("never flags an open meal's share on a removed staple line", () => {
    run("meal.cook", { mealId: 2, sheet: {} });
    const lentilles = line(P.lentilles);
    expect(lentilles.kind).toBe("staple_hors_budget");
    const shares = lentilles.forMeals.map((f) => ({ ...f }));
    expect(shares.map((f) => f.mealId)).toContain(2);
    expect(run("shopping.remove", { itemId: lentilles.id, reason: "pas_achete" }).status).toBe("applied");
    line(P.lentilles).forMeals = shares;
    s.meals.find((m) => m.id === 2)!.cookedAt = null;
    expect(codes()).toEqual([]);
  });

  it("flags an emptied line that still costs something", () => {
    const comte = line(P.comte);
    comte.qty = 0;
    expect(codes()).toContain(`empty_line_priced line:${comte.id}`);
  });
});

describe("newViolations", () => {
  it("keeps only what the second state adds, by code and subject", () => {
    const before = structuredClone(s);
    before.reservations.push({ id: 50, stockItemId: 99, mealId: 1, qty: 1, unit: "g", releasedAt: null, createdAt: NOW });
    const after = structuredClone(before);
    after.reservations.push({ id: 51, stockItemId: 99, mealId: 1, qty: 1, unit: "g", releasedAt: null, createdAt: NOW });
    expect(newViolations(before, after).map((v) => `${v.code} ${v.subject}`)).toEqual(["reservation_item_missing reservation:51"]);
  });

  it("flags a staple share on an unbought line beyond what its open meal needs, and nothing at the need", () => {
    s = fixtureState();
    run("planning.commit", doubledFixtureProposal());
    expect(codes()).toEqual([]);
    line(P.lentilles).forMeals = line(P.lentilles).forMeals.map((f) => (f.mealId === 2 ? { ...f, qty: 101 } : f));
    expect(codes()).toEqual([`staple_over_shared meal:2|product:${P.lentilles}|g`]);
  });
});

describe("stapleSharesByMeal", () => {
  /** The per-meal pass staple_over_shared made before it was folded into one pass over the lines. */
  const sharesOf = (state: State, mealId: number): Map<string, number> => {
    const out = new Map<string, number>();
    for (const l of state.shoppingItems.filter((x) => x.boughtAt === null && x.removedAt === null && x.productId !== null && x.unit !== null)) {
      if (!state.products.find((p) => p.id === l.productId)?.isStaple) continue;
      for (const f of l.forMeals.filter((x) => x.mealId === mealId)) out.set(`${l.productId}|${l.unit}`, (out.get(`${l.productId}|${l.unit}`) ?? 0) + f.qty);
    }
    return out;
  };

  // one pass over the lines, accumulated per meal, gives each meal the same shares, in the same order, as one pass per meal
  it("gives every meal the shares a pass over the lines for that meal alone gives", () => {
    s = fixtureState();
    run("planning.commit", doubledFixtureProposal());
    const lineArb = fc.record({
      productId: fc.option(fc.constantFrom(P.lentilles, P.riz, P.oignon, P.comte, P.poireau), { nil: null }),
      unit: fc.option(fc.constantFrom("g" as const, "piece" as const), { nil: null }),
      bought: fc.boolean(),
      removed: fc.boolean(),
      forMeals: fc.array(fc.record({ mealId: fc.integer({ min: 1, max: 6 }), qty: fc.integer({ min: 0, max: 400 }) }), { maxLength: 4 }),
    });
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 8 }), (extra) => {
        const state = structuredClone(s);
        extra.forEach((l, i) => state.shoppingItems.push({
          ...state.shoppingItems[0]!, id: 100 + i, productId: l.productId, unit: l.unit, forMeals: l.forMeals,
          boughtAt: l.bought ? NOW : null, removedAt: l.removed ? NOW : null,
        }));
        const byMeal = stapleSharesByMeal(state);
        for (let mealId = 1; mealId <= 6; mealId++) {
          expect([...(byMeal.get(mealId) ?? new Map<string, number>())]).toEqual([...sharesOf(state, mealId)]);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("removalCanLeaveShort", () => {
  it("holds for a planning line only: an ajout serves no meal, a staple share never leaves one short", () => {
    expect(removalCanLeaveShort({ kind: "planning" })).toBe(true);
    expect(removalCanLeaveShort({ kind: "staple_hors_budget" })).toBe(false);
    expect(removalCanLeaveShort({ kind: "ajout" })).toBe(false);
  });
});
