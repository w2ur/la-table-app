import { describe, expect, it } from "vitest";
import { fixtureState } from "../domain/test-fixtures";
import { euros, mealTitle, parseEuros, quantity } from "./format";

describe("euros", () => {
  it("writes cents as the app does (comma, euro sign after a space), and a dash when unknown", () => {
    expect(euros(1250)).toBe("12,50 €");
    expect(euros(5)).toBe("0,05 €");
    expect(euros(1200)).toBe("12 €");
    expect(euros(123456)).toBe("1234,56 €");
    expect(euros(null)).toBe("—");
  });
});

describe("mealTitle", () => {
  it("names a meal by its recipe's title, else by its id", () => {
    const s = fixtureState();
    s.meals.push({ id: 7, planningId: 1, recipeId: 3, portions: 2, doubledFrom: null, cookEarlyReason: null, cookedAt: null, droppedAt: null, verdict: null, note: null });
    s.meals.push({ id: 8, planningId: 1, recipeId: 99, portions: 2, doubledFrom: null, cookEarlyReason: null, cookedAt: null, droppedAt: null, verdict: null, note: null });
    expect(mealTitle(s, 7)).toBe("Salade d'endives au comté");
    expect(mealTitle(s, 8)).toBe("repas #8");
    expect(mealTitle(s, 9)).toBe("repas #9");
  });
});

describe("parseEuros", () => {
  it("reads euros typed with a comma or a dot into integer cents", () => {
    expect(parseEuros("3,5")).toBe(350);
    expect(parseEuros("3.50")).toBe(350);
    expect(parseEuros("12")).toBe(1200);
    expect(parseEuros("0,07")).toBe(7);
    expect(parseEuros(" 4,20 ")).toBe(420);
    expect(parseEuros("9999999,99")).toBe(999999999);
  });
  it("refuses negatives, more than two decimals, empty, non-numbers and amounts past 7 digits of euros", () => {
    for (const bad of ["-2", "3,505", "", "abc", "3,", ",5", "1e3", "3 €", "12345678", "99999999999999999999"]) expect(parseEuros(bad), bad).toBeNull();
  });
});

describe("quantity", () => {
  it("writes quantities as the app does", () => {
    expect(quantity(1500, "g")).toBe("1,5 kg");
    expect(quantity(3, "piece")).toBe("3 pièces");
    expect(quantity(null, null)).toBe("quantité inconnue");
  });
});
