import seed from "../../../data/products.seed.json";
import { addDays, parisDate } from "../../domain/dates";
import { applyOp } from "../../domain/ops/apply";
import { emptyState } from "../../domain/state";
import type { Product, State } from "../../domain/types";

/**
 * The demo's invented week, built through the real domain from the first catalogue (data/products.seed.json, numbered as
 * migration 0002 numbers it): seven meals committed as a planning, the lines of two of them bought (so Reste holds them),
 * one meal cooked, and three Reste items added by hand with use-by dates counted from the day the fixtures are made.
 *
 * Every vegetable is in season all year (carotte, champignon), a season exception (pomme de terre) or frozen or tinned, so
 * the planning passes the season rule whatever the month the demo is opened in. Prices are invented.
 */

const ingredient = (product: string, qty: number, unit: "g" | "ml" | "piece" = "g") => ({ product, qty, unit });

const recipe = (key: string, title: string, mainProtein: string, activeMin: number, ingredients: ReturnType<typeof ingredient>[], steps: string[]) => ({
  key, title, source_url: null, base_portions: 2, active_min: activeMin, total_min: activeMin + 20, main_protein: mainProtein, steps, ingredients,
});

/** A function, not a constant: a module-level call would keep the fixtures in the real bundle (src/app/demo/bundle.test.ts). */
export const demoRecipes = () => [
  recipe("saumon", "Saumon, lentilles vertes et carottes", "protein:poisson", 25, [
    ingredient("pavé de saumon", 250), ingredient("lentilles vertes", 150), ingredient("carotte", 300),
  ], ["Cuire les lentilles 25 min.", "Rôtir les carottes en bâtonnets.", "Poêler le saumon côté peau."]),
  recipe("dahl", "Dahl de lentilles corail aux épinards", "protein:legumineuse", 20, [
    ingredient("lentilles corail", 200), ingredient("épinards surgelés", 300), ingredient("lait de coco", 200, "ml"), ingredient("curry", 5),
  ], ["Faire revenir le curry.", "Cuire les lentilles dans le lait de coco.", "Ajouter les épinards en fin de cuisson."]),
  recipe("poulet", "Poulet rôti, carottes et pommes de terre", "protein:volaille", 20, [
    ingredient("cuisse de poulet", 500), ingredient("carotte", 300), ingredient("pomme de terre", 500),
  ], ["Couper les légumes.", "Rôtir le tout 45 min à 200 °C."]),
  recipe("omelette", "Omelette aux champignons, pain complet", "protein:oeuf", 15, [
    ingredient("œuf", 4, "piece"), ingredient("champignon de Paris", 250), ingredient("pain complet", 1, "piece"),
  ], ["Poêler les champignons.", "Verser les œufs battus.", "Servir avec le pain."]),
  recipe("pates", "Pâtes complètes à la tomate et mozzarella", "protein:laitier", 15, [
    ingredient("pâtes complètes", 200), ingredient("tomates concassées en boîte", 400), ingredient("mozzarella", 125),
  ], ["Réduire la sauce tomate 10 min.", "Cuire les pâtes.", "Ajouter la mozzarella hors du feu."]),
  recipe("curry", "Curry de pois chiches et petits pois", "protein:legumineuse", 25, [
    ingredient("pois chiches en boîte", 400), ingredient("petits pois surgelés", 300), ingredient("riz basmati", 150), ingredient("curry", 5),
  ], ["Cuire le riz.", "Mijoter pois chiches, petits pois et curry 15 min."]),
  recipe("cabillaud", "Cabillaud, haricots verts et riz complet", "protein:poisson", 20, [
    ingredient("dos de cabillaud", 250), ingredient("haricots verts surgelés", 300), ingredient("riz complet", 150),
  ], ["Cuire le riz complet.", "Cuire le cabillaud à la vapeur.", "Sauter les haricots verts."]),
];

/** A line's invented price, in cents, for the whole quantity the planning asks for. */
const PRICES: Record<string, [unit: "g" | "ml" | "piece", cents: number]> = {
  "pavé de saumon": ["g", 690], "lentilles vertes": ["g", 180], carotte: ["g", 160], "lentilles corail": ["g", 210],
  "épinards surgelés": ["g", 190], "lait de coco": ["ml", 150], curry: ["g", 90], "cuisse de poulet": ["g", 520],
  "pomme de terre": ["g", 120], "œuf": ["piece", 140], "champignon de Paris": ["g", 230], "pain complet": ["piece", 260],
  "pâtes complètes": ["g", 140], "tomates concassées en boîte": ["g", 110], mozzarella: ["g", 160], "pois chiches en boîte": ["g", 130],
  "petits pois surgelés": ["g", 170], "riz basmati": ["g", 120], "dos de cabillaud": ["g", 640], "haricots verts surgelés": ["g", 180],
  "riz complet": ["g", 130],
};

function catalogue(): Product[] {
  return (seed.products as Omit<Product, "id" | "nutrition" | "pack" | "price">[]).map((p, i) => ({
    ...p, id: i + 1, nutrition: null, pack: null, price: null,
  })) as Product[];
}

/** Applies one op at `at` and throws unless the domain applied it: a fixture the rules refuse is a bug here. */
function apply(state: State, type: string, payload: unknown, at: string): State {
  const n = Object.keys(state.appliedOps).length + 1; // the same ids every time: two fixture loads are equal
  const { state: next, result } = applyOp(state, { opId: `demo-${n}-${type}`, type, at, payload }, at);
  if (result.status !== "applied") throw new Error(`demo fixtures: ${type} ${result.status} (${result.reason ?? ""})`);
  return next;
}

/** The demo's state as of `now` (an ISO instant): its use-by dates are counted from that day. */
export function demoState(now: string): State {
  const today = parisDate(now);
  const recipes = demoRecipes();
  let state = emptyState();
  state.products = catalogue();
  state = apply(state, "planning.commit", {
    params: { portions: 2, red_meat_requested: false, constraints: "" },
    new_products: [],
    new_recipes: recipes,
    meals: recipes.map((r) => ({ recipe: r.key, portions: 2, doubled: false })),
    prices: Object.entries(PRICES).map(([product, [unit, cents]]) => ({ product, unit, est_price_cents: cents })),
    envies: { placed: [], kept: [] },
  }, now);

  // the saumon and the omelette are bought; the saumon is cooked
  const mealOf = (title: string) => {
    const recipeId = state.recipes.find((r) => r.title === title)!.id;
    return state.meals.find((m) => m.recipeId === recipeId)!.id;
  };
  const bought = new Set([mealOf(recipes[0]!.title), mealOf(recipes[3]!.title)]);
  for (const line of state.shoppingItems.filter((l) => l.forMeals.some((share) => bought.has(share.mealId)))) {
    state = apply(state, "shopping.buy", { itemId: line.id }, now);
  }
  const salmon = state.stockItems.find((s) => s.label === "pavé de saumon")!.id;
  state = apply(state, "meal.cook", { mealId: mealOf(recipes[0]!.title), sheet: { items: [{ stockItemId: salmon, outcome: "fini" }] } }, now);

  // what was already in the fridge: one item to eat today, one soon, a staple with no date
  const productId = (name: string) => state.products.find((p) => p.name === name)!.id;
  state = apply(state, "stock.add", { productId: productId("crème fraîche"), label: "crème fraîche", qtyText: "un demi-pot", useBy: addDays(today, 1) }, now);
  state = apply(state, "stock.add", { productId: null, label: "soupe de potiron", qtyText: "deux bols", useBy: addDays(today, 3) }, now);
  state = apply(state, "stock.add", { productId: productId("parmesan"), label: "parmesan", qtyText: "un morceau", useBy: null }, now);
  return state;
}
