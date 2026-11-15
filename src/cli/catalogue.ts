import { catalogueRuleErrors } from "../domain/catalogue-rules";
import { validateProduct, type ProposalProduct } from "../domain/proposal";
import { normalizeName } from "../domain/text";
import type { Product } from "../domain/types";
import { fetchState, postOp, resumable, type ClientConfig, type FetchLike } from "./client";

/**
 * `plan -- catalogue <file>`: products added to the catalogue, or updated, through `product.upsert` (one op each), so
 * the domain numbers and matches them as a planning's new products. The file: `{ "products": [ … ] }`, each in the
 * `new_products` shape (spec §7.3). Rerunning the same file answers noops.
 */
export interface CatalogueDeps { cfg: ClientConfig; fetch: FetchLike; now: () => string; uuid: () => string }

const FIELDS: [keyof ProposalProduct, keyof Product][] = [
  ["category", "category"], ["is_staple", "isStaple"], ["roles", "roles"], ["is_fresh_produce", "isFreshProduce"],
  ["season_months", "seasonMonths"], ["shelf_life_days", "shelfLifeDays"], ["opened_shelf_life_days", "openedShelfLifeDays"],
  ["default_unit", "defaultUnit"],
];

const KEYS = ["name", ...FIELDS.map(([wire]) => wire as string)];

export function parseCatalogueFile(text: string): { products: ProposalProduct[]; errors: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { products: [], errors: [`JSON illisible : ${e instanceof Error ? e.message : String(e)}`] }; }
  const list = (raw as { products?: unknown } | null)?.products;
  if (!Array.isArray(list) || list.length === 0) return { products: [], errors: ["« products » doit être une liste non vide"] };
  const products: ProposalProduct[] = [], errors: string[] = [], seen = new Set<string>();
  list.forEach((p: unknown, i) => {
    const at = `products[${i}]`;
    const extra = p !== null && typeof p === "object" ? Object.keys(p).filter((k) => !KEYS.includes(k)) : [];
    if (extra.length) return void errors.push(`${at}: champ inconnu ${extra.join(", ")}`);
    if (!validateProduct(p, at, errors)) return;
    if (!p.name.trim()) return void errors.push(`${at}.name: texte non vide attendu`);
    const rules = catalogueRuleErrors({ name: p.name, category: p.category, isStaple: p.is_staple, isFreshProduce: p.is_fresh_produce, seasonMonths: p.season_months, shelfLifeDays: p.shelf_life_days });
    if (rules.length) return void errors.push(`${at}: ${rules.join(", ")}`);
    if (seen.has(normalizeName(p.name))) return void errors.push(`${at}: « ${p.name} » figure deux fois`);
    seen.add(normalizeName(p.name));
    products.push(p);
  });
  return { products, errors };
}

export async function catalogueText(text: string, deps: CatalogueDeps): Promise<{ output: string; exitCode: 0 | 1 }> {
  const { products, errors } = parseCatalogueFile(text);
  if (errors.length) return { output: `${errors.map((e) => `✗ ${e}`).join("\n")}\n\nRien n'est envoyé.`, exitCode: 1 };
  const state = await fetchState(deps.cfg, deps.fetch);
  const out: string[] = [];
  let refused = false;
  for (const p of products) {
    const existing = state.products.find((e) => normalizeName(e.name) === normalizeName(p.name));
    const { result } = await resumable(out, p.name, "Relancez la même commande : un produit déjà à jour n'est pas modifié.",
      () => postOp(deps.cfg, deps.fetch, { opId: `catalogue-${deps.uuid()}`, type: "product.upsert", at: deps.now(), payload: p }));
    if (result.status === "refused") { refused = true; out.push(`✗ ${p.name} : refusé (${result.reason ?? "sans raison"})`); continue; }
    if (result.status === "noop") { out.push(`= ${p.name}`); continue; }
    if (!existing) { out.push(`+ ${p.name}`); continue; }
    const changed = FIELDS.filter(([wire, field]) => JSON.stringify(p[wire]) !== JSON.stringify(existing[field])).map(([wire]) => wire);
    out.push(`~ ${existing.name} : ${changed.join(", ")}`);
  }
  return { output: out.join("\n"), exitCode: refused ? 1 : 0 };
}
