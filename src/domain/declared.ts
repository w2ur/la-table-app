import { toBase, type Unit } from "./units";

const UNIT_WORDS: Record<string, string> = {
  g: "g", gr: "g", gramme: "g", grammes: "g",
  kg: "kg", kilo: "kg", kilos: "kg",
  ml: "ml", cl: "cl",
  l: "l", litre: "l", litres: "l",
  piece: "piece", pieces: "piece", pièce: "piece", pièces: "piece", pc: "piece", pcs: "piece",
};

const PACKAGING_WORDS = new Set([
  "paquet", "paquets", "pot", "pots", "boite", "boites", "boîte", "boîtes",
  "bouteille", "bouteilles", "brique", "briques", "sachet", "sachets", "barquette", "barquettes",
]);

const DECLARED = /^(\d+(?:[.,]\d+)?)\s*(\p{L}*)$/u;

/**
 * The words an owner typed for what is left (« 125g », « 1,5 kg », « 2 boîtes ») → an integer
 * quantity in the item's unit, or null when they are not one: no number, another dimension, a
 * word that is no unit, a packaging word without a pack in that unit, or a result of 0.
 */
export function parseDeclaredQty(text: string, unit: Unit, pack?: { qty: number; unit: Unit } | null): number | null {
  const match = DECLARED.exec(text.trim().toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]!.replace(",", "."));
  const word = match[2]!;
  if (!Number.isFinite(amount)) return null;

  let qty: number;
  if (word === "") {
    if (unit !== "piece") return null;
    qty = Math.round(amount);
  } else if (PACKAGING_WORDS.has(word)) {
    if (!pack || pack.unit !== unit) return null;
    qty = Math.round(amount * pack.qty);
  } else {
    const base = UNIT_WORDS[word];
    if (base === undefined) return null;
    try {
      const converted = toBase(amount, base);
      if (converted.unit !== unit) return null;
      qty = converted.qty;
    } catch {
      return null;
    }
  }
  return qty >= 1 ? qty : null;
}

/** What an item holds now, as a declared leftover reads it. */
export interface DeclaredItem {
  qty: number | null;
  unit: Unit | null;
  qtyText: string | null;
}

/** A live reservation of another open meal on the item: whose, and how much in which unit. */
export interface DeclaredHold {
  mealId: number;
  qty: number | null;
  unit: Unit | null;
}

/**
 * What the rule needs beyond the item: its product's base unit and pack (none for a free-text item or a plat cuisiné),
 * and the live reservations of the other open meals that still hold it (the cooking meal's own are released first).
 */
export interface DeclaredContext {
  productUnit: Unit | null;
  pack: { qty: number; unit: Unit } | null;
  held: readonly DeclaredHold[];
}

/** A hold after the rule, in the order `held` gave: its quantity now, or released (that meal is now short of it). */
export interface HoldAfter {
  qty: number | null;
  released: boolean;
}

export interface Declared {
  item: DeclaredItem;
  holds: HoldAfter[];
}

/**
 * Spec §6.3 and §6.5: the item after an « Il en reste », from the Cuisiné sheet (`meal.cook`, after what the meal ate was
 * taken off) or from Reste (`stock.partial`), and after a `stock.add`'s words. One rule for the server and the phone's
 * projection (src/app/sync/project.ts), so both show the same.
 *
 * - What the owners declare is the truth: words that parse in the item's unit (its product's base unit when the item has
 *   none) become `qty`, the unit is set, and the words go (`qtyText` null; the row shows the amount).
 * - Never a false zero: words that do not parse are kept (trimmed) as `qtyText` with `qty` unknown (null); no words leave
 *   the quantity as it is, unless it is 0 (or unknown), which becomes unknown.
 * - The other open meals' holds follow (spec §6.3): when they hold more than a known quantity in its unit, they are
 *   trimmed, the most recently planned meal first, each down to 0 (released) if need be, until they fit; an unknown
 *   quantity is held by one reservation at most (invariants.ts `item_over_reserved`), the earliest planned
 *   meal's, the others released. A trimmed meal is short of that product: `plan -- status` lists it under « Manques ».
 *   Meal ids are issued in planning order and never reused (state.ts `nextId`), so the latest planned is the highest id.
 *
 * `words` undefined (a sheet answer without them) keeps the item's own; null or blank clears them.
 */
export function declaredLeftover(item: DeclaredItem, words: string | null | undefined, ctx: DeclaredContext): Declared {
  const unit = item.unit ?? ctx.productUnit;
  const text = words?.trim() ?? "";
  if (text !== "") {
    const parsed = unit === null ? null : parseDeclaredQty(text, unit, ctx.pack);
    if (parsed !== null) return { item: { qty: parsed, unit, qtyText: null }, holds: fitHolds(parsed, unit, ctx.held) };
    return { item: { qty: null, unit: item.unit, qtyText: text }, holds: earliestHold(ctx.held) };
  }
  const qtyText = words === undefined ? item.qtyText : null;
  if (item.qty !== null && item.qty > 0) return { item: { qty: item.qty, unit: item.unit, qtyText }, holds: fitHolds(item.qty, item.unit, ctx.held) };
  return { item: { qty: null, unit: item.unit, qtyText }, holds: earliestHold(ctx.held) };
}

/** Latest planned first: the highest meal id, then the later of two holds of one meal. */
const latestFirst = (held: readonly DeclaredHold[]): number[] =>
  held.map((_, i) => i).sort((a, b) => held[b]!.mealId - held[a]!.mealId || b - a);

/** The holds in the item's unit trimmed, latest planned first, until their sum fits `qty`; the others as they are. */
function fitHolds(qty: number, unit: Unit | null, held: readonly DeclaredHold[]): HoldAfter[] {
  const holds = held.map((h) => ({ qty: h.qty, released: false }));
  let excess = held.reduce((sum, h) => sum + (h.unit === unit && h.qty !== null ? h.qty : 0), 0) - qty;
  for (const i of latestFirst(held)) {
    const h = held[i]!;
    if (excess <= 0) break;
    if (h.unit !== unit || h.qty === null) continue;
    if (h.qty <= excess) holds[i] = { qty: h.qty, released: true };
    else holds[i] = { qty: h.qty - excess, released: false };
    excess -= h.qty;
  }
  return holds;
}

/** An unknown quantity keeps one hold: the earliest planned meal's (its first), the others released. */
function earliestHold(held: readonly DeclaredHold[]): HoldAfter[] {
  const kept = latestFirst(held).at(-1);
  return held.map((h, i) => ({ qty: h.qty, released: i !== kept }));
}
