export type Unit = "g" | "ml" | "piece";

const CONVERSIONS: Record<string, { unit: Unit; factor: number }> = {
  g: { unit: "g", factor: 1 },
  kg: { unit: "g", factor: 1000 },
  ml: { unit: "ml", factor: 1 },
  cl: { unit: "ml", factor: 10 },
  l: { unit: "ml", factor: 1000 },
  piece: { unit: "piece", factor: 1 },
};

export function isUnit(value: unknown): value is Unit {
  return value === "g" || value === "ml" || value === "piece";
}

export function toBase(qty: number, unit: string): { qty: number; unit: Unit } {
  const conversion = CONVERSIONS[unit];
  if (!conversion) throw new Error(`unknown unit: ${unit}`);
  if (!Number.isFinite(qty) || qty < 0) throw new Error(`invalid quantity: ${qty}`);
  return { qty: Math.round(qty * conversion.factor), unit: conversion.unit };
}

/** Scales an integer quantity from `from` portions to `to` portions, rounding up. */
export function scaleQty(qty: number, from: number, to: number): number {
  return Math.ceil((qty * to) / from);
}

const decimal = (n: number): string => String(n).replace(".", ",");

export function formatQty(qty: number, unit: Unit): string {
  if (unit === "g") return qty >= 1000 && qty % 100 === 0 ? `${decimal(qty / 1000)} kg` : `${qty} g`;
  if (unit === "ml") {
    if (qty >= 1000 && qty % 100 === 0) return `${decimal(qty / 1000)} l`;
    if (qty >= 100 && qty % 10 === 0) return `${qty / 10} cl`;
    return `${qty} ml`;
  }
  return String(qty);
}

/** A quantity with its unit (`1,5 kg`, `20 cl`, `3 pièces`). */
export function formatAmount(qty: number, unit: Unit): string {
  return unit === "piece" ? `${qty} ${unitName(unit, qty)}` : formatQty(qty, unit);
}

/** The unit as a word (`g`, `ml`, `pièce`), pieces agreeing with `qty`. */
export function unitName(unit: Unit, qty = 1): string {
  return unit === "piece" ? (qty > 1 ? "pièces" : "pièce") : unit;
}

export function formatEuros(cents: number): string {
  const euros = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return rest === 0 ? `${euros} €` : `${euros},${String(rest).padStart(2, "0")} €`;
}

/** Euros as typed by the owner → integer cents; null unless a non-negative amount under 10 000 000 € with at most two decimals. */
export function parseEuros(text: string): number | null {
  const m = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}
