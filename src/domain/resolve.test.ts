import { describe, expect, it } from "vitest";
import { parseProposal } from "./proposal";
import { resolveProposal } from "./resolve";
import { NOW, fixtureProposal, fixtureState } from "./test-fixtures";

const parse = (input: unknown) => {
  const r = parseProposal(input);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.proposal;
};

describe("resolveProposal", () => {
  it("resolves existing recipes by id", () => {
    const r = resolveProposal(fixtureState(), parse(fixtureProposal()), NOW);
    expect(r.errors).toEqual([]);
    expect(r.meals.map((m) => m.recipe.title)).toEqual([
      "Gratin de poireaux au comté", "Salade d'endives au comté", "Saumon aux lentilles et poireaux",
    ]);
  });

  it("creates new products and recipes with fresh ids, converting units and matching names loosely", () => {
    const p = fixtureProposal();
    p.new_products = [{ name: "Panais", category: "fruits-legumes", is_staple: false, roles: ["vegetable", "fibre"],
      is_fresh_produce: true, season_months: [10, 11, 12, 1, 2, 3], shelf_life_days: 14, opened_shelf_life_days: null, default_unit: "g" }];
    p.new_recipes = [{ key: "r1", title: "Velouté de panais", source_url: null, base_portions: 2, active_min: 20, total_min: 40,
      main_protein: "protein:legumineuse", steps: ["Cuire.", "Mixer."],
      ingredients: [{ product: " panais ", qty: 0.6, unit: "kg" }, { product: "Lentilles Vertes", qty: 100, unit: "g" }] }];
    p.meals = [{ recipe: "r1", portions: 2, doubled: false }];
    const r = resolveProposal(fixtureState(), parse(p), NOW);
    expect(r.errors).toEqual([]);
    expect(r.newProducts[0]).toMatchObject({ id: 12, name: "Panais" });
    expect(r.newRecipes[0]).toMatchObject({ id: 6, title: "Velouté de panais", status: "normal", createdAt: NOW });
    expect(r.newIngredients.map((i) => [i.productId, i.qty, i.unit])).toEqual([[12, 600, "g"], [3, 100, "g"]]);
  });

  it("reports unknown products, unknown recipes and duplicate product names", () => {
    const p = fixtureProposal();
    p.new_products = [{ name: "Poireau", category: "fruits-legumes", is_staple: false, roles: [], is_fresh_produce: true,
      season_months: [1], shelf_life_days: 3, opened_shelf_life_days: null, default_unit: "g" }];
    p.new_recipes = [{ key: "r1", title: "X", source_url: null, base_portions: 2, active_min: 10, total_min: 10,
      main_protein: "protein:oeuf", steps: [], ingredients: [{ product: "licorne", qty: 1, unit: "piece" }] }];
    p.meals = [{ recipe: "r9", portions: 2, doubled: false }, { recipe: 99, portions: 2, doubled: false }];
    const r = resolveProposal(fixtureState(), parse(p), NOW);
    expect(r.errors).toEqual([
      "produit déjà connu : Poireau",
      "produit inconnu : licorne (recette X)",
      "recette inconnue : r9",
      "recette inconnue : #99",
    ]);
  });
});
