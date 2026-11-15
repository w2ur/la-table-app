import { parseDeclaredQty } from "../domain/declared";
import { mealShortfalls } from "../domain/invariants";
import { packedQty } from "../domain/packs";
import { sharedQty } from "../domain/quantities";
import type { ProductPack, StockItem, Unit } from "../domain/types";
import { CliError, fetchState, postOp, type ClientConfig, type FetchLike } from "./client";
import { mealTitle, quantity } from "./format";

/**
 * `plan -- bought <ligne> <mots…> [--oui]`: what a receipt says a bought line really was (a loose product's weight or
 * count, or packs beyond the plan), sent as the CLI-only `shopping.set_bought_qty` (spec §6.5, §7.1 step 2). The words
 * parse in the line's unit as a « Il en reste » does. The op sets a value, so a rerun after an exit 2 is safe.
 */
export interface BoughtDeps { cfg: ClientConfig; fetch: FetchLike; now: () => string; uuid: () => string }

/**
 * Above this many times the line's planned quantity (`plannedFor`), or below that fraction of it, a receipt is taken for a
 * typo unless `--oui` says otherwise: measured against the plan, so a second correction cannot drift tenfold from the first.
 * Downward matters as much: a « 2 g » for « 200 g » trims the meals' holds on the item, or leaves it unknown.
 */
export const BOUGHT_CONFIRM_RATIO = 10;

/**
 * What a line was planned at, from what a receipt never changes: its meals' shares rounded up to the product's pack as it
 * is now (a pack set since the planning only moves the guard, never a price). Not `plannedQty`, which is the price basis and is not kept on an unpriced line. A line with no
 * shares falls back to `plannedQty ?? qty`.
 */
function plannedFor(line: { forMeals: readonly { qty: number }[]; plannedQty: number | null; qty: number; unit: Unit }, pack: ProductPack | null): number {
  return line.forMeals.length > 0 ? packedQty(sharedQty(line), line.unit, pack) : (line.plannedQty ?? line.qty);
}

export async function boughtText(args: { lineId: number; words: string; confirmed: boolean }, deps: BoughtDeps): Promise<{ output: string; exitCode: 0 | 1 }> {
  const before = await fetchState(deps.cfg, deps.fetch);
  const line = before.shoppingItems.find((l) => l.id === args.lineId && l.removedAt === null);
  if (!line) return { output: `Rien n'est envoyé : #${args.lineId} n'est pas sur Courses.`, exitCode: 1 };
  if (line.productId === null || line.unit === null || line.qty === null) {
    return { output: `Rien n'est envoyé : #${line.id} ${line.label} est un article sans produit.`, exitCode: 1 };
  }
  const product = before.products.find((p) => p.id === line.productId);
  const qty = parseDeclaredQty(args.words, line.unit, product?.pack ?? null);
  if (qty === null) {
    return { output: `Rien n'est envoyé : « ${args.words} » n'est pas une quantité de ${line.label} en ${line.unit === "piece" ? "pièces" : line.unit}.`, exitCode: 1 };
  }
  const planned = plannedFor({ ...line, qty: line.qty, unit: line.unit }, product?.pack ?? null);
  const drift = qty > BOUGHT_CONFIRM_RATIO * planned ? `plus de ${BOUGHT_CONFIRM_RATIO} fois` : qty * BOUGHT_CONFIRM_RATIO < planned ? `plus de ${BOUGHT_CONFIRM_RATIO} fois moins` : null;
  if (planned > 0 && drift !== null && !args.confirmed) {
    return {
      output: `Rien n'est envoyé : ${quantity(qty, line.unit)} pour ${quantity(planned, line.unit)} prévus, ${drift} ; relancez avec --oui si le ticket le dit.`,
      exitCode: 1,
    };
  }

  const { result } = await postOp(deps.cfg, deps.fetch, {
    opId: `bought-${deps.uuid()}`, type: "shopping.set_bought_qty", at: deps.now(), payload: { itemId: line.id, qty },
  });
  if (result.status === "refused") return { output: `✗ #${line.id} ${line.label} : refusé (${result.reason ?? "sans raison"})`, exitCode: 1 };
  if (result.status === "noop") return { output: `= ${line.label} : ${quantity(line.qty, line.unit)}`, exitCode: 0 };

  const after = await fetchState(deps.cfg, deps.fetch);
  // the purchase's item, as shopping.set_bought_qty reads it: one « On en a déjà » put in Reste names no line
  const purchase = (i: StockItem) => i.sourceShoppingItemId === line.id;
  const itemBefore = before.stockItems.find(purchase);
  const itemAfter = after.stockItems.find(purchase);
  if (!itemBefore || !itemAfter) throw new CliError(`shopping.set_bought_qty : l'article du Reste de #${line.id} est absent de l'état`, 2);
  const out = [`~ ${line.label} : ${quantity(line.qty, line.unit)} → ${quantity(qty, line.unit)} · Reste #${itemAfter.id} ${quantity(itemBefore.qty, itemBefore.unit)} → ${quantity(itemAfter.qty, itemAfter.unit)}`];
  const had = new Map(mealShortfalls(before).map((x) => [`${x.mealId}|${x.productId}|${x.unit}`, x.qty]));
  for (const x of mealShortfalls(after)) {
    if (x.productId !== line.productId || x.qty <= (had.get(`${x.mealId}|${x.productId}|${x.unit}`) ?? 0)) continue;
    out.push(`  ! #${x.mealId} ${mealTitle(after, x.mealId)} : il manque ${product?.name ?? line.label} ${quantity(x.qty, x.unit)} (plan -- manques ${x.mealId})`);
  }
  return { output: out.join("\n"), exitCode: 0 };
}
