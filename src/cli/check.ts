import { checkProposal, type CheckResult } from "../domain/check";
import { recipeNutrition, type RecipeNutrition } from "../domain/nutrition";
import type { State } from "../domain/types";
import { formatAmount } from "../domain/units";
import { euros, nutritionSummary } from "./format";

/**
 * Each proposed meal's nutrition per base portion, in `resolved.meals` order. Over the proposal's new products too, so
 * one of them shows by name among the uncounted (it has no values yet), never as an unknown id.
 */
export function checkNutrition(r: CheckResult, state: State): (RecipeNutrition | null)[] {
  if (!r.resolved) return [];
  const products = [...state.products, ...r.resolved.newProducts];
  return r.resolved.meals.map((m) => recipeNutrition(m.ingredients, m.recipe.basePortions, products));
}

export function renderCheck(r: CheckResult, state: State): string {
  const out: string[] = [];
  for (const b of r.blocks) out.push(`✗ [${b.ruleId}] ${b.message}`);
  for (const w of r.warns) out.push(`! [${w.ruleId}] ${w.message}`);
  if (!r.blocks.length) out.push("Aucun blocage.");
  if (r.resolved) {
    out.push("");
    const nutrition = checkNutrition(r, state);
    for (const [i, m] of r.resolved.meals.entries()) {
      // a doubled meal's cost covers both rounds (its lines are planned at 2 × its portions)
      const cost = r.mealCostsCents[m.index] ?? null;
      const perPortion = cost === null ? null : Math.round(cost / (m.portions * (m.doubled ? 2 : 1)));
      const early = r.shopping?.cookEarly.get(m.index);
      out.push(`${m.index + 1}. ${m.recipe.title} · ${m.portions} p.${m.doubled ? " × 2" : ""} · ${euros(perPortion)} / portion · ${m.recipe.activeMin} min actives${early ? ` · à cuisiner tôt : ${early}` : ""}`);
      out.push(`   ${nutritionSummary(nutrition[i] ?? null)}`);
      for (const sp of r.shopping?.spares.filter((x) => x.mealIndex === m.index) ?? []) {
        const line = state.shoppingItems.find((l) => l.id === sp.lineId);
        if (line?.unit) out.push(`   repris sur la liste : ${formatAmount(sp.qty, line.unit)} de ${line.label} (article #${line.id})`);
      }
    }
    out.push("", `Total estimé ${euros(r.estimateCents)} · budget ${euros(r.budgetCents)}${r.calibratedCents !== null ? ` · calibré ${euros(r.calibratedCents)}` : ""}`);
  }
  return out.join("\n");
}

/** `input` is the parsed file, sent as is by commit; null with `result` when the text is not JSON. */
export function checkText(text: string, state: State, now: string): { result: CheckResult | null; input: unknown; output: string; exitCode: 0 | 1 } {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { result: null, input: null, output: `✗ [schema] proposal.json n'est pas du JSON valide`, exitCode: 1 };
  }
  const result = checkProposal(state, input, now);
  return { result, input, output: renderCheck(result, state), exitCode: result.blocks.length ? 1 : 0 };
}
