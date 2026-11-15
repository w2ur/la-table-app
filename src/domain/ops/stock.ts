import { addDays, parisDate } from "../dates";
import { declaredLeftover } from "../declared";
import { nextId, stableStringify } from "../state";
import type { State } from "../types";
import { INVALID, applied, bool, int, isDate, isResolution, noop, payloadObject, refused, settleReservations, str, strOrNull } from "./helpers";
import { markOpened } from "./meals";
import type { OpResult } from "./types";

export function finish(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.itemId)) return INVALID;
  const resolution = p.resolution ?? null;
  if (resolution !== null && !isResolution(resolution)) return INVALID;
  const item = next.stockItems.find((s) => s.id === p.itemId);
  if (!item) return refused("article introuvable");
  if (item.finishedAt !== null) return noop("déjà fini");
  const refusal = settleReservations(next, item, resolution, at);
  if (refusal !== null) return refused(refusal);
  item.finishedAt = at;
  return applied();
}

export function partial(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.itemId) || !strOrNull(p.qtyText) || !bool(p.low)) return INVALID;
  const item = next.stockItems.find((s) => s.id === p.itemId);
  if (!item) return refused("article introuvable");
  if (item.finishedAt !== null) return refused("déjà fini");
  // a write that changes nothing is no write: applied, it would leave no trace an earlier write's undo could see (§6.6);
  // the item's reservations count too, since a declared leftover may trim them
  const rows = () => stableStringify([item, next.reservations.filter((r) => r.stockItemId === item.id)]);
  const before = rows();
  markOpened(next, item, at, p.qtyText, p.low);
  if (rows() === before) return noop("déjà noté");
  return applied();
}

export function setUseBy(next: State, payload: unknown): OpResult {
  const p = payloadObject(payload);
  if (!p || !int(p.itemId) || !isDate(p.useBy)) return INVALID;
  const item = next.stockItems.find((s) => s.id === p.itemId);
  if (!item) return refused("article introuvable");
  if (item.finishedAt !== null) return refused("déjà fini");
  if (item.useBy === p.useBy) return noop("déjà à cette date");
  item.useBy = p.useBy;
  return applied();
}

export function addStock(next: State, payload: unknown, at: string): OpResult {
  const p = payloadObject(payload);
  if (!p || !str(p.label) || !strOrNull(p.qtyText)) return INVALID;
  if (p.productId !== null && !int(p.productId)) return INVALID;
  if (p.useBy !== null && !isDate(p.useBy)) return INVALID;
  const product = p.productId === null ? undefined : next.products.find((pr) => pr.id === p.productId);
  if (p.productId !== null && !product) return refused("produit introuvable");
  // a catalogue product's words in its base unit become the quantity (spec §6.5); a free-text item keeps them as text
  const leftover = declaredLeftover({ qty: null, unit: null, qtyText: null }, p.qtyText,
    { productUnit: product?.defaultUnit ?? null, pack: product?.pack ?? null, held: [] }).item;
  next.stockItems.push({
    id: nextId(next, "stockItems"), productId: product?.id ?? null, label: p.label.trim(), ...leftover, isLow: false,
    useBy: (p.useBy as string | null) ?? (product?.shelfLifeDays != null ? addDays(parisDate(at), product.shelfLifeDays) : null),
    openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: at,
  });
  return applied();
}
