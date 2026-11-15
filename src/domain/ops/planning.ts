import { checkProposal } from "../check";
import { nextId } from "../state";
import type { State } from "../types";
import { applied, refused } from "./helpers";
import type { OpResult } from "./types";

export function commitPlanning(next: State, payload: unknown, at: string): OpResult {
  const check = checkProposal(next, payload, at);
  if (check.blocks.length) return refused(check.blocks.map((b) => b.message).join(" · "));
  const proposal = check.proposal!;
  const resolved = check.resolved!;
  const shopping = check.shopping!;

  next.products.push(...resolved.newProducts);
  next.recipes.push(...resolved.newRecipes);
  next.recipeIngredients.push(...resolved.newIngredients);

  const planningId = nextId(next, "plannings");
  next.plannings.push({
    id: planningId,
    createdAt: at,
    mealsAdded: check.mealsAdded,
    budgetCents: check.budgetCents,
    estimateCents: check.estimateCents,
    params: {
      portions: proposal.params.portions,
      redMeatRequested: proposal.params.red_meat_requested,
      constraints: proposal.params.constraints,
    },
  });

  const mealIdByIndex = new Map<number, number>();
  for (const m of resolved.meals) {
    const id = nextId(next, "meals");
    const base = { planningId, recipeId: m.recipe.id, portions: m.portions, cookedAt: null, droppedAt: null, verdict: null, note: null };
    next.meals.push({ id, ...base, doubledFrom: null, cookEarlyReason: shopping.cookEarly.get(m.index) ?? null });
    mealIdByIndex.set(m.index, id);
    if (m.doubled) next.meals.push({ id: id + 1, ...base, doubledFrom: id, cookEarlyReason: null });
  }

  for (const r of shopping.reservations) {
    next.reservations.push({
      id: nextId(next, "reservations"), stockItemId: r.stockItemId, mealId: mealIdByIndex.get(r.mealIndex)!,
      qty: r.qty, unit: r.unit, releasedAt: null, createdAt: at,
    });
  }

  for (const sp of shopping.spares) {
    next.shoppingItems.find((l) => l.id === sp.lineId)!.forMeals.push({ mealId: mealIdByIndex.get(sp.mealIndex)!, qty: sp.qty });
  }

  shopping.lines.forEach((l, i) => {
    const summary = check.lines[i]!;
    next.shoppingItems.push({
      id: nextId(next, "shoppingItems"),
      productId: l.productId,
      label: summary.label,
      qty: l.qty,
      unit: l.unit,
      plannedQty: null,
      estPriceCents: summary.estPriceCents,
      kind: l.kind,
      planningId,
      forMeals: l.forMeals.map((f) => ({ mealId: mealIdByIndex.get(f.mealIndex)!, qty: f.qty })),
      isFood: true,
      boughtAt: null,
      tripId: null,
      removedAt: null,
      createdAt: at,
    });
  });

  for (const placed of proposal.envies.placed) {
    const envie = next.envies.find((e) => e.id === placed.envie_id)!;
    envie.status = "placee";
    envie.mealId = mealIdByIndex.get(placed.meal_index) ?? null;
  }
  for (const id of proposal.envies.kept) {
    const envie = next.envies.find((e) => e.id === id);
    if (envie && envie.status === "ouverte") envie.status = "gardee";
  }
  return applied();
}
