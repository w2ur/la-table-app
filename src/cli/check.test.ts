import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkProposal } from "../domain/check";
import { BLOCK_FIXTURES, WARN_FIXTURE } from "../domain/check-fixtures";
import { RULES } from "../domain/rules.config";
import { NOW, P, fixtureProposal, fixtureState } from "../domain/test-fixtures";
import type { ProductNutrition } from "../domain/types";
import { checkNutrition, checkText } from "./check";

/** Every id the checker can emit: string literals passed as ruleId in check.ts, plus RULES' nutrition ids. */
function emittableIds(): string[] {
  const src = readFileSync(new URL("../domain/check.ts", import.meta.url), "utf8");
  const literals = [...src.matchAll(/ruleId: "([a-z-]+)"/g)].map((m) => m[1]!);
  return [...new Set([...literals, ...RULES.nutrition.map((r) => r.id)])];
}

describe("check", () => {
  it("exits 0 on a clean proposal and prints each meal with its cost per portion and the totals against budget", () => {
    const r = checkText(JSON.stringify(fixtureProposal()), fixtureState(), NOW);
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/Aucun blocage/);
    expect(r.output).toMatch(/€ \/ portion/);
    expect(r.output).toMatch(/Total estimé .* · budget .*€/);
  });

  for (const [ruleId, make] of Object.entries(BLOCK_FIXTURES)) {
    it(`exits 1 and names the rule for a ${ruleId} block`, () => {
      const { state, proposal } = make();
      const r = checkText(JSON.stringify(proposal), state, NOW);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain(`[${ruleId}]`);
    });
  }

  it("has a fixture for every rule the checker can report as a block", () => {
    // A rule only ever emitted as a warning needs no fixture; prove which by running every fixture and the warn test case.
    const blockIds = new Set<string>();
    for (const make of Object.values(BLOCK_FIXTURES)) {
      const { state, proposal } = make();
      for (const b of checkProposal(state, proposal, NOW).blocks) blockIds.add(b.ruleId);
    }
    const nutritionBlocks = RULES.nutrition.filter((r) => r.severity === "block").map((r) => r.id);
    const literalIds = emittableIds().filter((id) => !RULES.nutrition.some((r) => r.id === id));
    const warnOnly = ["budget", "long-meals", "pack-leftover", "perishable-unused", "price-reference", "unknown-qty-stock"]; // confirmed warn-only in check.ts; edit with the code
    const expected = [...nutritionBlocks, ...literalIds.filter((id) => !warnOnly.includes(id))].sort();
    expect(Object.keys(BLOCK_FIXTURES).sort()).toEqual(expected);
    for (const id of expected) expect(blockIds.has(id), id).toBe(true);
  });

  it("reports a proposal that is not JSON as a schema block (exit 1)", () => {
    const r = checkText("{ not json", fixtureState(), NOW);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("[schema]");
    // Regression: d4ef458 — V8's English JSON.parse message leaked into a French line
    expect(r.output).toBe("✗ [schema] proposal.json n'est pas du JSON valide");
  });

  it("prints warnings without failing", () => {
    const { state, proposal } = WARN_FIXTURE();
    const r = checkText(JSON.stringify(proposal), state, NOW);
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^! \[budget\]/m);
  });
});

describe("check costs", () => {
  it("prices a doubled meal per portion over both rounds", () => {
    const p = fixtureProposal();
    (p.meals as { doubled: boolean }[])[2]!.doubled = true; // saumon aux lentilles, doubled: 4 portions over two rounds
    const r = checkText(JSON.stringify(p), fixtureState(), NOW);
    expect(r.exitCode).toBe(0);
    expect(r.result!.mealCostsCents[2]).toBe(818); // 650 saumon + 600/1000 of the 280 poireau line
    expect(r.output).toContain("3. Saumon aux lentilles et poireaux · 2 p. × 2 · 2,05 € / portion"); // round(818 / 4)
  });
});

describe("check nutrition", () => {
  const POIREAU: ProductNutrition = { ciqualCode: "20018", per100g: { kcal: 30, proteinG: 1.5, carbsG: 4.6, fatG: 0.3, fibreG: 3.2, saltG: 0.02 }, gramsPerPiece: null, gramsPerMl: null, ediblePct: 100 };
  const COMTE: ProductNutrition = { ciqualCode: "12726", per100g: { kcal: 400, proteinG: 28, carbsG: 0, fatG: 32, fibreG: 0, saltG: 1 }, gramsPerPiece: null, gramsPerMl: null, ediblePct: 100 };
  const withNutrition = () => {
    const s = fixtureState();
    s.products.find((p) => p.id === P.poireau)!.nutrition = POIREAU;
    s.products.find((p) => p.id === P.comte)!.nutrition = COMTE;
    return s;
  };

  it("prints each meal's kcal and protein per portion under it, partial when an ingredient has no values", () => {
    const r = checkText(JSON.stringify(fixtureProposal()), withNutrition(), NOW);
    const lines = r.output.split("\n");
    const gratin = lines.findIndex((l) => l.startsWith("1. Gratin de poireaux au comté"));
    // (400 g poireau + 100 g comté) / 2 base portions: 260 kcal, 17 g protein; riz and crème not counted
    expect(lines[gratin + 1]).toBe("   ≈ 260 kcal/portion · 17 g protéines (partiel)");
  });

  it("prints a full line without « partiel », and says so when no ingredient has values", () => {
    const s = withNutrition();
    for (const p of s.products) if (p.id !== P.poireau && p.id !== P.comte) p.nutrition = { ...COMTE, per100g: { ...COMTE.per100g, kcal: 0, proteinG: 0 }, gramsPerMl: 1 };
    const full = checkText(JSON.stringify(fixtureProposal()), s, NOW).output.split("\n");
    expect(full[full.findIndex((l) => l.startsWith("1. Gratin")) + 1]).toBe("   ≈ 260 kcal/portion · 17 g protéines");
    const none = checkText(JSON.stringify(fixtureProposal()), fixtureState(), NOW).output.split("\n");
    expect(none[none.findIndex((l) => l.startsWith("1. Gratin")) + 1]).toBe("   valeurs nutritionnelles : aucune");
  });

  it("names a proposal's new product among the uncounted, never by its id", () => {
    const p = fixtureProposal();
    p.new_products = [{
      name: "potimarron", category: "fruits-legumes", is_staple: false, roles: ["vegetable"], is_fresh_produce: true, season_months: [9, 10, 11],
      shelf_life_days: 30, opened_shelf_life_days: null, default_unit: "g",
    }];
    p.new_recipes = [{
      key: "v", title: "Velouté de potimarron au comté", source_url: null, base_portions: 2, active_min: 20, total_min: 40, main_protein: "protein:laitier",
      steps: ["Cuire."], ingredients: [{ product: "potimarron", qty: 800, unit: "g" }, { product: "comté", qty: 60, unit: "g" }],
    }];
    p.meals = [{ recipe: "v", portions: 2, doubled: false }];
    const r = checkText(JSON.stringify(p), withNutrition(), NOW);
    expect(r.result!.resolved!.meals[0]!.ingredients.some((i) => i.productId > 11)).toBe(true);
    expect(checkNutrition(r.result!, withNutrition()).map((n) => n?.missing)).toEqual([["potimarron"]]);
    expect(r.output).toContain("   ≈ 120 kcal/portion · 8 g protéines (partiel)"); // 60 g comté / 2
    expect(r.output).not.toMatch(/produit \d+/);
  });
});

describe("check spares", () => {
  it("names the line a meal draws its pack surplus from, under that meal", () => {
    const s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
    s.meals.push({ id: 90, planningId: 1, recipeId: 4, portions: 2, doubledFrom: null, cookEarlyReason: null, cookedAt: null, droppedAt: null, verdict: null, note: null });
    s.shoppingItems.push({ id: 70, productId: P.comte, label: "comté", qty: 250, unit: "g", plannedQty: null, estPriceCents: 420, kind: "planning", planningId: 1,
      forMeals: [{ mealId: 90, qty: 100 }], isFood: true, boughtAt: null, tripId: null, removedAt: null, createdAt: NOW });
    const lines = checkText(JSON.stringify(fixtureProposal()), s, NOW).output.split("\n");
    const gratin = lines.findIndex((l) => l.startsWith("1. Gratin"));
    expect(lines[gratin + 2]).toBe("   repris sur la liste : 100 g de comté (article #70)");
    expect(lines[gratin + 3]).toMatch(/^2\. /);
  });
});
