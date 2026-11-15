import { describe, expect, it } from "vitest";
import { libreQty, mealMultiplier, recipeNeeds, sharedQty } from "./quantities";
import type { Meal, StockItem } from "./types";

const meal = (id: number, doubledFrom: number | null = null): Meal => ({
  id, planningId: 1, recipeId: 1, portions: 2, doubledFrom, cookEarlyReason: null, cookedAt: null, droppedAt: null, verdict: null, note: null,
});

describe("recipeNeeds", () => {
  it("scales and merges ingredients of the same product and unit", () => {
    const needs = recipeNeeds(
      [
        { id: 1, recipeId: 1, productId: 1, qty: 100, unit: "g", note: null },
        { id: 2, recipeId: 1, productId: 1, qty: 50, unit: "g", note: null },
        { id: 3, recipeId: 1, productId: 2, qty: 1, unit: "piece", note: null },
      ],
      2, 3, 1,
    );
    expect(needs).toEqual([{ productId: 1, unit: "g", qty: 225 }, { productId: 2, unit: "piece", qty: 2 }]);
  });
  it("doubles for the first round of a cook-once-eat-twice", () => {
    expect(recipeNeeds([{ id: 1, recipeId: 1, productId: 1, qty: 100, unit: "g", note: null }], 2, 2, 2))
      .toEqual([{ productId: 1, unit: "g", qty: 200 }]);
  });
});

describe("mealMultiplier", () => {
  it("is 2 for a first round, 0 for a second round, 1 otherwise", () => {
    const meals = [meal(1), meal(2, 1), meal(3)];
    expect(mealMultiplier(meals[0]!, meals)).toBe(2);
    expect(mealMultiplier(meals[1]!, meals)).toBe(0);
    expect(mealMultiplier(meals[2]!, meals)).toBe(1);
  });
});

describe("libreQty", () => {
  const item = { id: 1, qty: 250, unit: "g" } as StockItem;
  it("subtracts unreleased reservations of the same unit", () => {
    expect(libreQty(item, [
      { stockItemId: 1, qty: 100, unit: "g", releasedAt: null },
      { stockItemId: 1, qty: 100, unit: "g", releasedAt: "2026-10-12T10:00:00Z" },
      { stockItemId: 2, qty: 999, unit: "g", releasedAt: null },
    ])).toBe(150);
  });
  it("is unknown when quantities or units don't line up", () => {
    expect(libreQty({ ...item, qty: null }, [])).toBeNull();
    expect(libreQty(item, [{ stockItemId: 1, qty: 1, unit: "piece", releasedAt: null }])).toBeNull();
  });
});

describe("sharedQty", () => {
  it("sums a line's shares, 0 without any", () => {
    expect(sharedQty({ forMeals: [{ qty: 200 }, { qty: 50 }] })).toBe(250);
    expect(sharedQty({ forMeals: [] })).toBe(0);
  });
});
