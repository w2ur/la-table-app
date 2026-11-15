import { describe, expect, it } from "vitest";
import { applyOp } from "./apply";
import { NOW, P, R, fixtureProposal, fixtureState, op, secondProposal } from "../test-fixtures";

describe("planning.commit", () => {
  it("creates the planning, its meals, Courses lines and reservations", () => {
    const s0 = fixtureState();
    s0.stockItems.push({ id: 1, productId: P.creme, label: "crème fraîche", qty: 200, unit: "ml", qtyText: null, isLow: false,
      useBy: "2026-10-14", openedAt: null, finishedAt: null, origin: "achat", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
    const { state, result, changes } = applyOp(s0, op("planning.commit", fixtureProposal()), NOW);
    expect(result).toEqual({ status: "applied", reason: null });
    expect(state.plannings).toHaveLength(1);
    expect(state.plannings[0]).toMatchObject({ mealsAdded: 3, budgetCents: 3000, estimateCents: 280 + 500 + 260 + 650 });
    expect(state.meals.map((m) => m.recipeId)).toEqual([R.gratin, R.salade, R.saumonLentilles]);
    expect(state.meals[0]!.cookEarlyReason).toBe("crème fraîche à utiliser avant mercredi 14");
    const comte = state.shoppingItems.find((l) => l.productId === P.comte)!;
    expect(comte).toMatchObject({ qty: 200, kind: "planning", estPriceCents: 500, forMeals: [{ mealId: 1, qty: 100 }, { mealId: 2, qty: 100 }] });
    expect(state.reservations).toEqual([{ id: 1, stockItemId: 1, mealId: 1, qty: 100, unit: "ml", releasedAt: null, createdAt: NOW }]);
    expect(changes.length).toBeGreaterThan(0);
  });

  it("creates two meals for a doubled recipe, the second pointing at the first", () => {
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.poulet, portions: 2, doubled: true }];
    p.prices = [...(p.prices as unknown[]), { product: "filet de poulet", unit: "g", est_price_cents: 900 }];
    const { state } = applyOp(fixtureState(), op("planning.commit", p), NOW);
    const [first, second] = state.meals.filter((m) => m.recipeId === R.poulet);
    expect(second!.doubledFrom).toBe(first!.id);
    expect(state.shoppingItems.find((l) => l.productId === P.poulet)!.qty).toBe(600);
  });

  it("refuses with the blocking reasons and changes nothing", () => {
    const p = fixtureProposal();
    p.meals = [{ recipe: R.gratin, portions: 2, doubled: false }];
    const s0 = fixtureState();
    const { state, result, changes } = applyOp(s0, op("planning.commit", p), NOW);
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("légumineuses");
    expect(changes).toEqual([]);
    expect(state.plannings).toEqual([]);
  });

  it("marks placed envies and kept envies", () => {
    const s0 = fixtureState();
    s0.envies.push({ id: 1, text: "gratin", url: null, createdAt: NOW, status: "ouverte", mealId: null },
      { id: 2, text: "curry", url: null, createdAt: NOW, status: "ouverte", mealId: null });
    const p = fixtureProposal();
    p.envies = { placed: [{ envie_id: 1, meal_index: 0 }], kept: [2] };
    const { state } = applyOp(s0, op("planning.commit", p), NOW);
    expect(state.envies.map((e) => [e.status, e.mealId])).toEqual([["placee", 1], ["gardee", null]]);
  });

  it("appends a share taken from another line's spare to that line, leaving its qty, price and planning", () => {
    let s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
    s = applyOp(s, op("planning.commit", fixtureProposal()), NOW).state; // comté line: 250 g for 200 g of shares
    const line = s.shoppingItems.find((l) => l.productId === P.comte)!;
    const before = { qty: line.qty, estPriceCents: line.estPriceCents, planningId: line.planningId };
    const second = applyOp(s, op("planning.commit", secondProposal()), NOW); // 100 g comté: 50 g spare, 50 g new
    expect(second.result.status).toBe("applied");
    const after = second.state.shoppingItems.find((l) => l.id === line.id)!;
    expect({ qty: after.qty, estPriceCents: after.estPriceCents, planningId: after.planningId }).toEqual(before);
    const newMeal = second.state.meals.at(-1)!;
    expect(after.forMeals).toContainEqual({ mealId: newMeal.id, qty: 50 });
    expect(second.state.shoppingItems.filter((l) => l.productId === P.comte && l.id !== line.id)).toEqual([expect.objectContaining({ qty: 250, forMeals: [{ mealId: newMeal.id, qty: 50 }] })]);
  });
});
