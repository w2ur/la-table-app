import type { Meal, RecipeIngredient, Reservation, State, StockItem, Unit } from "./types";
import { scaleQty } from "./units";

export interface Need {
  productId: number;
  unit: Unit;
  qty: number;
}

/** What the meals hold of a Courses line: the sum of its shares. */
export const sharedQty = (line: { forMeals: readonly { qty: number }[] }): number => line.forMeals.reduce((n, f) => n + f.qty, 0);

export type HeldQty = Pick<Reservation, "stockItemId" | "qty" | "unit" | "releasedAt">;

export function recipeNeeds(ingredients: RecipeIngredient[], basePortions: number, portions: number, multiplier: 0 | 1 | 2): Need[] {
  if (multiplier === 0) return [];
  const needs = new Map<string, Need>();
  for (const ing of ingredients) {
    const key = `${ing.productId}|${ing.unit}`;
    const qty = scaleQty(ing.qty, basePortions, portions * multiplier);
    const prev = needs.get(key);
    if (prev) prev.qty += qty;
    else needs.set(key, { productId: ing.productId, unit: ing.unit, qty });
  }
  return [...needs.values()];
}

export function mealMultiplier(meal: Meal, meals: readonly Meal[]): 0 | 1 | 2 {
  if (meal.doubledFrom !== null) return 0;
  return meals.some((m) => m.doubledFrom === meal.id && m.droppedAt === null) ? 2 : 1;
}

/**
 * The multiplier a meal is shown at, open or cooked: a first round cooked as a double stays one even once its second
 * round is dropped after the cook (spec §6.3); a second round dropped before it, or none planned, leaves it at 1×.
 */
export function cookedMultiplier(meal: Meal, meals: readonly Meal[]): 0 | 1 | 2 {
  if (meal.doubledFrom !== null) return 0;
  const cookedAt = meal.cookedAt;
  const counted = (m: Meal) => m.droppedAt === null || (cookedAt !== null && m.droppedAt > cookedAt);
  return meals.some((m) => m.doubledFrom === meal.id && counted(m)) ? 2 : 1;
}

export function mealNeed(state: State, meal: Meal, productId: number, unit: Unit): number {
  const recipe = state.recipes.find((r) => r.id === meal.recipeId);
  if (!recipe) return 0;
  const ingredients = state.recipeIngredients.filter((i) => i.recipeId === recipe.id);
  const need = recipeNeeds(ingredients, recipe.basePortions, meal.portions, mealMultiplier(meal, state.meals))
    .find((n) => n.productId === productId && n.unit === unit);
  return need?.qty ?? 0;
}

export function liveReservations(state: State): Reservation[] {
  return state.reservations.filter((r) => r.releasedAt === null);
}

/** A meal is open until it is cooked or dropped. */
export function isOpen(meal: Meal): boolean {
  return meal.cookedAt === null && meal.droppedAt === null;
}

/** What a meal's live reservations hold of a product, in one unit. */
export function reservedQty(state: State, mealId: number, productId: number, unit: Unit): number {
  return liveReservations(state)
    .filter((r) => r.mealId === mealId && r.unit === unit)
    .filter((r) => state.stockItems.find((s) => s.id === r.stockItemId)?.productId === productId)
    .reduce((sum, r) => sum + (r.qty ?? 0), 0);
}

export function libreQty(item: Pick<StockItem, "id" | "qty" | "unit">, held: readonly HeldQty[]): number | null {
  if (item.qty === null) return null;
  const mine = held.filter((r) => r.stockItemId === item.id && r.releasedAt === null);
  if (mine.some((r) => r.qty === null || r.unit !== item.unit)) return null;
  return Math.max(0, item.qty - mine.reduce((sum, r) => sum + (r.qty ?? 0), 0));
}
