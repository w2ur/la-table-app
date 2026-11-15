import { describe, expect, it } from "vitest";
import { declaredLeftover, parseDeclaredQty, type DeclaredContext, type DeclaredItem } from "./declared";
import type { Unit } from "./units";

describe("parseDeclaredQty", () => {
  it("reads a number with a unit, glued or spaced", () => {
    expect(parseDeclaredQty("125g", "g")).toBe(125);
    expect(parseDeclaredQty("500g", "g")).toBe(500);
    expect(parseDeclaredQty("125 g", "g")).toBe(125);
    expect(parseDeclaredQty("125 gr", "g")).toBe(125);
    expect(parseDeclaredQty("125 grammes", "g")).toBe(125);
    expect(parseDeclaredQty("1 gramme", "g")).toBe(1);
  });

  it("converts kilos, litres and centilitres to the base unit", () => {
    expect(parseDeclaredQty("1 kg", "g")).toBe(1000);
    expect(parseDeclaredQty("2 kilos", "g")).toBe(2000);
    expect(parseDeclaredQty("1 kilo", "g")).toBe(1000);
    expect(parseDeclaredQty("20 cl", "ml")).toBe(200);
    expect(parseDeclaredQty("1 l", "ml")).toBe(1000);
    expect(parseDeclaredQty("2 litres", "ml")).toBe(2000);
    expect(parseDeclaredQty("1 litre", "ml")).toBe(1000);
    expect(parseDeclaredQty("250 ml", "ml")).toBe(250);
  });

  it("accepts a comma or a dot decimal and rounds to an integer", () => {
    expect(parseDeclaredQty("1,5 kg", "g")).toBe(1500);
    expect(parseDeclaredQty("1.5 kg", "g")).toBe(1500);
    expect(parseDeclaredQty("0,5 l", "ml")).toBe(500);
    expect(parseDeclaredQty("2,6 g", "g")).toBe(3);
  });

  it("is case-insensitive and tolerant of surrounding spaces", () => {
    expect(parseDeclaredQty("  125 G  ", "g")).toBe(125);
    expect(parseDeclaredQty("1 KG", "g")).toBe(1000);
    expect(parseDeclaredQty("2 Pièces", "piece")).toBe(2);
  });

  it("reads pieces, accented or not, plural or not", () => {
    expect(parseDeclaredQty("3 pièces", "piece")).toBe(3);
    expect(parseDeclaredQty("1 pièce", "piece")).toBe(1);
    expect(parseDeclaredQty("3 pieces", "piece")).toBe(3);
    expect(parseDeclaredQty("1 piece", "piece")).toBe(1);
    expect(parseDeclaredQty("4 pc", "piece")).toBe(4);
  });

  it("takes a bare number only on a piece item", () => {
    expect(parseDeclaredQty("6", "piece")).toBe(6);
    expect(parseDeclaredQty("60", "g")).toBeNull();
    expect(parseDeclaredQty("400", "g")).toBeNull();
    expect(parseDeclaredQty("2", "ml")).toBeNull();
  });

  it("multiplies a packaging word by the pack, in the pack's unit", () => {
    expect(parseDeclaredQty("1 boîte", "g", { qty: 140, unit: "g" })).toBe(140);
    expect(parseDeclaredQty("2 boîtes", "g", { qty: 135, unit: "g" })).toBe(270);
    expect(parseDeclaredQty("2 boites", "g", { qty: 135, unit: "g" })).toBe(270);
    expect(parseDeclaredQty("1,5 bouteille", "ml", { qty: 750, unit: "ml" })).toBe(1125);
    expect(parseDeclaredQty("1 paquet", "g", { qty: 500, unit: "g" })).toBe(500);
    expect(parseDeclaredQty("2 pots", "g", { qty: 125, unit: "g" })).toBe(250);
    expect(parseDeclaredQty("1 brique", "ml", { qty: 200, unit: "ml" })).toBe(200);
    expect(parseDeclaredQty("3 sachets", "g", { qty: 10, unit: "g" })).toBe(30);
    expect(parseDeclaredQty("2 barquettes", "g", { qty: 250, unit: "g" })).toBe(500);
  });

  it("refuses a packaging word without a usable pack", () => {
    expect(parseDeclaredQty("1 paquet", "g")).toBeNull();
    expect(parseDeclaredQty("1 paquet", "g", null)).toBeNull();
    expect(parseDeclaredQty("1 boîte", "g", { qty: 400, unit: "ml" })).toBeNull();
  });

  it("answers null for words that are not a quantity of the item's unit", () => {
    expect(parseDeclaredQty("un peu", "g")).toBeNull();
    expect(parseDeclaredQty("un fond", "ml")).toBeNull();
    expect(parseDeclaredQty("12 feuilles", "g")).toBeNull();
    expect(parseDeclaredQty("150 g", "piece")).toBeNull();
    expect(parseDeclaredQty("1 l", "g")).toBeNull();
    expect(parseDeclaredQty("2 pièces", "g")).toBeNull();
    expect(parseDeclaredQty("125g de plus", "g")).toBeNull();
  });

  it("never turns an empty, zero or negative declaration into a number", () => {
    expect(parseDeclaredQty("", "g")).toBeNull();
    expect(parseDeclaredQty("   ", "g")).toBeNull();
    expect(parseDeclaredQty("0", "piece")).toBeNull();
    expect(parseDeclaredQty("0 g", "g")).toBeNull();
    expect(parseDeclaredQty("0,2 g", "g")).toBeNull();
    expect(parseDeclaredQty("-5 g", "g")).toBeNull();
    expect(parseDeclaredQty("-1", "piece")).toBeNull();
  });
});

describe("declaredLeftover", () => {
  const free: DeclaredContext = { productUnit: null, pack: null, held: [] };
  const comte: DeclaredContext = { productUnit: "g", pack: { qty: 250, unit: "g" }, held: [] };
  const grams = (qty: number | null, qtyText: string | null = null) => ({ qty, unit: "g" as const, qtyText });
  const item = (i: DeclaredItem, words: string | null | undefined, ctx: DeclaredContext) => declaredLeftover(i, words, ctx).item;
  const hold = (mealId: number, qty: number | null, unit: Unit | null = "g") => ({ mealId, qty, unit });
  const kept = (qty: number | null) => ({ qty, released: false });
  const released = (qty: number | null) => ({ qty, released: true });

  it("takes words that parse as the quantity and drops them", () => {
    expect(item(grams(0), "125g", comte)).toEqual({ qty: 125, unit: "g", qtyText: null });
    expect(item(grams(null, "un fond"), "1 paquet", comte)).toEqual({ qty: 250, unit: "g", qtyText: null });
  });

  it("parses in the product's base unit when the item has none, and sets it", () => {
    expect(item({ qty: null, unit: null, qtyText: null }, "1 kg", comte)).toEqual({ qty: 1000, unit: "g", qtyText: null });
  });

  it("keeps words that do not parse, trimmed, the quantity unknown", () => {
    for (const words of ["un fond", "la moitié", "2 tranches", "0", "125"]) {
      expect(item(grams(200), words, comte)).toEqual({ qty: null, unit: "g", qtyText: words });
    }
    expect(item(grams(200), "  un fond ", comte)).toEqual({ qty: null, unit: "g", qtyText: "un fond" });
    expect(item({ qty: null, unit: null, qtyText: null }, "500 g", free)).toEqual({ qty: null, unit: null, qtyText: "500 g" });
  });

  it("with no words, keeps a known quantity and makes a 0 unknown; undefined keeps the item's words, null or blank clears them", () => {
    expect(item(grams(80, "un bout"), undefined, comte)).toEqual({ qty: 80, unit: "g", qtyText: "un bout" });
    expect(item(grams(80, "un bout"), null, comte)).toEqual({ qty: 80, unit: "g", qtyText: null });
    expect(item(grams(80, "un bout"), "  ", comte)).toEqual({ qty: 80, unit: "g", qtyText: null });
    expect(item(grams(0), null, comte)).toEqual({ qty: null, unit: "g", qtyText: null });
    expect(item(grams(0, "un fond"), undefined, comte)).toEqual({ qty: null, unit: "g", qtyText: "un fond" });
  });

  it("leaves the other meals' holds as they are while they fit the declared amount", () => {
    const two = { ...comte, held: [hold(1, 100), hold(2, 60)] };
    expect(declaredLeftover(grams(300), "160 g", two)).toEqual({ item: { qty: 160, unit: "g", qtyText: null }, holds: [kept(100), kept(60)] });
    expect(declaredLeftover(grams(300), "450 g", two).holds).toEqual([kept(100), kept(60)]);
    expect(declaredLeftover(grams(300), null, two).holds).toEqual([kept(100), kept(60)]);
  });

  // Regression: 309f2ec — a declared amount below the other meals' holds was raised to their sum, so Reste showed
  // stock that was not there, and once those meals were dropped it read as libre
  it("takes a declared amount below the other meals' holds as it is and trims them, the latest planned meal first", () => {
    const two = { ...comte, held: [hold(1, 100), hold(2, 60)] };
    expect(declaredLeftover(grams(300), "50 g", two)).toEqual({ item: { qty: 50, unit: "g", qtyText: null }, holds: [kept(50), released(60)] });
    expect(declaredLeftover(grams(300), "120 g", two).holds).toEqual([kept(100), kept(20)]);
    // listed latest first or not, the highest meal id goes first; two holds of one meal, the later one first
    expect(declaredLeftover(grams(300), "50 g", { ...comte, held: [hold(7, 60), hold(3, 100)] }).holds).toEqual([released(60), kept(50)]);
    expect(declaredLeftover(grams(300), "30 g", { ...comte, held: [hold(4, 20), hold(4, 30)] }).holds).toEqual([kept(20), kept(10)]);
    // a hold in another unit, or of no quantity, is not counted against a known quantity
    expect(declaredLeftover(grams(300), "50 g", { ...comte, held: [hold(1, 100), hold(9, 2, "piece")] }).holds).toEqual([kept(50), kept(2)]);
  });

  // Regression: 309f2ec — words that are no quantity on an item several meals hold kept their sum as the quantity, a
  // number the owners never gave
  it("keeps only the earliest planned meal's hold when the quantity becomes unknown", () => {
    const three = { ...comte, held: [hold(5, 100), hold(2, 60), hold(8, 40)] };
    expect(declaredLeftover(grams(300), "un peu", three)).toEqual({ item: { qty: null, unit: "g", qtyText: "un peu" }, holds: [released(100), kept(60), released(40)] });
    expect(declaredLeftover(grams(0), null, three).holds).toEqual([released(100), kept(60), released(40)]);
    expect(declaredLeftover({ qty: null, unit: null, qtyText: null }, "un fond", { ...free, held: [hold(3, null, null), hold(3, null, null)] }).holds)
      .toEqual([kept(null), released(null)]);
  });

  it("leaves a single hold on an unknown quantity", () => {
    expect(declaredLeftover(grams(300), "un peu", { ...comte, held: [hold(1, 100)] })).toEqual({ item: { qty: null, unit: "g", qtyText: "un peu" }, holds: [kept(100)] });
  });
});
