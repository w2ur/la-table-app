import { isDate } from "../domain/ops/helpers";
import { normalizeName } from "../domain/text";
import type { State, StockItem } from "../domain/types";
import { fetchState, postOp, resumable as step, type ClientConfig, type FetchLike } from "./client";

/**
 * `plan -- stock <file>`: what the owners already hold, dictated once to Claude, written to Reste through the same ops
 * the phone sends (`stock.add`, then `stock.partial` for what is nearly finished), one row per op. The file:
 *   { "items": [ { "product": "huile d'olive", "qty": "1,5 bouteille", "low": false, "useBy": null, "label": "…" } ] }
 * `product` names a catalogue product (null for free text, then `label` is required); `label` defaults to its name.
 *
 * Reruns are safe because they read the state, not a journal: an item whose label already has an unfinished row in
 * Reste is not added again, so a run cut short by an exit 2 is finished by running the same command. « Bientôt fini » is
 * set only on rows this run added: stock.partial also opens the row, which must not happen to a row the phone owns.
 */
export interface StockDeps { cfg: ClientConfig; fetch: FetchLike; now: () => string; uuid: () => string }

interface StockEntry { productId: number | null; label: string; qtyText: string | null; useBy: string | null; low: boolean }

/** One op per request, so a cut run loses one answer at most; the cap is what one dictation can be. */
const MAX_ITEMS = 100;

/** AAAA-MM-JJ naming a day that exists (no 31 February). */
const isRealDate = (v: unknown): v is string =>
  isDate(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function parseStockFile(text: string, state: State): { entries: StockEntry[]; errors: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { entries: [], errors: [`JSON illisible : ${e instanceof Error ? e.message : String(e)}`] }; }
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) return { entries: [], errors: ["« items » doit être une liste non vide"] };
  if (items.length > MAX_ITEMS) return { entries: [], errors: [`${items.length} articles, au plus ${MAX_ITEMS} par fichier`] };
  const entries: StockEntry[] = [], errors: string[] = [], seen = new Set<string>();
  items.forEach((item: unknown, i) => {
    const at = `article ${i + 1}`;
    const it = item as Record<string, unknown> | null;
    if (it === null || typeof it !== "object" || Array.isArray(it)) { errors.push(`${at} : objet attendu`); return; }
    const unknownKeys = Object.keys(it).filter((k) => !["product", "label", "qty", "useBy", "low"].includes(k));
    if (unknownKeys.length) { errors.push(`${at} : champ inconnu ${unknownKeys.join(", ")}`); return; }
    const { product: name, label, qty, useBy, low } = it;
    if (name !== undefined && name !== null && typeof name !== "string") { errors.push(`${at} : « product » texte ou null`); return; }
    if (label !== undefined && (typeof label !== "string" || !label.trim())) { errors.push(`${at} : « label » texte non vide`); return; }
    if (qty !== undefined && qty !== null && (typeof qty !== "string" || !qty.trim())) { errors.push(`${at} : « qty » texte non vide ou null`); return; }
    if (useBy !== undefined && useBy !== null && !isRealDate(useBy)) { errors.push(`${at} : « useBy » date AAAA-MM-JJ ou null`); return; }
    if (low !== undefined && typeof low !== "boolean") { errors.push(`${at} : « low » true ou false`); return; }
    const product = typeof name === "string" ? state.products.find((p) => normalizeName(p.name) === normalizeName(name)) : undefined;
    if (typeof name === "string" && !product) { errors.push(`${at} : produit inconnu du catalogue : ${name}`); return; }
    const finalLabel = (label as string | undefined)?.trim() ?? product?.name;
    if (!finalLabel) { errors.push(`${at} : « label » requis sans produit`); return; }
    if (seen.has(normalizeName(finalLabel))) { errors.push(`${at} : « ${finalLabel} » figure deux fois`); return; }
    seen.add(normalizeName(finalLabel));
    entries.push({ productId: product?.id ?? null, label: finalLabel, qtyText: (qty as string | null | undefined)?.trim() ?? null, useBy: (useBy as string | null | undefined) ?? null, low: low === true });
  });
  return { entries, errors };
}

const held = (state: State, label: string): StockItem | undefined =>
  state.stockItems.find((s) => s.finishedAt === null && normalizeName(s.label) === normalizeName(label));

export async function stockText(text: string, deps: StockDeps): Promise<{ output: string; exitCode: 0 | 1 }> {
  const state = await fetchState(deps.cfg, deps.fetch);
  const { entries, errors } = parseStockFile(text, state);
  if (errors.length) return { output: `${errors.map((e) => `✗ ${e}`).join("\n")}\n\nRien n'est envoyé.`, exitCode: 1 };

  const out: string[] = [];
  let refused = false;
  const HINT = "Relancez la même commande : ce qui est déjà au Reste n'est pas rajouté.";
  const resumable = <T>(label: string, run: () => Promise<T>) => step(out, label, HINT, run);
  const send = async (type: string, payload: unknown, label: string) =>
    resumable(label, async () => (await postOp(deps.cfg, deps.fetch, { opId: `stock-${deps.uuid()}`, type, at: deps.now(), payload })).result);
  const added = new Set<string>();

  for (const e of entries) {
    const already = held(state, e.label);
    if (already) { out.push(`= ${e.label} : déjà au Reste${e.low && !already.isLow ? ", « bientôt fini » à mettre sur le téléphone s'il le faut" : ""}`); continue; }
    const r = await send("stock.add", { productId: e.productId, label: e.label, qtyText: e.qtyText, useBy: e.useBy }, e.label);
    if (r.status === "refused") { refused = true; out.push(`✗ ${e.label} : refusé (${r.reason ?? "sans raison"})`); continue; }
    added.add(e.label);
    out.push(`+ ${e.label}${e.qtyText ? ` · ${e.qtyText}` : ""}`);
  }

  const low = entries.filter((e) => e.low && added.has(e.label));
  if (low.length) {
    const after = await resumable("lecture avant « bientôt fini »", () => fetchState(deps.cfg, deps.fetch));
    for (const e of low) {
      const item = held(after, e.label);
      if (!item || item.isLow) continue;
      const r = await send("stock.partial", { itemId: item.id, qtyText: item.qtyText, low: true }, e.label);
      if (r.status === "refused") { refused = true; out.push(`✗ ${e.label} : « bientôt fini » refusé (${r.reason ?? "sans raison"})`); continue; }
      out.push(`↓ ${e.label} : bientôt fini`);
    }
  }
  return { output: out.join("\n"), exitCode: refused ? 1 : 0 };
}
