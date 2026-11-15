import { validateNutrition, type WireNutrition } from "../domain/ops/catalogue";
import { parseProductFile, sendProductFile, type ProductFileDeps } from "./product-file";

/**
 * `plan -- nutrition <file>`: Ciqual values set on catalogue products through `product.nutrition` (one op each, nutrition
 * only). The file: `{ "products": [ { "name", "nutrition" } ] }`, `nutrition` a wire nutrition or null to clear it.
 * Rerunning the same file answers noops.
 */
export type NutritionDeps = ProductFileDeps;

export interface WireEntry { name: string; nutrition: WireNutrition | null }

export function parseNutritionFile(text: string): { entries: WireEntry[]; errors: string[] } {
  return parseProductFile(text, ["name", "nutrition"], (p, name, at, errors) => {
    const { nutrition } = p;
    if (nutrition !== null && !validateNutrition(nutrition, `${at}.nutrition`, errors)) return null;
    return { name, nutrition: nutrition as WireNutrition | null };
  });
}

export function nutritionText(text: string, deps: NutritionDeps): Promise<{ output: string; exitCode: 0 | 1 }> {
  return sendProductFile(parseNutritionFile(text), deps, {
    prefix: "nutrition",
    type: "product.nutrition",
    payload: (e) => ({ name: e.name, nutrition: e.nutrition }),
    line: (product, _e, status) => `${status === "noop" ? "=" : "~"} ${product.name}`,
  });
}
