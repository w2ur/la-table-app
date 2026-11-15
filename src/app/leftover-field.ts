import { unitName, type Unit } from "../domain/units";
import type { ResteItem } from "../domain/snapshot";

/**
 * The unit an « Il en reste » field is in (spec §10.1, §10.3): the item's own, else its product's base unit, which the
 * server reads the words in too (declared.ts `declaredLeftover`); null for a free-text item or a plat cuisiné.
 */
export function leftOverUnit(item: Pick<ResteItem, "unit" | "productUnit"> | undefined): Unit | null {
  return item?.unit ?? item?.productUnit ?? null;
}

/** The word shown after the field: « g », « ml », « pièce » for what is typed up to 1, « pièces » otherwise; nothing without a unit. */
export function leftOverSuffix(unit: Unit | null, text = ""): string {
  return unit === null ? "" : unitName(unit, Number(text.trim().replace(",", ".")) || 2);
}

/**
 * The field's example: a bare number when the unit stands beside the field (« ex. 125 », « ex. 2 »), so the unit is not
 * read twice. Without a unit (a plat cuisiné, a free-text item) no amount is read, so the example is words: « ex. la moitié ».
 */
export function leftOverPlaceholder(unit: Unit | null): string {
  if (unit === null) return "ex. la moitié";
  return unit === "piece" ? "ex. 2" : "ex. 125";
}

const BARE_NUMBER = /^\d+(?:[.,]\d+)?$/;
const NUMBER_AND_WORD = /^(\d+(?:[.,]\d+)?)\s*(\p{L}+)$/u;

/**
 * What an « Il en reste » field opens with, so that a sheet left untouched changes nothing: empty on an item that holds a number, since a declared amount
 * leaves no words (declared.ts `declaredLeftover`) and sent empty the quantity stands; otherwise the item's own words, so
 * a cook who types nothing sends them back unchanged. Words that end in the unit shown beside the field (« 125 g », a row
 * kept as text) open as their number only, so the field never reads « 125 g g ».
 */
export function leftOverPrefill(item: Pick<ResteItem, "qty" | "qtyText" | "unit" | "productUnit"> | undefined): string {
  if (!item || item.qty !== null) return "";
  const words = item.qtyText ?? "";
  const unit = leftOverUnit(item);
  const match = NUMBER_AND_WORD.exec(words.trim());
  if (unit === null || !match) return words;
  const word = match[2]!.toLowerCase();
  return word === unit || word === unitName(unit, 1) || word === unitName(unit, 2) ? match[1]! : words;
}

/**
 * The words an « Il en reste » sends: trimmed, null when empty, and a bare number given the unit shown beside the field
 * (« 125 » → « 125 g »), since that is what the owner read. Any other words go as typed: the server stays strict (a bare
 * number only on pieces), so dictation and the planning CLI are read as before.
 */
export function leftOverWords(text: string, unit: Unit | null): string | null {
  const words = text.trim();
  if (words === "") return null;
  if (unit === null || !BARE_NUMBER.test(words)) return words;
  return `${words} ${unitName(unit, Number(words.replace(",", ".")))}`;
}
