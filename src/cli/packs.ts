import { validatePackAndPrice, validatePackShape, validatePriceShape } from "../domain/packs";
import type { Product, ProductPack, ProductPrice } from "../domain/types";
import { formatAmount, formatEuros } from "../domain/units";
import { parseProductFile, sendProductFile, type ProductFileDeps } from "./product-file";

/**
 * `plan -- packs <file>`: pack sizes and reference prices set on catalogue products through `product.pack` (one op each,
 * those two fields only). The file: `{ "products": [ { "name", "pack", "price" } ] }`, at least one of pack and price per
 * product: null clears a field, an absent one stays as it is. Rerunning the same file answers noops. Lines already on Courses keep their price. Each product changed prints its fields before
 * and after (only the fields it sends), read from the state fetched before posting.
 */
export type PacksDeps = ProductFileDeps;

/** A field left out (undefined) is kept; null clears it. */
export interface PackEntry { name: string; pack?: ProductPack | null; price?: ProductPrice | null }

export function parsePacksFile(text: string): { entries: PackEntry[]; errors: string[] } {
  return parseProductFile(text, ["name", "pack", "price"], (p, name, at, errors) => {
    const { pack, price } = p;
    if (pack === undefined && price === undefined) {
      errors.push(`${at}: « pack » ou « price » attendu (null pour effacer, absent pour garder)`);
      return null;
    }
    const valid = pack !== undefined && price !== undefined
      ? validatePackAndPrice(pack, price, at, errors)
      : pack !== undefined ? validatePackShape(pack, at, errors) : validatePriceShape(price, at, errors);
    if (!valid) return null;
    return { name, ...(pack === undefined ? {} : { pack: pack as ProductPack | null }), ...(price === undefined ? {} : { price: price as ProductPrice | null }) };
  });
}

const packText = (p: ProductPack | null): string => (p === null ? "aucun" : formatAmount(p.qty, p.unit));
const priceText = (p: ProductPrice | null): string => (p === null ? "aucun" : `${formatEuros(p.cents)} / ${formatAmount(p.qty, p.unit)}`);

/** The fields an entry sends that change, as « paquet 250 g → aucun, prix … → … » (a product read without a key has neither). */
function changes(product: Product, e: PackEntry): string {
  const out: string[] = [];
  const pack = product.pack ?? null, price = product.price ?? null;
  if (e.pack !== undefined && packText(pack) !== packText(e.pack)) out.push(`paquet ${packText(pack)} → ${packText(e.pack)}`);
  if (e.price !== undefined && priceText(price) !== priceText(e.price)) out.push(`prix ${priceText(price)} → ${priceText(e.price)}`);
  return out.join(", ");
}

export function packsText(text: string, deps: PacksDeps): Promise<{ output: string; exitCode: 0 | 1 }> {
  return sendProductFile(parsePacksFile(text), deps, {
    prefix: "packs",
    type: "product.pack",
    payload: (e) => ({ ...e }),
    line: (product, e, status) => {
      if (status === "noop") return `= ${product.name}`;
      const changed = changes(product, e);
      return `~ ${product.name}${changed ? ` : ${changed}` : ""}`;
    },
  });
}
