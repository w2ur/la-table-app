import { calibration, hasReceipt, type Calibration } from "./calibration";
import { daysBetween, parisDate } from "./dates";
import { mealShortfalls } from "./invariants";
import { recipeNutrition, type RecipeNutrition } from "./nutrition";
import { cookedMultiplier, isOpen, libreQty, liveReservations, recipeNeeds } from "./quantities";
import { RULES } from "./rules.config";
import type { Category, Envie, LineKind, Meal, ProductPack, State, StockItem, Trip, Unit } from "./types";

/** An ingredient of a recipe view: its quantity for the meal's portions (`recipeNeeds`, the pool's scaling). */
export interface MealIngredient {
  productId: number;
  label: string;
  qty: number;
  unit: Unit;
}

/** A meal's recipe as its view shows it (spec §10.1), open or cooked: what the pool and « Cuisinés récemment » share. */
export interface MealRecipe {
  title: string;
  portions: number;
  activeMin: number;
  totalMin: number;
  isSecondRound: boolean;
  steps: string[];
  sourceUrl: string | null;
  /** Scaled to the meal's portions, twice for a first round of a double; a second round's at 1× (it eats the plat cuisiné). */
  ingredients: MealIngredient[];
  /**
   * One portion of the recipe at its base portions (Ciqual values), so a meal planned for more portions or a second round
   * shows the same figures; null when no ingredient has values. Absent from a snapshot an older build stored or served.
   */
  nutrition?: RecipeNutrition | null;
}

export interface PoolMeal extends MealRecipe {
  id: number;
  cookEarlyReason: string | null;
  /** A second round's first round while that one is still in the pool: it is cooked first (spec §6.3); null otherwise. */
  firstRoundId: number | null;
  ingredients: (MealIngredient & { reserved: boolean })[];
  reservedItems: { stockItemId: number; label: string; qty: number | null; unit: Unit | null }[];
  /**
   * What the meal lacks of a product (`mealShortfalls`, spec §6.3: a declared leftover trimmed its hold), by product name.
   * Absent from a snapshot an older build stored or served: the view takes it as none.
   */
  shortfalls?: { label: string; qty: number; unit: Unit }[];
}

export interface CourseLine {
  id: number;
  label: string;
  qty: number | null;
  unit: Unit | null;
  estPriceCents: number | null;
  kind: LineKind;
  group: Category | "ajouts";
  isFood: boolean;
  boughtAt: string | null;
  /** The applied op that bought it, while its row can still undo it (spec §6.6); null when unbought or past the window. */
  buyOpId: string | null;
  /** The open meals an unbought planning line serves (its shares), each once, by id and recipe (id and title); an ajout or a bought line serves none, and a staple line is given none by choice (it does carry open meals' shares, but a staple never creates a « manque », so the removal sheet has no meal to name for it). A row joins its lines' (mealLabels), so two lines of one meal name it once. Absent from a snapshot an older build stored: read as none. */
  mealRefs?: MealRef[];
}

/** An open meal, by id and its recipe (id and title: two recipes may share a title). */
export interface MealRef {
  id: number;
  recipeId: number;
  title: string;
}

export interface ResteItem {
  id: number;
  label: string;
  qty: number | null;
  unit: Unit | null;
  qtyText: string | null;
  isLow: boolean;
  useBy: string | null;
  daysLeft: number | null;
  libreQty: number | null;
  reservations: { mealId: number; mealTitle: string; qty: number | null; unit: Unit | null }[];
  /** A staple (spec §2): in Placard unless its date makes it urgent; never reserved. */
  isStaple: boolean;
  /**
   * Its product's base unit and pack (null for a free-text item or a plat cuisiné), so the phone reads a declared leftover
   * as the server does (declared.ts `declaredLeftover`). Absent from a snapshot an older build stored or served.
   */
  productUnit?: Unit | null;
  pack?: ProductPack | null;
}

/**
 * A meal's recipe as « Cuisinés récemment » keeps it, read-only (spec §10.1). Every field is optional: a snapshot an
 * older build stored or served has none of them, so the view leaves out each part it does not have.
 */
export type CookedRecipe = Partial<Omit<MealRecipe, "title">>;

export interface RecentMeal extends CookedRecipe {
  mealId: number;
  title: string;
  cookedAt: string;
  /** The applied op that cooked it, while its row can still undo it (spec §6.6); null past the window. */
  cookOpId: string | null;
}

/**
 * What a cooked meal keeps of its recipe: all of it but the « réservé » marks (it holds nothing now), and for a second
 * round neither ingredients nor nutrition (it ate the plat cuisiné, as its view says). One function for the server's
 * snapshot and the phone's projection of a cook (src/app/sync/project.ts), so both show the same; the fields are named
 * one by one, so a field added to `MealRecipe` fails the typecheck here, and a pool meal's own fields never leak in.
 */
export function cookedRecipe(recipe: MealRecipe): CookedRecipe {
  const kept: Required<Omit<MealRecipe, "title" | "ingredients" | "nutrition">> = {
    portions: recipe.portions, activeMin: recipe.activeMin, totalMin: recipe.totalMin, isSecondRound: recipe.isSecondRound, steps: recipe.steps,
    sourceUrl: recipe.sourceUrl,
  };
  if (recipe.isSecondRound) return kept;
  const ingredients = recipe.ingredients.map(({ productId, label, qty, unit }) => ({ productId, label, qty, unit }));
  // a pool meal an older app stored has no nutrition: the cooked one has none either, rather than a made-up null
  return recipe.nutrition === undefined ? { ...kept, ingredients } : { ...kept, ingredients, nutrition: recipe.nutrition };
}

export interface Snapshot {
  version: number;
  today: string;
  menu: { pool: PoolMeal[]; recentlyCooked: RecentMeal[]; envies: Envie[] };
  courses: { lines: CourseLine[]; estimateCents: number; budgetCents: number };
  reste: { urgent: ResteItem[]; reserved: ResteItem[]; libre: ResteItem[]; placard: ResteItem[] };
  /** The trip recorded last, whatever its date: a forgotten trip recorded with a past date is the one whose ticket is due. */
  lastTrip: Trip | null;
  calibration: Calibration;
}

export type ResteSection = keyof Snapshot["reste"];

/** Reste's sections in the order the screen and `plan -- status` show them. */
export const RESTE_SECTIONS: readonly ResteSection[] = ["urgent", "reserved", "libre", "placard"];

/** Every Reste item, a section after the other: a snapshot's, or the phone's view of it. */
export function resteItems<T>(lists: { reste: Record<ResteSection, T[]> }): T[] {
  return RESTE_SECTIONS.flatMap((section) => lists.reste[section]);
}

/**
 * Spec §10.3: À utiliser vite (within RULES.urgentWithinDays, past dates included), then Réservé, then Placard for a
 * staple, Libre for the rest. Shared with the phone's projection (src/app/sync/project.ts), so a predicted item lands
 * where the server's next snapshot puts it.
 */
export function resteSection(item: Pick<ResteItem, "daysLeft" | "reservations" | "isStaple">): ResteSection {
  if (item.daysLeft !== null && item.daysLeft <= RULES.urgentWithinDays) return "urgent";
  if (item.reservations.length > 0) return "reserved";
  return item.isStaple ? "placard" : "libre";
}

/** The op types whose rows offer undo once their « Annuler » bar is gone: a cooked meal, a bought line (spec §6.6). */
export const UNDO_FROM_ROW_TYPES = ["meal.cook", "shopping.buy"] as const;

/** Oldest op time whose record still lets its row be undone; the store loads the records from then on. */
export function undoWindowStart(now: string): string {
  return new Date(Date.parse(now) - RULES.undoFromRowDays * 86_400_000).toISOString();
}

/** The open meals among `mealIds`, each once, in first-seen order. */
function mealRefsOf(mealIds: readonly number[], recipes: ReadonlyMap<number, Pick<MealRef, "recipeId" | "title">>): MealRef[] {
  return [...new Set(mealIds)].flatMap((id) => {
    const recipe = recipes.get(id);
    return recipe === undefined ? [] : [{ id, ...recipe }];
  });
}

/** One name per recipe (by id, not title: two recipes may share one, and are listed apart) in first-seen order, « Titre ×2 » when two distinct meals are of it. */
export function mealLabels(refs: readonly MealRef[]): string[] {
  const perRecipe = new Map<number, { title: string; meals: Set<number> }>();
  for (const { id, recipeId, title } of refs) {
    const entry = perRecipe.get(recipeId) ?? { title, meals: new Set<number>() };
    entry.meals.add(id);
    perRecipe.set(recipeId, entry);
  }
  return [...perRecipe.values()].map(({ title, meals }) => (meals.size > 1 ? `${title} ×${meals.size}` : title));
}

/**
 * For each meal cooked and each line bought by an op applied since `since` and not undone, that op's id. Read from the
 * op records the state holds (the store loads those of the window), never from the rows: a row does not know its op.
 */
export function undoTargets(state: State, since: string): { cooked: Map<number, string>; bought: Map<number, string> } {
  const cooked = new Map<number, string>();
  const bought = new Map<number, string>();
  for (const rec of Object.values(state.appliedOps)) {
    if (rec.status !== "applied" || rec.undoneBy !== null || rec.appliedAt < since) continue;
    for (const c of rec.changes) {
      if (c.before === null || c.after === null) continue;
      if (rec.type === "meal.cook" && c.table === "meals" && c.before.cookedAt === null && c.after.cookedAt !== null) cooked.set(c.id, rec.opId);
      if (rec.type === "shopping.buy" && c.table === "shoppingItems" && c.before.boughtAt === null && c.after.boughtAt !== null) bought.set(c.id, rec.opId);
    }
  }
  return { cooked, bought };
}

export function snapshot(state: State, now: string): Snapshot {
  const today = parisDate(now);
  const undo = undoTargets(state, undoWindowStart(now));
  const live = liveReservations(state);
  const recipe = (id: number) => state.recipes.find((r) => r.id === id)!;
  const titleOfMeal = (mealId: number) => {
    const meal = state.meals.find((m) => m.id === mealId);
    return meal ? recipe(meal.recipeId).title : `repas #${mealId}`;
  };

  const products = new Map(state.products.map((p) => [p.id, p]));
  // a meal's recipe as its view shows it, open or cooked: at the double it was cooked for (`cookedMultiplier`), a second
  // round's at 1× (it eats the plat cuisiné), nutrition per base portion
  const recipeView = (m: Meal): MealRecipe => {
    const r = recipe(m.recipeId);
    const mult = cookedMultiplier(m, state.meals);
    const own = state.recipeIngredients.filter((i) => i.recipeId === r.id);
    const ingredients = recipeNeeds(own, r.basePortions, m.portions, mult === 0 ? 1 : mult).map((n) => ({
      productId: n.productId, label: products.get(n.productId)?.name ?? "?", qty: n.qty, unit: n.unit,
    }));
    return {
      title: r.title, portions: m.portions, activeMin: r.activeMin, totalMin: r.totalMin, steps: r.steps, sourceUrl: r.sourceUrl,
      isSecondRound: m.doubledFrom !== null, ingredients, nutrition: recipeNutrition(own, r.basePortions, state.products, products),
    };
  };

  const shortfalls = mealShortfalls(state);
  const open = state.meals.filter(isOpen);
  const pool: PoolMeal[] = open
    .map((m) => {
      const view = recipeView(m);
      const mine = live.filter((x) => x.mealId === m.id);
      const reservedProducts = new Set(mine.map((x) => state.stockItems.find((s) => s.id === x.stockItemId)?.productId));
      return {
        id: m.id, ...view,
        cookEarlyReason: m.cookEarlyReason,
        firstRoundId: m.doubledFrom !== null && open.some((o) => o.id === m.doubledFrom) ? m.doubledFrom : null,
        ingredients: view.ingredients.map((i) => ({ ...i, reserved: reservedProducts.has(i.productId) })),
        reservedItems: mine.map((x) => ({
          stockItemId: x.stockItemId, label: state.stockItems.find((s) => s.id === x.stockItemId)?.label ?? "?", qty: x.qty, unit: x.unit,
        })),
        shortfalls: shortfalls.filter((s) => s.mealId === m.id).map((s) => ({ label: products.get(s.productId)?.name ?? "?", qty: s.qty, unit: s.unit })),
      };
    })
    .sort((a, b) => Number(b.cookEarlyReason !== null) - Number(a.cookEarlyReason !== null) || a.id - b.id);

  const recentlyCooked = state.meals
    .filter((m) => m.cookedAt !== null && daysBetween(parisDate(m.cookedAt), today) <= 7)
    .sort((a, b) => b.cookedAt!.localeCompare(a.cookedAt!))
    .map((m): RecentMeal => ({ mealId: m.id, title: recipe(m.recipeId).title, cookedAt: m.cookedAt!, cookOpId: undo.cooked.get(m.id) ?? null, ...cookedRecipe(recipeView(m)) }));

  // each open meal's recipe, for the lines that name the meals they serve (mealRefsOf)
  const mealRecipes = new Map(open.map((m) => [m.id, { recipeId: m.recipeId, title: recipe(m.recipeId).title }]));
  const shown = state.shoppingItems.filter((l) => l.removedAt === null && (l.boughtAt === null || l.tripId === null));
  const lines: CourseLine[] = shown.map((l) => ({
    id: l.id, label: l.label, qty: l.qty, unit: l.unit, estPriceCents: l.estPriceCents, kind: l.kind,
    group: l.productId === null ? "ajouts" : products.get(l.productId)!.category, isFood: l.isFood, boughtAt: l.boughtAt,
    buyOpId: l.boughtAt === null ? null : (undo.bought.get(l.id) ?? null),
    // a staple line is never kind planning (a product turns staple only while no unbought line holds a share of it)
    mealRefs: l.boughtAt !== null || l.kind !== "planning"
      ? []
      : mealRefsOf(l.forMeals.map((s) => s.mealId), mealRecipes),
  }));
  const shownPlannings = new Set(shown.filter((l) => l.kind === "planning" && l.planningId !== null).map((l) => l.planningId));
  const estimateCents = shown.filter((l) => l.kind === "planning").reduce((s, l) => s + (l.estPriceCents ?? 0), 0);
  const budgetCents = state.plannings.filter((p) => shownPlannings.has(p.id)).reduce((s, p) => s + p.budgetCents, 0);

  const toResteItem = (i: StockItem): ResteItem => ({
    id: i.id, label: i.label, qty: i.qty, unit: i.unit, qtyText: i.qtyText, isLow: i.isLow, useBy: i.useBy,
    daysLeft: i.useBy === null ? null : daysBetween(today, i.useBy),
    libreQty: libreQty(i, live),
    reservations: live.filter((r) => r.stockItemId === i.id).map((r) => ({ mealId: r.mealId, mealTitle: titleOfMeal(r.mealId), qty: r.qty, unit: r.unit })),
    isStaple: i.productId !== null && products.get(i.productId)?.isStaple === true,
    productUnit: i.productId === null ? null : (products.get(i.productId)?.defaultUnit ?? null),
    pack: i.productId === null ? null : (products.get(i.productId)?.pack ?? null),
  });
  const reste: Snapshot["reste"] = { urgent: [], reserved: [], libre: [], placard: [] };
  for (const item of state.stockItems.filter((i) => i.finishedAt === null).map(toResteItem)) reste[resteSection(item)].push(item);
  reste.urgent.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));

  // a trip without a receipt is not the last one: it would hide the real trip's total and make « autre » the next default place
  const lastTrip = state.trips.filter(hasReceipt).sort((a, b) => b.id - a.id)[0] ?? null;
  return {
    version: state.version,
    today,
    menu: { pool, recentlyCooked, envies: state.envies.filter((e) => e.status !== "placee") },
    courses: { lines, estimateCents, budgetCents },
    reste,
    lastTrip,
    calibration: calibration(state),
  };
}
