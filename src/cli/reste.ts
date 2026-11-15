import { resteItems } from "../domain/snapshot";
import type { State, StockItem } from "../domain/types";
import { CliError, fetchState, postOp, type ClientConfig, type FetchLike } from "./client";
import { quantity } from "./format";

/**
 * `plan -- reste <id> <mots…> [--low|--pas-low]`: the owner's answer to « Restes à préciser », sent as the phone's own
 * `stock.partial`, so the server parses the words into the item's unit (spec §6.5). It sets a value, so a rerun after an
 * exit 2 is safe. « Presque fini » is the item's own unless a flag says otherwise: a phone's mark is never cleared.
 */
export interface ResteDeps { cfg: ClientConfig; fetch: FetchLike; now: () => string; uuid: () => string }

/**
 * Open product items whose quantity Reste cannot count on (spec §7.1 step 3): 0 or unknown, whatever their words. Words
 * that would parse are listed too: a row kept as text before the server read them (« 120 g » beside an unknown quantity)
 * becomes a number once `plan -- reste <id>` sends them back. A staple is left out, as the phone leaves it out of coverage.
 */
export function unknownLeftovers(state: State): StockItem[] {
  return state.stockItems.filter((i) => {
    if (i.finishedAt !== null || i.productId === null || (i.qty !== null && i.qty !== 0)) return false;
    const product = state.products.find((p) => p.id === i.productId);
    return product !== undefined && !product.isStaple;
  });
}

/** An item as the owner reads it: its quantity, then its words when it keeps some. */
export function leftoverLine(i: Pick<StockItem, "qty" | "unit" | "qtyText">): string {
  return `${quantity(i.qty, i.unit)}${i.qtyText ? ` « ${i.qtyText} »` : ""}`;
}

export async function resteText(args: { itemId: number; words: string; low: boolean | null }, deps: ResteDeps): Promise<{ output: string; exitCode: 0 | 1 }> {
  const state = await fetchState(deps.cfg, deps.fetch);
  const item = state.stockItems.find((s) => s.id === args.itemId);
  if (!item) return { output: `Rien n'est envoyé : #${args.itemId} n'est pas au Reste.`, exitCode: 1 };
  if (item.finishedAt !== null) return { output: `Rien n'est envoyé : #${args.itemId} ${item.label} est fini.`, exitCode: 1 };

  const before = leftoverLine(item);
  const { result, snapshot } = await postOp(deps.cfg, deps.fetch, {
    opId: `reste-${deps.uuid()}`, type: "stock.partial", at: deps.now(),
    payload: { itemId: item.id, qtyText: args.words, low: args.low ?? item.isLow },
  });
  if (result.status === "refused") return { output: `✗ #${item.id} ${item.label} : refusé (${result.reason ?? "sans raison"})`, exitCode: 1 };
  const after = resteItems(snapshot).find((i) => i.id === item.id);
  if (!after) throw new CliError(`stock.partial : #${item.id} absent de la réponse`, 2);
  const line = `#${item.id} ${item.label} : ${before} → ${leftoverLine(after)}`;
  return { output: result.status === "noop" ? `= ${line}` : `~ ${line}`, exitCode: 0 };
}
