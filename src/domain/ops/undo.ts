import { mealShortfalls, newViolations, removalCanLeaveShort, type Violation, type ViolationCode } from "../invariants";
import { isOpen } from "../quantities";
import { cloneState, stableStringify, storedOp, storeOp, tableRows } from "../state";
import type { AppliedOp, Change, Meal, Reservation, Row, ShoppingItem, State, TableName } from "../types";
import { INVALID, applied, payloadObject, refused } from "./helpers";
import type { OpResult } from "./types";

/** Op types an undo refuses outright (the D1 store skips them when it loads the later writes of an undo's rows). */
export const NOT_UNDOABLE: ReadonlySet<string> = new Set(["planning.commit", "product.upsert", "product.nutrition", "product.pack", "undo"]);

/** The refusal of an undo whose target the server holds no record of. */
export const TARGET_MISSING = "action introuvable";
/** The refusal of an undo whose target an earlier undo already took back. */
export const ALREADY_UNDONE = "déjà annulée";
/** The refusal of an undo whose target was answered noop or refused: it changed nothing. */
export const NOTHING_TO_UNDO = "rien à annuler";

/** Every id a row points at, by table: the D1 foreign keys plus the meal ids inside `for_meals`. */
function referencedIds(s: State): Map<TableName, Set<number>> {
  const refs = new Map<TableName, Set<number>>();
  const add = (table: TableName, id: number | null) => {
    if (id === null) return;
    const set = refs.get(table) ?? new Set<number>();
    set.add(id);
    refs.set(table, set);
  };
  for (const i of s.recipeIngredients) { add("recipes", i.recipeId); add("products", i.productId); }
  for (const m of s.meals) { add("plannings", m.planningId); add("recipes", m.recipeId); add("meals", m.doubledFrom); }
  for (const l of s.shoppingItems) {
    add("products", l.productId); add("plannings", l.planningId); add("trips", l.tripId);
    for (const f of l.forMeals) add("meals", f.mealId);
  }
  for (const i of s.stockItems) { add("products", i.productId); add("shoppingItems", i.sourceShoppingItemId); add("meals", i.sourceMealId); }
  for (const r of s.reservations) { add("stockItems", r.stockItemId); add("meals", r.mealId); }
  for (const e of s.envies) add("meals", e.mealId);
  return refs;
}

/** A meal's words when it would reopen with a share on a line taken off Courses since it closed, short of it or not. */
const REMOVED_SINCE = "retiré des courses depuis : impossible d'annuler";

/** The refusal each new violation earns an undo: what changed since, in the words the phone shows. */
const UNDO_REASONS: Record<ViolationCode, string> = {
  reservation_item_missing: "utilisé depuis : impossible d'annuler",
  reservation_meal_missing: "utilisé depuis : impossible d'annuler",
  reserved_finished_item: "article fini depuis : impossible d'annuler",
  reserved_closed_meal: "repas cuisiné ou retiré depuis : impossible d'annuler",
  item_over_reserved: "réservé depuis pour un autre repas : impossible d'annuler",
  second_round_without_plat: "repas cuisiné ou retiré depuis : impossible d'annuler",
  second_round_cooked_first: "second tour cuisiné depuis : impossible d'annuler",
  meal_under_covered: "acheté depuis : impossible d'annuler",
  meal_over_covered: "repas doublé retiré depuis : impossible d'annuler",
  staple_over_shared: "repas doublé retiré depuis : impossible d'annuler",
  dropped_meal_share: "repas cuisiné ou retiré depuis : impossible d'annuler",
  removed_line_open_share: REMOVED_SINCE,
  empty_line_priced: "modifié depuis : impossible d'annuler",
};

/** The meal's words that cover too much is not always a doubled meal dropped: also a hold put back on a meal covered since. */
const COVERED_SINCE = "couvert depuis : impossible d'annuler";

/**
 * The refusal a violation the undo introduces earns, in the words the phone shows, or null when it is tolerated. A meal
 * short of a product is tolerated when the undo reopens it as short as it closed (reopenedShort), or gives back the
 * shortfall its own cover took (shortAsBeforeCover). A meal over-covered names a dropped second round only when that meal
 * has one; otherwise what covered it was another write since (a cover of its shortfall, say).
 */
function refusal(before: State, after: State, target: AppliedOp, v: Violation): string | null {
  if (v.code === "meal_under_covered") {
    const [, meal, product, unit] = /^meal:(\d+)\|product:(\d+)\|(\w+)$/.exec(v.subject)!;
    const mealId = Number(meal);
    const productId = Number(product);
    const reopened = after.meals.find((m) => m.id === mealId);
    const was = before.meals.find((m) => m.id === mealId);
    if (reopened && was && !isOpen(was) && isOpen(reopened)) return reopenedShort(after, mealId, productId, unit!);
    return shortAsBeforeCover(after, target, mealId, productId, unit!) ? null : UNDO_REASONS[v.code];
  }
  if (v.code !== "meal_over_covered") return UNDO_REASONS[v.code];
  const mealId = Number(/^meal:(\d+)\|/.exec(v.subject)![1]);
  return after.meals.some((m) => m.doubledFrom === mealId && m.droppedAt !== null) ? UNDO_REASONS[v.code] : COVERED_SINCE;
}

/** A meal's share on a line, counted only while the line is still on Courses. */
function unboughtShare(line: ShoppingItem | null, mealId: number): number {
  if (!line || line.boughtAt !== null || line.removedAt !== null) return 0;
  return line.forMeals.filter((f) => f.mealId === mealId).reduce((n, f) => n + f.qty, 0);
}

/**
 * Not a state invariant, so the guard cannot see it: a cooked first round legitimately keeps its 2× shares on Courses
 * (cooking leaves the list alone), so only their growth is wrong. An undo that brings back its second round, or undoes
 * that round's drop, must not put shares back on unbought lines for a first round closed since.
 */
function closedFirstRoundRegrows(s: State, changes: Change[]): boolean {
  const regrouped = new Set(
    changes
      .filter((c) => c.table === "meals" && c.before !== null && c.after !== null)
      .filter((c) => (c.before as unknown as Meal).droppedAt !== (c.after as unknown as Meal).droppedAt)
      .map((c) => (c.before as unknown as Meal).doubledFrom)
      .filter((id): id is number => id !== null),
  );
  return s.meals.filter((m) => regrouped.has(m.id) && !isOpen(m)).some((first) =>
    changes.filter((c) => c.table === "shoppingItems").some((c) =>
      unboughtShare(c.before as unknown as ShoppingItem | null, first.id) > unboughtShare(c.after as unknown as ShoppingItem | null, first.id)));
}

/**
 * Not a state invariant either: a cooked meal may keep its share on an unbought line (cooking leaves Courses alone). But
 * `shopping.remove` takes an open meal's share off the line it removes, so a share the line had before the removal and
 * not after it was an open meal's then; undoing the removal once that meal is cooked or dropped would put back on Courses
 * what a closed meal needs. Read from the removal's own rows and the meals' current rows, never from a later op. Only a
 * removal's: a meal.drop also removes a line, one it emptied into another line's spare (mergeIntoSpare), and its undo
 * moves those shares back from that line, cooked meals' included, so Courses carries no more than before the drop. Nor a
 * staple line's: its share never leaves a meal short, so a removal of it is undone whatever its meals became.
 */
function restoresClosedMealShare(s: State, target: AppliedOp): boolean {
  if (target.type !== "shopping.remove") return false;
  return target.changes.filter((c) => c.table === "shoppingItems" && c.before !== null && c.after !== null).some((c) => {
    const before = c.before as unknown as ShoppingItem;
    const after = c.after as unknown as ShoppingItem;
    // a staple share never leaves a meal short (removed_line_open_share and reopenedShort skip a staple line too), and a
    // cooked meal's share on an unbought staple line stays within the need it was cooked at (staple_over_shared)
    if (before.removedAt !== null || after.removedAt === null || !removalCanLeaveShort(after)) return false;
    const kept = new Set(after.forMeals.map((f) => f.mealId));
    return before.forMeals.some((f) => !kept.has(f.mealId) && s.meals.some((m) => m.id === f.mealId && !isOpen(m)));
  });
}

/**
 * A meal the undo reopens, short of a product and unit: null when it comes back as short as it was when the target closed
 * it, else the refusal. As short: a declared leftover may have trimmed its holds before (declared.ts, spec §6.3), and
 * that shortfall is the owners' own, listed under « Manques », as is a line removed « On n'en prend pas » while the meal
 * was open (that removal took the meal's share off the line). Shorter, refused:
 * - a removed planning line still carrying the meal's share (never a staple one: a staple share never leaves a meal
 *   short): `shopping.remove` keeps only the shares of meals already closed, so the meal was closed when the line left
 *   Courses, and its share was still on Courses at the close (« retiré des courses depuis »). Read from the row alone,
 *   never a time or an op order: the D1 store loads only the ops touching the undone rows (a later removal is not among
 *   them), and the phones' clocks disagree. The invariant removed_line_open_share refuses it too, short or not; checked
 *   here first so that it wins over « acheté depuis »;
 * - a line carrying its share bought while it was closed served the other meals only (the purchase left no reservation of
 *   it on the item, live or released), so nothing reserved and nothing on Courses would cover it (« acheté depuis »).
 */
function reopenedShort(after: State, mealId: number, productId: number, unit: string): string | null {
  const carries = (l: ShoppingItem) => l.productId === productId && l.unit === unit && l.forMeals.some((f) => f.mealId === mealId);
  if (after.shoppingItems.some((l) => l.removedAt !== null && removalCanLeaveShort(l) && carries(l))) return REMOVED_SINCE;
  const boughtSince = after.shoppingItems.some((l) => l.boughtAt !== null && carries(l)
    && !after.stockItems.some((i) => i.sourceShoppingItemId === l.id && after.reservations.some((r) => r.stockItemId === i.id && r.mealId === mealId)));
  return boughtSince ? UNDO_REASONS.meal_under_covered : null;
}

/**
 * Undoing a meal.cover_shortfalls brings back the shortfall it covered: that meal was short of it before, and the owners
 * take their cover back. Tolerated on the op's own meal only (the only one whose coverage it raised), and only up to what
 * it covered of that product and unit (its new reservations plus its shares' growth on lines), so an undo never leaves
 * the meal shorter than it was before the op.
 */
function shortAsBeforeCover(after: State, target: AppliedOp, mealId: number, productId: number, unit: string): boolean {
  if (target.type !== "meal.cover_shortfalls") return false;
  const share = (l: ShoppingItem | null) => l?.forMeals.filter((x) => x.mealId === mealId).reduce((n, x) => n + x.qty, 0) ?? 0;
  let covered = 0;
  for (const c of target.changes) {
    if (c.table === "reservations" && c.before === null) {
      const r = c.after as unknown as Reservation;
      const item = after.stockItems.find((i) => i.id === r.stockItemId);
      if (r.mealId === mealId && r.unit === unit && item?.productId === productId) covered += r.qty ?? 0;
    }
    if (c.table === "shoppingItems") {
      const line = c.after as unknown as ShoppingItem | null;
      if (line && line.productId === productId && line.unit === unit) covered += share(line) - share(c.before as unknown as ShoppingItem | null);
    }
  }
  const short = mealShortfalls(after).find((x) => x.mealId === mealId && x.productId === productId && x.unit === unit)?.qty ?? 0;
  return covered > 0 && short <= covered;
}

/**
 * Whether an op applied after `target`, and still in effect, wrote one of its rows. Comparing rows alone misses a later
 * write that left a row as the target had (the same words again, or « un fond », « presque fini », « un fond »): the undo
 * would take the row back under it. An undo's own record is no such write: what it restored, the op it took back wrote.
 */
function writtenSince(s: State, target: AppliedOp): boolean {
  const rows = new Set(target.changes.map((c) => `${c.table}:${c.id}`));
  return Object.values(s.appliedOps).some((o) =>
    o.seq > target.seq && o.type !== "undo" && o.status === "applied" && o.undoneBy === null
    && o.changes.some((c) => rows.has(`${c.table}:${c.id}`)));
}

export function undo(next: State, payload: unknown, _at: string, opId?: string): OpResult {
  const p = payloadObject(payload);
  if (!p || typeof p.targetOpId !== "string") return INVALID;
  const target = storedOp(next.appliedOps, p.targetOpId);
  if (!target) return refused(TARGET_MISSING);
  if (NOT_UNDOABLE.has(target.type)) return refused("cette action ne s'annule pas");
  if (target.status !== "applied") return refused(NOTHING_TO_UNDO);
  if (target.undoneBy !== null) return refused(ALREADY_UNDONE);

  // not a state invariant: the trip row records what was paid, so the purchase is history from then on
  if (target.type === "shopping.buy") {
    const bought = target.changes.find((c) => c.table === "shoppingItems");
    const line = bought && next.shoppingItems.find((l) => l.id === bought.id);
    if (line && line.tripId !== null) return refused("déjà passé en caisse");
  }

  for (const change of target.changes) {
    const current = tableRows(next, change.table).find((r) => r.id === change.id) ?? null;
    if (stableStringify(current) !== stableStringify(change.after)) return refused("modifié depuis : impossible d'annuler");
  }
  if (writtenSince(next, target)) return refused("modifié depuis : impossible d'annuler");
  const before = cloneState(next);
  for (const change of [...target.changes].reverse()) {
    const rows = tableRows(next, change.table);
    const index = rows.findIndex((r) => r.id === change.id);
    if (change.before === null) rows.splice(index, 1);
    else if (index === -1) rows.push(structuredClone(change.before) as Row);
    else rows[index] = structuredClone(change.before) as Row;
  }
  for (const table of new Set(target.changes.map((c) => c.table))) tableRows(next, table).sort((a, b) => a.id - b.id);

  // not covered by the guard: it checks reservations' rows only, while a deleted row can be held by any foreign key
  const refs = referencedIds(next);
  if (target.changes.some((c) => c.before === null && refs.get(c.table)?.has(c.id))) return refused("utilisé depuis : impossible d'annuler");
  // §6.6: the restored state may break no invariant the state before the undo kept; a tolerated one blocks nothing else
  for (const v of newViolations(before, next)) {
    const reason = refusal(before, next, target, v);
    if (reason !== null) return refused(reason);
  }
  if (closedFirstRoundRegrows(next, target.changes) || restoresClosedMealShare(next, target)) {
    return refused("repas cuisiné ou retiré depuis : impossible d'annuler");
  }

  storeOp(next.appliedOps, { ...target, undoneBy: opId ?? "undo" });
  return applied();
}
