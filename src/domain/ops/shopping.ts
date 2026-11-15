import { addDays, parisDate } from "../dates";
import { declaredLeftover } from "../declared";
import { cookEarlyReason, stockByUseBy } from "../shopping-plan";
import { isOpen, liveReservations } from "../quantities";
import { nextId } from "../state";
import { isWebUrl } from "../text";
import type { Meal, Reservation, ShoppingItem, State, StockOrigin, Unit } from "../types";
import { INVALID, applied, bool, int, isDate, isRemoveReason, mealRemainingNeed, noop, payloadObject, pushReservation, refused, reserveLibreStock, str } from "./helpers";
import type { OpResult } from "./types";

/**
 * §6.2. A tick on a line no longer on Courses is refused, nothing entering Reste: a planned line taken off by
 * `shopping.remove` (the other phone, or a planning) or by a drop answers « retiré des courses », so the owners who did buy
 * it re-add it as an ajout; a removed ajout, like an unknown line, « article introuvable ».
 */
export function buy(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.itemId)) return INVALID;
  const line = next.shoppingItems.find((l) => l.id === p.itemId);
  if (!line || (line.removedAt !== null && line.kind === "ajout")) return refused("article introuvable");
  if (line.removedAt !== null) return refused("retiré des courses");
  if (line.boughtAt !== null) return noop("déjà acheté");
  line.boughtAt = at;
  // only a planning line of food reserves for its meals, each open one owed its whole share
  enterReste(next, line, at, line.qty, "achat", line.isFood && line.kind === "planning" ? openShares(next, line) : []);
  return applied();
}

/** An open meal on a line, and a quantity of its share: the share itself (openShares), or what of it the line still owes. */
interface OpenShare {
  meal: Meal;
  qty: number;
}

/**
 * The shares of a line that open meals hold, in the line's order, read once per op: only the meals the shares name are
 * looked up, and nothing an op does here closes or reopens one.
 */
function openShares(next: State, line: ShoppingItem): OpenShare[] {
  return line.forMeals.flatMap((share) => {
    const meal = next.meals.find((m) => m.id === share.mealId);
    return meal && isOpen(meal) ? [{ meal, qty: share.qty }] : [];
  });
}

/**
 * §6.2: a line's food enters Reste (`qty` in the line's unit, use-by from the shelf life, `sourceShoppingItemId` the line for a
 * purchase only) and
 * each open meal of a planning line is reserved its share, then any surplus goes to a need nothing else covers. Shared by
 * `shopping.buy` (the line's quantity, `origin: achat`) and a removal « On en a déjà » (`atHomeQty`, `origin: ajout`:
 * declared by the owners, not bought, so it names no line: the purchase link keeps one meaning, the item a buy made, which a
 * receipt moves): the caller first takes the line off
 * Courses (`boughtAt` or `removedAt`), since `unboughtShares` would otherwise count it and the surplus pass under-reserve.
 * `owed` lists the line's open meals in its order (openShares), each with what of its share the line still owes it: the
 * whole share for a buy, less what free Reste stock already gave it for « On en a déjà » (reserveFreeStock). A meal's
 * first pass is capped at that, so it never takes what the line set aside for a later meal.
 */
function enterReste(next: State, line: ShoppingItem, at: string, qty: number | null, origin: StockOrigin, owed: readonly OpenShare[]): void {
  if (!line.isFood) return;
  const product = line.productId === null ? undefined : next.products.find((pr) => pr.id === line.productId);
  const stockId = nextId(next, "stockItems");
  next.stockItems.push({
    id: stockId,
    productId: line.productId,
    label: line.label,
    qty,
    unit: line.unit,
    qtyText: null,
    isLow: false,
    useBy: product?.shelfLifeDays != null ? addDays(parisDate(at), product.shelfLifeDays) : null,
    openedAt: null,
    finishedAt: null,
    origin,
    sourceShoppingItemId: origin === "achat" ? line.id : null,
    sourceMealId: null,
    createdAt: at,
  });

  if (line.productId !== null && qty !== null && line.unit !== null && line.kind === "planning") {
    const productId = line.productId;
    const unit = line.unit;
    let available = qty;
    const reserve = (meal: Meal, take: number) => {
      if (take <= 0) return;
      pushReservation(next, { stockItemId: stockId, mealId: meal.id, qty: take, unit, at });
      available -= take;
    };
    // each meal first gets what this line set aside for it, so a share it still holds on another unbought line stays its own
    for (const { qty: left, meal } of owed) reserve(meal, Math.min(available, left, mealRemainingNeed(next, meal, productId, unit)));
    // a surplus only goes to a need that no reservation and no unbought line covers yet
    for (const { meal } of owed) reserve(meal, Math.min(available, mealRemainingNeed(next, meal, productId, unit) - unboughtShares(next, meal.id, productId, unit)));
  }
}

/** What a meal still holds on unbought lines of a product and unit. */
function unboughtShares(next: State, mealId: number, productId: number, unit: Unit): number {
  return next.shoppingItems
    .filter((l) => l.boughtAt === null && l.removedAt === null && l.productId === productId && l.unit === unit)
    .reduce((n, l) => n + l.forMeals.filter((f) => f.mealId === mealId).reduce((m, f) => m + f.qty, 0), 0);
}

export function addAjout(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !str(p.label) || !bool(p.isFood)) return INVALID;
  next.shoppingItems.push({
    id: nextId(next, "shoppingItems"), productId: null, label: p.label.trim(), qty: null, unit: null, plannedQty: null, estPriceCents: null,
    kind: "ajout", planningId: null, forMeals: [], isFood: p.isFood, boughtAt: null, tripId: null, removedAt: null, createdAt: at,
  });
  return applied();
}

/**
 * The open meals' shares of a line as « On en a déjà » reads them, once: each at most the meal's remaining need
 * (mealRemainingNeed), so no quantity enters Reste or is reserved that the meal does not need. What a reservation takes
 * off a meal's need it takes off its share too (min(share, need) - given = min(share - given, need - given)), so the later
 * steps (reserveFreeStock's `owed`, reserveUnheldUnknown, enterReste) read these and never the need again. A line without
 * a product or a unit has no need to cap by.
 */
function cappedShares(next: State, line: ShoppingItem, open: readonly OpenShare[]): OpenShare[] {
  const { productId, unit } = line;
  if (productId === null || unit === null) return [...open];
  return open.map(({ meal, qty }) => ({ meal, qty: Math.min(qty, mealRemainingNeed(next, meal, productId, unit)) }));
}

/**
 * What « On en a déjà » puts in Reste: for a planning line, what its open meals need of it (Σ their capped shares,
 * cappedShares), not its quantity rounded up to whole packs, since no pack was bought. A staple line, or one no open meal holds a share of, says
 * only that some is at home: an item of unknown quantity (null, as « Il en reste » without words leaves one), never the
 * line's quantity, which nobody counted; a line at 0 still puts nothing.
 */
function atHomeQty(line: ShoppingItem, shares: readonly OpenShare[]): number | null {
  if (shares.length > 0) return shares.reduce((n, { qty }) => n + qty, 0);
  return line.qty === 0 ? 0 : null;
}

/** What reserveFreeStock leaves: the line's `owed` per meal, the `taken` total, and the live reservations (its own included) and Paris day it read, which reserveUnheldUnknown reuses. */
interface FreeStock {
  owed: OpenShare[];
  taken: number;
  live: readonly Reservation[];
  today: string;
}

/**
 * « On en a déjà » on a planning line, before anything enters Reste: each open meal on the line (`shares`, cappedShares)
 * reserves, up to its capped share, the libre quantity of unfinished Reste items of the line's product
 * and unit, in use-by order (reserveLibreStock, shared with `meal.cover_shortfalls`, which also takes an item marked « presque fini »; here it is skipped, as reserveUnheldUnknown skips it); with no open meal, Reste is not
 * read. Returns what the line still owes each meal, its share less what the free stock gave it (enterReste's `owed`),
 * and the total the free stock gave: the new item then holds none of it (`owed` is already within each meal's need).
 */
function reserveFreeStock(next: State, line: ShoppingItem, at: string, shares: readonly OpenShare[]): FreeStock {
  const today = parisDate(at);
  // no open meal on the line: nothing to reserve for, so Reste is not read (and reserveUnheldUnknown, which needs the
  // reservations only for a meal still owed, finds none owed)
  if (shares.length === 0 || line.productId === null || line.unit === null) return { owed: [...shares], taken: 0, live: [], today };
  const productId = line.productId;
  const unit = line.unit;
  const stock = stockByUseBy(next).filter((i) => i.productId === productId);
  const live = liveReservations(next);
  let taken = 0;
  const owed = shares.map(({ qty, meal }) => {
    const given = reserveLibreStock(next, meal, { stock, live, unit, qty, at, today, skipLow: true });
    taken += given;
    return { meal, qty: qty - given };
  });
  return { owed, taken, live, today };
}

/**
 * « On en a déjà », after the free stock (reserveFreeStock, whose `owed`, live reservations and day it reads), decided by the owners so that Reste never shows the product twice:
 * when exactly one open meal on the line is still owed something, and an unfinished item of unknown quantity of the line's
 * product and unit (its product's base unit when it has none), not marked « presque fini » (an almost empty item must not
 * cover a whole share), is held by no live reservation, that meal's remaining share
 * is reserved on it (the oldest by `createdAt` when several, then the lowest id), flagging the meal « à cuisiner tôt » as
 * free stock does, and the caller puts no item in Reste. Two meals owed, or every such item already held, and nothing is reserved: an item of unknown quantity
 * holds one reservation at most (invariants.ts `item_over_reserved`). Returns whether it reserved.
 */
function reserveUnheldUnknown(next: State, line: ShoppingItem, at: string, free: FreeStock): boolean {
  if (line.productId === null || line.unit === null) return false;
  const productId = line.productId;
  const unit = line.unit;
  const { owed, live, today } = free;
  const due = owed.filter(({ qty }) => qty > 0);
  if (due.length !== 1) return false;
  const held = new Set(live.map((r) => r.stockItemId));
  // an item added without a parsed quantity has no unit yet: it is in its product's base unit, as declaredLeftover reads it
  const productUnit = next.products.find((p) => p.id === productId)?.defaultUnit ?? null;
  const item = next.stockItems
    .filter((i) => i.finishedAt === null && i.productId === productId && (i.unit ?? productUnit) === unit && i.qty === null && !i.isLow && !held.has(i.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)[0];
  if (!item) return false;
  const { meal, qty } = due[0]!;
  pushReservation(next, { stockItemId: item.id, mealId: meal.id, qty, unit, at });
  meal.cookEarlyReason ??= cookEarlyReason(item, today);
  return true;
}

/**
 * §6.5: takes an unbought line off Courses. An ajout just leaves, without a reason (any reason on it, or a malformed one on any line, is invalid). A planned line (planning or
 * staple) needs a reason; only an old cached build sends none. Either
 * way it keeps its quantity and price (as a bought line does), and of its shares only those of meals already cooked or dropped, a planning line only (a staple
 * line keeps none): every reader skips a removed line, and an undo that reopens one of those meals finds its share there, so it knows the share left Courses
 * after the meal closed (undo.ts `reopenedShort`). « On n'en prend pas » leaves each non-staple open meal it served short of its share, listed
 * under « Manques »; « On en a déjà » first reserves for those meals the libre Reste stock of that product
 * (reserveFreeStock); when one meal alone is still owed, an unheld item of unknown quantity of that product holds the rest
 * (reserveUnheldUnknown); else it puts what is left of what they need of it in Reste as a purchase would (atHomeQty, enterReste;
 * no item when nothing is left; of unknown quantity for a staple line or one no open meal holds a share of), reserved for them, though it never reaches the basket, a trip or calibration.
 */
export function removeLine(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  // a malformed reason is INVALID whatever the line (unknown, ajout, planned, removed); an absent one is allowed here
  if (!p || !int(p.itemId) || (p.reason !== undefined && !isRemoveReason(p.reason))) return INVALID;
  const line = next.shoppingItems.find((l) => l.id === p.itemId);
  if (!line) return refused("article introuvable");
  // an ajout leaves without a reason, the phone sends none for it: one with a reason is malformed, whatever its state,
  // since a line's kind never changes and no resend can change the answer
  if (line.kind === "ajout" && p.reason !== undefined) return INVALID;
  // an ajout just leaves, so a second removal changes nothing worth telling; a planned line's second removal may be a
  // different answer than the first (« On en a déjà » after « On n'en prend pas »), which the phone must show. A resend of
  // the same op never gets here: appliedOps replays its first answer.
  if (line.removedAt !== null) return line.kind === "ajout" ? noop("déjà retiré") : refused("déjà retiré des courses");
  // a bought line answers so whatever build sent the removal: updating the app would not make it removable
  if (line.boughtAt !== null) return refused("déjà acheté");
  if (line.kind !== "ajout" && p.reason === undefined) return refused("mettez l'application à jour");
  // removed first: enterReste's surplus pass must no longer count this line among the meals' unbought shares
  line.removedAt = at;
  // an ajout serves no meal and puts nothing in Reste: the meals are read only for a planned line
  if (line.kind === "ajout") return applied();
  const open = openShares(next, line);
  if (p.reason === "a_la_maison") {
    // a staple line reserves for no meal: its item has no quantity to share
    const shares = line.kind === "planning" ? cappedShares(next, line, open) : [];
    const qty = atHomeQty(line, shares);
    const free = reserveFreeStock(next, line, at, shares);
    const left = qty === null ? null : qty - free.taken;
    // an item only for what is left, never an empty one, nor one beside the unknown item the one meal owed now holds; of
    // unknown quantity when atHomeQty is, a line no open meal holds a share of, from which the free stock took nothing
    // (reserveFreeStock reserves only for open meals' shares, so `owed` is then empty and nothing is reserved here)
    if ((left === null || left > 0) && !reserveUnheldUnknown(next, line, at, free)) enterReste(next, line, at, left, "ajout", free.owed);
  }
  // after enterReste, which reserves from the open meals' shares: those leave the line, the closed meals' stay on a
  // planning line only, where undo reads them (reopenedShort, restoresClosedMealShare); no rule reads a removed staple
  // line's, so it keeps none, and an uncook never leaves a reopened meal's share on it (no fold of the ops then in
  // effect, the cook left out, puts one there)
  line.forMeals = line.kind === "staple_hors_budget" ? [] : line.forMeals.filter((f) => !open.some((o) => o.meal.id === f.mealId));
  return applied();
}

/**
 * §6.5, planning session only: prices a line (an ajout, a rebuy) so calibration can use the trip it was bought on (§5.5).
 * A line the planning priced (planning or staple) keeps its price, which drops pro-rate; an ajout can be repriced, since
 * nothing derives from its price but calibration. A bought line and a removed planned line keep their quantity and price (no total reads a removed line), and
 * setPrice still refuses a removed one; an emptied line (a meal dropped off it) stays at 0. The price is for the
 * line's quantity as it now is, so a planned quantity a receipt left on it (`plannedQty`) is cleared.
 */
export function setPrice(next: State, payload: unknown): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.itemId) || !int(p.estPriceCents) || p.estPriceCents < 0) return INVALID;
  const line = next.shoppingItems.find((l) => l.id === p.itemId);
  if (!line) return refused("article introuvable");
  if (line.removedAt !== null) return refused("article retiré");
  if (line.qty === 0) return refused("article vide");
  if (line.kind !== "ajout" && line.estPriceCents !== null) return refused("déjà chiffré par la planification");
  if (line.estPriceCents === p.estPriceCents) return noop("déjà à ce prix");
  line.estPriceCents = p.estPriceCents;
  line.plannedQty = null; // a price typed from the receipt is for the line's quantity now, the basis of a later rebuy
  return applied();
}

/**
 * §6.5, planning session only (`plan -- bought`): the quantity a receipt says a bought line really was, a loose product's
 * weight or count, or packs bought beyond the plan. Absolute: the line takes `qty`, and its Reste item moves by the same
 * difference, so what a cook already ate stays eaten (an item at 0 raised from 250 g to 1200 g holds 950 g); an item of
 * unknown quantity stays unknown. The line's price is the trip's and stays as it is; the first correction of a priced line keeps
 * the quantity that price was for in `plannedQty`, which prices a later rebuy per unit (helpers.ts rebuyPriceCents); an
 * unpriced line keeps none, since a price typed later (shopping.set_price) is for the quantity bought.
 *
 * Refused once the item was finished or declared (`openedAt`, « Il en reste »): the owners' word on what is left is the
 * truth from then on, and `plan -- reste` sets it. A receipt at or below what a cook already ate leaves the item of unknown
 * quantity (never a false zero), which « Restes à préciser » then asks about, and which every later correction keeps
 * unknown. A new quantity below what the other open meals hold of the item trims their holds as a declared
 * leftover does (declaredLeftover, spec §6.3), without opening it: those meals then show under « Manques ».
 */
export function setBoughtQty(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.itemId) || !Number.isSafeInteger(p.qty) || (p.qty as number) < 1) return INVALID;
  const qty = p.qty as number;
  const line = next.shoppingItems.find((l) => l.id === p.itemId);
  if (!line || line.removedAt !== null) return refused("article introuvable");
  if (line.boughtAt === null) return refused("pas encore acheté");
  if (line.productId === null || line.unit === null || line.qty === null) return refused("article sans produit");
  // the purchase's item: the one « On en a déjà » puts in Reste names no line
  const item = next.stockItems.find((s) => s.sourceShoppingItemId === line.id);
  if (!item) return refused("pas d'article en Reste");
  // before the refusals that can follow it: a resend of a correction that landed answers noop, never « déjà fini »
  if (qty === line.qty) return noop("déjà cette quantité");
  if (item.finishedAt !== null) return refused("déjà fini");
  if (item.openedAt !== null) return refused("reste déclaré depuis, à préciser avec reste");

  if (item.qty !== null) {
    // at or below 0 the item becomes unknown (declaredLeftover: never a false zero, one hold kept), which « Restes à
    // préciser » then asks about; a 0 would forget what was eaten, and a later correction would add phantom stock to it
    const product = next.products.find((pr) => pr.id === item.productId);
    const held = liveReservations(next).filter((r) => r.stockItemId === item.id);
    const left = declaredLeftover({ ...item, qty: Math.max(0, item.qty + (qty - line.qty)) }, undefined, { productUnit: product?.defaultUnit ?? null, pack: product?.pack ?? null, held });
    item.qty = left.item.qty;
    left.holds.forEach((h, i) => {
      if (h.released) held[i]!.releasedAt = at;
      else held[i]!.qty = h.qty;
    });
  }
  // the planning's price is for the quantity it planned; an unpriced line has no basis to keep, and a price typed later is for `qty`
  if (line.estPriceCents !== null) line.plannedQty ??= line.qty;
  line.qty = qty;
  return applied();
}

/** The refusal of a checkout whose listed basket the server no longer holds as it was. */
export const BASKET_CHANGED = "panier modifié depuis";

/**
 * §6.5: records a trip on exactly the lines the checkout sheet showed (`itemIds`), since the receipt typed there covers
 * those and no other. A line bought since by the other phone, and never shown, stays in the basket for its own checkout.
 * Every listed line must still be bought and on no trip, or nothing is recorded: attaching only
 * the rest would put a receipt on fewer lines than it paid for, and calibration would read it as a price.
 * `noReceipt: true` records lines bought off the receipt (another day, or without a ticket): it carries no total, never gets
 * one, and neither calibration, `lastTrip` nor `plan -- status` reads it; its lines leave the basket all the same.
 */
export function recordTrip(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !["marche", "supermarche", "autre"].includes(p.place as string) || !isDate(p.date)) return INVALID;
  const totalCents = p.totalCents ?? null; // optional (§6.5): the receipt can come later through trip.set_total
  if (totalCents !== null && !(int(totalCents) && totalCents >= 0)) return INVALID;
  if (p.noReceipt !== undefined && typeof p.noReceipt !== "boolean") return INVALID;
  if (p.noReceipt === true && totalCents !== null) return INVALID; // no receipt, so no total to carry
  const ids = p.itemIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(int) || new Set(ids).size !== ids.length) return INVALID;
  const lines = ids.map((id) => next.shoppingItems.find((l) => l.id === id));
  if (lines.some((l) => l === undefined || l.removedAt !== null || l.boughtAt === null || l.tripId !== null)) return refused(BASKET_CHANGED);
  const tripId = nextId(next, "trips");
  next.trips.push({ id: tripId, date: p.date, place: p.place as "marche" | "supermarche" | "autre", totalCents, noReceipt: p.noReceipt === true ? true : null, createdAt: at });
  for (const line of lines) line!.tripId = tripId;
  return applied();
}

export function setTripTotal(next: State, payload: unknown): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.tripId) || !int(p.totalCents) || p.totalCents < 0) return INVALID;
  const trip = next.trips.find((t) => t.id === p.tripId);
  if (!trip) return refused("passage en caisse introuvable");
  if (trip.noReceipt === true) return refused("passage sans ticket");
  if (trip.totalCents === p.totalCents) return noop("déjà ce total");
  trip.totalCents = p.totalCents;
  return applied();
}

export function addEnvie(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  // the link is rendered as one: a « javascript: » address would run on a tap
  if (!p || !str(p.text) || (p.url !== null && !isWebUrl(p.url))) return INVALID;
  next.envies.push({ id: nextId(next, "envies"), text: p.text.trim(), url: p.url, createdAt: at, status: "ouverte", mealId: null });
  return applied();
}
