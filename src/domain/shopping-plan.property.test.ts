import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recipeNeeds } from "./quantities";
import { resolveProposal } from "./resolve";
import { planShopping } from "./shopping-plan";
import { NOW, fixtureState } from "./test-fixtures";
import type { Proposal } from "./proposal";

const mealArb = fc.record({
  recipe: fc.integer({ min: 1, max: 5 }),
  portions: fc.integer({ min: 1, max: 6 }),
  doubled: fc.boolean(),
});
const stockArb = fc.array(
  fc.record({ productId: fc.integer({ min: 1, max: 11 }), qty: fc.option(fc.integer({ min: 0, max: 800 }), { nil: null }) }),
  { maxLength: 6 },
);

describe("planShopping properties", () => {
  it("conserves quantities: for every non-staple (product, unit), bought + reserved = needed", () => {
    fc.assert(
      fc.property(fc.array(mealArb, { minLength: 1, maxLength: 8 }), stockArb, (meals, stock) => {
        const state = fixtureState();
        stock.forEach((s, i) => {
          const product = state.products.find((p) => p.id === s.productId)!;
          state.stockItems.push({
            id: i + 1, productId: s.productId, label: product.name, qty: s.qty, unit: s.qty === null ? null : product.defaultUnit,
            qtyText: null, isLow: false, useBy: null, openedAt: null, finishedAt: null, origin: "achat",
            sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW,
          });
        });
        const proposal = { params: { portions: 2, red_meat_requested: false, constraints: "" }, new_products: [], new_recipes: [],
          meals, prices: [], envies: { placed: [], kept: [] } } as Proposal;
        const resolved = resolveProposal(state, proposal, NOW);
        const plan = planShopping(state, resolved.meals, resolved.productsById, NOW);

        const needed = new Map<string, number>();
        for (const m of resolved.meals) {
          for (const n of recipeNeeds(m.ingredients, m.recipe.basePortions, m.portions, m.doubled ? 2 : 1)) {
            if (resolved.productsById.get(n.productId)!.isStaple) continue;
            const key = `${n.productId}|${n.unit}`;
            needed.set(key, (needed.get(key) ?? 0) + n.qty);
          }
        }
        const covered = new Map<string, number>();
        for (const l of plan.lines.filter((l) => l.kind === "planning")) {
          const key = `${l.productId}|${l.unit}`;
          covered.set(key, (covered.get(key) ?? 0) + l.qty);
        }
        for (const r of plan.reservations) {
          const item = state.stockItems.find((s) => s.id === r.stockItemId)!;
          const key = `${item.productId}|${r.unit}`;
          covered.set(key, (covered.get(key) ?? 0) + (r.qty ?? 0));
        }
        expect(covered).toEqual(needed);
        for (const l of plan.lines) expect(Number.isInteger(l.qty) && l.qty > 0).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("never reserves more than a known-quantity item holds", () => {
    fc.assert(
      fc.property(fc.array(mealArb, { minLength: 1, maxLength: 8 }), fc.integer({ min: 0, max: 500 }), (meals, qty) => {
        const state = fixtureState();
        state.stockItems.push({ id: 1, productId: 2, label: "comté", qty, unit: "g", qtyText: null, isLow: false, useBy: null,
          openedAt: null, finishedAt: null, origin: "achat", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
        const proposal = { params: { portions: 2, red_meat_requested: false, constraints: "" }, new_products: [], new_recipes: [],
          meals, prices: [], envies: { placed: [], kept: [] } } as Proposal;
        const resolved = resolveProposal(state, proposal, NOW);
        const plan = planShopping(state, resolved.meals, resolved.productsById, NOW);
        const reserved = plan.reservations.filter((r) => r.stockItemId === 1).reduce((s, r) => s + (r.qty ?? 0), 0);
        expect(reserved).toBeLessThanOrEqual(qty);
      }),
      { numRuns: 1000 },
    );
  });

  it("with packs, every line covers its shares, in whole packs, less than one pack over", () => {
    fc.assert(
      fc.property(fc.array(mealArb, { minLength: 1, maxLength: 8 }), fc.integer({ min: 1, max: 500 }), (meals, size) => {
        const state = fixtureState();
        for (const p of state.products) p.pack = { qty: size, unit: p.defaultUnit };
        const proposal = { params: { portions: 2, red_meat_requested: false, constraints: "" }, new_products: [], new_recipes: [],
          meals, prices: [], envies: { placed: [], kept: [] } } as Proposal;
        const resolved = resolveProposal(state, proposal, NOW);
        const plan = planShopping(state, resolved.meals, resolved.productsById, NOW);
        for (const l of plan.lines) {
          const shares = l.forMeals.reduce((n, f) => n + f.qty, 0);
          expect(l.qty).toBeGreaterThanOrEqual(shares);
          expect(l.qty % size).toBe(0);
          expect(l.qty - shares).toBeLessThan(size);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
