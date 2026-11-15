import { describe, expect, it } from "vitest";
import { parseDeclaredQty } from "../domain/declared";
import { leftOverPlaceholder, leftOverPrefill, leftOverSuffix, leftOverUnit, leftOverWords } from "./leftover-field";

describe("« Il en reste » field", () => {
  it("is in the item's unit, else its product's, else none", () => {
    expect(leftOverUnit({ unit: "ml", productUnit: "g" })).toBe("ml");
    expect(leftOverUnit({ unit: null, productUnit: "g" })).toBe("g");
    expect(leftOverUnit({ unit: null, productUnit: null })).toBeNull();
    expect(leftOverUnit({ unit: null })).toBeNull(); // a snapshot an older build stored
    expect(leftOverUnit(undefined)).toBeNull();
  });

  it("names the unit after the field, a piece agreeing with what is typed", () => {
    expect([leftOverSuffix("g"), leftOverSuffix("ml"), leftOverSuffix("piece"), leftOverSuffix(null)]).toEqual(["g", "ml", "pièces", ""]);
    // Regression: d28df09 — « 1 pièces » beside a field reading 1
    expect([leftOverSuffix("piece", "1"), leftOverSuffix("piece", " 0,5 "), leftOverSuffix("piece", "3"), leftOverSuffix("piece", "un fond")])
      .toEqual(["pièce", "pièce", "pièces", "pièces"]);
  });

  // Regression: d28df09 — the example repeated the unit the field already shows beside it (« ex. 125 g » then « g »)
  it("gives a bare number as the example when the unit stands beside the field, words when there is none", () => {
    expect([leftOverPlaceholder("g"), leftOverPlaceholder("ml"), leftOverPlaceholder("piece"), leftOverPlaceholder(null)])
      .toEqual(["ex. 125", "ex. 125", "ex. 2", "ex. la moitié"]);
  });

  // Regression: d28df09 — the field opened with « 60 g » beside the unit « g » (« 60 g g »), and with words beside an amount
  it("opens empty on an item that holds a number, with an unknown quantity's words otherwise, their unit left beside the field", () => {
    const at = (qty: number | null, qtyText: string | null, unit: "g" | "piece" | null = "g", productUnit: "g" | null = null) => ({ qty, qtyText, unit, productUnit });
    expect(leftOverPrefill(at(60, "60 g"))).toBe("");
    expect(leftOverPrefill(at(200, null))).toBe("");
    expect(leftOverPrefill(at(null, "un fond"))).toBe("un fond");
    expect(leftOverPrefill(at(null, "60 g"))).toBe("60");
    expect(leftOverPrefill(at(null, "125G"))).toBe("125");
    expect(leftOverPrefill(at(null, "1,5 g", null, "g"))).toBe("1,5");
    expect(leftOverPrefill(at(null, "2 pièces", "piece"))).toBe("2");
    expect(leftOverPrefill(at(null, "1 kg"))).toBe("1 kg");
    expect(leftOverPrefill(at(null, "2 tranches"))).toBe("2 tranches");
    expect(leftOverPrefill(at(null, "500 g", null))).toBe("500 g");
    expect(leftOverPrefill(at(null, null))).toBe("");
    expect(leftOverPrefill(undefined)).toBe("");
  });

  it("sends a bare number with the unit shown, which the server then reads as that amount", () => {
    expect(leftOverWords(" 125 ", "g")).toBe("125 g");
    expect(leftOverWords("1,5", "ml")).toBe("1,5 ml");
    expect(leftOverWords("1", "piece")).toBe("1 pièce");
    expect(leftOverWords("3", "piece")).toBe("3 pièces");
    for (const [text, unit, qty] of [["125", "g", 125], ["20", "ml", 20], ["3", "piece", 3], ["1", "piece", 1]] as const) {
      expect(parseDeclaredQty(leftOverWords(text, unit)!, unit)).toBe(qty);
    }
  });

  it("sends any other words as typed, nothing for an empty field, and a bare number as is without a unit", () => {
    expect(leftOverWords("un fond", "g")).toBe("un fond");
    expect(leftOverWords("1 kg", "g")).toBe("1 kg");
    expect(leftOverWords("2 tranches", "g")).toBe("2 tranches");
    expect(leftOverWords("   ", "g")).toBeNull();
    expect(leftOverWords("125", null)).toBe("125");
  });
});
