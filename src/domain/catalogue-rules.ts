import exceptionsList from "../../data/season-exceptions.json";
import { normalizeName } from "./text";
import type { Product } from "./types";
import { PERISHABLE_CATEGORIES } from "./vocabulary";

/** Fresh produce sold all year (data/season-exceptions.json): no season months, and a shelf life only if known. */
export const SEASON_EXEMPT: ReadonlySet<string> = new Set(exceptionsList.map(normalizeName));

/** What every catalogue product must carry, from the seed or from `product.upsert`: the planning rules read both. */
export function catalogueRuleErrors(p: Pick<Product, "name" | "category" | "isStaple" | "isFreshProduce" | "seasonMonths" | "shelfLifeDays">): string[] {
  const exempt = SEASON_EXEMPT.has(normalizeName(p.name));
  const errors: string[] = [];
  if (p.isFreshProduce && !exempt && p.seasonMonths === null) errors.push("produit frais sans mois de saison");
  if (!p.isStaple && PERISHABLE_CATEGORIES.includes(p.category) && p.shelfLifeDays === null && !exempt) errors.push("produit périssable sans durée de conservation");
  return errors;
}
