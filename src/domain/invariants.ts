import { isOpen, liveReservations, mealMultiplier, mealNeed, recipeNeeds } from "./quantities";
import type { Meal, ShoppingItem, State, Unit } from "./types";

/**
 * Global invariants every op must preserve (spec §6, §11 property 2, deviations 6 and 11). `invariantViolations` lists
 * what a state breaks; an empty list is a sound state. Codes and subjects are stable so a caller can compare two states
 * (undo refuses only the violations it would introduce, never one already tolerated before it).
 *
 * Left out on purpose, because they do not hold today for a legitimate reason:
 * - « planning.estimateCents = Σ its lines »: the stored estimate is the one at commit; a drop shrinks the lines' prices
 *   but not the planning row, and the Courses total is recomputed from the lines (snapshot).
 * - « a closed meal holds no share on an unbought line »: cooking a meal leaves its shares on Courses (39c0f26: a cooked
 *   meal's line stays listed until it is bought or removed). Only a dropped meal loses them, so only that is checked.
 *   What a cooked meal keeps is still bounded: a staple share by the need it was cooked at (staple_over_shared, which
 *   covers open and cooked meals); a non-staple one by undo's row guards, since its purchase made rows they see change.
 * - « a removed line holds no share »: `shopping.remove` keeps a planned line's quantity and price, as a bought line keeps
 *   them, and the shares of the meals already cooked or dropped when it was removed (an open meal's share leaves it; a
 *   staple line keeps none); every
 *   rule below reads unbought, unremoved lines only, and undo reads the kept shares (undo.ts `reopenedShort`). What is
 *   checked is narrower: no open meal holds a share on a removed line other than a staple one (removed_line_open_share
 *   below), so an undo that reopens a meal whose share a line took off Courses after it closed is refused. A staple line
 *   is left out: a staple share never leaves a meal short (the staple just leaves Courses, as « On n'en prend pas » on an
 *   open meal's staple line does), and a removed staple line keeps no share, so an uncook reopens none there.
 * - « an item reserved in another unit than its own »: libreQty treats it as unknown; nothing forbids it.
 *
 * Reachable on purpose, yet still listed: `meal_under_covered`. An « Il en reste » that declares less than the other open
 * meals hold trims their holds (declared.ts, spec §6.3), so those meals are short of that product until a line covers
 * them; `plan -- status` lists them under « Manques » (`mealShortfalls`). The second legitimate source is a planned line
 * removed « On n'en prend pas » (`shopping.remove` with `pas_achete`): each open meal it served is short of its share. It
 * stays a violation so that an undo never introduces one: only a declaration or that removal does.
 */
export type ViolationCode =
  | "reservation_item_missing"
  | "reservation_meal_missing"
  | "reserved_finished_item"
  | "reserved_closed_meal"
  | "item_over_reserved"
  | "second_round_without_plat"
  | "second_round_cooked_first"
  | "meal_under_covered"
  | "meal_over_covered"
  | "staple_over_shared"
  | "dropped_meal_share"
  | "removed_line_open_share"
  | "empty_line_priced";

/**
 * Whether a removed line can leave a meal short: a planning line only. An ajout serves no meal, and a staple share never
 * leaves a meal short (the staple just leaves Courses). One rule for removed_line_open_share below and undo.ts
 * (`reopenedShort`, `restoresClosedMealShare`).
 */
export const removalCanLeaveShort = (line: Pick<ShoppingItem, "kind">): boolean => line.kind !== "ajout" && line.kind !== "staple_hors_budget";

export interface Violation {
  code: ViolationCode;
  /** the rows it is about, e.g. `meal:3|product:5|g`; with `code`, identifies the violation across two states */
  subject: string;
  /** French, user-facing */
  reason: string;
}

export function invariantViolations(s: State): Violation[] {
  const out: Violation[] = [];
  const push = (code: ViolationCode, subject: string, reason: string) => out.push({ code, subject, reason });
  const live = liveReservations(s);
  const itemById = new Map(s.stockItems.map((i) => [i.id, i]));
  const mealById = new Map(s.meals.map((m) => [m.id, m]));

  // reservations point at existing rows; a live one sits on an unfinished item, for an open meal
  for (const r of s.reservations) {
    if (!itemById.has(r.stockItemId)) push("reservation_item_missing", `reservation:${r.id}`, "réservation sur un article introuvable");
    if (!mealById.has(r.mealId)) push("reservation_meal_missing", `reservation:${r.id}`, "réservation pour un repas introuvable");
  }
  for (const r of live) {
    if (itemById.get(r.stockItemId)?.finishedAt != null) push("reserved_finished_item", `reservation:${r.id}`, "réservation sur un article fini");
    const meal = mealById.get(r.mealId);
    if (meal && !isOpen(meal)) push("reserved_closed_meal", `reservation:${r.id}`, "réservation pour un repas cuisiné ou retiré");
  }

  // §11 property 2: never more reserved than held; an item of unknown quantity covers at most one meal
  for (const item of s.stockItems) {
    const held = live.filter((r) => r.stockItemId === item.id);
    const over = item.qty === null
      ? held.length > 1
      : held.filter((r) => r.unit === item.unit).reduce((n, r) => n + (r.qty ?? 0), 0) > item.qty;
    if (over) push("item_over_reserved", `stock:${item.id}`, "plus réservé que l'article n'en contient");
  }

  // §6.3: a second round eats the first round's leftovers, so it is cooked only once the first round is
  for (const meal of s.meals.filter((m) => m.doubledFrom !== null && m.cookedAt !== null)) {
    if (mealById.get(meal.doubledFrom!)?.cookedAt == null) push("second_round_cooked_first", `meal:${meal.id}`, "second tour cuisiné avant le premier");
  }

  for (const meal of s.meals.filter(isOpen)) {
    // §6.3: once its first round is cooked (or gone), a second round is the plat cuisiné and nothing else
    const first = meal.doubledFrom === null ? undefined : mealById.get(meal.doubledFrom);
    if (meal.doubledFrom !== null && (!first || !isOpen(first))) {
      const plats = live.filter((r) => r.mealId === meal.id && itemById.get(r.stockItemId)?.origin === "plat_cuisine");
      if (plats.length !== 1) push("second_round_without_plat", `meal:${meal.id}`, "second tour sans plat cuisiné");
    }
    // covered exactly at its need: live reservations plus shares on unbought lines, per non-staple product and unit
    for (const [key, covered] of coverage(s, meal)) {
      const [productId, unit] = key.split("|") as [string, Unit];
      const need = mealNeed(s, meal, Number(productId), unit);
      const subject = `meal:${meal.id}|product:${productId}|${unit}`;
      if (covered < need) push("meal_under_covered", subject, "repas pas assez couvert : ni réservé ni sur la liste");
      if (covered > need) push("meal_over_covered", subject, "repas couvert au-delà de son besoin");
    }
  }

  // a staple is never reserved, so the coverage rule skips it; its shares on unbought lines still stay within the need
  // (a second round dropped after a staple line was bought, that purchase then undone, put a 2× share back). Open and
  // cooked meals both: a cooked meal's shares stay on Courses, bounded by the need it was cooked at, so a first round
  // cooked at 2× keeps its 2× share when its second round is dropped later, and one cooked at 1× gets none back. A
  // dropped meal holds no share at all (dropped_meal_share below).
  const staple = stapleSharesByMeal(s);
  for (const meal of s.meals.filter((m) => m.droppedAt === null)) {
    for (const [key, shared] of staple.get(meal.id) ?? []) {
      const [productId, unit] = key.split("|") as [string, Unit];
      if (shared > stapleNeed(s, meal, Number(productId), unit)) {
        push("staple_over_shared", `meal:${meal.id}|product:${productId}|${unit}`, "part de placard au-delà du besoin du repas");
      }
    }
  }

  for (const line of s.shoppingItems.filter((l) => l.boughtAt === null && l.removedAt === null)) {
    // §6.4: dropping a meal takes its share off every unbought line
    for (const f of line.forMeals) {
      if (mealById.get(f.mealId)?.droppedAt != null) push("dropped_meal_share", `line:${line.id}|meal:${f.mealId}`, "part d'un repas retiré encore sur la liste");
    }
  }
  // §6.5: a removed line keeps only the shares of meals closed when it left Courses, so no open meal holds one there;
  // a staple line's share never leaves a meal short, and a removed one keeps none for an uncook to reopen
  for (const line of s.shoppingItems.filter((l) => l.removedAt !== null && removalCanLeaveShort(l))) {
    for (const f of line.forMeals) {
      const meal = mealById.get(f.mealId);
      if (meal && isOpen(meal)) push("removed_line_open_share", `line:${line.id}|meal:${f.mealId}`, "part d'un repas ouvert sur un article retiré");
    }
  }
  // a line's price shrinks with its quantity, so an emptied line costs nothing
  for (const line of s.shoppingItems) {
    if (line.qty === 0 && line.estPriceCents !== null && line.estPriceCents !== 0) push("empty_line_priced", `line:${line.id}`, "article vide encore chiffré");
  }
  return out;
}

/** What an open meal lacks of a non-staple product, in one unit: its need less its live reservations and unbought shares. */
export interface Shortfall {
  mealId: number;
  productId: number;
  unit: Unit;
  qty: number;
}

/**
 * Every open meal short of a product (spec §6.3: a declared leftover trimmed its hold; or a line removed « On n'en
 * prend pas »), in meal order: the `meal_under_covered` violations with their amounts, which `plan -- status` lists
 * under « Manques ».
 */
export function mealShortfalls(s: State): Shortfall[] {
  const out: Shortfall[] = [];
  for (const meal of s.meals.filter(isOpen)) {
    for (const [key, covered] of coverage(s, meal)) {
      const [productId, unit] = key.split("|") as [string, Unit];
      const need = mealNeed(s, meal, Number(productId), unit);
      if (covered < need) out.push({ mealId: meal.id, productId: Number(productId), unit, qty: need - covered });
    }
  }
  return out;
}

/** A meal's coverage per non-staple `product|unit`, every need key included (at 0 when nothing covers it). */
function coverage(s: State, meal: Meal): Map<string, number> {
  const out = new Map<string, number>();
  const add = (productId: number | null | undefined, unit: Unit | null, qty: number | null) => {
    if (productId == null || unit === null || qty === null) return;
    if (s.products.find((p) => p.id === productId)?.isStaple) return;
    out.set(`${productId}|${unit}`, (out.get(`${productId}|${unit}`) ?? 0) + qty);
  };
  for (const line of s.shoppingItems.filter((l) => l.boughtAt === null && l.removedAt === null)) {
    for (const f of line.forMeals.filter((x) => x.mealId === meal.id)) add(line.productId, line.unit, f.qty);
  }
  for (const r of liveReservations(s).filter((x) => x.mealId === meal.id)) {
    add(s.stockItems.find((i) => i.id === r.stockItemId)?.productId, r.unit, r.qty);
  }
  const recipe = s.recipes.find((r) => r.id === meal.recipeId);
  const ingredients = recipe ? s.recipeIngredients.filter((i) => i.recipeId === recipe.id) : [];
  for (const need of recipe ? recipeNeeds(ingredients, recipe.basePortions, meal.portions, mealMultiplier(meal, s.meals)) : []) {
    add(need.productId, need.unit, 0);
  }
  return out;
}

/**
 * What an undropped meal needs of a product: an open meal's need now, a cooked one's at cook time. A first round cooked
 * while its second round was open was cooked at 2×, which is what its plat cuisiné records (meal.cook creates one then,
 * and only then); the second round's state now says nothing, since it may have been dropped either side of that cook.
 */
function stapleNeed(s: State, meal: Meal, productId: number, unit: Unit): number {
  if (isOpen(meal)) return mealNeed(s, meal, productId, unit);
  const recipe = s.recipes.find((r) => r.id === meal.recipeId);
  if (!recipe) return 0;
  const cookedAt2x = s.stockItems.some((i) => i.origin === "plat_cuisine" && i.sourceMealId === meal.id);
  const multiplier = meal.doubledFrom !== null ? 0 : cookedAt2x ? 2 : 1;
  const ingredients = s.recipeIngredients.filter((i) => i.recipeId === recipe.id);
  return recipeNeeds(ingredients, recipe.basePortions, meal.portions, multiplier)
    .find((n) => n.productId === productId && n.unit === unit)?.qty ?? 0;
}

/**
 * Every meal's shares of staple products on unbought lines, per meal id then `product|unit`, in one pass over the lines
 * (a meal holding no share is absent, so its need is never computed). Exported for its test.
 */
export function stapleSharesByMeal(s: State): Map<number, Map<string, number>> {
  const staples = new Set(s.products.filter((p) => p.isStaple).map((p) => p.id));
  const out = new Map<number, Map<string, number>>();
  for (const line of s.shoppingItems) {
    if (line.boughtAt !== null || line.removedAt !== null || line.productId === null || line.unit === null || !staples.has(line.productId)) continue;
    const key = `${line.productId}|${line.unit}`;
    for (const f of line.forMeals) {
      let shares = out.get(f.mealId);
      if (!shares) out.set(f.mealId, (shares = new Map()));
      shares.set(key, (shares.get(key) ?? 0) + f.qty);
    }
  }
  return out;
}

/** The violations `after` has that `before` did not, by code and subject, in `after`'s order. */
export function newViolations(before: State, after: State): Violation[] {
  const had = new Set(invariantViolations(before).map((v) => `${v.code} ${v.subject}`));
  return invariantViolations(after).filter((v) => !had.has(`${v.code} ${v.subject}`));
}
