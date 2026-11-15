import { NOW, P, R, fixtureProposal, fixtureState } from "./test-fixtures";
import type { State } from "./types";

type Fixture = () => { state: State; proposal: Record<string, unknown> };

/** A planning `recipeIds` were part of, a week before NOW (or long ago), cooked unless told otherwise. */
export function withPastPlanning(s: State, recipeIds: number[], opts: { cooked?: boolean; longAgo?: boolean } = {}): State {
  const planningId = s.plannings.length + 1;
  s.plannings.push({ id: planningId, createdAt: opts.longAgo ? "2026-01-01T10:00:00Z" : "2026-10-05T10:00:00Z", mealsAdded: recipeIds.length,
    budgetCents: 0, estimateCents: 0, params: { portions: 2, redMeatRequested: false, constraints: "" } });
  for (const recipeId of recipeIds) {
    s.meals.push({ id: s.meals.length + 1, planningId, recipeId, portions: 2, doubledFrom: null, cookEarlyReason: null,
      cookedAt: opts.cooked === false ? null : "2026-10-06T19:00:00Z", droppedAt: null, verdict: null, note: null });
  }
  return s;
}

const withMeals = (meals: unknown[], extra: Record<string, unknown> = {}) => ({ ...fixtureProposal(), meals, ...extra });
const courgettesPrices = () => [...(fixtureProposal().prices as unknown[]), { product: "courgette", unit: "g", est_price_cents: 300 }, { product: "bœuf haché", unit: "g", est_price_cents: 400 }];
const meal = (recipe: number | string, doubled = false) => ({ recipe, portions: 2, doubled });

/** One construction per rule checkProposal can report as a block, each producing that block from the shared fixtures. */
export const BLOCK_FIXTURES: Record<string, Fixture> = {
  schema: () => ({ state: fixtureState(), proposal: { meals: [] } }),
  resolve: () => ({ state: fixtureState(), proposal: withMeals([meal(99)]) }),
  envie: () => ({ state: fixtureState(), proposal: { ...fixtureProposal(), envies: { placed: [{ envie_id: 99, meal_index: 0 }], kept: [] } } }),
  "meal-protein": () => ({
    state: fixtureState(),
    proposal: withMeals([meal("r1"), meal(R.saumonLentilles)], { new_recipes: [{ key: "r1", title: "Riz nature", source_url: null, base_portions: 2, active_min: 15,
      total_min: 20, main_protein: "protein:oeuf", steps: [], ingredients: [{ product: "riz complet", qty: 150, unit: "g" }] }] }),
  }),
  "meal-vegetable": () => BLOCK_FIXTURES["meal-protein"]!(),
  "meal-fibre": () => ({
    state: fixtureState(),
    proposal: withMeals([...(fixtureProposal().meals as unknown[]), meal("r1")], { new_recipes: [{ key: "r1", title: "Endives braisées au comté", source_url: null,
      base_portions: 2, active_min: 20, total_min: 30, main_protein: "protein:laitier", steps: ["Cuire."],
      ingredients: [{ product: "endive", qty: 400, unit: "g" }, { product: "comté", qty: 100, unit: "g" }] }] }),
  }),
  "planning-legume": () => ({ state: fixtureState(), proposal: withMeals([meal(R.gratin), meal(R.poulet)]) }),
  "planning-fish": () => BLOCK_FIXTURES["planning-legume"]!(),
  "red-meat": () => ({ state: fixtureState(), proposal: withMeals([...(fixtureProposal().meals as unknown[]), meal(R.courgettes)], { prices: courgettesPrices() }) }),
  season: () => ({
    state: fixtureState(),
    proposal: withMeals([...(fixtureProposal().meals as unknown[]), meal(R.courgettes)], {
      prices: courgettesPrices(), params: { portions: 2, red_meat_requested: true, constraints: "" },
    }),
  }),
  "no-repeat": () => ({ state: withPastPlanning(fixtureState(), [R.gratin]), proposal: fixtureProposal() }),
  "favourite-gap": () => {
    const state = withPastPlanning(fixtureState(), [R.gratin]);
    state.recipes.find((r) => r.id === R.gratin)!.status = "favourite";
    return { state, proposal: fixtureProposal() };
  },
  banned: () => {
    const state = fixtureState();
    state.recipes.find((r) => r.id === R.salade)!.status = "banned";
    return { state, proposal: fixtureProposal() };
  },
  "duplicate-recipe": () => ({
    state: fixtureState(),
    proposal: withMeals([...(fixtureProposal().meals as unknown[]), meal("r1")], { new_recipes: [{ key: "r1", title: "  gratin de poireaux au Comté", source_url: null,
      base_portions: 2, active_min: 10, total_min: 10, main_protein: "protein:laitier", steps: [], ingredients: [] }] }),
  }),
  "protein-rotation": () => ({
    state: withPastPlanning(fixtureState(), [R.poulet], { cooked: false, longAgo: true }),
    proposal: withMeals([...(fixtureProposal().meals as unknown[]), meal(R.poulet, true)], {
      prices: [...(fixtureProposal().prices as unknown[]), { product: "filet de poulet", unit: "g", est_price_cents: 900 }],
    }),
  }),
  "price-missing": () => ({
    state: fixtureState(),
    proposal: { ...fixtureProposal(), prices: (fixtureProposal().prices as { product: string }[]).filter((x) => x.product !== "endive") },
  }),
};

/** Warnings only, no block: budget overrun, an unused perishable, reliance on unknown-quantity stock. */
export function WARN_FIXTURE(): { state: State; proposal: Record<string, unknown> } {
  const state = fixtureState();
  state.stockItems.push(
    { id: 1, productId: P.poulet, label: "filet de poulet", qty: 300, unit: "g", qtyText: null, isLow: false, useBy: "2026-10-14",
      openedAt: null, finishedAt: null, origin: "achat", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW },
    { id: 2, productId: P.creme, label: "crème fraîche", qty: null, unit: null, qtyText: "un fond", isLow: false, useBy: null,
      openedAt: NOW, finishedAt: null, origin: "achat", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW },
  );
  const proposal = fixtureProposal();
  proposal.prices = (proposal.prices as { product: string; est_price_cents: number }[]).map((x) => ({ ...x, est_price_cents: x.est_price_cents * 10 }));
  return { state, proposal };
}
