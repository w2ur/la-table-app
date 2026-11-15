import { emptyState } from "./state";
import type { Product, Recipe, RecipeIngredient, State } from "./types";

/** In the form a stored op time takes (`toISOString()`), so tests compare it as is. */
export const NOW = "2026-10-12T10:00:00.000Z";

const product = (p: Partial<Product> & Pick<Product, "id" | "name" | "category">): Product => ({
  isStaple: false,
  roles: [],
  isFreshProduce: false,
  seasonMonths: null,
  shelfLifeDays: null,
  openedShelfLifeDays: null,
  defaultUnit: "g",
  nutrition: null,
  pack: null,
  price: null,
  ...p,
});

export const P = {
  poireau: 1, comte: 2, lentilles: 3, poulet: 4, saumon: 5, riz: 6, creme: 7, courgette: 8, oignon: 9, endive: 10, boeuf: 11,
} as const;

export const R = { saumonLentilles: 1, gratin: 2, salade: 3, poulet: 4, courgettes: 5 } as const;

export function fixtureState(): State {
  const s = emptyState();
  s.products = [
    product({ id: 1, name: "poireau", category: "fruits-legumes", roles: ["vegetable", "fibre"], isFreshProduce: true, seasonMonths: [9, 10, 11, 12, 1, 2, 3, 4], shelfLifeDays: 10 }),
    product({ id: 2, name: "comté", category: "cremerie", roles: ["protein:laitier"], shelfLifeDays: 30, openedShelfLifeDays: 21 }),
    product({ id: 3, name: "lentilles vertes", category: "epicerie", isStaple: true, roles: ["legume", "fibre", "protein:legumineuse"] }),
    product({ id: 4, name: "filet de poulet", category: "boucherie-volaille", roles: ["protein:volaille"], shelfLifeDays: 2 }),
    product({ id: 5, name: "pavé de saumon", category: "poissonnerie", roles: ["protein:poisson"], shelfLifeDays: 2 }),
    product({ id: 6, name: "riz complet", category: "epicerie", isStaple: true, roles: ["fibre"] }),
    product({ id: 7, name: "crème fraîche", category: "cremerie", shelfLifeDays: 21, openedShelfLifeDays: 5, defaultUnit: "ml" }),
    product({ id: 8, name: "courgette", category: "fruits-legumes", roles: ["vegetable"], isFreshProduce: true, seasonMonths: [6, 7, 8, 9], shelfLifeDays: 7 }),
    product({ id: 9, name: "oignon", category: "fruits-legumes", isStaple: true, roles: ["vegetable"], isFreshProduce: true }),
    product({ id: 10, name: "endive", category: "fruits-legumes", roles: ["vegetable"], isFreshProduce: true, seasonMonths: [10, 11, 12, 1, 2, 3, 4], shelfLifeDays: 7 }),
    product({ id: 11, name: "bœuf haché", category: "boucherie-volaille", roles: ["protein:viande_rouge"], shelfLifeDays: 1 }),
  ];
  const recipe = (id: number, title: string, mainProtein: string, activeMin: number): Recipe => ({
    id, title, sourceUrl: null, basePortions: 2, activeMin, totalMin: activeMin + 20,
    steps: ["Préparer.", "Cuire."], mainProtein, status: "normal", createdAt: "2026-09-01T10:00:00Z",
  });
  s.recipes = [
    recipe(1, "Saumon aux lentilles et poireaux", "protein:poisson", 25),
    recipe(2, "Gratin de poireaux au comté", "protein:laitier", 20),
    recipe(3, "Salade d'endives au comté", "protein:laitier", 15),
    recipe(4, "Poulet aux poireaux", "protein:volaille", 30),
    recipe(5, "Courgettes farcies", "protein:viande_rouge", 40),
  ];
  let id = 0;
  const ing = (recipeId: number, productId: number, qty: number, unit: "g" | "ml" = "g"): RecipeIngredient => ({
    id: ++id, recipeId, productId, qty, unit, note: null,
  });
  s.recipeIngredients = [
    ing(1, P.saumon, 250), ing(1, P.lentilles, 150), ing(1, P.poireau, 300),
    ing(2, P.poireau, 400), ing(2, P.comte, 100), ing(2, P.riz, 150), ing(2, P.creme, 100, "ml"),
    ing(3, P.endive, 400), ing(3, P.comte, 100), ing(3, P.lentilles, 100),
    ing(4, P.poulet, 300), ing(4, P.poireau, 300), ing(4, P.riz, 150),
    ing(5, P.courgette, 600), ing(5, P.boeuf, 250), ing(5, P.riz, 100),
  ];
  return s;
}

/** The gratin's recipe as a cooked meal of fixtureProposal() shows it (snapshot.ts `MealRecipe`): 2 portions, no nutrition values. */
export const GRATIN_RECIPE = {
  title: "Gratin de poireaux au comté", portions: 2, activeMin: 20, totalMin: 40, isSecondRound: false, steps: ["Préparer.", "Cuire."], sourceUrl: null,
  ingredients: [
    { productId: P.poireau, label: "poireau", qty: 400, unit: "g" }, { productId: P.comte, label: "comté", qty: 100, unit: "g" },
    { productId: P.riz, label: "riz complet", qty: 150, unit: "g" }, { productId: P.creme, label: "crème fraîche", qty: 100, unit: "ml" },
  ],
  nutrition: null,
} as const;

/** Passes every rule in October against fixtureState(): 3 meals (gratin, salade, saumon). */
export function fixtureProposal(): Record<string, unknown> {
  return {
    params: { portions: 2, red_meat_requested: false, constraints: "" },
    new_products: [],
    new_recipes: [],
    meals: [
      { recipe: 2, portions: 2, doubled: false },
      { recipe: 3, portions: 2, doubled: false },
      { recipe: 1, portions: 2, doubled: false },
    ],
    prices: [
      { product: "poireau", unit: "g", est_price_cents: 280 },
      { product: "comté", unit: "g", est_price_cents: 500 },
      { product: "endive", unit: "g", est_price_cents: 260 },
      { product: "pavé de saumon", unit: "g", est_price_cents: 650 },
      { product: "crème fraîche", unit: "ml", est_price_cents: 190 },
      { product: "lentilles vertes", unit: "g", est_price_cents: 150 },
      { product: "riz complet", unit: "g", est_price_cents: 200 },
    ],
    envies: { placed: [], kept: [] },
  };
}

let counter = 0;
export function op(type: string, payload: unknown, at: string = NOW): { opId: string; type: string; at: string; payload: unknown } {
  counter += 1;
  return { opId: `op-${counter}-${type}`, type, at, payload };
}

/** A one-meal planning that passes after fixtureProposal(): a new fish recipe that also needs 100 g of comté, so it reserves libre comté. */
export function secondProposal(): Record<string, unknown> {
  return {
    params: { portions: 2, red_meat_requested: false, constraints: "" },
    new_products: [],
    new_recipes: [
      { key: "s", title: "Saumon gratiné au comté", source_url: null, base_portions: 2, active_min: 25, total_min: 40, main_protein: "protein:poisson",
        steps: ["Cuire."], ingredients: [
          { product: "pavé de saumon", qty: 250, unit: "g" }, { product: "lentilles vertes", qty: 150, unit: "g" },
          { product: "poireau", qty: 300, unit: "g" }, { product: "comté", qty: 100, unit: "g" },
        ] },
    ],
    meals: [{ recipe: "s", portions: 2, doubled: false }],
    prices: fixtureProposal().prices,
    envies: { placed: [], kept: [] },
  };
}

/**
 * A two-meal planning that passes after fixtureProposal(): both meals need comté (200 g, then 100 g), so the first
 * reserves libre comté and the rest of both needs goes on one shared line.
 */
export function sharedComteProposal(): Record<string, unknown> {
  const recipe = (key: string, title: string, protein: string, ingredients: { product: string; qty: number; unit: string }[]) => ({
    key, title, source_url: null, base_portions: 2, active_min: 20, total_min: 40, main_protein: protein, steps: ["Cuire."], ingredients,
  });
  return {
    params: { portions: 2, red_meat_requested: false, constraints: "" },
    new_products: [],
    new_recipes: [
      recipe("a", "Saumon gratiné au comté", "protein:poisson", [
        { product: "pavé de saumon", qty: 250, unit: "g" }, { product: "poireau", qty: 300, unit: "g" },
        { product: "comté", qty: 200, unit: "g" }, { product: "lentilles vertes", qty: 150, unit: "g" },
      ]),
      recipe("b", "Poulet au comté", "protein:volaille", [
        { product: "filet de poulet", qty: 300, unit: "g" }, { product: "poireau", qty: 300, unit: "g" }, { product: "comté", qty: 100, unit: "g" },
      ]),
    ],
    meals: [{ recipe: "a", portions: 2, doubled: false }, { recipe: "b", portions: 2, doubled: false }],
    prices: [...(fixtureProposal().prices as object[]), { product: "filet de poulet", unit: "g", est_price_cents: 400 }],
    envies: { placed: [], kept: [] },
  };
}

/**
 * fixtureProposal() with the saumon doubled (as ops.property.test's firstProposal(true)): meal 3 is its first round,
 * meal 4 its second, so a first round, its plat cuisiné and a second round are reachable. Passes every rule in October.
 */
export function doubledFixtureProposal(): Record<string, unknown> {
  const p = fixtureProposal();
  p.meals = (p.meals as { recipe: number }[]).map((m, i) => (i === 2 ? { ...m, doubled: true } : m));
  return p;
}
