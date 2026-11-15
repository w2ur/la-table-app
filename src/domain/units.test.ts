import { describe, expect, it } from "vitest";
import { formatAmount, formatEuros, formatQty, scaleQty, toBase, unitName } from "./units";

describe("toBase", () => {
  it("converts kg, cl and l to base units", () => {
    expect(toBase(1.5, "kg")).toEqual({ qty: 1500, unit: "g" });
    expect(toBase(20, "cl")).toEqual({ qty: 200, unit: "ml" });
    expect(toBase(1, "l")).toEqual({ qty: 1000, unit: "ml" });
    expect(toBase(3, "piece")).toEqual({ qty: 3, unit: "piece" });
  });
  it("rejects unknown units and negative or non-finite quantities", () => {
    expect(() => toBase(1, "cup")).toThrow("unknown unit");
    expect(() => toBase(-1, "g")).toThrow("invalid quantity");
    expect(() => toBase(Number.NaN, "g")).toThrow("invalid quantity");
  });
});

describe("scaleQty", () => {
  it("rounds up so a non-zero ingredient never scales to 0", () => {
    expect(scaleQty(1, 2, 3)).toBe(2); // 1 egg for 2 → 1.5 → 2
    expect(scaleQty(1, 4, 1)).toBe(1); // 0.25 → 1
    expect(scaleQty(200, 2, 2)).toBe(200);
    expect(scaleQty(0, 2, 5)).toBe(0);
  });
});

describe("formatQty / formatEuros", () => {
  it("formats in French", () => {
    expect(formatQty(1500, "g")).toBe("1,5 kg");
    expect(formatQty(250, "g")).toBe("250 g");
    expect(formatQty(200, "ml")).toBe("20 cl");
    expect(formatQty(3, "piece")).toBe("3");
    expect(formatEuros(5840)).toBe("58,40 €");
    expect(formatEuros(7000)).toBe("70 €");
  });
});

describe("formatAmount", () => {
  it("writes a quantity with its unit, pieces spelled out", () => {
    expect(formatAmount(1500, "g")).toBe("1,5 kg");
    expect(formatAmount(200, "ml")).toBe("20 cl");
    expect(formatAmount(1, "piece")).toBe("1 pièce");
    expect(formatAmount(3, "piece")).toBe("3 pièces");
  });
});

describe("unitName", () => {
  it("spells pieces in French, agreeing with the quantity, and leaves g and ml as they are", () => {
    expect(unitName("piece")).toBe("pièce");
    expect(unitName("piece", 1)).toBe("pièce");
    expect(unitName("piece", 3)).toBe("pièces");
    expect(unitName("g", 3)).toBe("g");
    expect(unitName("ml")).toBe("ml");
  });
});
