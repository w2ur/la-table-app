import { daysBetween, parisDate } from "./dates";
import { packedQty } from "./packs";
import { libreQty, liveReservations, recipeNeeds, sharedQty, type HeldQty } from "./quantities";
import type { ResolvedMeal } from "./resolve";
import { RULES } from "./rules.config";
import { formatDay } from "./text";
import type { LineKind, Product, State, StockItem, Unit } from "./types";

export interface PlannedReservation {
  mealIndex: number;
  stockItemId: number;
  qty: number | null;
  unit: Unit | null;
  reliesOnUnknownQty: boolean;
}

export interface PlannedLine {
  productId: number;
  unit: Unit;
  qty: number;
  kind: Exclude<LineKind, "ajout">;
  forMeals: { mealIndex: number; qty: number }[];
}

/** A share a new meal takes from the spare of a line already on Courses (pack surplus another planning bought). */
export interface PlannedSpare { lineId: number; mealIndex: number; qty: number }

export interface ShoppingPlan {
  reservations: PlannedReservation[];
  lines: PlannedLine[];
  spares: PlannedSpare[];
  /** meal index → French reason, e.g. "comté à utiliser avant mercredi 14" */
  cookEarly: Map<number, string>;
}

const byUseBy = (a: StockItem, b: StockItem): number =>
  (a.useBy ?? "9999-12-31").localeCompare(b.useBy ?? "9999-12-31") || a.id - b.id;

/** Unfinished Reste items in the order a need takes them: earliest use-by first, undated last, then by id. */
export const stockByUseBy = (state: State): StockItem[] => state.stockItems.filter((s) => s.finishedAt === null).sort(byUseBy);

/**
 * What a need still `remaining` takes of an item of known quantity: its libre quantity under `held`, up to the need, and
 * only in the need's unit (0 for another unit, or when nothing is libre). An item of unknown quantity takes nothing here.
 */
export function libreTake(item: StockItem, held: readonly HeldQty[], unit: Unit, remaining: number): number {
  if (item.qty === null || item.unit !== unit) return 0;
  return Math.min(libreQty(item, held) ?? 0, remaining);
}

/**
 * Why a meal that reserves `item` should be cooked early: its use-by within `RULES.cookEarlyWithinDays` of `today`
 * (e.g. "comté à utiliser avant mercredi 14"), else null. A meal keeps the first reason it was given.
 */
export function cookEarlyReason(item: StockItem, today: string): string | null {
  if (item.useBy === null || daysBetween(today, item.useBy) > RULES.cookEarlyWithinDays) return null;
  return `${item.label} à utiliser avant ${formatDay(item.useBy)}`;
}

export function planShopping(state: State, meals: ResolvedMeal[], productsById: Map<number, Product>, at: string): ShoppingPlan {
  const today = parisDate(at);
  const live = liveReservations(state);
  const stock = stockByUseBy(state);
  const reservations: PlannedReservation[] = [];
  const lines = new Map<string, PlannedLine>();
  const cookEarly = new Map<number, string>();
  const spares: PlannedSpare[] = [];
  // spare of each unbought planning line: its pack surplus, less what this planning already took from it
  const spareLeft = new Map<number, number>();
  for (const l of state.shoppingItems) {
    if (l.boughtAt !== null || l.removedAt !== null || l.kind !== "planning" || l.qty === null) continue;
    const spare = l.qty - sharedQty(l);
    if (spare > 0) spareLeft.set(l.id, spare);
  }
  const takeSpare = (productId: number, unit: Unit, need: number, mealIndex: number): number => {
    let remaining = need;
    for (const l of state.shoppingItems) {
      if (remaining === 0) break;
      const spare = spareLeft.get(l.id) ?? 0;
      if (spare === 0 || l.productId !== productId || l.unit !== unit) continue;
      const take = Math.min(spare, remaining);
      spares.push({ lineId: l.id, mealIndex, qty: take });
      spareLeft.set(l.id, spare - take);
      remaining -= take;
    }
    return remaining;
  };

  const addLine = (productId: number, unit: Unit, qty: number, kind: PlannedLine["kind"], mealIndex: number): void => {
    const key = `${productId}|${unit}|${kind}`;
    const line = lines.get(key) ?? { productId, unit, qty: 0, kind, forMeals: [] };
    line.qty += qty;
    line.forMeals.push({ mealIndex, qty });
    lines.set(key, line);
  };

  const flagEarly = (mealIndex: number, item: StockItem): void => {
    const reason = cookEarly.has(mealIndex) ? null : cookEarlyReason(item, today);
    if (reason !== null) cookEarly.set(mealIndex, reason);
  };

  for (const meal of meals) {
    const needs = recipeNeeds(meal.ingredients, meal.recipe.basePortions, meal.portions, meal.doubled ? 2 : 1);
    for (const need of needs) {
      const product = productsById.get(need.productId);
      if (!product) continue;
      const held = stock.filter((s) => s.productId === need.productId);

      if (product.isStaple) {
        // a known 0 is empty; words of unknown quantity are not a zero (spec §5.6)
        if (held.every((s) => s.isLow || s.qty === 0)) addLine(need.productId, need.unit, need.qty, "staple_hors_budget", meal.index);
        continue;
      }

      let remaining = need.qty;
      for (const item of held) {
        if (remaining === 0) break;
        const planned: HeldQty[] = reservations
          .filter((r) => r.stockItemId === item.id)
          .map((r) => ({ stockItemId: r.stockItemId, qty: r.qty, unit: r.unit, releasedAt: null }));
        if (item.qty === null) {
          const spoken = live.some((r) => r.stockItemId === item.id) || planned.length > 0;
          if (spoken) continue;
          reservations.push({ mealIndex: meal.index, stockItemId: item.id, qty: remaining, unit: need.unit, reliesOnUnknownQty: true });
          remaining = 0;
          flagEarly(meal.index, item);
        } else {
          const take = libreTake(item, [...live, ...planned], need.unit, remaining);
          if (take === 0) continue;
          reservations.push({ mealIndex: meal.index, stockItemId: item.id, qty: take, unit: need.unit, reliesOnUnknownQty: false });
          remaining -= take;
          flagEarly(meal.index, item);
        }
      }
      remaining = takeSpare(need.productId, need.unit, remaining, meal.index);
      if (remaining > 0) addLine(need.productId, need.unit, remaining, "planning", meal.index);
    }
  }

  for (const line of lines.values()) line.qty = packedQty(line.qty, line.unit, productsById.get(line.productId)?.pack ?? null);
  return { reservations, lines: [...lines.values()], spares, cookEarly };
}
