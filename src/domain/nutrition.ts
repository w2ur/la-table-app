import { SEASONING_ROLE } from "./vocabulary";
import type { Nutrients, Product, ProductNutrition, RecipeIngredient, Unit } from "./types";

export interface RecipeNutrition {
  perPortion: Nutrients;
  /** Product names not counted: no nutrition, or no weight for the ingredient's unit. */
  missing: string[];
}

const ZERO: Nutrients = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, saltG: 0 };
const KEYS = Object.keys(ZERO) as (keyof Nutrients)[];

/** Grams as bought (bone, shell and peel included) in `qty` of `unit`, or null when the product has no weight for that unit. */
export function gramsOf(qty: number, unit: Unit, n: ProductNutrition): number | null {
  if (unit === "g") return qty;
  if (unit === "ml") return n.gramsPerMl === null ? null : qty * n.gramsPerMl;
  return n.gramsPerPiece === null ? null : qty * n.gramsPerPiece;
}

/** Nutrition of one base portion, counting the edible share of each bought weight (g and piece, not ml); null when no ingredient can be counted. A seasoning (role `assaisonnement`) is ignored: neither counted nor missing. */
export function recipeNutrition(
  ingredients: Pick<RecipeIngredient, "productId" | "qty" | "unit">[],
  basePortions: number,
  products: Product[],
  /** The same products by id, when the caller already built it (a snapshot builds one for every meal). */
  byId: ReadonlyMap<number, Product> = new Map(products.map((p) => [p.id, p])),
): RecipeNutrition | null {
  const total = { ...ZERO };
  const missing: string[] = [];
  let counted = 0;
  for (const i of ingredients) {
    const p = byId.get(i.productId);
    if (p?.roles.includes(SEASONING_ROLE)) continue;
    const grams = p?.nutrition ? gramsOf(i.qty, i.unit, p.nutrition) : null;
    if (!p?.nutrition || grams === null) {
      missing.push(p?.name ?? `produit ${i.productId}`);
      continue;
    }
    // The edible share is of a bought weight: a volume has none. A nutrition stored before the field has no share (100).
    const eaten = i.unit === "ml" ? grams : grams * ((p.nutrition.ediblePct ?? 100) / 100);
    for (const k of KEYS) total[k] += (eaten / 100) * p.nutrition.per100g[k];
    counted++;
  }
  if (counted === 0) return null;
  const perPortion = { ...ZERO };
  for (const k of KEYS) perPortion[k] = total[k] / basePortions;
  return { perPortion, missing: [...new Set(missing)] };
}
