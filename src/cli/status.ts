import { hasReceipt } from "../domain/calibration";
import { mealShortfalls } from "../domain/invariants";
import { RULES } from "../domain/rules.config";
import { SEASONING_ROLE } from "../domain/vocabulary";
import { snapshot, type ResteItem } from "../domain/snapshot";
import type { Place, State, Verdict } from "../domain/types";
import { formatDayMonth } from "../domain/text";
import { euros, mealTitle, quantity } from "./format";
import { freeStock } from "./manques";
import { leftoverLine, unknownLeftovers } from "./reste";

const VERDICT: Record<Verdict, string> = { a_refaire: "À refaire", correct: "Correct", pas_pour_nous: "Pas pour nous" };
const PLACE: Record<Place, string> = { marche: "marché", supermarche: "supermarché", autre: "autre" };

function resteLine(i: ResteItem): string {
  const parts = [i.label, i.qtyText ?? quantity(i.qty, i.unit)];
  if (i.useBy) parts.push(`à utiliser avant ${formatDayMonth(i.useBy)}${i.daysLeft !== null && i.daysLeft < 0 ? " (dépassé)" : ""}`);
  if (i.isLow) parts.push("presque fini");
  for (const r of i.reservations) parts.push(`réservé ${quantity(r.qty, r.unit)} pour ${r.mealTitle}`);
  if (i.libreQty !== null && i.libreQty > 0 && i.reservations.length) parts.push(`≈ ${quantity(i.libreQty, i.unit)} libres`);
  return `  - #${i.id} ${parts.join(" · ")}`;
}

export function renderStatus(state: State, now: string): string {
  const snap = snapshot(state, now);
  const out: string[] = [];
  // first, because planning reads Reste's coverage from these: `plan -- reste <id> <mots…>` records the owner's answer
  const unknown = unknownLeftovers(state);
  out.push(`Restes à préciser : ${unknown.length ? "" : "aucun"}`.trimEnd());
  for (const i of unknown) out.push(`  - #${i.id} ${i.label} · ${leftoverLine(i)}`);
  out.push("");
  // open meals a declared leftover left short (spec §6.3): the next planning puts each back on Courses
  const short = mealShortfalls(state);
  out.push(`Manques : ${short.length ? "" : "aucun"}`.trimEnd());
  for (const x of short) {
    const product = state.products.find((p) => p.id === x.productId)?.name ?? `produit #${x.productId}`;
    const free = freeStock(state, x.productId, x.unit);
    out.push(`  - ${product} : ${quantity(x.qty, x.unit)} ${x.qty > 1 ? "manquent" : "manque"} pour ${mealTitle(state, x.mealId)} (#${x.mealId})${free > 0 ? ` (Reste : ${quantity(free, x.unit)} libres)` : ""}`);
  }
  out.push("");
  out.push(`Menu · ${snap.menu.pool.length} repas à cuisiner`);
  for (const m of snap.menu.pool) {
    const reserved = m.reservedItems.map((r) => `${r.label} ${quantity(r.qty, r.unit)}`).join(", ");
    out.push(`  - #${m.id} ${m.title} · ${m.portions} portion${m.portions > 1 ? "s" : ""}${m.isSecondRound ? " · second tour" : ""}${reserved ? ` · réservé : ${reserved}` : ""}${m.cookEarlyReason ? ` · à cuisiner tôt : ${m.cookEarlyReason}` : ""}`);
  }
  out.push("", "Reste");
  for (const [title, items] of [["À utiliser vite", snap.reste.urgent], ["Réservé", snap.reste.reserved], ["Libre", snap.reste.libre], ["Placard", snap.reste.placard]] as const) {
    out.push(` ${title} : ${items.length ? "" : "rien"}`.trimEnd());
    for (const i of items) out.push(resteLine(i));
  }
  out.push("", `Envies ouvertes : ${snap.menu.envies.length ? "" : "aucune"}`.trimEnd());
  for (const e of snap.menu.envies) out.push(`  - #${e.id} ${e.text}${e.url ? ` (${e.url})` : ""}`);

  // §7.1 step 3: meals cooked after the latest planning was committed
  const lastPlanning = [...state.plannings].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
  const feedback = state.meals.filter((m) => m.cookedAt !== null && (!lastPlanning || m.cookedAt > lastPlanning.createdAt) && (m.verdict || m.note));
  out.push("", `Retours depuis la dernière planification : ${feedback.length ? "" : "aucun"}`.trimEnd());
  for (const m of feedback) {
    const title = state.recipes.find((r) => r.id === m.recipeId)?.title ?? `recette ${m.recipeId}`;
    out.push(`  - ${title}${m.verdict ? ` · ${VERDICT[m.verdict]}` : ""}${m.note ? ` · « ${m.note} »` : ""}`);
  }

  // a trip without a receipt has no total to wait for, and no calibration reads its lines
  // recordTrip and setTripTotal refuse a total on a no-receipt trip, so `hasReceipt` is what keeps it off this list
  const noTotal = state.trips.filter((t) => t.totalCents === null && hasReceipt(t));
  const noReceiptTrips = new Set(state.trips.filter((t) => !hasReceipt(t)).map((t) => t.id));
  out.push("", `Passages sans total : ${noTotal.length ? "" : "aucun"}`.trimEnd());
  for (const t of noTotal) out.push(`  - #${t.id} · ${formatDayMonth(t.date)} · ${PLACE[t.place]}`);

  const toPrice = state.shoppingItems.filter((l) => l.tripId !== null && !noReceiptTrips.has(l.tripId) && l.estPriceCents === null && l.removedAt === null);
  out.push("", `Lignes à chiffrer : ${toPrice.length ? "" : "aucune"}`.trimEnd());
  for (const l of toPrice) out.push(`  - #${l.id} ${l.label}${l.qty !== null ? ` · ${quantity(l.qty, l.unit)}` : ""} (passage #${l.tripId})`);

  // what `plan -- nutrition` has still to fill: these count nowhere in a recipe's nutrition (a seasoning never counts, so it is not listed)
  const noNutrition = state.products.filter((p) => p.nutrition == null && !p.roles.includes(SEASONING_ROLE)).map((p) => p.name).sort((a, b) => a.localeCompare(b, "fr"));
  out.push("", `Produits sans valeurs nutritionnelles : ${noNutrition.length}`);
  if (noNutrition.length) out.push(`  ${noNutrition.join(", ")}`);

  // what `plan -- packs` has still to fill: a line of these is priced only by the proposal
  const noPrice = state.products.filter((p) => p.price == null).map((p) => p.name).sort((a, b) => a.localeCompare(b, "fr"));
  out.push("", `Produits sans prix de référence : ${noPrice.length}`);
  if (noPrice.length) out.push(`  ${noPrice.join(", ")}`);

  const cal = snap.calibration;
  out.push("", cal.factorPermille === null
    ? `Calibrage : pas encore (${cal.tripCount} / ${RULES.calibrationMinTrips} passages)`
    : `Calibrage : × ${(cal.factorPermille / 1000).toFixed(2).replace(".", ",")} sur ${cal.tripCount} passages`);
  out.push(`Courses en cours : ${euros(snap.courses.estimateCents)} estimés`);
  return out.join("\n");
}
