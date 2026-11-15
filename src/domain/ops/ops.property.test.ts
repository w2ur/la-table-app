import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyOp } from "./apply";
import { snapshot } from "../snapshot";
import { stableStringify, storedOp, TABLES } from "../state";
import { NOW, P, fixtureProposal, fixtureState, secondProposal, sharedComteProposal } from "../test-fixtures";
import { invariantViolations, mealShortfalls } from "../invariants";
import { libreQty, mealMultiplier, mealNeed, recipeNeeds } from "../quantities";
import type { State, Unit } from "../types";

const tables = (s: State) => stableStringify(Object.fromEntries(TABLES.map((t) => [t, s[t]])));

/**
 * A random tap: ids range over what two plannings, a few rebuys and stock.adds can create, so many taps target missing
 * rows on purpose. The second planning and stock.add let a later planning reserve what an earlier op freed or created,
 * which is what undo must not tear up.
 */
/**
 * What an « Il en reste » says: none (absent, null or blank), words that are no quantity, an amount, a pack (which parses
 * only when the product has one in that unit), so the declared leftover sets, keeps or clears the quantity.
 */
const leftWords = fc.constantFrom(undefined, null, "", "un peu", "50 g", "1 boîte");

const tapArb = fc.oneof(
  { arbitrary: fc.record({ type: fc.constant("shopping.buy"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 12 }) }) }), weight: 3 },
  { arbitrary: fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 8 }),
    sheet: fc.record({ items: fc.array(fc.record({ stockItemId: fc.integer({ min: 1, max: 12 }), outcome: fc.constantFrom("fini", "il_en_reste"),
      resolution: fc.constantFrom("drop_meal", "rebuy", undefined), qtyText: leftWords, ifEmpty: fc.boolean() })
      .map(({ ifEmpty, ...i }) => (ifEmpty && i.outcome === "fini" ? { ...i, ifEmpty: true } : i)), { maxLength: 2 }) }) }) }), weight: 2 },
  fc.record({ type: fc.constant("meal.drop"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 8 }) }) }),
  fc.record({ type: fc.constant("stock.finish"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 12 }),
    resolution: fc.constantFrom("drop_meal", "rebuy", undefined) }) }),
  fc.record({ type: fc.constant("stock.partial"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 12 }), qtyText: leftWords.map((w) => w ?? null), low: fc.boolean() }) }),
  fc.record({ type: fc.constant("stock.add"), payload: fc.record({ label: fc.constant("comté"), productId: fc.constantFrom(P.comte, null),
    qtyText: fc.constantFrom("un bout", "50 g", "1 boîte", null), useBy: fc.constant(null) }) }),
  // a doubled second planning lets a first round take part of its need from stock and the rest from a line, so a rebuy
  // on it leaves two unbought lines carrying its share
  { arbitrary: fc.record({ type: fc.constant("planning.commit"), payload: fc.boolean().map(secondPlanning) }), weight: 2 },
  // the ids reach removed and emptied lines (a dropped meal's), rebuys and ajouts alike
  // a receipt corrects a bought line: above or below the plan, below what was eaten, or below what other meals hold
  fc.record({ type: fc.constant("shopping.set_bought_qty"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 16 }), qty: fc.integer({ min: 0, max: 1200 }) }) }),
  // a short meal covered from free stock, a line's spare or a new line, among the taps that make it short or follow it
  fc.record({ type: fc.constant("meal.cover_shortfalls"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 8 }) }) }),
  fc.record({ type: fc.constant("shopping.set_price"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 16 }), estPriceCents: fc.integer({ min: 0, max: 1000 }) }) }),
  // a checkout lists the lines its sheet showed: some bought and on no trip, others bought since, on a trip, or unbought;
  // some lines leave the basket on a trip without a receipt
  fc.record({ type: fc.constant("trip.record"), payload: fc.record({ place: fc.constant("marche"), totalCents: fc.constant(null), date: fc.constant("2026-10-12"),
    itemIds: fc.uniqueArray(fc.integer({ min: 1, max: 16 }), { minLength: 1, maxLength: 3 }), noReceipt: fc.constantFrom(undefined, true, false) })
    .map(({ noReceipt, ...p }) => (noReceipt === undefined ? p : { ...p, noReceipt })) }),
  // a line taken off Courses: « On en a déjà » (into Reste), « On n'en prend pas » (its meals short), or no reason (an ajout
  // alone leaves); the ids reach planned, staple, rebuy and ajout lines, bought, removed or missing
  { arbitrary: fc.record({ type: fc.constant("shopping.remove"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 16 }), reason: fc.constantFrom("a_la_maison", "pas_achete", undefined) })
    .map(({ reason, ...p }) => (reason === undefined ? p : { ...p, reason })) }), weight: 2 },
  // a rebuy and, right after it, a drop aimed at a second round: the pair a first round carried by two lines needs
  { arbitrary: fc.record({ type: fc.constant("rebuy.drop"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 4 }), mealId: fc.integer({ min: 4, max: 8 }) }) }), weight: 2 },
  // an undo names an op 0–6 taps back (the 5-second bar, or the row soon after); "t-1" and below name nothing
  { arbitrary: fc.record({ type: fc.constant("undo"), payload: fc.record({ back: fc.integer({ min: 0, max: 6 }) }) }), weight: 3 },
);

function secondPlanning(doubled: boolean): Record<string, unknown> {
  const p = secondProposal();
  if (doubled) p.meals = [{ recipe: "s", portions: 2, doubled: true }];
  return p;
}

/** Half the runs double the saumon, so a second round, its plat cuisiné and a second round dropped alone are reachable. */
function firstProposal(doubled: boolean): Record<string, unknown> {
  const p = fixtureProposal();
  if (doubled) p.meals = (p.meals as { recipe: number }[]).map((m, i) => (i === 2 ? { ...m, doubled: true } : m));
  return p;
}

/** One entry per fixture product: a pack of that many units in the product's default unit, or none. */
const packsArb = fc.array(fc.option(fc.integer({ min: 1, max: 400 }), { nil: null }), { minLength: 11, maxLength: 11 });

/** The ops that give the fixture products their packs, before the first planning rounds its lines. */
function packOps(packs: (number | null)[]): { opId: string; type: string; at: string; payload: unknown }[] {
  const products = fixtureState().products;
  return packs.flatMap((qty, i) => (qty === null ? [] : [{
    opId: `pack-${i}`, type: "product.pack", at: NOW,
    payload: { name: products[i]!.name, pack: { qty, unit: products[i]!.defaultUnit }, price: null },
  }]));
}

const toOps = ([doubled, taps, packs = []]: [boolean, { type: string; payload: unknown }[], (number | null)[]?]) => [
  ...packOps(packs),
  { opId: "commit", type: "planning.commit", at: NOW, payload: firstProposal(doubled) },
  ...taps.flatMap((t, i) => {
    if (t.type === "rebuy.drop") {
      const { itemId, mealId } = t.payload as { itemId: number; mealId: number };
      return [
        { opId: `t${i}`, at: NOW, type: "stock.finish", payload: { itemId, resolution: "rebuy" } },
        { opId: `t${i}-drop`, at: NOW, type: "meal.drop", payload: { mealId } },
      ];
    }
    if (t.type === "free.remove") {
      const { declared, mealId, qtyText, itemId } = t.payload as { declared: string; mealId: number; qtyText: string; itemId: number };
      return [
        { opId: `t${i}-short`, at: NOW, type: "stock.partial", payload: { itemId: 1, qtyText: declared, low: false } },
        { opId: `t${i}-cover`, at: NOW, type: "meal.cover_shortfalls", payload: { mealId } },
        { opId: `t${i}-add`, at: NOW, type: "stock.add", payload: { label: "comté", productId: P.comte, qtyText, useBy: null } },
        { opId: `t${i}`, at: NOW, type: "shopping.remove", payload: { itemId, reason: "a_la_maison" } },
      ];
    }
    if (t.type === "receipt.eaten") {
      const { itemId, mealId, qty } = t.payload as { itemId: number; mealId: number; qty: number };
      return [
        { opId: `t${i}-buy`, at: NOW, type: "shopping.buy", payload: { itemId } },
        { opId: `t${i}-cook`, at: NOW, type: "meal.cook", payload: { mealId, sheet: {} } },
        { opId: `t${i}`, at: NOW, type: "shopping.set_bought_qty", payload: { itemId, qty } },
      ];
    }
    return [{
      opId: `t${i}`, at: NOW, type: t.type,
      payload: t.type === "undo" ? { targetOpId: `t${i - 1 - (t.payload as { back: number }).back}` } : t.payload,
    }];
  }),
];
const seqArb = fc.tuple(fc.boolean(), fc.array(tapArb, { maxLength: 25 }), packsArb).map(toOps);
/** Longer runs reach "buy, cook, a second planning takes the freed quantity, undo the cook" often enough to fail without the undo guard. */
const longSeqArb = fc.tuple(fc.boolean(), fc.array(tapArb, { maxLength: 25, size: "medium" }), packsArb).map(toOps);

/**
 * Taps aimed at a first round carried by two lines: buy, free some stock by dropping or cooking a first-planning meal,
 * plan a doubled round that reserves the freed stock and puts the rest on a line, rebuy that stock, drop a second round.
 * The general taps reach that chain in too few runs to fail without the fix.
 */
const twoLineTapArb = fc.oneof(
  // line 6 is the lentilles, a staple shared by the doubled round; other ids keep the rest of the list moving
  fc.record({ type: fc.constant("shopping.buy"), payload: fc.record({ itemId: fc.oneof(fc.constant(6), fc.integer({ min: 1, max: 7 })) }) }),
  fc.record({ type: fc.constant("meal.drop"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 8 }) }) }),
  fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 3 }), sheet: fc.constant({ items: [] }) }) }),
  fc.record({ type: fc.constant("planning.commit"), payload: fc.constant(true).map(secondPlanning) }),
  fc.record({ type: fc.constant("rebuy.drop"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 4 }), mealId: fc.integer({ min: 4, max: 8 }) }) }),
  fc.record({ type: fc.constant("undo"), payload: fc.record({ back: fc.integer({ min: 0, max: 3 }) }) }),
);
const twoLineSeqArb = fc.tuple(fc.boolean(), fc.array(twoLineTapArb, { maxLength: 12, size: "medium" })).map(toOps);

/**
 * Taps aimed at the doubled saumon (meal 3, its second round meal 4): try to cook either round in either order (the
 * second round first is refused), drop the second round, buy a line (its staple lentilles among them), undo a tap or two
 * back. These sequences are out of reach of the general taps often enough to matter.
 */
const doubledTapArb = fc.oneof(
  fc.record({ type: fc.constant("shopping.buy"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 7 }) }) }),
  { arbitrary: fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.constantFrom(3, 4), sheet: fc.constant({ items: [] }) }) }), weight: 2 },
  fc.record({ type: fc.constant("meal.drop"), payload: fc.record({ mealId: fc.constant(4) }) }),
  { arbitrary: fc.record({ type: fc.constant("undo"), payload: fc.record({ back: fc.integer({ min: 0, max: 2 }) }) }), weight: 2 },
);
const doubledSeqArb = fc.tuple(fc.constant(true), fc.array(doubledTapArb, { maxLength: 10, size: "medium" })).map(toOps);

/**
 * Taps aimed at the doubled round's staple: buy the lentilles (line 6), drop the second round, cook the first, undo a
 * tap or a few back. Undoing the purchase after a drop then a cook needs all four in order, which the doubled taps reach
 * in too few runs.
 */
const stapleTapArb = fc.oneof(
  fc.constant({ type: "shopping.buy", payload: { itemId: 6 } }),
  fc.constant({ type: "meal.drop", payload: { mealId: 4 } }),
  fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.constantFrom(3, 4), sheet: fc.constant({ items: [] }) }) }),
  fc.record({ type: fc.constant("undo"), payload: fc.record({ back: fc.integer({ min: 0, max: 3 }) }) }),
);
const stapleSeqArb = fc.tuple(fc.constant(true), fc.array(stapleTapArb, { maxLength: 6 })).map(toOps);

/**
 * Taps aimed at one meal carried by a shared line and its own rebuy line: buy the comté, cook the gratin leaving some,
 * plan two comté meals (the first reserves the libre comté, both share one line for the rest), rebuy the old comté,
 * then buy the comté lines in any order. Buying the shared line first is what handed one meal the other's share.
 */
const sharedLineTapArb = fc.oneof(
  // the comté lines are 2 (first planning), 10 (shared) and 13, 14 (rebuys); other ids keep the rest of the list moving
  { arbitrary: fc.record({ type: fc.constant("shopping.buy"), payload: fc.record({ itemId: fc.oneof(fc.constantFrom(2, 10, 13, 14), fc.integer({ min: 1, max: 16 })) }) }), weight: 4 },
  fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 3 }),
    sheet: fc.record({ items: fc.array(fc.record({ stockItemId: fc.integer({ min: 1, max: 2 }), outcome: fc.constant("il_en_reste") }), { maxLength: 1 }) }) }) }),
  fc.record({ type: fc.constant("planning.commit"), payload: fc.constant(null).map(sharedComteProposal) }),
  { arbitrary: fc.record({ type: fc.constant("stock.finish"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 3 }), resolution: fc.constant("rebuy") }) }), weight: 2 },
  fc.record({ type: fc.constant("undo"), payload: fc.record({ back: fc.integer({ min: 0, max: 2 }) }) }),
);
const sharedLineSeqArb = fc.tuple(fc.constant(false), fc.array(sharedLineTapArb, { maxLength: 14, size: "medium" })).map(toOps);

/**
 * Taps aimed at short meals: comté at home before the first planning (which reserves it for the gratin and the salade),
 * with or without a pack (250 g leaves a spare on the comté line), then « Il en reste » declaring less than they hold,
 * more comté added to Reste, purchases, receipts, removals, drops, cooks, covers and undos. The general taps make a meal short too
 * rarely for a cover to apply in their sequences (once in thousands of runs), nor from a line's spare at all.
 */
const shortTapArb = fc.oneof(
  { arbitrary: fc.record({ type: fc.constant("stock.partial"), payload: fc.record({ itemId: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 4 })), qtyText: fc.constantFrom("50 g", "10 g", "un peu"), low: fc.constant(false) }) }), weight: 3 },
  fc.record({ type: fc.constant("stock.add"), payload: fc.record({ label: fc.constant("comté"), productId: fc.constant(P.comte), qtyText: fc.constantFrom("30 g", "200 g"), useBy: fc.constant(null) }) }),
  fc.record({ type: fc.constant("shopping.buy"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 8 }) }) }),
  fc.record({ type: fc.constant("shopping.set_bought_qty"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 8 }), qty: fc.integer({ min: 1, max: 400 }) }) }),
  { arbitrary: fc.record({ type: fc.constant("meal.cover_shortfalls"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 3 }) }) }), weight: 3 },
  fc.record({ type: fc.constant("meal.drop"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 3 }) }) }),
  fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 3 }), sheet: fc.constant({ items: [] }) }) }),
  { arbitrary: fc.record({ type: fc.constant("undo"), payload: fc.record({ back: fc.integer({ min: 0, max: 3 }) }) }), weight: 2 },
  // « On en a déjà » on a line while comté added since sits libre in Reste: the meals reserve it before any new item
  fc.record({ type: fc.constant("shopping.remove"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 8 }), reason: fc.constantFrom("a_la_maison", "pas_achete") }) }),
  // buy a line, cook a meal it serves, then a receipt at or below what was eaten: the item turns unknown (never a false zero), one hold kept
  { arbitrary: fc.record({ type: fc.constant("receipt.eaten"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 4 }), mealId: fc.integer({ min: 1, max: 3 }), qty: fc.integer({ min: 1, max: 60 }) }) }), weight: 2 },
  // a declared leftover makes a meal short, a cover puts its need on a second line, comté is added to Reste, then « On en
  // a déjà » on a line (2 is the first planning's comté line, which the gratin and the salade share): free stock gives a
  // meal part of its share, and the new item must give it only the rest, not what the line set aside for the other meal
  { arbitrary: fc.record({ type: fc.constant("free.remove"), payload: fc.record({ declared: fc.constantFrom("10 g", "50 g"), mealId: fc.integer({ min: 1, max: 2 }), qtyText: fc.constantFrom("30 g", "200 g"), itemId: fc.oneof(fc.constant(2), fc.integer({ min: 1, max: 8 })) }) }), weight: 2 },
);
const shortSeqArb = fc.tuple(fc.constantFrom(null, 7, 250), fc.constantFrom("160 g", "300 g", "30 g"), fc.array(shortTapArb, { maxLength: 10, size: "medium" }))
  .map(([pack, home, taps]) => {
    const packs = fixtureState().products.map((p) => (p.id === P.comte ? pack : null));
    const ops = toOps([false, taps, packs]);
    const at = ops.findIndex((o) => o.opId === "commit");
    const stocked = { opId: "home", type: "stock.add", at: NOW, payload: { label: "comté", productId: P.comte, qtyText: home, useBy: null } };
    return [...ops.slice(0, at), stocked, ...ops.slice(at)];
  });

/**
 * Taps aimed at a drop that empties a line into another's spare: a comté pack, the first planning then the second (line A
 * 250 g for the gratin, the salade and the saumon's 50 g in packs of 250 g, line B for the saumon's other 50 g), then cooks,
 * drops, purchases and undos. Cooking one meal of A and dropping the other leaves A a cooked meal's share and the saumon's,
 * which B's spare takes, A leaving Courses empty; the general taps reach that in a few runs out of thousands.
 */
const mergeTapArb = fc.oneof(
  { arbitrary: fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 5 }), sheet: fc.constant({}) }) }), weight: 2 },
  { arbitrary: fc.record({ type: fc.constant("meal.drop"), payload: fc.record({ mealId: fc.integer({ min: 1, max: 5 }) }) }), weight: 2 },
  fc.record({ type: fc.constant("shopping.buy"), payload: fc.record({ itemId: fc.integer({ min: 1, max: 12 }) }) }),
  fc.record({ type: fc.constant("undo"), payload: fc.record({ back: fc.integer({ min: 0, max: 2 }) }) }),
);
const mergeSeqArb = fc.tuple(fc.constantFrom(250, 150, 120), fc.array(mergeTapArb, { maxLength: 8 })).map(([pack, taps]) =>
  toOps([false, [{ type: "planning.commit", payload: secondProposal() }, ...taps], fixtureState().products.map((p) => (p.id === P.comte ? pack : null))]));

/** What a meal is covered by, per product and unit: its shares on unbought lines plus its live reservations. */
function coverage(s: State, mealId: number): Map<string, number> {
  const out = new Map<string, number>();
  const add = (key: string, qty: number) => out.set(key, (out.get(key) ?? 0) + qty);
  for (const l of s.shoppingItems.filter((l) => l.boughtAt === null && l.removedAt === null && l.productId !== null && l.unit !== null)) {
    for (const f of l.forMeals.filter((f) => f.mealId === mealId)) add(`${l.productId}|${l.unit}`, f.qty);
  }
  for (const r of s.reservations.filter((r) => r.mealId === mealId && r.releasedAt === null && r.qty !== null && r.unit !== null)) {
    const productId = s.stockItems.find((i) => i.id === r.stockItemId)?.productId ?? null;
    if (productId !== null) add(`${productId}|${r.unit}`, r.qty!);
  }
  return out;
}

/**
 * The products of the items an op answers « Il en reste » on: from Reste, or in a Cuisiné sheet; and the product of the
 * line a receipt corrects, whose lower quantity trims the other meals' holds by the same rule.
 */
function declaredProducts(s: State, o: unknown): Set<number | null> {
  const { type, payload } = o as { type: string; payload: { itemId?: unknown; sheet?: { items?: { stockItemId: unknown; outcome: unknown }[] } } };
  if (type === "shopping.set_bought_qty") return new Set(s.shoppingItems.filter((l) => l.id === payload.itemId).map((l) => l.productId));
  const ids = type === "stock.partial" ? [payload.itemId]
    : type === "meal.cook" ? (payload.sheet?.items ?? []).filter((a) => a.outcome === "il_en_reste").map((a) => a.stockItemId) : [];
  return new Set(s.stockItems.filter((i) => ids.includes(i.id)).map((i) => i.productId));
}

/**
 * What a line removed « On n'en prend pas » carried, before the removal, for each meal open then, per
 * `meal|product|unit`: the most each shortfall may grow by that removal. Empty for any other op, and for a removal not
 * applied.
 */
function notTakenShares(s: State, o: unknown, status: string): Map<string, number> {
  const out = new Map<string, number>();
  const { type, payload } = o as { type: string; payload: { itemId?: unknown; reason?: unknown } };
  if (type !== "shopping.remove" || payload.reason !== "pas_achete" || status !== "applied") return out;
  const line = s.shoppingItems.find((l) => l.id === payload.itemId);
  if (!line || line.productId === null || line.unit === null) return out;
  const open = new Set(s.meals.filter((m) => m.cookedAt === null && m.droppedAt === null).map((m) => m.id));
  for (const f of line.forMeals.filter((x) => open.has(x.mealId))) out.set(`${f.mealId}|${line.productId}|${line.unit}`, (out.get(`${f.mealId}|${line.productId}|${line.unit}`) ?? 0) + f.qty);
  return out;
}

/** Per state reached, each meal's shortfalls when it was last open, so a meal an undo reopens may come back as short. */
const lastOpenShort = new WeakMap<State, Map<string, number>>();
/** Per state reached, each op applied on the way there: the shortfalls just before it and just after it. */
const opShorts = new WeakMap<State, Map<string, { pre: Map<string, number>; post: Map<string, number> }>>();

/**
 * Applies one op and asserts the resulting state breaks no domain invariant, whatever the op and its outcome. A meal may
 * fall short of a product (`meal_under_covered`) only where an « Il en reste » declared less than the other open meals
 * held of it (spec §6.3), or by at most its share on a line removed « On n'en prend pas » (`shopping.remove` with
 * `pas_achete`, per meal, product and unit): any other op leaves every shortfall as it was or smaller, and an undo that
 * reopens a meal brings it back no shorter than it was when last open. An undo may give back what its target took off a
 * shortfall (a purchase whose surplus went to a meal a receipt or a declared leftover left short), and no more.
 */
function step(s: State, o: unknown, now: string): ReturnType<typeof applyOp> {
  const r = applyOp(s, o, now);
  expect({ op: o, violations: invariantViolations(r.state).filter((v) => v.code !== "meal_under_covered") }).toEqual({ op: o, violations: [] });
  const key = (x: { mealId: number; productId: number; unit: Unit }) => `${x.mealId}|${x.productId}|${x.unit}`;
  const had = new Map(mealShortfalls(s).map((x) => [key(x), x.qty]));
  const remembered = new Map([...(lastOpenShort.get(s) ?? new Map<string, number>()), ...had]);
  for (const m of s.meals.filter((x) => x.cookedAt === null && x.droppedAt === null)) {
    for (const k of remembered.keys()) if (k.startsWith(`${m.id}|`) && !had.has(k)) remembered.delete(k);
  }
  lastOpenShort.set(r.state, remembered);
  const { opId, type, payload } = o as { opId: string; type: string; payload: { targetOpId?: unknown } };
  const shorts = new Map(opShorts.get(s) ?? []);
  if (!shorts.has(opId)) shorts.set(opId, { pre: had, post: new Map(mealShortfalls(r.state).map((x) => [key(x), x.qty])) });
  opShorts.set(r.state, shorts);
  const target = type === "undo" && typeof payload?.targetOpId === "string" ? shorts.get(payload.targetOpId) : undefined;
  const givenBack = (k: string) => (target ? Math.max(0, (target.pre.get(k) ?? 0) - (target.post.get(k) ?? 0)) : 0);
  const reopened = new Set(s.meals.filter((m) => m.cookedAt !== null || m.droppedAt !== null).map((m) => m.id));
  const declared = declaredProducts(s, o);
  const removed = notTakenShares(s, o, r.result.status);
  const grown = mealShortfalls(r.state)
    .filter((x) => x.qty > (had.get(key(x)) ?? (reopened.has(x.mealId) ? (remembered.get(key(x)) ?? 0) : 0)) + givenBack(key(x)) + (removed.get(key(x)) ?? 0)
      && !declared.has(x.productId))
    .map(key);
  expect({ op: o, grown }).toEqual({ op: o, grown: [] });
  return r;
}

function applyAll(state: State, ops: unknown[], now: string): State {
  return ops.reduce<State>((s, o) => step(s, o, now).state, state);
}

describe("op replay properties", () => {
  it("idempotence: resending any prefix before the full sequence changes nothing", () => {
    fc.assert(
      fc.property(fc.oneof(seqArb, shortSeqArb), fc.nat(), (ops, k) => {
        const once = applyAll(fixtureState(), ops, NOW);
        const prefix = ops.slice(0, k % (ops.length + 1));
        const twice = applyAll(applyAll(fixtureState(), prefix, NOW), ops, NOW);
        expect(tables(twice)).toBe(tables(once));
      }),
      { numRuns: 2000 }, // about 1000 each for the general and the aimed sequences
    );
  });

  it("offline = online: replaying the same taps later gives the same state", () => {
    fc.assert(
      fc.property(fc.oneof(seqArb, shortSeqArb), (ops) => {
        const live = applyAll(fixtureState(), ops, NOW);
        const late = applyAll(fixtureState(), ops, "2026-10-19T08:00:00Z");
        expect(tables(late)).toBe(tables(live));
      }),
      { numRuns: 2000 }, // about 1000 each for the general and the aimed sequences
    );
  });

  it("reservations never exceed what an item holds nor sit on a finished one nor a meal's need, undo included; dropping every open meal releases them all", () => {
    fc.assert(
      fc.property(fc.oneof(longSeqArb, shortSeqArb), (ops) => {
        let s = applyAll(fixtureState(), ops, NOW);
        for (const r of s.reservations) {
          expect(s.stockItems.some((i) => i.id === r.stockItemId)).toBe(true);
          expect(s.meals.some((m) => m.id === r.mealId)).toBe(true);
        }
        for (const item of s.stockItems) {
          const held = s.reservations.filter((r) => r.stockItemId === item.id && r.releasedAt === null);
          if (item.qty === null) expect(held.length).toBeLessThanOrEqual(1);
          else expect(held.filter((r) => r.unit === item.unit).reduce((n, r) => n + (r.qty ?? 0), 0)).toBeLessThanOrEqual(item.qty);
          if (item.finishedAt !== null) expect(held).toEqual([]);
        }
        for (const m of s.meals.filter((m) => m.cookedAt === null && m.droppedAt === null)) {
          const reserved = new Map<string, { productId: number; unit: Unit; qty: number }>();
          for (const r of s.reservations.filter((r) => r.mealId === m.id && r.releasedAt === null && r.qty !== null && r.unit !== null)) {
            const productId = s.stockItems.find((i) => i.id === r.stockItemId)!.productId;
            if (productId === null) continue;
            const entry = reserved.get(`${productId}|${r.unit}`) ?? { productId, unit: r.unit!, qty: 0 };
            entry.qty += r.qty!;
            reserved.set(`${productId}|${r.unit}`, entry);
          }
          for (const { productId, unit, qty } of reserved.values()) expect(qty).toBeLessThanOrEqual(mealNeed(s, m, productId, unit));
        }
        for (const m of s.meals.filter((m) => m.cookedAt === null && m.droppedAt === null)) {
          s = step(s, { opId: `drop-${m.id}`, type: "meal.drop", at: NOW, payload: { mealId: m.id } }, NOW).state;
        }
        expect(s.reservations.filter((r) => r.releasedAt === null)).toEqual([]);
      }),
      { numRuns: 2000 }, // about 1000 each for the general and the aimed sequences
    );
  }, 60_000);

  it("dropping a second round alone leaves its first round covered for min(what it had, its 1× need), however many lines carry it", () => {
    fc.assert(
      fc.property(fc.oneof(longSeqArb, twoLineSeqArb), (ops) => {
        let s = fixtureState();
        for (const o of ops) {
          s = step(s, o, NOW).state;
          for (const second of s.meals.filter((m) => m.doubledFrom !== null && m.cookedAt === null && m.droppedAt === null)) {
            const first = s.meals.find((m) => m.id === second.doubledFrom)!;
            if (first.cookedAt !== null || first.droppedAt !== null) continue;
            const before = coverage(s, first.id);
            const after = step(s, { opId: `drop-${second.id}`, type: "meal.drop", at: NOW, payload: { mealId: second.id } }, NOW).state;
            const now = coverage(after, first.id);
            for (const [key, had] of before) {
              const [productId, unit] = key.split("|") as [string, Unit];
              expect(now.get(key) ?? 0).toBe(Math.min(had, mealNeed(after, first, Number(productId), unit)));
            }
          }
        }
      }),
      { numRuns: 1000 },
    );
  }, 60_000);

  it("every open meal is covered for exactly its need less what a declared leftover left it short of: live reservations plus shares on unbought lines, per non-staple product and unit; an open second round whose first round is closed holds a plat cuisiné", () => {
    const covered = (ops: unknown[]) => {
      let s = fixtureState();
      for (const o of ops) {
        s = step(s, o, NOW).state;
        for (const m of s.meals.filter((x) => x.cookedAt === null && x.droppedAt === null)) {
          const first = s.meals.find((x) => x.id === m.doubledFrom);
          if (first && (first.cookedAt !== null || first.droppedAt !== null)) {
            const plats = s.reservations
              .filter((r) => r.mealId === m.id && r.releasedAt === null)
              .filter((r) => s.stockItems.find((i) => i.id === r.stockItemId)?.origin === "plat_cuisine");
            expect({ meal: m.id, plats: plats.length }).toEqual({ meal: m.id, plats: 1 });
          }
          const recipe = s.recipes.find((r) => r.id === m.recipeId)!;
          const ingredients = s.recipeIngredients.filter((i) => i.recipeId === recipe.id);
          const needs = recipeNeeds(ingredients, recipe.basePortions, m.portions, mealMultiplier(m, s.meals));
          const keys = new Set([...needs.map((n) => `${n.productId}|${n.unit}`), ...coverage(s, m.id).keys()]);
          for (const key of keys) {
            const [productId, unit] = key.split("|") as [string, Unit];
            if (s.products.find((p) => p.id === Number(productId))?.isStaple) continue;
            const short = mealShortfalls(s).find((x) => x.mealId === m.id && `${x.productId}|${x.unit}` === key)?.qty ?? 0;
            expect({ meal: m.id, key, covered: coverage(s, m.id).get(key) ?? 0 }).toEqual({ meal: m.id, key, covered: mealNeed(s, m, Number(productId), unit) - short });
          }
        }
      }
    };
    fc.assert(fc.property(fc.oneof(longSeqArb, twoLineSeqArb), covered), { numRuns: 1000 });
    fc.assert(fc.property(doubledSeqArb, covered), { numRuns: 5000 });
    fc.assert(fc.property(sharedLineSeqArb, covered), { numRuns: 2000 });
    fc.assert(fc.property(shortSeqArb, covered), { numRuns: 1000 });
  }, 60_000);

  // Regression: 9020707 — the staple bound covered open meals only, so a first round cooked at 1× after its
  // second round was dropped got its 2× lentilles share back when a purchase made before the drop was undone
  it("a meal's staple shares on unbought lines stay within its need: now while it is open, at cook time once cooked", () => {
    const withinNeed = (ops: { type: string; payload: unknown }[]) => {
      let s = fixtureState();
      /** each cooked meal's multiplier when its cook applied, recorded from the state the cook ran on */
      const cookedAt = new Map<number, 0 | 1 | 2>();
      for (const o of ops) {
        const before = s;
        s = step(s, o, NOW).state;
        for (const m of s.meals) {
          if (m.cookedAt === null) cookedAt.delete(m.id);
          else if (!cookedAt.has(m.id)) cookedAt.set(m.id, mealMultiplier(before.meals.find((x) => x.id === m.id)!, before.meals));
        }
        for (const m of s.meals.filter((x) => x.droppedAt === null)) {
          const recipe = s.recipes.find((r) => r.id === m.recipeId)!;
          const ingredients = s.recipeIngredients.filter((i) => i.recipeId === recipe.id);
          const needs = recipeNeeds(ingredients, recipe.basePortions, m.portions, m.cookedAt === null ? mealMultiplier(m, s.meals) : cookedAt.get(m.id)!);
          for (const l of s.shoppingItems.filter((x) => x.boughtAt === null && x.removedAt === null && x.productId !== null && x.unit !== null)) {
            if (!s.products.find((p) => p.id === l.productId)?.isStaple) continue;
            const shared = l.forMeals.filter((f) => f.mealId === m.id).reduce((n, f) => n + f.qty, 0);
            const need = needs.find((n) => n.productId === l.productId && n.unit === l.unit)?.qty ?? 0;
            expect({ meal: m.id, line: l.id, over: shared > need }).toEqual({ meal: m.id, line: l.id, over: false });
          }
        }
      }
    };
    fc.assert(fc.property(stapleSeqArb, withinNeed), { numRuns: 5000 });
    fc.assert(fc.property(doubledSeqArb, withinNeed), { numRuns: 5000 });
    fc.assert(fc.property(fc.oneof(longSeqArb, twoLineSeqArb), withinNeed), { numRuns: 1000 });
  }, 60_000);

  // Regression: 8e9c785 — cooking released a meal's reservations without taking what it ate off the item, so the eaten quantity read as libre for the next planning
  // An « Il en reste » with words is the owner saying what is left, which prevails over the subtraction (38c46e6): such
  // an item may hold more libre after the cook than before, and is left out.
  it("cooking never makes stock libre: what a meal held, it ate; only a meal its sheet drops, or a declared leftover, frees what it held", () => {
    fc.assert(
      fc.property(fc.oneof(longSeqArb, sharedLineSeqArb), (ops) => {
        let s = fixtureState();
        for (const o of ops) {
          const { state, result } = step(s, o, NOW);
          if (o.type === "meal.cook" && result.status === "applied") {
            // a « fini » with drop_meal drops another meal, and a dropped meal's reservations are libre again (§6.4)
            const dropped = new Set(state.meals.filter((m) => m.droppedAt !== null && s.meals.find((x) => x.id === m.id)!.droppedAt === null).map((m) => m.id));
            const sheet = (o.payload as { sheet?: { items?: { stockItemId: number; outcome: string; qtyText?: string | null }[] } }).sheet;
            const declared = new Set((sheet?.items ?? []).filter((a) => a.outcome === "il_en_reste" && (a.qtyText ?? "").trim() !== "").map((a) => a.stockItemId));
            for (const before of s.stockItems) {
              const was = libreQty(before, s.reservations);
              const after = state.stockItems.find((i) => i.id === before.id)!;
              // a finished item holds nothing libre whatever its numbers say
              if (was !== null && after.finishedAt === null && !declared.has(before.id)) {
                const freed = s.reservations
                  .filter((r) => r.stockItemId === before.id && r.releasedAt === null && dropped.has(r.mealId))
                  .reduce((n, r) => n + (r.qty ?? 0), 0);
                const now = libreQty(after, state.reservations);
                expect({ item: after.id, rose: now !== null && now > was + freed }).toEqual({ item: after.id, rose: false });
              }
            }
          }
          s = state;
        }
      }),
      { numRuns: 1000 },
    );
  }, 60_000);

  it("estimate = Σ lines: at commit, after drops, rebuys and undos, and in the Courses total", () => {
    fc.assert(
      fc.property(fc.oneof(seqArb, shortSeqArb), (ops) => {
        let s = fixtureState();
        /** each line's price and quantity when it first appeared, and how many meal shares it then carried */
        const first = new Map<number, { price: number; qty: number; shares: number }>();
        for (const o of ops) {
          const { state, result } = step(s, o, NOW);
          s = state;
          if (o.type === "planning.commit" && result.status === "applied") {
            const planning = s.plannings.at(-1)!;
            const lines = s.shoppingItems.filter((l) => l.planningId === planning.id && l.kind === "planning");
            expect(planning.estimateCents).toBe(lines.reduce((n, l) => n + (l.estPriceCents ?? 0), 0));
          }
          for (const id of first.keys()) if (!s.shoppingItems.some((l) => l.id === id)) first.delete(id);
          for (const l of s.shoppingItems) {
            // a receipt corrects a bought line's quantity, never its price: the price stays the planned quantity's
            const qty = l.plannedQty ?? l.qty;
            if (l.estPriceCents === null || qty === null) continue;
            const base = first.get(l.id) ?? { price: l.estPriceCents, qty, shares: Math.max(1, l.forMeals.length) };
            first.set(l.id, base);
            if (qty === 0) expect(l.estPriceCents).toBe(0);
            // proportional to the quantity left, within half a cent per share taken off
            expect(Math.abs(2 * (l.estPriceCents * base.qty - base.price * qty))).toBeLessThanOrEqual(base.qty * base.shares);
          }
          const courses = snapshot(s, NOW).courses;
          expect(courses.estimateCents).toBe(courses.lines.filter((l) => l.kind === "planning").reduce((n, l) => n + (l.estPriceCents ?? 0), 0));
        }
      }),
      { numRuns: 2000 }, // about 1000 each for the general and the aimed sequences
    );
  });
  // Regression: beda49f — an « Il en reste » repeating the item's words was applied with no change, so the undo of
  // the earlier one went through and took the item back to before it, erasing the later one still in effect
  // Regression: 99b4539 — a later write that left the item as the undone op had (« un fond », « presque fini »,
  // « un fond » again, or a cook's « Il en reste » in the same words) let the undo of the first erase the writes after it
  it("an undo leaves the state the ops still in effect fold to, a write repeated with identical values included", () => {
    // the saumon doubled: the comté bought from line 2 is item 1, the saumon from line 7 item 2, and cooking the first
    // round (meal 3) makes item 3, the plat cuisiné its second round (meal 4) holds
    const COMTE = 1;
    const PLAT = 3;
    const words = fc.constantFrom("un fond", "presque fini", "50 g", "");
    const item = fc.constantFrom(COMTE, PLAT);
    const sheet = (stockItemId: number) => fc.record({ items: words.map((qtyText) => [{ stockItemId, outcome: "il_en_reste", qtyText, low: false }]) });
    const repeatTapArb = fc.oneof(
      { arbitrary: fc.record({ type: fc.constant("stock.partial"), payload: fc.record({ itemId: item, qtyText: words, low: fc.constant(false) }) }), weight: 3 },
      fc.record({ type: fc.constant("stock.set_use_by"), payload: fc.record({ itemId: item, useBy: fc.constantFrom("2026-10-20", "2026-10-25") }) }),
      // the gratin or the salade cooked, its sheet answering « Il en reste » on the comté both hold; or the second round,
      // answering it on the plat cuisiné, which cooking leaves as it was (it has no quantity to take off)
      fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.constantFrom(1, 2), sheet: sheet(COMTE) }) }),
      fc.record({ type: fc.constant("meal.cook"), payload: fc.record({ mealId: fc.constant(4), sheet: sheet(PLAT) }) }),
      { arbitrary: fc.record({ type: fc.constant("undo"), payload: fc.record({ back: fc.integer({ min: 0, max: 3 }) }) }), weight: 2 },
    );
    const repeatSeqArb = fc.array(repeatTapArb, { maxLength: 8 }).map((taps) => {
      // an undo names a tap after the three that set the scene: undoing those frees ids the fold would hand out again
      const aimed: { type: string; payload: unknown }[] = [];
      for (const t of taps) {
        if (t.type !== "undo") aimed.push(t);
        else if (aimed.length > 0) aimed.push({ ...t, payload: { back: Math.min((t.payload as { back: number }).back, aimed.length - 1) } });
      }
      const [commit, ...rest] = toOps([true, [
        { type: "shopping.buy", payload: { itemId: 2 } }, { type: "shopping.buy", payload: { itemId: 7 } }, { type: "meal.cook", payload: { mealId: 3, sheet: {} } },
        ...aimed,
      ]]);
      return [commit!, ...rest];
    });
    fc.assert(
      fc.property(repeatSeqArb, (ops) => {
        const s = applyAll(fixtureState(), ops, NOW);
        const inEffect = ops.filter((o) => o.type !== "undo" && storedOp(s.appliedOps, o.opId)?.status === "applied" && storedOp(s.appliedOps, o.opId)?.undoneBy === null);
        const fold = applyAll(fixtureState(), inEffect, NOW);
        expect(stableStringify(s.stockItems)).toBe(stableStringify(fold.stockItems));
      }),
      { numRuns: 2000 },
    );
  }, 60_000);

  it("meal.cover_shortfalls leaves its meal short of nothing and no item over-reserved, and its undo puts every row back", () => {
    let reached = 0;
    // each way a cover places a shortfall, counted so that none of them is left to the example tests alone
    const outcomes = { stock: 0, spare: 0, newLine: 0 };
    const share = (s: State, lineId: number, mealId: number) => s.shoppingItems.find((l) => l.id === lineId)?.forMeals.find((x) => x.mealId === mealId)?.qty ?? 0;
    fc.assert(
      fc.property(fc.oneof(longSeqArb, sharedLineSeqArb, shortSeqArb), (ops) => {
        let s = fixtureState();
        for (const o of ops) {
          s = step(s, o, NOW).state;
          // other meals may stay short: only the covered one is checked; step checks every other invariant
          for (const mealId of new Set(mealShortfalls(s).map((x) => x.mealId))) {
            reached += 1;
            const cover = { opId: `cover-${mealId}`, type: "meal.cover_shortfalls", at: NOW, payload: { mealId } };
            const covered = step(s, cover, NOW);
            expect({ meal: mealId, status: covered.result.status }).toEqual({ meal: mealId, status: "applied" });
            expect(mealShortfalls(covered.state).filter((x) => x.mealId === mealId)).toEqual([]);
            if (covered.state.reservations.length > s.reservations.length) outcomes.stock += 1;
            if (s.shoppingItems.some((l) => share(covered.state, l.id, mealId) > share(s, l.id, mealId))) outcomes.spare += 1;
            if (covered.state.shoppingItems.length > s.shoppingItems.length) outcomes.newLine += 1;
            const undone = applyOp(covered.state, { opId: `undo-${mealId}`, type: "undo", at: NOW, payload: { targetOpId: cover.opId } }, NOW);
            expect({ meal: mealId, status: undone.result.status }).toEqual({ meal: mealId, status: "applied" });
            expect(tables(undone.state)).toBe(tables(s));
          }
        }
      }),
      { numRuns: 1000 },
    );
    expect(reached).toBeGreaterThan(0);
    expect(outcomes.stock, JSON.stringify(outcomes)).toBeGreaterThan(0);
    expect(outcomes.spare, JSON.stringify(outcomes)).toBeGreaterThan(0);
    expect(outcomes.newLine, JSON.stringify(outcomes)).toBeGreaterThan(0);
  }, 60_000);

  it("covers apply in the aimed sequences, so the replay properties interleave them with the other taps", () => {
    const sequences = fc.sample(shortSeqArb, { numRuns: 200, seed: 1 });
    const covering = sequences.filter((ops) => {
      const s = applyAll(fixtureState(), ops, NOW);
      return ops.some((o) => o.type === "meal.cover_shortfalls" && storedOp(s.appliedOps, o.opId)?.status === "applied");
    });
    expect(covering.length).toBeGreaterThanOrEqual(10); // 62 of 200 at this seed
  });

  it("receipts at or below what was eaten turn an item unknown in the aimed sequences, under the invariant checks", () => {
    const sequences = fc.sample(shortSeqArb, { numRuns: 200, seed: 1 });
    const turning = sequences.filter((ops) => {
      let s = fixtureState();
      let turned = false;
      for (const o of ops) {
        const before = s;
        s = step(s, o, NOW).state;
        if (o.type !== "shopping.set_bought_qty" || storedOp(s.appliedOps, o.opId)?.status !== "applied") continue;
        const itemId = (o.payload as { itemId: number }).itemId;
        const item = (st: State) => st.stockItems.find((i) => i.sourceShoppingItemId === itemId);
        if (item(before)?.qty != null && item(s)?.qty === null) turned = true;
      }
      return turned;
    });
    expect(turning.length).toBeGreaterThanOrEqual(15); // 37 of 200 at this seed
  });

  it("packs are set in the random states: some sequences give a product a pack and some line rounds up to it", () => {
    const sequences = fc.sample(seqArb, { numRuns: 200, seed: 1 });
    const withPack = sequences.filter((ops) => ops.some((o) => o.type === "product.pack"));
    expect(withPack.length).toBeGreaterThan(100);
    const rounded = withPack.filter((ops) => {
      const s = applyAll(fixtureState(), ops.slice(0, ops.findIndex((o) => o.opId === "commit") + 1), NOW);
      return s.shoppingItems.some((l) => {
        const pack = s.products.find((p) => p.id === l.productId)?.pack;
        return pack != null && pack.unit === l.unit && l.qty !== null && l.qty % pack.qty === 0 && l.qty > l.forMeals.reduce((n, f) => n + f.qty, 0);
      });
    });
    expect(rounded.length).toBeGreaterThan(20);
  });

  it("a meal.drop never raises a line's quantity or price, packs or not", () => {
    fc.assert(
      fc.property(fc.oneof(seqArb, longSeqArb), (ops) => {
        let s = fixtureState();
        for (const o of ops) {
          const { state } = step(s, o, NOW);
          if (o.type === "meal.drop") {
            for (const before of s.shoppingItems) {
              const after = state.shoppingItems.find((l) => l.id === before.id)!;
              if (before.qty !== null) expect({ line: before.id, qty: after.qty! <= before.qty }).toEqual({ line: before.id, qty: true });
              if (before.estPriceCents !== null) expect({ line: before.id, price: after.estPriceCents! <= before.estPriceCents }).toEqual({ line: before.id, price: true });
            }
          }
          s = state;
        }
      }),
      { numRuns: 1000 },
    );
  }, 60_000);

  it("the undo of a meal.drop right after it applies and puts every row back, a line it emptied into another's spare included", () => {
    let merged = 0;
    fc.assert(
      fc.property(mergeSeqArb, (ops) => {
        let s = fixtureState();
        for (const o of ops) {
          const r = step(s, o, NOW);
          if (o.type === "meal.drop" && r.result.status === "applied") {
            const dropped = (o.payload as { mealId: number }).mealId;
            // a line the drop removed while it still carried another meal's share, cooked since: the shape counted
            if (r.state.shoppingItems.some((l) => l.removedAt !== null && s.shoppingItems.some((b) => b.id === l.id && b.removedAt === null
              && b.forMeals.some((f) => f.mealId !== dropped && r.state.meals.some((m) => m.id === f.mealId && m.cookedAt !== null))))) merged += 1;
            const undone = step(r.state, { opId: `undo-${o.opId}`, type: "undo", at: NOW, payload: { targetOpId: o.opId } }, NOW);
            expect({ op: o.opId, result: undone.result }).toMatchObject({ op: o.opId, result: { status: "applied" } });
            expect(tables(undone.state)).toBe(tables(s));
          }
          s = r.state;
        }
      }),
      { numRuns: 1000 },
    );
    expect(merged).toBeGreaterThan(0);
  }, 60_000);
});
