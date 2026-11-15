import { packedQty, referencePriceCents } from "../packs";
import { isOpen, liveReservations, mealNeed, reservedQty, sharedQty } from "../quantities";
import { isRecord } from "../shape";
import { cookEarlyReason, libreTake } from "../shopping-plan";
import { nextId } from "../state";
import type { Meal, RemoveReason, Reservation, ShoppingItem, State, StockItem, Unit } from "../types";
import type { OpResult } from "./types";

export const applied = (): OpResult => ({ status: "applied", reason: null });
export const noop = (reason: string | null = null): OpResult => ({ status: "noop", reason });
export const refused = (reason: string): OpResult => ({ status: "refused", reason });
export const INVALID = refused("données invalides");
/** An envelope parseEnvelope rejects: no resend of the same op can change this answer, so it is final though unrecorded. */
export const MALFORMED = refused("opération mal formée");
/** The most ops one POST /api/ops may carry: the Worker answers 413 past it (src/worker/app.ts), and so does the demo's local server. */
export const MAX_OPS = 100;

export function payloadObject(p: unknown): Record<string, unknown> | null {
  return isRecord(p) ? p : null;
}
export const int = (v: unknown): v is number => Number.isInteger(v);
export const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
export const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
export const bool = (v: unknown): v is boolean => typeof v === "boolean";
export const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function releaseReservationsOf(next: State, mealId: number, at: string): void {
  for (const r of next.reservations) if (r.mealId === mealId && r.releasedAt === null) r.releasedAt = at;
}

/**
 * Removes up to `qty` of a meal's share from an unbought line. Without a pack in the line's unit, the quantity drops by
 * the share and the price pro rata, so it stays proportional within half a cent per share taken off; the first drop
 * takes exactly the meal's cost as check's mealCostsCents rounds it. With a pack in the line's unit and a quantity that
 * is a whole number of packs, the line is bought again in whole packs for the shares left (never more than it was), and
 * the price follows the quantity pro rata; a line planned before its product had a pack, which is no such multiple,
 * keeps the exact arithmetic.
 */
function reduceShare(next: State, line: ShoppingItem, mealId: number, qty: number, at: string, touched: Set<ShoppingItem>): void {
  const share = line.forMeals.find((f) => f.mealId === mealId);
  if (!share) return;
  touched.add(line);
  const removed = Math.min(qty, share.qty);
  line.forMeals = line.forMeals.flatMap((f) => (f.mealId !== mealId ? [f] : f.qty > removed ? [{ ...f, qty: f.qty - removed }] : []));
  if (line.qty !== null) {
    const pack = line.unit === null ? null : (next.products.find((p) => p.id === line.productId)?.pack ?? null);
    const packed = pack !== null && pack.unit === line.unit && line.qty % pack.qty === 0;
    const left = sharedQty(line);
    const newQty = packed ? Math.min(line.qty, packedQty(left, line.unit!, pack)) : line.qty - removed;
    if (line.qty > 0 && line.estPriceCents !== null) {
      line.estPriceCents = packed
        ? Math.round((line.estPriceCents * newQty) / line.qty)
        : line.estPriceCents - Math.round((line.estPriceCents * removed) / line.qty);
    }
    line.qty = newQty;
  }
  if (line.forMeals.length === 0 && line.kind !== "ajout") line.removedAt = at;
}

const unboughtLines = (next: State): ShoppingItem[] => next.shoppingItems.filter((l) => l.boughtAt === null && l.removedAt === null);

/**
 * After a drop, each unbought planning line it touched whose remaining shares all fit in the spare of another unbought
 * planning line of that product and unit (the lowest id first) hands them over, merged per meal, and is emptied and
 * removed: two packs half-held by one meal become one. The receiving line keeps its qty and price.
 */
function mergeIntoSpare(next: State, touched: Set<ShoppingItem>, at: string): void {
  const open = (l: ShoppingItem): boolean => l.boughtAt === null && l.removedAt === null && l.kind === "planning";
  for (const line of [...touched].sort((a, b) => a.id - b.id)) {
    if (!open(line) || line.forMeals.length === 0) continue;
    const moved = sharedQty(line);
    const receiver = next.shoppingItems
      .filter((l) => l !== line && open(l) && l.productId === line.productId && l.unit === line.unit && l.qty !== null && l.qty - sharedQty(l) >= moved)
      .sort((a, b) => a.id - b.id)[0];
    if (!receiver) continue;
    for (const f of line.forMeals) {
      const held = receiver.forMeals.find((r) => r.mealId === f.mealId);
      if (held) held.qty += f.qty;
      else receiver.forMeals.push({ ...f });
    }
    line.forMeals = [];
    line.qty = 0;
    if (line.estPriceCents !== null) line.estPriceCents = 0;
    line.removedAt = at;
  }
}

/**
 * §6.4 drop_meal and §6.5 meal.drop: drop, release, subtract this meal's share from unbought lines. Drops a second round
 * with its first. A second round dropped alone has no share of its own: its first round's reservations shrink to the 1×
 * need so that stock bought at 2× is libre again, then its shares on unbought lines shrink until shares plus
 * reservations cover exactly the 1× need, however many lines carry them. Last, the lines it touched move their shares
 * into another line's spare where they fit (mergeIntoSpare).
 */
export function dropMeal(next: State, meal: Meal, at: string): void {
  const touched = new Set<ShoppingItem>();
  const targets = [meal, ...next.meals.filter((m) => m.doubledFrom === meal.id && isOpen(m))];
  for (const m of targets) {
    m.droppedAt = at;
    releaseReservationsOf(next, m.id, at);
    for (const line of unboughtLines(next)) {
      const share = line.forMeals.find((f) => f.mealId === m.id);
      if (share) reduceShare(next, line, m.id, share.qty, at, touched);
    }
    const first = m.doubledFrom === null ? undefined : next.meals.find((f) => f.id === m.doubledFrom);
    if (first && isOpen(first)) {
      trimReservations(next, first, at);
      trimShares(next, first, at, touched);
    }
  }
  mergeIntoSpare(next, touched, at);
}

/** Shrinks a meal's live reservations, latest first, down to what it still needs of each product and unit. */
function trimReservations(next: State, meal: Meal, at: string): void {
  const groups = new Map<string, { productId: number; unit: Unit; rows: Reservation[] }>();
  for (const r of liveReservations(next).filter((x) => x.mealId === meal.id && x.qty !== null && x.unit !== null)) {
    const productId = next.stockItems.find((s) => s.id === r.stockItemId)?.productId ?? null;
    if (productId === null) continue;
    const key = `${productId}|${r.unit}`;
    const group = groups.get(key) ?? { productId, unit: r.unit!, rows: [] };
    group.rows.push(r);
    groups.set(key, group);
  }
  for (const { productId, unit, rows } of groups.values()) {
    let excess = rows.reduce((n, r) => n + r.qty!, 0) - mealNeed(next, meal, productId, unit);
    for (const r of [...rows].sort((a, b) => b.id - a.id)) {
      if (excess <= 0) break;
      if (r.qty! <= excess) {
        excess -= r.qty!;
        r.releasedAt = at;
      } else {
        r.qty = r.qty! - excess;
        excess = 0;
      }
    }
  }
}

/**
 * Shrinks a meal's shares on unbought lines, latest line first, so that its shares plus its live reservations come down
 * to what it still needs of each product and unit. The excess is taken once per product and unit, spread across lines.
 */
function trimShares(next: State, meal: Meal, at: string, touched: Set<ShoppingItem>): void {
  const groups = new Map<string, { productId: number; unit: Unit; lines: ShoppingItem[] }>();
  for (const line of unboughtLines(next)) {
    if (line.productId === null || line.unit === null || !line.forMeals.some((f) => f.mealId === meal.id)) continue;
    const key = `${line.productId}|${line.unit}`;
    const group = groups.get(key) ?? { productId: line.productId, unit: line.unit, lines: [] };
    group.lines.push(line);
    groups.set(key, group);
  }
  for (const { productId, unit, lines } of groups.values()) {
    const shared = lines.reduce((n, l) => n + (l.forMeals.find((f) => f.mealId === meal.id)?.qty ?? 0), 0);
    let excess = shared + reservedQty(next, meal.id, productId, unit) - mealNeed(next, meal, productId, unit);
    for (const line of [...lines].sort((a, b) => b.id - a.id)) {
      if (excess <= 0) break;
      const share = line.forMeals.find((f) => f.mealId === meal.id)!.qty;
      const removed = Math.min(share, excess);
      reduceShare(next, line, meal.id, removed, at, touched);
      excess -= removed;
    }
  }
}

export const isRemoveReason = (v: unknown): v is RemoveReason => v === "a_la_maison" || v === "pas_achete";

export type Resolution = "drop_meal" | "rebuy";
export const isResolution = (v: unknown): v is Resolution => v === "drop_meal" || v === "rebuy";

/**
 * §6.4 rebuy: pro rata from the source line when there is one, else from the latest priced line of that product and unit,
 * else unknown. A line's price is what its planned quantity cost: a line a receipt corrected (shopping.set_bought_qty) is
 * read per unit against its plannedQty, never against the quantity bought.
 */
function rebuyPriceCents(next: State, productId: number | null, sourceLineId: number | null, qty: number, unit: Unit): number | null {
  const basisQty = (l: ShoppingItem): number => l.plannedQty ?? l.qty ?? 0;
  const priced = (l: ShoppingItem): boolean => l.estPriceCents !== null && basisQty(l) > 0 && l.unit === unit;
  const source = sourceLineId === null ? undefined : next.shoppingItems.find((l) => l.id === sourceLineId);
  const basis = source && priced(source)
    ? source
    : next.shoppingItems
      .filter((l) => productId !== null && l.productId === productId && priced(l))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
  return basis ? Math.round((basis.estPriceCents! * qty) / basisQty(basis)) : null;
}

/** A live reservation of `qty` of a stock item for a meal, appended to the state and returned. */
export function pushReservation(next: State, { stockItemId, mealId, qty, unit, at }: { stockItemId: number; mealId: number; qty: number; unit: Unit; at: string }): Reservation {
  const reservation: Reservation = { id: nextId(next, "reservations"), stockItemId, mealId, qty, unit, releasedAt: null, createdAt: at };
  next.reservations.push(reservation);
  return reservation;
}

/** What reserveLibreStock reads: the caller builds each list once per product, and `today` once per op. */
export interface LibreStock {
  /** the unfinished items of one product, in the order a need takes them (stockByUseBy: earliest use-by first) */
  stock: readonly StockItem[];
  /** the live reservations, which each new one joins so that a later call in the same op sees it */
  live: Reservation[];
  unit: Unit;
  qty: number;
  at: string;
  /** the Paris day of `at` */
  today: string;
  /** skip the items marked « presque fini » (isLow), whatever their quantity: « On en a déjà » never reserves a share on an almost empty item */
  skipLow?: boolean;
}

/**
 * Reserves for `meal`, up to `qty`, the libre quantity of the `stock` items in `unit`, in the order given, under `live`.
 * An item of unknown quantity takes nothing; one near its use-by flags the meal « à cuisiner tôt », a reason it keeps once
 * given. Shared by `meal.cover_shortfalls` and « On en a déjà » (`shopping.remove`). Returns the quantity reserved.
 */
export function reserveLibreStock(next: State, meal: Meal, { stock, live, unit, qty, at, today, skipLow }: LibreStock): number {
  let remaining = qty;
  for (const item of stock) {
    if (remaining === 0) break;
    if (skipLow && item.isLow) continue;
    const take = libreTake(item, live, unit, remaining);
    if (take === 0) continue;
    live.push(pushReservation(next, { stockItemId: item.id, mealId: meal.id, qty: take, unit, at }));
    meal.cookEarlyReason ??= cookEarlyReason(item, today);
    remaining -= take;
  }
  return qty - remaining;
}

/** A meal's need for a product, in one unit, that Courses must carry: what a rebuy puts back and a shortfall lacks. */
export interface CoverNeed {
  meal: Meal;
  productId: number | null;
  /** the new line's label: the stock item's for a rebuy, the product's name for a shortfall */
  label: string;
  unit: Unit;
  qty: number;
  /** the line a rebuy's item was bought from, which prices a new line before any other; null for a shortfall */
  sourceLineId: number | null;
}

/**
 * §6.4: puts a meal's need on Courses. The first unbought `planning` line of that product and unit, in list order, whose
 * spare (`qty − Σ shares`) holds the whole amount takes it as the meal's share (its own share grows, one per meal per
 * line); otherwise a new `planning` line carries it alone, rounded up to whole packs, priced from the reference price,
 * else rebuyPriceCents. Never split across lines.
 */
export function coverNeed(next: State, need: CoverNeed, at: string): void {
  const { meal, productId, label, unit, qty, sourceLineId } = need;
  const spareLine = next.shoppingItems.find((l) => l.boughtAt === null && l.removedAt === null && l.kind === "planning"
    && l.productId === productId && l.unit === unit && l.qty !== null && l.qty - sharedQty(l) >= qty);
  if (spareLine) {
    const held = spareLine.forMeals.find((f) => f.mealId === meal.id);
    if (held) held.qty += qty;
    else spareLine.forMeals.push({ mealId: meal.id, qty });
    return;
  }
  const product = next.products.find((p) => p.id === productId);
  const lineQty = packedQty(qty, unit, product?.pack ?? null);
  next.shoppingItems.push({
    id: nextId(next, "shoppingItems"), productId, label, qty: lineQty, unit, plannedQty: null,
    estPriceCents: referencePriceCents(lineQty, unit, product?.price ?? null) ?? rebuyPriceCents(next, productId, sourceLineId, lineQty, unit),
    kind: "planning", planningId: meal.planningId,
    forMeals: [{ mealId: meal.id, qty }], isFood: true, boughtAt: null, tripId: null, removedAt: null, createdAt: at,
  });
}

/**
 * §6.4 reservation warning, shared by stock.finish and a cook sheet's « fini »: an item still reserved for an open meal
 * is finished only with a resolution. Returns the refusal reason, or null once every holding meal is settled. A plat
 * cuisiné cannot be bought back, so its reservation only accepts drop_meal.
 */
export function settleReservations(next: State, item: StockItem, resolution: Resolution | null, at: string): string | null {
  const holding = liveReservations(next)
    .filter((r) => r.stockItemId === item.id)
    .map((r) => ({ r, meal: next.meals.find((m) => m.id === r.mealId) }))
    .filter((h): h is { r: Reservation; meal: Meal } => h.meal !== undefined && isOpen(h.meal));
  if (holding.length === 0) return null;
  if (resolution === null) {
    const titles = holding.map(({ meal }) => next.recipes.find((rc) => rc.id === meal.recipeId)?.title ?? `repas #${meal.id}`);
    return `réservé pour ${[...new Set(titles)].join(", ")}`;
  }
  if (resolution === "rebuy" && holding.some(({ r }) => r.qty === null || r.unit === null)) {
    return "un plat cuisiné ne se rachète pas ; retirez le repas";
  }
  for (const { r, meal } of holding) {
    if (resolution === "drop_meal") {
      dropMeal(next, meal, at);
    } else {
      r.releasedAt = at;
      coverNeed(next, { meal, productId: item.productId, label: item.label, unit: r.unit!, qty: r.qty!, sourceLineId: item.sourceShoppingItemId }, at);
    }
  }
  return null;
}

/** Remaining quantity a meal still needs of a product, after its live reservations. */
export function mealRemainingNeed(next: State, meal: Meal, productId: number, unit: Unit): number {
  return Math.max(0, mealNeed(next, meal, productId, unit) - reservedQty(next, meal.id, productId, unit));
}
