import { isRecord } from "../domain/shape";
import { normalizeName } from "../domain/text";
import type { Product } from "../domain/types";
import { fetchState, postOp, resumable, type ClientConfig, type FetchLike, type WireResult } from "./client";

/**
 * The frame shared by the per-product catalogue files (`plan -- nutrition`, `plan -- packs`): `{ "products": [ … ] }`,
 * each entry an object of `keys` with a non-empty `name`, no name twice; then one op per entry, sent only once every
 * name is in the catalogue. Rerunning the same file answers noops.
 */
export interface ProductFileDeps { cfg: ClientConfig; fetch: FetchLike; now: () => string; uuid: () => string }

/**
 * Parses the file; `entry` checks an entry's other fields (pushing its errors) and returns the entry, or null when
 * refused. The duplicate check runs after it, on valid entries only.
 */
export function parseProductFile<E>(
  text: string,
  keys: readonly string[],
  entry: (p: Record<string, unknown>, name: string, at: string, errors: string[]) => E | null,
): { entries: E[]; errors: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { entries: [], errors: [`JSON illisible : ${e instanceof Error ? e.message : String(e)}`] }; }
  const list = (raw as { products?: unknown } | null)?.products;
  if (!Array.isArray(list) || list.length === 0) return { entries: [], errors: ["« products » doit être une liste non vide"] };
  const entries: E[] = [], errors: string[] = [], seen = new Set<string>();
  list.forEach((p: unknown, i) => {
    const at = `products[${i}]`;
    if (!isRecord(p)) return void errors.push(`${at}: objet attendu`);
    const extra = Object.keys(p).filter((k) => !keys.includes(k));
    if (extra.length) return void errors.push(`${at}: champ inconnu ${extra.join(", ")}`);
    const name = p.name;
    if (typeof name !== "string" || !name.trim()) return void errors.push(`${at}.name: texte non vide attendu`);
    const e = entry(p, name, at, errors);
    if (e === null) return;
    if (seen.has(normalizeName(name))) return void errors.push(`${at}: « ${name} » figure deux fois`);
    seen.add(normalizeName(name));
    entries.push(e);
  });
  return { entries, errors };
}

export interface ProductOps<E extends { name: string }> {
  /** The op id's prefix and the op type. */
  prefix: string;
  type: string;
  payload: (e: E) => unknown;
  /** The line printed for an entry the server applied or found unchanged. */
  line: (product: Product, e: E, status: Exclude<WireResult["status"], "refused">) => string;
}

/** Given a parsed file: refuses on any error, checks every name against the catalogue (any absent: nothing sent), then sends one op per entry. */
export async function sendProductFile<E extends { name: string }>(
  parsed: { entries: E[]; errors: string[] },
  deps: ProductFileDeps,
  ops: ProductOps<E>,
): Promise<{ output: string; exitCode: 0 | 1 }> {
  const { entries, errors } = parsed;
  if (errors.length) return { output: `${errors.map((e) => `✗ ${e}`).join("\n")}\n\nRien n'est envoyé.`, exitCode: 1 };
  const state = await fetchState(deps.cfg, deps.fetch);
  const catalogue = new Map(state.products.map((p) => [normalizeName(p.name), p]));
  const absent = entries.filter((e) => !catalogue.has(normalizeName(e.name)));
  if (absent.length) return { output: `${absent.map((e) => `✗ ${e.name} : pas au catalogue`).join("\n")}\n\nRien n'est envoyé.`, exitCode: 1 };
  const out: string[] = [];
  let refused = false;
  for (const e of entries) {
    const product = catalogue.get(normalizeName(e.name))!;
    const { result } = await resumable(out, product.name, "Relancez la même commande : un produit déjà à jour n'est pas modifié.",
      () => postOp(deps.cfg, deps.fetch, { opId: `${ops.prefix}-${deps.uuid()}`, type: ops.type, at: deps.now(), payload: ops.payload(e) }));
    if (result.status === "refused") { refused = true; out.push(`✗ ${product.name} : refusé (${result.reason ?? "sans raison"})`); continue; }
    out.push(ops.line(product, e, result.status));
  }
  return { output: out.join("\n"), exitCode: refused ? 1 : 0 };
}
