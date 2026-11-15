import type { ProductPack, ProductPrice } from "./types";
import { isRecord } from "./shape";
import { isUnit, type Unit } from "./units";

/** The quantity bought for a need: whole packs when the product has a pack in that unit, the need itself otherwise. */
export function packedQty(need: number, unit: Unit, pack: ProductPack | null): number {
  if (pack === null || pack.unit !== unit || need <= 0) return need;
  return Math.ceil(need / pack.qty) * pack.qty;
}

/** A quantity's price from the product's reference price, or null without one in that unit. */
export function referencePriceCents(qty: number, unit: Unit, price: ProductPrice | null): number | null {
  if (price === null || price.unit !== unit) return null;
  return Math.round((qty * price.cents) / price.qty);
}

const exactly = (o: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => k in o);
const positiveInt = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;

/** Checks a wire pack (`{ qty, unit }` or null) on its own: integer qty > 0, a base unit, no other key. */
export function validatePackShape(pack: unknown, at: string, errors: string[]): boolean {
  if (pack === null) return true;
  if (isRecord(pack) && exactly(pack, ["qty", "unit"]) && positiveInt(pack.qty) && isUnit(pack.unit)) return true;
  errors.push(`${at}.pack: { qty entier > 0, unit g|ml|piece } ou null attendu`);
  return false;
}

/** Checks a wire price (`{ cents, qty, unit }` or null) on its own: integer cents ≥ 0, integer qty > 0, a base unit, no other key. */
export function validatePriceShape(price: unknown, at: string, errors: string[]): boolean {
  if (price === null) return true;
  if (isRecord(price) && exactly(price, ["cents", "qty", "unit"]) && Number.isSafeInteger(price.cents) && (price.cents as number) >= 0 && positiveInt(price.qty) && isUnit(price.unit)) return true;
  errors.push(`${at}.price: { cents entier ≥ 0, qty entier > 0, unit g|ml|piece } ou null attendu`);
  return false;
}

/** True when a pack and a price are both set in different units: the pair a product cannot hold. */
export const unitsDiffer = (pack: ProductPack | null, price: ProductPrice | null): boolean => pack !== null && price !== null && pack.unit !== price.unit;

export const UNIT_MISMATCH = "le paquet et le prix doivent être dans la même unité";

/**
 * Checks a wire pack and price, pushing one message per fault under `at`: each field's shape (validatePackShape,
 * validatePriceShape) and one unit for both when both are set.
 */
export function validatePackAndPrice(pack: unknown, price: unknown, at: string, errors: string[]): boolean {
  const before = errors.length;
  validatePackShape(pack, at, errors);
  validatePriceShape(price, at, errors);
  if (errors.length === before && unitsDiffer(pack as ProductPack | null, price as ProductPrice | null)) errors.push(`${at}: ${UNIT_MISMATCH}`);
  return errors.length === before;
}
