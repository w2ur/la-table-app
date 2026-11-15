import { describe, expect, it } from "vitest";
import { parseProposal } from "./proposal";
import { resolveProposal } from "./resolve";
import { planShopping } from "./shopping-plan";
import { NOW, P, fixtureProposal, fixtureState } from "./test-fixtures";
import type { State, StockItem } from "./types";

function plan(state: State, input = fixtureProposal()) {
  const parsed = parseProposal(input);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const resolved = resolveProposal(state, parsed.proposal, NOW);
  return planShopping(state, resolved.meals, resolved.productsById, NOW);
}

const stock = (s: Partial<StockItem> & Pick<StockItem, "id" | "label">): StockItem => ({
  productId: null, qty: null, unit: null, qtyText: null, isLow: false, useBy: null, openedAt: null, finishedAt: null,
  origin: "achat", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW, ...s,
});

describe("planShopping", () => {
  it("aggregates the cheese story into one 200 g comté line serving two meals", () => {
    const p = plan(fixtureState());
    const comte = p.lines.find((l) => l.productId === P.comte)!;
    expect(comte).toMatchObject({ qty: 200, unit: "g", kind: "planning" });
    expect(comte.forMeals).toEqual([{ mealIndex: 0, qty: 100 }, { mealIndex: 1, qty: 100 }]);
  });

  it("puts staples on the list hors budget only when Reste lacks them or they are low", () => {
    const empty = plan(fixtureState());
    expect(empty.lines.find((l) => l.productId === P.lentilles)).toMatchObject({ kind: "staple_hors_budget", qty: 250 });
    const s = fixtureState();
    s.stockItems.push(stock({ id: 1, label: "lentilles vertes", productId: P.lentilles, qtyText: "un bocal" }));
    expect(plan(s).lines.find((l) => l.productId === P.lentilles)).toBeUndefined();
    s.stockItems[0]!.isLow = true;
    expect(plan(s).lines.find((l) => l.productId === P.lentilles)).toMatchObject({ kind: "staple_hors_budget" });
  });

  // Regression: 805246e — a staple whose only Reste item was at a known 0 still read as held, so planning #4 put no lait on Courses
  it("buys a staple whose every Reste item is at a known 0, not one of unknown quantity", () => {
    const s = fixtureState();
    s.stockItems.push(stock({ id: 1, label: "lentilles vertes", productId: P.lentilles, qty: 0, unit: "g" }));
    expect(plan(s).lines.find((l) => l.productId === P.lentilles)).toMatchObject({ kind: "staple_hors_budget", qty: 250 });
    s.stockItems.push(stock({ id: 2, label: "lentilles vertes", productId: P.lentilles, qtyText: "0" }));
    expect(plan(s).lines.find((l) => l.productId === P.lentilles)).toBeUndefined();
  });

  it("reserves libre stock before buying, earliest use-by first, and flags the meal to cook early", () => {
    const s = fixtureState();
    s.stockItems.push(
      stock({ id: 1, label: "comté", productId: P.comte, qty: 150, unit: "g", useBy: "2026-10-30" }),
      stock({ id: 2, label: "comté", productId: P.comte, qty: 30, unit: "g", useBy: "2026-10-14" }),
    );
    const p = plan(s);
    expect(p.reservations.filter((r) => r.mealIndex === 0)).toEqual([
      { mealIndex: 0, stockItemId: 2, qty: 30, unit: "g", reliesOnUnknownQty: false },
      { mealIndex: 0, stockItemId: 1, qty: 70, unit: "g", reliesOnUnknownQty: false },
    ]);
    expect(p.reservations.filter((r) => r.mealIndex === 1)).toEqual([
      { mealIndex: 1, stockItemId: 1, qty: 80, unit: "g", reliesOnUnknownQty: false },
    ]);
    expect(p.lines.find((l) => l.productId === P.comte)).toMatchObject({ qty: 20, forMeals: [{ mealIndex: 1, qty: 20 }] });
    expect(p.cookEarly.get(0)).toBe("comté à utiliser avant mercredi 14");
  });

  it("lets an unknown-quantity item cover one meal only, and marks it", () => {
    const s = fixtureState();
    s.stockItems.push(stock({ id: 1, label: "crème fraîche", productId: P.creme, qtyText: "un fond" }));
    const p = plan(s);
    expect(p.reservations).toContainEqual({ mealIndex: 0, stockItemId: 1, qty: 100, unit: "ml", reliesOnUnknownQty: true });
    expect(p.lines.find((l) => l.productId === P.creme)).toBeUndefined();
  });

  it("buys twice the quantity for a doubled meal", () => {
    const input = fixtureProposal();
    input.meals = [{ recipe: 1, portions: 2, doubled: true }];
    const p = plan(fixtureState(), input);
    expect(p.lines.find((l) => l.productId === P.saumon)).toMatchObject({ qty: 500 });
  });
});

describe("planShopping with packs", () => {
  const withPack = (s: State, productId: number, qty: number): State => {
    s.products.find((p) => p.id === productId)!.pack = { qty, unit: "g" };
    return s;
  };

  it("rounds a line up to whole packs once, after summing the planning's meals", () => {
    const p = plan(withPack(fixtureState(), P.comte, 250));
    const comte = p.lines.find((l) => l.productId === P.comte)!;
    expect(comte).toMatchObject({ qty: 250, unit: "g" });
    expect(comte.forMeals).toEqual([{ mealIndex: 0, qty: 100 }, { mealIndex: 1, qty: 100 }]);
  });

  it("rounds a staple line too", () => {
    const p = plan(withPack(fixtureState(), P.lentilles, 500));
    expect(p.lines.find((l) => l.productId === P.lentilles)).toMatchObject({ kind: "staple_hors_budget", qty: 500 });
  });

  it("leaves a line exact when the pack is in another unit", () => {
    const s = fixtureState();
    s.products.find((p) => p.id === P.creme)!.pack = { qty: 1, unit: "piece" };
    expect(plan(s).lines.find((l) => l.productId === P.creme)).toMatchObject({ qty: 100, unit: "ml" });
  });

  it("takes a meal's need from the spare of an unbought line before adding a line, once", () => {
    const s = withPack(fixtureState(), P.comte, 250);
    s.meals.push({ id: 90, planningId: 1, recipeId: 4, portions: 2, doubledFrom: null, cookEarlyReason: null, cookedAt: null, droppedAt: null, verdict: null, note: null });
    s.shoppingItems.push({ id: 70, productId: P.comte, label: "comté", qty: 250, unit: "g", plannedQty: null, estPriceCents: 420, kind: "planning", planningId: 1,
      forMeals: [{ mealId: 90, qty: 100 }], isFood: true, boughtAt: null, tripId: null, removedAt: null, createdAt: NOW });
    const p = plan(s);
    // 150 g spare: the gratin takes 100 g, the salade the last 50 g and rounds a new pack for its other 50 g
    expect(p.spares).toEqual([{ lineId: 70, mealIndex: 0, qty: 100 }, { lineId: 70, mealIndex: 1, qty: 50 }]);
    expect(p.lines.find((l) => l.productId === P.comte)).toMatchObject({ qty: 250, forMeals: [{ mealIndex: 1, qty: 50 }] });
  });

  it("takes no spare from a bought, removed or staple line", () => {
    for (const over of [{ boughtAt: NOW }, { removedAt: NOW }, { kind: "staple_hors_budget" as const }]) {
      const s = withPack(fixtureState(), P.comte, 250);
      s.shoppingItems.push({ id: 70, productId: P.comte, label: "comté", qty: 250, unit: "g", plannedQty: null, estPriceCents: 420, kind: "planning", planningId: 1,
        forMeals: [], isFood: true, boughtAt: null, tripId: null, removedAt: null, createdAt: NOW, ...over });
      expect(plan(s).spares, JSON.stringify(over)).toEqual([]);
    }
  });
});
