import { mealShortfalls, type Shortfall } from "../domain/invariants";
import { liveReservations } from "../domain/quantities";
import { libreTake, stockByUseBy } from "../domain/shopping-plan";
import type { State, Unit } from "../domain/types";
import { AccessRefused, CliError, NotFinal, fetchState, postOp, type ClientConfig, type FetchLike } from "./client";
import { euros, mealTitle, quantity } from "./format";

/**
 * `plan -- manques [<repas>…]`: puts what an open meal lacks (« Manques » of `status`) back on the owners' side of the
 * shop, with `meal.cover_shortfalls` (spec §6.5, §7.2), the op the phone's « Ajouter aux courses » sends too: free Reste
 * stock first, then Courses. One op per request, so a cut run loses one answer at most. A covered meal answers noop, so
 * a rerun after an exit 2 is safe.
 */
export interface ManquesDeps { cfg: ClientConfig; fetch: FetchLike; now: () => string; uuid: () => string }

/**
 * Free Reste stock of a product in one unit: what `meal.cover_shortfalls` could reserve of it, by the rule its first step
 * reads (`stockByUseBy`, `libreTake`), with no need to stop at.
 */
export function freeStock(state: State, productId: number, unit: Unit): number {
  const live = liveReservations(state);
  return stockByUseBy(state)
    .filter((i) => i.productId === productId)
    .reduce((sum, i) => sum + libreTake(i, live, unit, Infinity), 0);
}

/** Where `meal.cover_shortfalls` put one shortfall, read from the state before and after. */
function placed(before: State, after: State, x: Shortfall): string {
  const where: string[] = [];
  const known = new Set(before.reservations.map((r) => r.id));
  for (const r of after.reservations) {
    const item = after.stockItems.find((i) => i.id === r.stockItemId);
    if (known.has(r.id) || r.mealId !== x.mealId || r.unit !== x.unit || item?.productId !== x.productId) continue;
    where.push(`Reste #${r.stockItemId} (réservé)`);
  }
  const share = (s: State, id: number) => s.shoppingItems.find((l) => l.id === id)?.forMeals.find((f) => f.mealId === x.mealId)?.qty ?? 0;
  for (const line of after.shoppingItems) {
    if (line.productId !== x.productId || line.unit !== x.unit || share(after, line.id) === share(before, line.id)) continue;
    const isNew = !before.shoppingItems.some((l) => l.id === line.id);
    const price = line.estPriceCents === null ? "prix inconnu" : euros(line.estPriceCents);
    where.push(isNew ? `nouvelle ligne ${line.label} ${quantity(line.qty, line.unit)}, ${price}` : `ligne #${line.id} (réserve)`);
  }
  return where.join(", ");
}

export async function manquesText(mealIds: number[], deps: ManquesDeps): Promise<{ output: string; exitCode: 0 | 1 | 2 }> {
  const before = await fetchState(deps.cfg, deps.fetch);
  const short = mealShortfalls(before);
  const targets = mealIds.length ? [...new Set(mealIds)] : [...new Set(short.map((x) => x.mealId))];
  if (targets.length === 0) return { output: "Manques : aucun", exitCode: 0 };

  const sent: { mealId: number; status: "applied" | "noop" | "refused"; reason: string | null | undefined }[] = [];
  // an answer that may have landed carries the rerun hint once (« réponse non définitive » already says to rerun); an Access
  // refusal landed nowhere, and a rerun cannot change it
  const failed = new Map<number, string>();
  const SAFE = "un repas déjà couvert répond « rien ne manque ».";
  for (const mealId of targets) {
    try {
      const { result } = await postOp(deps.cfg, deps.fetch, { opId: `manques-${deps.uuid()}`, type: "meal.cover_shortfalls", at: deps.now(), payload: { mealId } });
      sent.push({ mealId, status: result.status, reason: result.reason });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      failed.set(mealId, error instanceof AccessRefused ? error.message
        : error instanceof NotFinal ? `${error.message} : ${SAFE}` : `${error.message}\nRelancez la même commande : ${SAFE}`);
    }
  }
  const after = sent.some((s) => s.status === "applied") ? await fetchState(deps.cfg, deps.fetch) : before;

  const out: string[] = [];
  for (const mealId of targets) {
    const lost = failed.get(mealId);
    if (lost !== undefined) { out.push(`✗ #${mealId} : ${lost}`); continue; }
    const s = sent.find((x) => x.mealId === mealId)!;
    if (s.status === "refused") { out.push(`✗ #${mealId} : refusé (${s.reason ?? "sans raison"})`); continue; }
    if (s.status === "noop") { out.push(`= #${mealId} : ${s.reason ?? "rien ne manque"}`); continue; }
    for (const x of short.filter((y) => y.mealId === mealId)) {
      const name = before.products.find((p) => p.id === x.productId)?.name ?? `produit #${x.productId}`;
      out.push(`+ #${mealId} ${mealTitle(before, mealId)} : ${name} ${quantity(x.qty, x.unit)} → ${placed(before, after, x)}`);
    }
  }
  const refused = sent.some((s) => s.status === "refused");
  return { output: out.join("\n"), exitCode: failed.size ? 2 : refused ? 1 : 0 };
}
