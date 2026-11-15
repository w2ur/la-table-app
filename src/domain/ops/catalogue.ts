import { catalogueRuleErrors } from "../catalogue-rules";
import { newViolations } from "../invariants";
import { UNIT_MISMATCH, unitsDiffer, validatePackShape, validatePriceShape } from "../packs";
import { validateProduct } from "../proposal";
import { cloneState, nextId, stableStringify } from "../state";
import { normalizeName } from "../text";
import type { Product, ProductNutrition, ProductPack, ProductPrice, State } from "../types";
import { isKnownRole } from "../vocabulary";
import { INVALID, applied, noop, payloadObject, refused, str } from "./helpers";
import type { OpResult } from "./types";

/**
 * `product.upsert`: one catalogue product, in the `new_products` shape (spec §7.3), matched by `normalizeName` as a
 * planning's new products are. Absent → added under `nextId`; identical → noop; otherwise its fields are updated, its
 * id and name kept. A product breaking the catalogue rules (`catalogueRuleErrors`) is refused. So is a change of its
 * staple flag while a meal in progress counts on it (a live reservation, a meal's share of an unbought line, or any
 * invariant it would break, §6.6): a staple is never reserved, and coverage reads the flag. Not undoable: a product row
 * may already be referenced by stock, lines or ingredients.
 */
const IN_USE = "produit utilisé par un repas en cours : à modifier après ce planning";

export function upsertProduct(next: State, payload: unknown): OpResult {
  if (!validateProduct(payload, "product", []) || !str(payload.name) || !payload.roles.every(isKnownRole)) return INVALID;
  const fields: Omit<Product, "id" | "name" | "nutrition" | "pack" | "price"> = {
    category: payload.category,
    isStaple: payload.is_staple,
    roles: payload.roles,
    isFreshProduce: payload.is_fresh_produce,
    seasonMonths: payload.season_months,
    shelfLifeDays: payload.shelf_life_days,
    openedShelfLifeDays: payload.opened_shelf_life_days,
    defaultUnit: payload.default_unit,
  };
  const rules = catalogueRuleErrors({ name: payload.name, ...fields });
  if (rules.length) return refused(`règle du catalogue : ${rules.join(", ")}`);
  const existing = next.products.find((p) => normalizeName(p.name) === normalizeName(payload.name));
  if (!existing) {
    next.products.push({ id: nextId(next, "products"), name: payload.name.trim(), ...fields, nutrition: null, pack: null, price: null });
    return applied();
  }
  const updated: Product = { ...existing, ...fields };
  if (stableStringify(updated) === stableStringify(existing)) return noop("déjà au catalogue");
  if (updated.isStaple !== existing.isStaple) {
    const held = new Set(next.stockItems.filter((s) => s.productId === existing.id).map((s) => s.id));
    const inUse = next.reservations.some((r) => r.releasedAt === null && held.has(r.stockItemId))
      || next.shoppingItems.some((l) => l.productId === existing.id && l.boughtAt === null && l.removedAt === null && l.forMeals.length > 0);
    const before = cloneState(next);
    Object.assign(existing, fields);
    if (inUse || newViolations(before, next).length > 0) return refused(IN_USE);
    return applied();
  }
  Object.assign(existing, fields);
  return applied();
}

/** The wire shape of a product's nutrition (snake_case, as `product.upsert` carries a product). */
export interface WireNutrition {
  ciqual_code: string;
  per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fibre_g: number; salt_g: number };
  grams_per_piece: number | null;
  grams_per_ml: number | null;
  edible_pct: number;
}

const NUTRIENT_KEYS = ["kcal", "protein_g", "carbs_g", "fat_g", "fibre_g", "salt_g"] as const;
const NUTRITION_KEYS = ["ciqual_code", "per_100g", "grams_per_piece", "grams_per_ml", "edible_pct"] as const;

const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
/** An edible share: a finite number above 0 and at most 100 (percent of the bought weight). */
export const isEdiblePct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100;
const finiteFrom = (v: unknown, min: number, strict: boolean): v is number =>
  typeof v === "number" && Number.isFinite(v) && (strict ? v > min : v >= min);

/**
 * Checks a wire nutrition, pushing one message per fault under `at`: a non-empty Ciqual code, exactly the six nutrients
 * each a finite number ≥ 0, each conversion null or a finite number > 0, and the edible share a number in (0, 100]. An extra key anywhere is a fault.
 */
export function validateNutrition(n: unknown, at: string, errors: string[]): n is WireNutrition {
  const before = errors.length;
  const o = payloadObject(n);
  if (!o) { errors.push(`${at}: objet attendu`); return false; }
  if (!onlyKeys(o, NUTRITION_KEYS)) errors.push(`${at}: clé inconnue`);
  if (!str(o.ciqual_code)) errors.push(`${at}.ciqual_code: texte non vide attendu`);
  const per100g = payloadObject(o.per_100g);
  if (!per100g) errors.push(`${at}.per_100g: objet attendu`);
  else {
    if (!onlyKeys(per100g, NUTRIENT_KEYS)) errors.push(`${at}.per_100g: clé inconnue`);
    for (const key of NUTRIENT_KEYS) {
      if (!finiteFrom(per100g[key], 0, false)) errors.push(`${at}.per_100g.${key}: nombre ≥ 0 attendu`);
    }
  }
  for (const key of ["grams_per_piece", "grams_per_ml"] as const) {
    if (o[key] !== null && !finiteFrom(o[key], 0, true)) errors.push(`${at}.${key}: nombre > 0 ou null attendu`);
  }
  if (!isEdiblePct(o.edible_pct)) errors.push(`${at}.edible_pct: nombre > 0 et ≤ 100 attendu`);
  return errors.length === before;
}

export function nutritionFromWire(n: WireNutrition): ProductNutrition {
  return {
    ciqualCode: n.ciqual_code.trim(),
    per100g: {
      kcal: n.per_100g.kcal, proteinG: n.per_100g.protein_g, carbsG: n.per_100g.carbs_g,
      fatG: n.per_100g.fat_g, fibreG: n.per_100g.fibre_g, saltG: n.per_100g.salt_g,
    },
    gramsPerPiece: n.grams_per_piece,
    gramsPerMl: n.grams_per_ml,
    ediblePct: n.edible_pct,
  };
}

/**
 * `product.nutrition`: sets, or with `nutrition: null` clears, the Ciqual nutrition of one catalogue product matched by
 * `normalizeName`, and nothing else of it. An unknown name is refused, an identical value is a noop. Not undoable, as
 * `product.upsert` is not.
 */
export function setNutrition(next: State, payload: unknown): OpResult {
  const body = payloadObject(payload);
  if (!body || !onlyKeys(body, ["name", "nutrition"]) || !str(body.name) || !("nutrition" in body)) return INVALID;
  const wire = body.nutrition;
  if (wire !== null && !validateNutrition(wire, "nutrition", [])) return INVALID;
  const product = next.products.find((p) => normalizeName(p.name) === normalizeName(body.name as string));
  if (!product) return refused(`produit inconnu : ${(body.name as string).trim()}`);
  const value = wire === null ? null : nutritionFromWire(wire);
  if (stableStringify(value) === stableStringify(product.nutrition)) return noop("déjà à jour");
  product.nutrition = value;
  return applied();
}

/**
 * `product.pack`: sets, or with null clears, the pack size and reference price of one catalogue product matched by
 * `normalizeName`, and nothing else of it. At least one of `pack` and `price` is required; an absent one stays as it
 * is. A malformed field is invalid data; a pack and a price that would end in two units are refused. An unknown name is
 * refused, an identical value is a noop. Not undoable, as `product.upsert` is not. Lines already on Courses keep their price.
 */
export function setPack(next: State, payload: unknown): OpResult {
  const body = payloadObject(payload);
  if (!body || !onlyKeys(body, ["name", "pack", "price"]) || !str(body.name) || !("pack" in body || "price" in body)) return INVALID;
  if (("pack" in body && !validatePackShape(body.pack, "product", [])) || ("price" in body && !validatePriceShape(body.price, "product", []))) return INVALID;
  const product = next.products.find((p) => normalizeName(p.name) === normalizeName(body.name as string));
  if (!product) return refused(`produit inconnu : ${(body.name as string).trim()}`);
  const wirePack = "pack" in body ? (body.pack as ProductPack | null) : (product.pack ?? null);
  const wirePrice = "price" in body ? (body.price as ProductPrice | null) : (product.price ?? null);
  const pack: ProductPack | null = wirePack === null ? null : { qty: wirePack.qty, unit: wirePack.unit };
  const price: ProductPrice | null = wirePrice === null ? null : { cents: wirePrice.cents, qty: wirePrice.qty, unit: wirePrice.unit };
  if (unitsDiffer(pack, price)) return refused(UNIT_MISMATCH);
  if (stableStringify({ pack, price }) === stableStringify({ pack: product.pack, price: product.price })) return noop("déjà à jour");
  product.pack = pack;
  product.price = price;
  return applied();
}
