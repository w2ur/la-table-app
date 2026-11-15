import { describe, expect, it } from "vitest";
import { gramsOf, recipeNutrition } from "./nutrition";
import type { Nutrients, Product, ProductNutrition } from "./types";

const per100g = (kcal: number): Nutrients => ({ kcal, proteinG: 1, carbsG: 2, fatG: 3, fibreG: 4, saltG: 0.5 });

const nutrition = (kcal: number, extra: Partial<ProductNutrition> = {}): ProductNutrition => ({
  ciqualCode: "T0001", per100g: per100g(kcal), gramsPerPiece: null, gramsPerMl: null, ediblePct: 100, ...extra,
});

const product = (id: number, name: string, n: ProductNutrition | null): Product => ({
  id, name, category: "epicerie", isStaple: false, roles: [], isFreshProduce: false, seasonMonths: null,
  shelfLifeDays: null, openedShelfLifeDays: null, defaultUnit: "g", nutrition: n, pack: null, price: null,
});

const poireau = product(1, "poireau", nutrition(30));
const oeuf = product(2, "œuf", nutrition(140, { gramsPerPiece: 55 }));
const huile = product(3, "huile", nutrition(900, { gramsPerMl: 0.92 }));

describe("gramsOf", () => {
  it("converts by unit and refuses a missing conversion", () => {
    expect(gramsOf(400, "g", nutrition(1))).toBe(400);
    expect(gramsOf(2, "piece", nutrition(1, { gramsPerPiece: 55 }))).toBe(110);
    expect(gramsOf(10, "ml", nutrition(1, { gramsPerMl: 0.5 }))).toBe(5);
    expect(gramsOf(2, "piece", nutrition(1))).toBeNull();
    expect(gramsOf(10, "ml", nutrition(1))).toBeNull();
  });
});

describe("recipeNutrition", () => {
  it("sums grams and pieces, then divides by the base portions", () => {
    const r = recipeNutrition(
      [{ productId: 1, qty: 400, unit: "g" }, { productId: 2, qty: 2, unit: "piece" }], 2, [poireau, oeuf],
    );
    expect(r!.perPortion.kcal).toBeCloseTo(137, 9);
    expect(r!.missing).toEqual([]);
  });

  it("converts millilitres through the density", () => {
    const r = recipeNutrition([{ productId: 3, qty: 20, unit: "ml" }], 1, [huile]);
    expect(r!.perPortion.kcal).toBeCloseTo(165.6, 9);
  });

  it("counts only the edible share of the bought weight, for g and piece, never ml", () => {
    const moules = product(6, "moules", nutrition(80, { ediblePct: 25 }));
    expect(recipeNutrition([{ productId: 6, qty: 1000, unit: "g" }], 2, [moules])!.perPortion.kcal).toBeCloseTo(100, 9);
    const piece = product(7, "banane", nutrition(90, { gramsPerPiece: 150, ediblePct: 65 }));
    expect(recipeNutrition([{ productId: 7, qty: 2, unit: "piece" }], 1, [piece])!.perPortion.kcal).toBeCloseTo(175.5, 9);
    // a volume has no bought-weight share: ml counted in full whatever edible_pct
    const ml = product(8, "bouillon", nutrition(50, { gramsPerMl: 1, ediblePct: 50 }));
    expect(recipeNutrition([{ productId: 8, qty: 200, unit: "ml" }], 1, [ml])!.perPortion.kcal).toBeCloseTo(100, 9);
  });

  // Regression: 65f6ab6 — a nutrition stored before edible_pct has no share and must count as 100, never NaN
  it("counts a stored nutrition without ediblePct as 100", () => {
    const { ediblePct: _share, ...legacy } = nutrition(80);
    const old = product(9, "ancien", legacy);
    const r = recipeNutrition([{ productId: 9, qty: 500, unit: "g" }], 1, [old])!;
    expect(r.perPortion.kcal).toBeCloseTo(400, 9);
    expect(r.perPortion).toEqual(recipeNutrition([{ productId: 9, qty: 500, unit: "g" }], 1, [product(9, "ancien", nutrition(80))])!.perPortion);
  });

  it("lists a product without nutrition and still sums the others", () => {
    const r = recipeNutrition(
      [{ productId: 1, qty: 400, unit: "g" }, { productId: 4, qty: 100, unit: "g" }], 1, [poireau, product(4, "sel", null)],
    );
    expect(r!.perPortion.kcal).toBeCloseTo(120, 9);
    expect(r!.missing).toEqual(["sel"]);
  });

  it("lists a piece ingredient whose product has no weight per piece", () => {
    const noWeight = product(5, "ail", nutrition(130));
    const r = recipeNutrition([{ productId: 1, qty: 100, unit: "g" }, { productId: 5, qty: 2, unit: "piece" }], 1, [poireau, noWeight]);
    expect(r!.missing).toEqual(["ail"]);
    expect(r!.perPortion.kcal).toBeCloseTo(30, 9);
  });

  it("returns null when nothing is countable", () => {
    expect(recipeNutrition([{ productId: 4, qty: 100, unit: "g" }], 2, [product(4, "sel", null)])).toBeNull();
    expect(recipeNutrition([], 2, [])).toBeNull();
  });

  it("names an unknown product id without throwing", () => {
    const r = recipeNutrition([{ productId: 1, qty: 100, unit: "g" }, { productId: 99, qty: 1, unit: "g" }], 1, [poireau]);
    expect(r!.missing).toEqual(["produit 99"]);
  });

  it("ignores a seasoning: not counted, not missing, never partial", () => {
    const withRole = (p: Product): Product => ({ ...p, roles: ["assaisonnement"] });
    const cumin = withRole(product(6, "cumin", null));
    const paprika = withRole(product(7, "paprika", nutrition(300)));
    const base = recipeNutrition([{ productId: 1, qty: 400, unit: "g" }], 2, [poireau]);
    const r = recipeNutrition(
      [{ productId: 1, qty: 400, unit: "g" }, { productId: 6, qty: 5, unit: "g" }, { productId: 7, qty: 5, unit: "g" }],
      2, [poireau, cumin, paprika],
    );
    expect(r!.missing).toEqual([]);
    expect(r!.perPortion).toEqual(base!.perPortion);
  });

  it("returns null when every ingredient is a seasoning", () => {
    const paprika: Product = { ...product(7, "paprika", nutrition(300)), roles: ["assaisonnement"] };
    expect(recipeNutrition([{ productId: 7, qty: 5, unit: "g" }], 1, [paprika])).toBeNull();
  });
});
