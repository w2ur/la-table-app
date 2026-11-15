import { liveReservations } from "../domain/quantities";
import { fetchState, postOp, resumable, type ClientConfig, type FetchLike } from "./client";
import { mealTitle } from "./format";

/**
 * `plan -- fini <id>…`: what the owner says is gone, sent as the phone's own `stock.finish`. An item a meal holds is
 * refused before anything is sent: whether to drop the meal or buy again is the owner's choice, made on the phone
 * (spec §6.4). A finished item answers « déjà fini », so a rerun after an exit 2 is safe.
 */
export interface FiniDeps { cfg: ClientConfig; fetch: FetchLike; now: () => string; uuid: () => string }

export async function finiText(ids: readonly number[], deps: FiniDeps): Promise<{ output: string; exitCode: 0 | 1 }> {
  const itemIds = [...new Set(ids)];
  const state = await fetchState(deps.cfg, deps.fetch);
  // a cook or a drop releases its meal's holds (invariants.ts `reserved_closed_meal`), so a live one is an open meal's
  const live = liveReservations(state);
  const blocked: string[] = [];
  for (const id of itemIds) {
    const item = state.stockItems.find((s) => s.id === id);
    if (!item) { blocked.push(`#${id} n'est pas au Reste`); continue; }
    const holders = new Set(live.filter((r) => r.stockItemId === id).map((r) => r.mealId));
    if (item.finishedAt === null && holders.size > 0) {
      const titles = [...holders].map((m) => mealTitle(state, m));
      blocked.push(`#${id} ${item.label} est réservé pour ${titles.join(", ")} : à marquer fini sur le téléphone, qui demande s'il faut racheter ou retirer le repas`);
    }
  }
  if (blocked.length > 0) return { output: `Rien n'est envoyé :\n${blocked.map((b) => `  - ${b}`).join("\n")}`, exitCode: 1 };

  const lines: string[] = [];
  let exitCode: 0 | 1 = 0;
  for (const id of itemIds) {
    const item = state.stockItems.find((s) => s.id === id)!;
    const { result } = await resumable(lines, `#${id} ${item.label}`, "Relancez la même commande : un article déjà fini répond « déjà fini ».",
      () => postOp(deps.cfg, deps.fetch, { opId: `fini-${deps.uuid()}`, type: "stock.finish", at: deps.now(), payload: { itemId: id } }));
    if (result.status === "refused") { exitCode = 1; lines.push(`✗ #${id} ${item.label} : refusé (${result.reason ?? "sans raison"})`); continue; }
    lines.push(result.status === "noop" ? `= #${id} ${item.label} : déjà fini` : `✓ #${id} ${item.label} : fini`);
  }
  return { output: lines.join("\n"), exitCode };
}
