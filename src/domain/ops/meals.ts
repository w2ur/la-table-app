import { addDays, parisDate } from "../dates";
import { declaredLeftover } from "../declared";
import { mealShortfalls } from "../invariants";
import { isOpen, liveReservations } from "../quantities";
import { RULES } from "../rules.config";
import { stockByUseBy } from "../shopping-plan";
import { nextId } from "../state";
import type { State, StockItem, Verdict } from "../types";
import { INVALID, applied, bool, coverNeed, dropMeal, int, isResolution, noop, payloadObject, refused, releaseReservationsOf, reserveLibreStock, settleReservations, strOrNull } from "./helpers";
import type { Resolution } from "./helpers";
import type { OpResult } from "./types";

const VERDICTS: readonly Verdict[] = ["a_refaire", "correct", "pas_pour_nous"];

interface SheetItem {
  stockItemId: number;
  outcome: "fini" | "il_en_reste";
  qtyText?: string | null;
  low?: boolean;
  /** §6.4: required when a « fini » item is still reserved for another open meal */
  resolution?: Resolution | null;
  /**
   * A « fini » the sheet pre-made, not tapped (decided 2026-10-25): it finishes the item only if the cook leaves it at a
   * known 0 and no other open meal holds it, judged when the op applies; otherwise the item is left as it is. A receipt
   * correction or an « Il en reste » that raised the item before the cook landed then keeps it.
   */
  ifEmpty?: true;
}

/** The Cuisiné sheet as the server accepts it; null when any part of it is invalid, which refuses the whole cook (the app's projection reads it too). */
export function parseSheet(sheet: unknown): { verdict: Verdict | null; note: string | null; items: SheetItem[] } | null {
  const s = payloadObject(sheet);
  if (!s) return null;
  const verdict = s.verdict ?? null;
  if (verdict !== null && !VERDICTS.includes(verdict as Verdict)) return null;
  const note = s.note ?? null;
  if (!strOrNull(note)) return null;
  const items = s.items ?? [];
  if (!Array.isArray(items)) return null;
  for (const raw of items) {
    const i = payloadObject(raw);
    if (!i || !int(i.stockItemId) || (i.outcome !== "fini" && i.outcome !== "il_en_reste")) return null;
    if (i.qtyText !== undefined && !strOrNull(i.qtyText)) return null;
    if (i.low !== undefined && !bool(i.low)) return null;
    if (i.resolution !== undefined && i.resolution !== null && !isResolution(i.resolution)) return null;
    if (i.ifEmpty !== undefined && (i.ifEmpty !== true || i.outcome !== "fini")) return null;
  }
  return { verdict: verdict as Verdict | null, note: note === null || note.trim() === "" ? null : note.trim(), items: items as SheetItem[] };
}

/**
 * Shared by meal.cook and stock.partial: opened item, what is left (`declaredLeftover`: the declared words set the
 * quantity, never a false zero; the other open meals' holds trimmed to fit, latest planned first), shorter use-by. A cook
 * has released its own reservations first, so every live one left on the item is another open meal's.
 */
export function markOpened(next: State, item: StockItem, at: string, qtyText: string | null | undefined, low: boolean | undefined): void {
  item.openedAt ??= at;
  const product = item.productId === null ? undefined : next.products.find((p) => p.id === item.productId);
  const held = liveReservations(next).filter((r) => r.stockItemId === item.id);
  const left = declaredLeftover(item, qtyText, { productUnit: product?.defaultUnit ?? null, pack: product?.pack ?? null, held });
  Object.assign(item, left.item);
  left.holds.forEach((h, i) => {
    if (h.released) held[i]!.releasedAt = at;
    else held[i]!.qty = h.qty;
  });
  if (low !== undefined) item.isLow = low;
  if (product?.openedShelfLifeDays != null) {
    const opened = addDays(parisDate(at), product.openedShelfLifeDays);
    if (item.useBy === null || opened < item.useBy) item.useBy = opened;
  }
}

export function cook(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.mealId)) return INVALID;
  const sheet = parseSheet(p.sheet ?? {});
  if (!sheet) return INVALID;
  const meal = next.meals.find((m) => m.id === p.mealId);
  if (!meal) return refused("repas introuvable");
  if (meal.cookedAt !== null) return noop("déjà cuisiné");
  if (meal.droppedAt !== null) return refused("repas retiré du menu");
  // §6.3: a second round eats the first round's leftovers
  const first = meal.doubledFrom === null ? undefined : next.meals.find((m) => m.id === meal.doubledFrom);
  if (first && isOpen(first)) return refused("cuisinez d'abord le premier tour");

  meal.cookedAt = at;
  meal.verdict = sheet.verdict;
  meal.note = sheet.note;
  const recipe = next.recipes.find((r) => r.id === meal.recipeId);
  if (recipe && sheet.verdict === "a_refaire") recipe.status = "favourite";
  if (recipe && sheet.verdict === "pas_pour_nous") recipe.status = "banned";

  // what the meal ate leaves the item, so it never reads as libre; an unknown quantity (or another unit) stays as it is
  for (const r of next.reservations.filter((x) => x.mealId === meal.id && x.releasedAt === null)) {
    const item = next.stockItems.find((s) => s.id === r.stockItemId);
    if (item && item.qty !== null && r.qty !== null && r.unit === item.unit) item.qty = Math.max(0, item.qty - r.qty);
  }
  releaseReservationsOf(next, meal.id, at);
  // every « Fini » first, with the meals its resolution drops, so an « Il en reste » never counts a hold the same sheet
  // releases (§6.3); an « Il en reste » in the item's own words changes nothing on it, yet is a write an earlier op's
  // undo must see (§6.6)
  const touched: { table: "stockItems"; id: number }[] = [];
  for (const answer of sheet.items.filter((a) => a.outcome === "fini" && !a.ifEmpty)) {
    const item = next.stockItems.find((s) => s.id === answer.stockItemId);
    if (!item || item.finishedAt !== null) continue;
    const refusal = settleReservations(next, item, answer.resolution ?? null, at);
    if (refusal !== null) return refused(`${item.label} : ${refusal}`);
    item.finishedAt = at;
  }
  // a pre-made « Fini » after every tapped one, whose resolutions may free its item; this meal's holds are released
  // above, so a live one is another open meal's
  const held = new Set(liveReservations(next).map((r) => r.stockItemId)); // this loop releases nothing
  for (const answer of sheet.items.filter((a) => a.outcome === "fini" && a.ifEmpty)) {
    const item = next.stockItems.find((s) => s.id === answer.stockItemId);
    if (!item || item.finishedAt !== null || item.qty !== 0 || held.has(item.id)) continue;
    item.finishedAt = at;
  }
  for (const answer of sheet.items.filter((a) => a.outcome === "il_en_reste")) {
    const item = next.stockItems.find((s) => s.id === answer.stockItemId);
    if (!item || item.finishedAt !== null) continue;
    markOpened(next, item, at, answer.qtyText, answer.low);
    touched.push({ table: "stockItems", id: item.id });
  }

  const second = next.meals.find((m) => m.doubledFrom === meal.id && isOpen(m));
  if (second && recipe) {
    const platId = nextId(next, "stockItems");
    next.stockItems.push({
      id: platId, productId: null, label: recipe.title, qty: null, unit: null, qtyText: null, isLow: false,
      useBy: addDays(parisDate(at), RULES.platCuisineUseByDays), openedAt: null, finishedAt: null, origin: "plat_cuisine",
      sourceShoppingItemId: null, sourceMealId: meal.id, createdAt: at,
    });
    next.reservations.push({ id: nextId(next, "reservations"), stockItemId: platId, mealId: second.id, qty: null, unit: null, releasedAt: null, createdAt: at });
  }
  return { ...applied(), touched };
}

export function dropMealOp(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.mealId)) return INVALID;
  const meal = next.meals.find((m) => m.id === p.mealId);
  if (!meal) return refused("repas introuvable");
  if (meal.droppedAt !== null) return noop("déjà retiré");
  if (meal.cookedAt !== null) return refused("repas déjà cuisiné");
  dropMeal(next, meal, at);
  return applied();
}

/**
 * §6.5 meal.cover_shortfalls: covers what an open meal lacks (mealShortfalls) in planning.commit's order,
 * so nothing free at home is bought: first the libre quantity of unfinished Reste items of that product and unit, in
 * use-by order, reserved for the meal, which an item near its use-by flags « à cuisiner tôt » as the commit does (a meal
 * keeps a reason it has); then what is left goes on Courses as a §6.4 rebuy does (coverNeed). Flagging writes the meal row,
 * so a later write to that meal makes the cover's undo « modifié depuis », as it does planning.commit's.
 */
export function coverShortfalls(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !Number.isSafeInteger(p.mealId)) return INVALID;
  const meal = next.meals.find((m) => m.id === p.mealId);
  if (!meal) return refused("repas introuvable");
  if (meal.cookedAt !== null) return refused("repas déjà cuisiné");
  if (meal.droppedAt !== null) return refused("repas retiré du menu");
  const shortfalls = mealShortfalls(next).filter((x) => x.mealId === meal.id);
  if (shortfalls.length === 0) return noop("rien ne manque");

  // read once: a reservation this cover adds goes into `live` too, and no other row changes until coverNeed
  const stock = stockByUseBy(next);
  const live = liveReservations(next);
  const today = parisDate(at);
  for (const { productId, unit, qty } of shortfalls) {
    const remaining = qty - reserveLibreStock(next, meal, { stock: stock.filter((i) => i.productId === productId), live, unit, qty, at, today });
    if (remaining === 0) continue;
    const label = next.products.find((x) => x.id === productId)?.name ?? `produit #${productId}`;
    coverNeed(next, { meal, productId, label, unit, qty: remaining, sourceLineId: null }, at);
  }
  return applied();
}
