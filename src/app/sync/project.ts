import { addDays, daysBetween, parisDate } from "../../domain/dates";
import { declaredLeftover } from "../../domain/declared";
import { int, isDate, isRemoveReason, isResolution, str, strOrNull } from "../../domain/ops/helpers";
import { parseSheet } from "../../domain/ops/meals";
import { libreQty } from "../../domain/quantities";
import { RULES } from "../../domain/rules.config";
import { RESTE_SECTIONS, cookedRecipe, resteItems, resteSection, type CourseLine, type PoolMeal, type RecentMeal, type ResteItem, type ResteSection, type Snapshot } from "../../domain/snapshot";
import { isWebUrl } from "../../domain/text";
import type { Envie, Place } from "../../domain/types";
import type { Op, OutboxEntry } from "./types";

/** A Courses line as shown: `pending` when an op not yet answered created it, so it has no server id to name. */
export interface ViewLine extends CourseLine {
  pending: boolean;
}

/** A Reste item as shown: `pending` when an op not yet answered created it (an addition, a plat cuisiné). */
export interface ViewItem extends ResteItem {
  pending: boolean;
}

/** An envie as shown: `pending` while the op that adds it waits. */
export interface ViewEnvie extends Envie {
  pending: boolean;
}

/** A meal of « Cuisinés récemment » as shown: `undoing` while an undo of its cook waits, so its row offers no second one. */
export interface ViewRecent extends RecentMeal {
  undoing: boolean;
}

export type View = Omit<Snapshot, "menu" | "courses" | "reste"> & {
  menu: { pool: PoolMeal[]; recentlyCooked: ViewRecent[]; envies: ViewEnvie[] };
  courses: { lines: ViewLine[]; estimateCents: number; budgetCents: number };
  reste: Record<ResteSection, ViewItem[]>;
};

type Payload = Record<string, unknown>;

/** Every Reste item a view shows, a section after the other. */
export const viewItems = (view: Pick<View, "reste">): ViewItem[] => resteItems(view);

/**
 * The snapshot as it will be once the waiting ops land (spec §8.3: apply optimistically to the local snapshot). A guess
 * for display only, replaced by the server's next snapshot. It predicts every op the phone sends, as the domain applies
 * it, on what the snapshot shows:
 *
 * - Courses: a tick, an ajout added, a line removed (an ajout, or a planned line with its reason), a checkout (a trip without a receipt too), a ticket total, the undo of a buy.
 * - Menu and Reste: a meal cooked (it leaves the pool for « Cuisinés récemment » with its recipe; what it held leaves its
 *   items, a quantity in the same unit taken off; each answer of its sheet, every « Fini » before any « Il en reste »;
 *   a first round's plat cuisiné), a meal dropped (with its open second round, their reservations released), an item finished (with the meals it held
 *   dropped when the resolution says so), partly used, given a date or added, an envie added. An « Il en reste », from the
 *   sheet or from Reste, sets what is left by the server's own rule (declared.ts `declaredLeftover`): words that parse
 *   in the item's unit or its product's (the snapshot carries both, and the pack) become the quantity, words that do not
 *   leave it unknown, never a false zero; the other open meals' holds on it are trimmed to fit, on the Reste row and in
 *   the recipe views. An op the server would
 *   refuse as a whole (a « fini » on an item held for another meal with no resolution, a rebuy of a plat cuisiné, a
 *   second round cooked before its first, a payload the domain's own checks find invalid) shows nothing.
 *
 * A « Ajouter aux courses » (meal.cover_shortfalls) clears that meal's « manque » and nothing else: the phone holds no product
 * id, no pack and no line's meals to run `mealShortfalls` or `coverNeed`.
 *
 * Not predicted, so shown with the server's answer: the budget (the phone knows no line's planning; Totals shows nothing once no
 * planning line is left), a line's `mealRefs` after a projected cook, drop or untick (it refreshes with the
 * server's answer), the Reste row and reservations of a line removed « à la maison » and the « manque » of one « pas acheté » (the line only leaves Courses, as a buy makes no Reste row either), the Courses line a meal.cover_shortfalls adds or extends and the Reste stock
 * it reserves, the undo of a removal that already landed (its line is no longer in the
 * snapshot, so the phone cannot bring it back before the server answers), the shortfall a trim (an « Il en reste » below the other meals' holds) creates on another meal, the quantity
 * a stock.add's words give a catalogue product (the phone
 * holds no catalogue; its own additions name none), a rebuy's new Courses line, the shares and prices a drop takes off
 * Courses, the shorter date an opened item gets from its product, the trim of a first round's reservations when its
 * second round is dropped alone, and the « réservé » mark of the recipe view's ingredients.
 *
 * An op and its own undo, both still waiting, show neither, unless the server will refuse that undo: a buy followed by
 * a checkout listing its line, still shown before its undo, stays shown (« déjà passé en caisse »). A waiting op that the
 * server will judge as having changed another waiting op's rows (a « fini » after a cook that used the item, then the
 * cook's undo) is not modelled: that undo is shown as taking its op back until the answer says « modifié depuis ». An
 * « Il en reste » repeating the last waiting one on its item shows nothing, as the server answers it noop « déjà noté »
 * (`repeatedWrites`), so an earlier one's undo behind it takes the item back to before both; a cook or a drop of a
 * meal that holds the item, waiting between them, may change what the words give (a quantity taken off, a hold
 * released), so the repeat is then shown as applied. An undo whose target's rows a later op wrote since, even back to
 * what the target left (« un fond », then « presque fini », then « un fond » again, then the undo of the first; or a
 * cook's « Il en reste » in the item's own words), is refused « modifié depuis » by the server, which keeps the later
 * writes the projection shows over it. A removal, like the server, takes off only a line not yet bought, a planned one only with a reason (an old build sends none: refused) and an ajout only without one (invalid with one); a checkout,
 * like the server, takes off the lines it lists, and only when every one of them is in the basket (« panier modifié
 * depuis » otherwise). A checkout of a trip without a receipt leaves `lastTrip` alone, as the server's snapshot skips it, and shows nothing
 * with a total beside it (refused).
 *
 * Known transient: an op the server applied but whose answer was lost (sends > 0) is still projected over a base that
 * already holds it, once a refresh has brought that base. A shopping.add then shows twice (its real row and a pending
 * one), and a trip.record shows trip id -1 over the real one, until the next answer settles the op. Display only: the
 * resend replays the stored answer (applied) and the next snapshot replaces the guess. The same holds for an op answered
 * applied, which stays in the outbox until a snapshot is stored after its answer, when the app was closed between that
 * snapshot's write and the op's delete: the read on the next open drops it. And an undo of a buy, waiting, puts its line
 * back but leaves on screen the Reste item that buy made (the snapshot does not say which line an item came from), until
 * the answer: a Cuisiné sheet shown meanwhile may name it, and the server skips an answer about an item it no longer holds.
 */
export function project(base: Snapshot, outbox: readonly OutboxEntry[]): View {
  const copy = structuredClone(base);
  const view: View = {
    ...copy,
    menu: {
      pool: copy.menu.pool,
      recentlyCooked: copy.menu.recentlyCooked.map((m) => ({ ...m, undoing: false })),
      envies: copy.menu.envies.map((e) => ({ ...e, pending: false })),
    },
    courses: { ...copy.courses, lines: copy.courses.lines.map((l) => ({ ...l, pending: false })) },
    reste: { urgent: [], reserved: [], libre: [], placard: [] },
  };
  const items: ViewItem[] = resteItems(copy).map((i) => ({ ...i, pending: false }));
  // an op answered noop or refused changed nothing; one en échec is not sent
  const live = outbox.filter((e) => !e.failed && e.final !== "noop" && e.final !== "refused");
  const undone = skippedByUndo(live);
  const repeats = repeatedWrites(live, items, view.menu.pool);
  let tempId = 0;
  const temp = (): number => --tempId;
  for (const { op } of live) {
    if (undone.has(op.opId) || repeats.has(op.opId)) continue;
    const p = (op.payload ?? {}) as Payload;
    const lines = view.courses.lines;
    switch (op.type) {
      case "shopping.buy": {
        const line = lines.find((l) => l.id === p.itemId);
        if (line && line.boughtAt === null) {
          line.boughtAt = op.at;
          line.buyOpId = op.opId;
        }
        break;
      }
      case "shopping.add":
        lines.push({
          id: temp(), label: String(p.label ?? "").trim(), qty: null, unit: null, estPriceCents: null, kind: "ajout", group: "ajouts",
          isFood: p.isFood !== false, boughtAt: null, buyOpId: null, mealRefs: [], pending: true,
        });
        break;
      case "shopping.remove":
        // a planned line leaves with one of the two reasons (refused without one: an old build sent none), an ajout only
        // without any (INVALID with one); a reason other than the two is INVALID for every line
        view.courses.lines = lines.filter((l) => !(l.id === p.itemId && l.boughtAt === null
          && (l.kind === "ajout" ? p.reason === undefined : isRemoveReason(p.reason))));
        break;
      case "trip.record": {
        const listed = listedIds(op.payload);
        // a non-boolean noReceipt is INVALID on the server: nothing to predict
        if (p.noReceipt !== undefined && typeof p.noReceipt !== "boolean") break;
        if (listed.length === 0 || !listed.every((id) => lines.some((l) => l.id === id && l.boughtAt !== null))) break;
        // no receipt, so no total to carry: the server refuses a total beside it
        if (p.noReceipt === true && p.totalCents != null) break;
        view.courses.lines = lines.filter((l) => !listed.includes(l.id));
        // a trip without a receipt is not the last trip (snapshot.ts `lastTrip`): the real trip keeps its « Saisir le total »
        if (p.noReceipt === true) break;
        // a receipt trip is stored with noReceipt null (shopping.ts recordTrip), never false
        view.lastTrip = {
          id: -1, date: String(p.date), place: p.place as Place, totalCents: typeof p.totalCents === "number" ? p.totalCents : null, noReceipt: null, createdAt: op.at,
        };
        break;
      }
      case "trip.set_total":
        if (view.lastTrip !== null && view.lastTrip.id === p.tripId && typeof p.totalCents === "number") {
          view.lastTrip = { ...view.lastTrip, totalCents: p.totalCents };
        }
        break;
      case "meal.cook":
        cook(view, items, op, temp);
        break;
      case "meal.drop":
        if (view.menu.pool.some((m) => m.id === p.mealId)) drop(view, items, p.mealId as number);
        break;
      case "meal.cover_shortfalls": {
        const meal = view.menu.pool.find((m) => m.id === p.mealId);
        if (meal) meal.shortfalls = [];
        break;
      }
      case "stock.finish": {
        const item = shownItem(items, p.itemId);
        const resolution = p.resolution ?? null;
        if (resolution !== null && !isResolution(resolution)) break;
        if (item && settle(view, items, item, resolution)) removeItem(view, items, item);
        break;
      }
      case "stock.partial": {
        const item = shownItem(items, p.itemId);
        if (item && typeof p.low === "boolean" && (typeof p.qtyText === "string" || p.qtyText === null)) {
          declare(view, item, p.qtyText);
          item.isLow = p.low;
        }
        break;
      }
      case "stock.set_use_by": {
        const item = shownItem(items, p.itemId);
        if (item && isDate(p.useBy)) {
          item.useBy = p.useBy;
          item.daysLeft = daysBetween(view.today, p.useBy);
        }
        break;
      }
      case "stock.add": {
        // the domain's checks (stock.ts `addStock`); a product's own shelf life comes with the answer
        if (!str(p.label) || !strOrNull(p.qtyText) || (p.productId !== null && !int(p.productId))) break;
        if (p.useBy !== null && !isDate(p.useBy)) break;
        const useBy = p.useBy;
        // a catalogue product's words are read in its unit by the server only: the phone does not hold the catalogue
        const leftover = declaredLeftover({ qty: null, unit: null, qtyText: null }, p.qtyText, { productUnit: null, pack: null, held: [] }).item;
        items.push({
          id: temp(), label: p.label.trim(), ...leftover, isLow: false,
          useBy, daysLeft: useBy === null ? null : daysBetween(view.today, useBy), libreQty: null, reservations: [], isStaple: false, pending: true,
        });
        break;
      }
      case "envie.add":
        if (!str(p.text) || (p.url !== null && !isWebUrl(p.url))) break;
        view.menu.envies.push({
          id: temp(), text: p.text.trim(), url: p.url, createdAt: op.at, status: "ouverte", mealId: null,
          pending: true,
        });
        break;
      case "undo":
        for (const line of lines) {
          if (line.buyOpId === p.targetOpId && line.boughtAt !== null) {
            line.boughtAt = null;
            line.buyOpId = null;
          }
        }
        // the cooked meal's pool row is not in the snapshot: it comes back with the answer; until then the row says so
        for (const meal of view.menu.recentlyCooked) if (meal.cookOpId === p.targetOpId) meal.undoing = true;
        break;
    }
  }
  view.reste = sectioned(items);
  // the server's formula (snapshot.ts): every shown planning line, bought since the last trip or not
  view.courses.estimateCents = view.courses.lines.filter((l) => l.kind === "planning").reduce((sum, l) => sum + (l.estPriceCents ?? 0), 0);
  return view;
}

/**
 * Spec §6.4: a resolution is needed, and accepted, as the domain decides (helpers.ts `settleReservations`): « Racheter »
 * only when every reservation holding the item has a known quantity, which a plat cuisiné never has.
 */
export function canRebuy(holding: readonly { qty: number | null; unit: string | null }[]): boolean {
  return holding.every((r) => r.qty !== null && r.unit !== null);
}

/**
 * « Il en reste » on a shown item, by the server's rule (declared.ts `declaredLeftover`): the declared words set its
 * quantity, never a false zero, and the other open meals' holds are trimmed to fit, latest planned first. The
 * reservations it still shows are theirs (a cook has taken its own off first); the pool's recipe views follow them.
 */
function declare(view: View, item: ViewItem, words: string | null | undefined): void {
  const left = declaredLeftover(item, words, { productUnit: item.productUnit ?? null, pack: item.pack ?? null, held: item.reservations });
  Object.assign(item, left.item);
  item.reservations = item.reservations.flatMap((r, i) => (left.holds[i]!.released ? [] : [{ ...r, qty: left.holds[i]!.qty }]));
  for (const meal of view.menu.pool) {
    const kept = item.reservations.filter((r) => r.mealId === meal.id);
    let next = 0;
    meal.reservedItems = meal.reservedItems.flatMap((x) => (x.stockItemId !== item.id ? [x] : next < kept.length ? [{ ...x, qty: kept[next++]!.qty }] : []));
  }
}

/** An item the screen shows with a server id: a pending one has none, so no op names it. */
function shownItem(items: readonly ViewItem[], id: unknown): ViewItem | undefined {
  return items.find((i) => i.id === id && !i.pending);
}

/** meal.cook, in the domain's order (meals.ts `cook`); nothing at all when the server would refuse it. */
function cook(view: View, items: ViewItem[], op: Op, temp: () => number): void {
  const p = (op.payload ?? {}) as Payload;
  const meal = view.menu.pool.find((m) => m.id === p.mealId);
  // gone from the pool: the server answers noop or refuses; a second round waits for its first (`!= null`: a snapshot
  // stored by an older app has no firstRoundId)
  if (!meal || meal.firstRoundId != null) return;
  // an invalid sheet, any part of it, refuses the whole cook (« données invalides »)
  const sheet = parseSheet(p.sheet ?? {});
  if (!sheet) return;
  const saved = structuredClone({ items, pool: view.menu.pool, recent: view.menu.recentlyCooked });
  view.menu.pool = view.menu.pool.filter((m) => m !== meal);
  // the server's order (snapshot.ts): latest first, a tie in meal order; it keeps its recipe, so it opens read-only offline
  const cooked: ViewRecent = { mealId: meal.id, title: meal.title, cookedAt: op.at, cookOpId: op.opId, undoing: false, ...cookedRecipe(meal) };
  view.menu.recentlyCooked = [...view.menu.recentlyCooked, cooked]
    .sort((x, y) => y.cookedAt.localeCompare(x.cookedAt) || x.mealId - y.mealId);
  // what the meal ate leaves the item, so it never reads as libre; an unknown quantity or another unit stays as it is
  for (const item of items) {
    for (const r of item.reservations.filter((x) => x.mealId === meal.id)) {
      if (item.qty !== null && r.qty !== null && r.unit === item.unit) item.qty = Math.max(0, item.qty - r.qty);
    }
    item.reservations = item.reservations.filter((x) => x.mealId !== meal.id);
  }
  // every « Fini » before any « Il en reste », as the server settles them
  for (const answer of sheet.items.filter((a) => a.outcome === "fini" && !a.ifEmpty)) {
    const item = shownItem(items, answer.stockItemId);
    if (!item) continue;
    if (!settle(view, items, item, answer.resolution ?? null)) {
      // the whole cook is refused (« réservé pour … »): back to what the earlier ops left
      items.splice(0, items.length, ...saved.items);
      view.menu.pool = saved.pool;
      view.menu.recentlyCooked = saved.recent;
      return;
    }
    removeItem(view, items, item);
  }
  // a pre-made « Fini » after every tapped one: only an item the cook left at 0 that no other meal holds, as the server judges it
  for (const answer of sheet.items.filter((a) => a.outcome === "fini" && a.ifEmpty)) {
    const item = shownItem(items, answer.stockItemId);
    if (item && item.qty === 0 && item.reservations.length === 0) removeItem(view, items, item);
  }
  for (const answer of sheet.items.filter((a) => a.outcome === "il_en_reste")) {
    const item = shownItem(items, answer.stockItemId);
    if (!item) continue;
    declare(view, item, answer.qtyText);
    if (answer.low !== undefined) item.isLow = answer.low;
  }
  // a first round's leftovers become the plat cuisiné its second round eats (spec §6.3)
  const second = view.menu.pool.find((m) => m.firstRoundId === meal.id);
  if (second) {
    second.firstRoundId = null;
    const id = temp();
    const useBy = addDays(parisDate(op.at), RULES.platCuisineUseByDays);
    items.push({
      id, label: meal.title, qty: null, unit: null, qtyText: null, isLow: false, useBy, daysLeft: daysBetween(view.today, useBy), libreQty: null,
      reservations: [{ mealId: second.id, mealTitle: second.title, qty: null, unit: null }], isStaple: false, pending: true,
    });
    second.reservedItems.push({ stockItemId: id, label: meal.title, qty: null, unit: null });
  }
}

/**
 * Spec §6.4 for an item about to be finished: free when nothing holds it; otherwise only with a resolution, and
 * « Racheter » only when every reservation has a known quantity. False when the server refuses.
 */
function settle(view: View, items: ViewItem[], item: ViewItem, resolution: unknown): boolean {
  const holding = item.reservations; // a live reservation is always for an open meal (invariants.ts)
  if (holding.length === 0) return true;
  if (resolution === "drop_meal") {
    for (const mealId of new Set(holding.map((r) => r.mealId))) drop(view, items, mealId);
    return true;
  }
  if (resolution !== "rebuy" || !canRebuy(holding)) return false;
  // released; the line that buys it back comes with the server's answer
  const held = new Set(holding.map((r) => r.mealId));
  item.reservations = [];
  for (const meal of view.menu.pool) if (held.has(meal.id)) meal.reservedItems = meal.reservedItems.filter((x) => x.stockItemId !== item.id);
  return true;
}

/** meal.drop and §6.4 drop_meal: the meal and its open second round leave the pool, and what they held is released. */
function drop(view: View, items: ViewItem[], mealId: number): void {
  const gone = new Set([mealId, ...view.menu.pool.filter((m) => m.firstRoundId === mealId).map((m) => m.id)]);
  view.menu.pool = view.menu.pool.filter((m) => !gone.has(m.id));
  for (const item of items) item.reservations = item.reservations.filter((r) => !gone.has(r.mealId));
}

/** A finished item leaves Reste, and the recipe views that listed it. */
function removeItem(view: View, items: ViewItem[], item: ViewItem): void {
  items.splice(items.indexOf(item), 1);
  for (const meal of view.menu.pool) meal.reservedItems = meal.reservedItems.filter((x) => x.stockItemId !== item.id);
}

/**
 * Reste by section, by the server's own rule (snapshot.ts `resteSection`), in its order: urgent by days left, then by
 * id; an item not yet synced after the rest, in the order it was added. The libre amount follows the reservations left.
 */
function sectioned(items: ViewItem[]): View["reste"] {
  const reste: View["reste"] = { urgent: [], reserved: [], libre: [], placard: [] };
  for (const item of items) {
    item.libreQty = libreQty(item, item.reservations.map((r) => ({ stockItemId: item.id, qty: r.qty, unit: r.unit, releasedAt: null })));
    reste[resteSection(item)].push(item);
  }
  const order = (a: ViewItem, b: ViewItem) => Number(a.pending) - Number(b.pending) || Math.abs(a.id) - Math.abs(b.id);
  for (const section of RESTE_SECTIONS) reste[section].sort(order);
  reste.urgent.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || order(a, b));
  return reste;
}

/** The lines a trip.record lists (its checkout sheet's basket); none when the payload holds no list. */
function listedIds(payload: unknown): number[] {
  const ids = (payload as Payload | null)?.itemIds;
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === "number") : [];
}

/** Undone targets in the outbox, in tap order, so a checkout that an earlier undo took back blocks nothing. */
function skippedByUndo(live: readonly OutboxEntry[]): Set<string> {
  const skipped = new Set<string>();
  live.forEach((e, at) => {
    if (e.op.type !== "undo") return;
    const targetId = String((e.op.payload as Payload | null)?.targetOpId);
    const from = live.findIndex((t) => t.op.opId === targetId);
    if (from === -1 || from > at) return;
    const target = live[from]!.op;
    const bought = target.type === "shopping.buy" ? (target.payload as Payload | null)?.itemId : undefined;
    // the server refuses to undo a buy once its line is on a trip (src/domain/ops/undo.ts); a trip it undoes whatever follows
    const blocks = (t: OutboxEntry): boolean => t.op.type === "trip.record" && !skipped.has(t.op.opId)
      && target.type === "shopping.buy" && listedIds(t.op.payload).includes(bought as number);
    if (live.slice(from + 1, at).some(blocks)) return;
    skipped.add(targetId);
  });
  return skipped;
}

/** The meals an op closes or drops, with the open second rounds a drop takes along (meal.drop, §6.4 drop_meal). */
function mealsClosedBy(op: Op, items: readonly ViewItem[], pool: readonly PoolMeal[]): Set<number> {
  const p = (op.payload ?? {}) as Payload;
  const closed = new Set<number>();
  const drop = (mealId: unknown) => {
    if (typeof mealId !== "number") return;
    closed.add(mealId);
    for (const m of pool) if (m.firstRoundId === mealId) closed.add(m.id);
  };
  const holdersOf = (itemId: unknown) => {
    for (const r of items.find((i) => i.id === itemId)?.reservations ?? []) drop(r.mealId);
  };
  if (op.type === "meal.cook") {
    if (typeof p.mealId === "number") closed.add(p.mealId);
    const answers = (p.sheet as Payload | null | undefined)?.items;
    for (const a of Array.isArray(answers) ? (answers as (Payload | null)[]) : []) {
      if (a?.outcome === "fini" && a.resolution === "drop_meal") holdersOf(a.stockItemId);
    }
  }
  if (op.type === "meal.drop") drop(p.mealId);
  if (op.type === "stock.finish" && p.resolution === "drop_meal") holdersOf(p.itemId);
  return closed;
}

/**
 * Whether a waiting op may change what an « Il en reste » on a Reste item reads (declared.ts `declaredLeftover`): its
 * own fields, or the reservations other open meals hold on it. An undo may write any. A cook, a drop or a « fini » that
 * drops meals writes only the items they touch: one its sheet answers, one a meal it closes holds (a cook takes what
 * its meal ate off it; a closed meal releases its hold), `closed` being the meals it closes (`mealsClosedBy`). Read on
 * the items the base shows: no waiting op adds a hold.
 */
function writesItem(op: Op, closed: ReadonlySet<number>, itemId: unknown, items: readonly ViewItem[]): boolean {
  const p = (op.payload ?? {}) as Payload;
  if (op.type === "undo") return true;
  if (op.type.startsWith("stock.") && p.itemId === itemId) return true;
  if (op.type === "meal.cook") {
    const answers = (p.sheet as Payload | null | undefined)?.items;
    if (Array.isArray(answers) && answers.some((a) => (a as Payload | null)?.stockItemId === itemId)) return true;
  }
  return closed.size > 0 && (items.find((i) => i.id === itemId)?.reservations ?? []).some((r) => closed.has(r.mealId));
}

/**
 * The waiting « Il en reste » the server will answer noop « déjà noté » (stock.ts `partial`): the last waiting write to
 * its item before it is an « Il en reste », sent no later, which opened the item and dated it, and whose result this one
 * leaves as it is (`declaredLeftover`: the same quantity, unit and words, so « 125 g » after « 125g » too) with the same
 * « Presque fini ». Only then is the answer known from the outbox; any other write to it in between (an undo, a date, a
 * cook or a drop of a meal that holds it) and the op is shown as applied, as before. It must not be shown: an earlier
 * one's undo waiting behind it takes the item back to before both, as the server does.
 *
 * The first one's result is read on the item as the base shows it, which may differ from what the ops before it left;
 * whether the second changes it does not depend on that: parsed words set the amount whatever was there, words that do
 * not parse set the words and an unknown quantity, and no words keep a known quantity (an unknown stays unknown). Its
 * holds already fit what it left, so the second trims none.
 */
function repeatedWrites(live: readonly OutboxEntry[], items: readonly ViewItem[], pool: readonly PoolMeal[]): Set<string> {
  const repeats = new Set<string>();
  // the meals each waiting op closes, read once per op rather than once per op and « Il en reste »
  const closedBy = new Map(live.map(({ op }) => [op.opId, mealsClosedBy(op, items, pool)]));
  live.forEach(({ op }, at) => {
    if (op.type !== "stock.partial") return;
    const p = (op.payload ?? {}) as Payload;
    const item = shownItem(items, p.itemId);
    const last = live.slice(0, at).reverse().find((e) => writesItem(e.op, closedBy.get(e.op.opId)!, p.itemId, items));
    if (!item || !last || last.op.type !== "stock.partial" || last.op.at > op.at) return;
    const q = (last.op.payload ?? {}) as Payload;
    if (!strOrNull(p.qtyText) || !strOrNull(q.qtyText) || typeof p.low !== "boolean" || q.low !== p.low) return;
    const ctx = { productUnit: item.productUnit ?? null, pack: item.pack ?? null, held: [] };
    const first = declaredLeftover(item, q.qtyText, ctx).item;
    const again = declaredLeftover(first, p.qtyText, ctx).item;
    if (first.qty === again.qty && first.unit === again.unit && first.qtyText === again.qtyText) repeats.add(op.opId);
  });
  return repeats;
}
