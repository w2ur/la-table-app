import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recipeNutrition } from "./nutrition";
import type { Nutrients, Product } from "./types";

const nutrientsArb: fc.Arbitrary<Nutrients> = fc.record({
  kcal: fc.double({ min: 0, max: 900, noNaN: true, noDefaultInfinity: true }),
  proteinG: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  carbsG: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  fatG: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  fibreG: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  saltG: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
});

const factor = fc.option(fc.double({ min: 0.1, max: 5, noNaN: true, noDefaultInfinity: true }), { nil: null });
const ediblePct = fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true });

const productArb = (id: number): fc.Arbitrary<Product> =>
  fc.record({
    nutrition: fc.option(
      fc.record({ ciqualCode: fc.constant("T0001"), per100g: nutrientsArb, gramsPerPiece: factor, gramsPerMl: factor, ediblePct }),
      { nil: null },
    ),
  }).map(({ nutrition }) => ({
    id, name: `produit-${id}`, category: "epicerie", isStaple: false, roles: [], isFreshProduce: false, seasonMonths: null,
    shelfLifeDays: null, openedShelfLifeDays: null, defaultUnit: "g", nutrition, pack: null, price: null,
  }));

const productsArb = fc.tuple(productArb(1), productArb(2), productArb(3), productArb(4));
const ingredientsArb = fc.array(
  fc.record({
    productId: fc.integer({ min: 1, max: 5 }),
    qty: fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
    unit: fc.constantFrom("g", "ml", "piece" as const),
  }),
  { maxLength: 8 },
);
const portionsArb = fc.integer({ min: 1, max: 12 });
const TOLERANCE = 1e-6;

describe("recipeNutrition properties", () => {
  it("doubling every quantity and the base portions leaves the per-portion values unchanged", () => {
    fc.assert(
      fc.property(productsArb, ingredientsArb, portionsArb, (products, ingredients, portions) => {
        const a = recipeNutrition(ingredients, portions, products);
        const b = recipeNutrition(ingredients.map((i) => ({ ...i, qty: i.qty * 2 })), portions * 2, products);
        expect(b === null).toBe(a === null);
        if (a && b) {
          for (const k of Object.keys(a.perPortion) as (keyof Nutrients)[]) {
            expect(Math.abs(a.perPortion[k] - b.perPortion[k])).toBeLessThan(TOLERANCE);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("halving every edible share halves every per-portion value of g and piece ingredients", () => {
    fc.assert(
      fc.property(productsArb, ingredientsArb.map((l) => l.map((i) => ({ ...i, unit: i.unit === "ml" ? ("g" as const) : i.unit }))), portionsArb, (products, ingredients, portions) => {
        const halved = products.map((p) => (p.nutrition ? { ...p, nutrition: { ...p.nutrition, ediblePct: (p.nutrition.ediblePct ?? 100) / 2 } } : p));
        const a = recipeNutrition(ingredients, portions, products);
        const b = recipeNutrition(ingredients, portions, halved);
        expect(b === null).toBe(a === null);
        if (a && b) {
          for (const k of Object.keys(a.perPortion) as (keyof Nutrients)[]) {
            expect(Math.abs(a.perPortion[k] / 2 - b.perPortion[k])).toBeLessThan(TOLERANCE);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("never yields a negative value", () => {
    fc.assert(
      fc.property(productsArb, ingredientsArb, portionsArb, (products, ingredients, portions) => {
        const r = recipeNutrition(ingredients, portions, products);
        if (r) for (const v of Object.values(r.perPortion)) expect(v).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1000 },
    );
  });

  it("accounts for every ingredient's product: counted or missing, none lost", () => {
    fc.assert(
      fc.property(productsArb, ingredientsArb, portionsArb, (products, ingredients, portions) => {
        const r = recipeNutrition(ingredients, portions, products);
        const names = new Set(ingredients.map((i) => products.find((p) => p.id === i.productId)?.name ?? `produit ${i.productId}`));
        const counted = ingredients
          .filter((i) => {
            const n = products.find((p) => p.id === i.productId)?.nutrition;
            return n && (i.unit === "g" || (i.unit === "ml" ? n.gramsPerMl !== null : n.gramsPerPiece !== null));
          })
          .map((i) => products.find((p) => p.id === i.productId)!.name);
        if (r === null) {
          expect(counted).toEqual([]);
          return;
        }
        // A product can be counted through one ingredient and missing through another.
        expect(new Set([...r.missing, ...counted])).toEqual(names);
      }),
      { numRuns: 1000 },
    );
  });
});
