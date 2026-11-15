import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { packedQty, referencePriceCents, validatePackAndPrice } from "./packs";

describe("packedQty", () => {
  it("rounds a need up to whole packs in the pack's unit", () => {
    expect(packedQty(125, "g", { qty: 250, unit: "g" })).toBe(250);
    expect(packedQty(250, "g", { qty: 250, unit: "g" })).toBe(250);
    expect(packedQty(251, "g", { qty: 250, unit: "g" })).toBe(500);
  });
  it("leaves the need exact without a pack, or with a pack in another unit", () => {
    expect(packedQty(405, "g", null)).toBe(405);
    expect(packedQty(2, "piece", { qty: 1000, unit: "g" })).toBe(2);
  });
  it("rounds to at least the need, a multiple of the pack, less than one pack over", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 5_000 }), (need, size) => {
      const q = packedQty(need, "g", { qty: size, unit: "g" });
      expect(q).toBeGreaterThanOrEqual(need);
      expect(q % size).toBe(0);
      expect(q - need).toBeLessThan(size);
    }));
  });
});

describe("referencePriceCents", () => {
  it("prices a quantity from the reference, rounded to the cent", () => {
    expect(referencePriceCents(250, "g", { cents: 287, qty: 250, unit: "g" })).toBe(287);
    expect(referencePriceCents(405, "g", { cents: 369, qty: 1000, unit: "g" })).toBe(149);
  });
  it("knows no price without a reference or in another unit", () => {
    expect(referencePriceCents(250, "g", null)).toBeNull();
    expect(referencePriceCents(1, "piece", { cents: 319, qty: 1000, unit: "g" })).toBeNull();
  });
});

describe("validatePackAndPrice", () => {
  const ok = (pack: unknown, price: unknown) => validatePackAndPrice(pack, price, "p", []);
  it("accepts null, a pack, a price, or both in one unit", () => {
    expect(ok(null, null)).toBe(true);
    expect(ok({ qty: 250, unit: "g" }, { cents: 287, qty: 250, unit: "g" })).toBe(true);
    expect(ok(null, { cents: 369, qty: 1000, unit: "g" })).toBe(true);
    expect(ok({ qty: 6, unit: "piece" }, null)).toBe(true);
    expect(ok(null, { cents: 0, qty: 1, unit: "piece" })).toBe(true);
  });
  it("refuses a pack and a price in different units, and every malformed value", () => {
    expect(ok({ qty: 1000, unit: "g" }, { cents: 319, qty: 1, unit: "piece" })).toBe(false);
    for (const pack of [{ qty: 0, unit: "g" }, { qty: -1, unit: "g" }, { qty: 2.5, unit: "g" }, { qty: 250, unit: "kg" }, { qty: 250 }, { qty: 250, unit: "g", x: 1 }, "250 g", []]) {
      expect(ok(pack, null), JSON.stringify(pack)).toBe(false);
    }
    expect(ok({ qty: 1e20, unit: "g" }, null)).toBe(false);
    for (const price of [{ cents: 1e20, qty: 1, unit: "g" }, { cents: -1, qty: 1, unit: "g" }, { cents: 1.5, qty: 1, unit: "g" }, { cents: 100, qty: 0, unit: "g" }, { cents: 100, unit: "g" }, { cents: 100, qty: 1, unit: "g", x: 1 }, 287]) {
      expect(ok(null, price), JSON.stringify(price)).toBe(false);
    }
  });
});
