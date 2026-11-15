import type { RecipeNutrition } from "../domain/nutrition";
import type { State } from "../domain/types";
import { formatEuros, formatQty, unitName, type Unit } from "../domain/units";

export { parseEuros } from "../domain/units";

/** The app's euro format (`12,50 €`, `12 €`), and a dash for an unknown price. */
export function euros(cents: number | null): string {
  return cents === null ? "—" : formatEuros(cents);
}

/** A line or Reste quantity as the app writes it (`1,5 kg`, `25 cl`), pieces spelled out. */
export function quantity(qty: number | null, unit: Unit | null): string {
  if (qty === null) return "quantité inconnue";
  if (unit === null) return String(qty);
  if (unit === "piece") return `${qty} ${unitName(unit, qty)}`;
  return formatQty(qty, unit);
}

/** A meal as the CLI names it: its recipe's title, else « repas #id » (an unknown meal or recipe). */
export function mealTitle(state: State, mealId: number): string {
  const meal = state.meals.find((m) => m.id === mealId);
  return state.recipes.find((r) => r.id === meal?.recipeId)?.title ?? `repas #${mealId}`;
}

/** A proposed meal's nutrition line in `check`: kcal and protein per portion, as the recipe screen rounds them. */
export function nutritionSummary(n: RecipeNutrition | null): string {
  if (n === null) return "valeurs nutritionnelles : aucune";
  return `≈ ${Math.round(n.perPortion.kcal)} kcal/portion · ${Math.round(n.perPortion.proteinG)} g protéines${n.missing.length > 0 ? " (partiel)" : ""}`;
}
