import type { Resolution } from "../domain/ops/helpers";
import type { PoolMeal } from "../domain/snapshot";
import type { Verdict } from "../domain/types";
import { reservedFor, resolutionMeta } from "./format";
import { leftOverPrefill, leftOverUnit, leftOverWords } from "./leftover-field";
import type { ViewItem } from "./sync/project";

/**
 * One held item's answer in the Cuisiné sheet: « Fini » (with the warning's resolution) or « Il en reste ». `heldBy` is
 * the other meals the warning named when its resolution was chosen (empty without one): a resolution covers those meals
 * only, so one more holder since asks again (`unresolvedFini`).
 */
export interface CookAnswer {
  outcome: "fini" | "il_en_reste";
  qtyText: string;
  low: boolean;
  resolution: Resolution | null;
  heldBy: readonly number[];
  /** Pre-made by the sheet, not tapped: sent as a « Fini » the server applies only if the cook empties the item. */
  ifEmpty?: true;
}

/** The sheet's answers by Reste item id; an item with no entry is unanswered. */
export type CookAnswers = Partial<Record<number, CookAnswer>>;

type Held = PoolMeal["reservedItems"][number];

/** Each Reste item the meal holds, once, though it may hold one through two reservations. */
export function heldOnce(meal: Pick<PoolMeal, "reservedItems">): Held[] {
  return [...new Map(meal.reservedItems.map((r) => [r.stockItemId, r])).values()];
}

/** An item no op may name yet: created offline and not synced, or gone from Reste since: no op ever names a guessed id. */
export function pendingItem(id: number, items: readonly ViewItem[]): boolean {
  return id < 0 || !items.some((i) => i.id === id);
}

/**
 * The answers a Cuisiné sheet opens with: « Fini » on each item the cook will empty, which a tap clears; nothing on the
 * rest. A second round's plat cuisiné is one, since a second round eats it: a second round holds nothing else (invariants.ts
 * `second_round_without_plat` and its coverage at a need of zero). So is an item of known quantity whose whole quantity
 * this meal holds, in its unit (decided 2026-10-25): the cook would leave it at 0, and a 0 is never finished without a
 * tap (§6.7), so the tap is made in advance, as `ifEmpty`: the server finishes the item only if it is still emptied when
 * the cook lands, so a refresh the sheet never saw cannot make the tick finish what is left. An item not yet synced is not
 * answerable, and one another open meal holds would need the warning first: neither is preselected.
 */
export function openingAnswers(meal: Pick<PoolMeal, "id" | "isSecondRound" | "reservedItems">, items: readonly ViewItem[]): CookAnswers {
  const answers: CookAnswers = {};
  for (const r of heldOnce(meal)) {
    const item = items.find((i) => i.id === r.stockItemId);
    if (pendingItem(r.stockItemId, items) || !item || item.reservations.some((h) => h.mealId !== meal.id)) continue;
    if (meal.isSecondRound) answers[r.stockItemId] = { outcome: "fini", qtyText: "", low: false, resolution: null, heldBy: [] };
    else if (emptiedBy(meal, item)) answers[r.stockItemId] = { outcome: "fini", qtyText: "", low: false, resolution: null, heldBy: [], ifEmpty: true };
  }
  return answers;
}

/**
 * Whether the cook's subtraction leaves `item` at 0: a known quantity, all of it held by `meal` in the item's unit. A meal
 * that holds nothing of it in that unit subtracts nothing, so an item already at 0 is not this cook's to finish.
 */
function emptiedBy(meal: Pick<PoolMeal, "reservedItems">, item: Pick<ViewItem, "id" | "qty" | "unit">): boolean {
  if (item.qty === null || item.unit === null) return false;
  const held = meal.reservedItems.filter((r) => r.stockItemId === item.id && r.unit === item.unit).reduce((sum, r) => sum + (r.qty ?? 0), 0);
  return held > 0 && held >= item.qty;
}

/**
 * The answer a tap on « Fini » or « Il en reste » gives an item, changing nothing the cook did not touch: « Il en reste » opens with `leftOverPrefill`
 * and the item's « Presque fini »: empty on an item that holds a number, so sent empty the cook's subtraction stands;
 * otherwise the item's own words, so a cook who types nothing sends them back unchanged rather than clearing them.
 */
export function answerFor(
  item: Pick<ViewItem, "qty" | "qtyText" | "unit" | "productUnit" | "isLow"> | undefined, outcome: CookAnswer["outcome"],
): CookAnswer {
  return { outcome, qtyText: leftOverPrefill(item), low: item?.isLow ?? false, resolution: null, heldBy: [] };
}

/** What other open meals hold an item now (spec §10.4): none for an item gone from Reste. */
export function othersHolding(meal: Pick<PoolMeal, "id">, items: readonly ViewItem[], id: number): ViewItem["reservations"] {
  return items.find((i) => i.id === id)?.reservations.filter((r) => r.mealId !== meal.id) ?? [];
}

/**
 * The item whose reservation warning the sheet shows, judged against the view now rather than at the tap: none once a
 * refresh shows the meal no longer holding it, the item gone or « en attente », or no other meal holding it (the other
 * phone finished it with « Racheter », or dropped the meal that held it). Kept as asked, the warning would show for no
 * item and hold « Valider » off for good.
 */
export function liveAsking(meal: Pick<PoolMeal, "id" | "reservedItems">, items: readonly ViewItem[], asking: number | null): number | null {
  if (asking === null || !heldOnce(meal).some((r) => r.stockItemId === asking) || pendingItem(asking, items)) return null;
  return othersHolding(meal, items, asking).length > 0 ? asking : null;
}

/** Under a pre-made « Fini »: it applies only if nothing is left once the meal is cooked. */
export const FINI_IF_EMPTY = "fini s'il ne reste rien après ce repas";

/**
 * The line under a « Fini » pre-made by the sheet (`FINI_IF_EMPTY`), or under one answered through the warning (spec §10.4): what its resolution does to the other meals that
 * hold the item now, or null. Once a refresh shows no other meal holding it, the resolution does nothing (helpers.ts
 * `settleReservations` ignores it) and the answer reads as a plain « Fini », not « Fini ·  : retiré du menu ».
 */
export function finiMeta(meal: Pick<PoolMeal, "id">, items: readonly ViewItem[], id: number, answer: CookAnswer | undefined): string | null {
  const holders = othersHolding(meal, items, id);
  // the server finishes a pre-made « Fini » only if the item is still emptied, held by no other meal, when the cook lands
  if (answer?.outcome === "fini" && answer.ifEmpty) return holders.length > 0 ? `${reservedFor(holders.map((h) => h.mealTitle))} : restera au Reste` : FINI_IF_EMPTY;
  if (answer?.outcome !== "fini" || answer.resolution === null || holders.length === 0) return null;
  return resolutionMeta(answer.resolution, holders.map((h) => h.mealTitle));
}

/**
 * The first held item whose « Fini » carries no resolution though another open meal holds it now, or null (spec §10.4):
 * a refresh since the tap (the other phone planned a meal on the leftover) or a preselected plat. « Valider » asks the
 * warning for it instead of sending a meal.cook the domain would refuse whole, verdict and note included. A resolution
 * chosen for fewer meals than hold the item now asks again too: « Retirer le repas » would drop a meal nobody named.
 */
export function unresolvedFini(meal: Pick<PoolMeal, "id" | "reservedItems">, items: readonly ViewItem[], answers: CookAnswers): number | null {
  for (const r of heldOnce(meal)) {
    const a = answers[r.stockItemId];
    // a pre-made « Fini » asks nothing: the server leaves an item another meal holds as it is
    if (!a || a.outcome !== "fini" || a.ifEmpty || pendingItem(r.stockItemId, items)) continue;
    const holders = othersHolding(meal, items, r.stockItemId);
    if (holders.length > 0 && (a.resolution === null || holders.some((h) => !a.heldBy.includes(h.mealId)))) return r.stockItemId;
  }
  return null;
}

/** What one « Valider » sends (spec §6.3 meal.cook). */
export interface CookPayload {
  mealId: number;
  sheet: {
    verdict: Verdict | null;
    note: string | null;
    items: ({ stockItemId: number; outcome: "fini"; resolution?: Resolution; ifEmpty?: true } | { stockItemId: number; outcome: "il_en_reste"; qtyText: string | null; low: boolean })[];
  };
}

/**
 * The meal.cook payload of a sheet: the verdict, the note (empty is null), and each answered item the meal holds, once,
 * that an op may name. « Il en reste » sends its words trimmed (empty is null, which clears them), a bare number with the
 * unit shown beside the field (`leftOverWords`), and « Presque fini »; « Fini » carries the warning's resolution when one
 * was chosen, and `ifEmpty` when the sheet pre-made it.
 */
export function cookPayload(meal: Pick<PoolMeal, "id" | "reservedItems">, items: readonly ViewItem[], verdict: Verdict | null, note: string, answers: CookAnswers): CookPayload {
  const sheet = heldOnce(meal).flatMap((r): CookPayload["sheet"]["items"] => {
    const a = answers[r.stockItemId];
    if (!a || pendingItem(r.stockItemId, items)) return [];
    if (a.outcome === "fini") {
      return [{ stockItemId: r.stockItemId, outcome: "fini", ...(a.resolution === null ? {} : { resolution: a.resolution }), ...(a.ifEmpty ? { ifEmpty: true as const } : {}) }];
    }
    const unit = leftOverUnit(items.find((i) => i.id === r.stockItemId));
    return [{ stockItemId: r.stockItemId, outcome: "il_en_reste", qtyText: leftOverWords(a.qtyText, unit), low: a.low }];
  });
  return { mealId: meal.id, sheet: { verdict, note: note.trim() === "" ? null : note.trim(), items: sheet } };
}
