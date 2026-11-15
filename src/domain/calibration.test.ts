import { describe, expect, it } from "vitest";
import { applyCalibration, calibration, hasReceipt } from "./calibration";
import { fixtureState } from "./test-fixtures";
import type { ShoppingItem, Trip } from "./types";

const trip = (id: number, totalCents: number | null): Trip => ({ id, date: `2026-10-0${id}`, place: "supermarche", totalCents, noReceipt: null, createdAt: "" });
const line = (id: number, tripId: number, estPriceCents: number | null): ShoppingItem => ({
  id, productId: 1, label: "x", qty: 1, unit: "g", plannedQty: null, estPriceCents, kind: "ajout", planningId: null, forMeals: [], isFood: true,
  boughtAt: "2026-10-01T10:00:00Z", tripId, removedAt: null, createdAt: "",
});

describe("hasReceipt", () => {
  it("is false only for a trip recorded noReceipt: true; null (before migration 0009) and false have a receipt", () => {
    expect([true, false, null].map((noReceipt) => hasReceipt({ noReceipt }))).toEqual([false, true, true]);
  });
});

describe("calibration", () => {
  it("needs at least 3 trips with a total", () => {
    const s = fixtureState();
    s.trips = [trip(1, 1100), trip(2, 1200)];
    s.shoppingItems = [line(1, 1, 1000), line(2, 2, 1000)];
    expect(calibration(s)).toEqual({ factorPermille: null, tripCount: 2 });
  });

  it("is the median ratio over the last 6 trips with a total, ignoring trips without an estimate", () => {
    const s = fixtureState();
    s.trips = [trip(1, 1100), trip(2, 900), trip(3, 1300), trip(4, null), trip(5, 500)];
    s.shoppingItems = [line(1, 1, 1000), line(2, 2, 1000), line(3, 3, 1000), line(4, 5, null)];
    expect(calibration(s)).toEqual({ factorPermille: 1100, tripCount: 3 });
    expect(applyCalibration(5800, calibration(s))).toBe(6380);
    expect(applyCalibration(5800, { factorPermille: null, tripCount: 0 })).toBeNull();
  });
});

describe("calibration and unpriced lines", () => {
  // Regression: 3f9aa49 — an unpriced ajout's spend counted against no estimate and read as overspend
  it("uses only trips whose bought lines all carry a price", () => {
    const s = fixtureState();
    s.trips = [trip(1, 1100), trip(2, 1200), trip(3, 1300), trip(4, 9000)];
    s.shoppingItems = [line(1, 1, 1000), line(2, 2, 1000), line(3, 3, 1000), line(4, 4, 1000), line(5, 4, null)];
    expect(calibration(s)).toEqual({ factorPermille: 1200, tripCount: 3 });
    s.shoppingItems[4]!.estPriceCents = 3500; // 9000 ÷ 4500 = 2000 ‰, priced at the next planning session (shopping.set_price)
    expect(calibration(s)).toEqual({ factorPermille: 1250, tripCount: 4 });
  });
});

describe("calibration and a trip without a receipt", () => {
  it("reads only the receipt trips' lines: a trip without a receipt counts for nothing, priced lines or not", () => {
    const s = fixtureState();
    const noReceipt = (id: number): Trip => ({ ...trip(id, null), noReceipt: true });
    s.trips = [trip(1, 1100), trip(2, 1200), trip(3, 1300), noReceipt(4), { ...noReceipt(5), totalCents: 9000 }];
    s.shoppingItems = [line(1, 1, 1000), line(2, 2, 1000), line(3, 3, 1000), line(4, 4, 1000), line(5, 5, 1000)];
    expect(calibration(s)).toEqual({ factorPermille: 1200, tripCount: 3 });
  });
});
