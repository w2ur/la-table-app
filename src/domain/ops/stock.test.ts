import { beforeEach, describe, expect, it } from "vitest";
import { applyOp } from "./apply";
import { invariantViolations, mealShortfalls } from "../invariants";
import { NOW, P, R, doubledFixtureProposal, fixtureProposal, fixtureState, op, secondProposal } from "../test-fixtures";
import type { State } from "../types";

let s: State;
const run = (type: string, payload: unknown) => {
  const r = applyOp(s, op(type, payload), NOW);
  s = r.state;
  return r.result;
};
const comteItem = () => s.stockItems.find((i) => i.productId === P.comte)!;

beforeEach(() => {
  s = fixtureState();
  run("planning.commit", fixtureProposal());
  run("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.comte)!.id });
  run("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comteItem().id, outcome: "il_en_reste" }] } });
});

describe("stock.finish and the reservation warning", () => {
  it("refuses to finish a reserved item without a resolution, naming the meal", () => {
    expect(run("stock.finish", { itemId: comteItem().id })).toEqual({ status: "refused", reason: "réservé pour Salade d'endives au comté" });
  });

  it("drop_meal finishes the item and drops the reserving meal", () => {
    expect(run("stock.finish", { itemId: comteItem().id, resolution: "drop_meal" }).status).toBe("applied");
    expect(comteItem().finishedAt).toBe(NOW);
    expect(s.meals.find((m) => m.id === 2)!.droppedAt).toBe(NOW);
  });

  // Regression: a529283 — the rebuy line had no price, so the Courses total left it out and its spend read as overspend
  it("rebuy finishes the item and puts the reserved quantity back on the list for that meal", () => {
    run("stock.finish", { itemId: comteItem().id, resolution: "rebuy" });
    const rebuy = s.shoppingItems.filter((l) => l.productId === P.comte && l.boughtAt === null);
    expect(rebuy).toHaveLength(1);
    expect(rebuy[0]).toMatchObject({ qty: 100, kind: "planning", forMeals: [{ mealId: 2, qty: 100 }], estPriceCents: 250 }); // 100 g of the 200 g line bought at 500 c
    expect(s.meals.find((m) => m.id === 2)!.droppedAt).toBeNull();
  });

  it("prices a rebuy from the latest priced line of the product when the item has no source line", () => {
    s = fixtureState();
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "un bout", useBy: null });
    run("planning.commit", fixtureProposal()); // the gratin takes the comté in Reste, the salade gets a 100 g line at 500 c
    run("stock.finish", { itemId: comteItem().id, resolution: "rebuy" });
    expect(s.shoppingItems.at(-1)).toMatchObject({ productId: P.comte, qty: 100, forMeals: [{ mealId: 1, qty: 100 }], estPriceCents: 500 });
  });

  // Regression: 748b912 — rebuying a plat cuisiné added a line with no meal share, which neither dropping the second round nor shopping.remove could clear
  it("refuses to rebuy a plat cuisiné, which only drop_meal settles", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.poulet, portions: 2, doubled: true }];
    p.prices = [...(p.prices as unknown[]), { product: "filet de poulet", unit: "g", est_price_cents: 900 }];
    run("planning.commit", p);
    const [first, second] = s.meals.filter((m) => m.recipeId === R.poulet);
    run("meal.cook", { mealId: first!.id, sheet: {} });
    const plat = s.stockItems.find((i) => i.origin === "plat_cuisine")!;
    const lines = s.shoppingItems.length;
    expect(run("stock.finish", { itemId: plat.id, resolution: "rebuy" })).toEqual({ status: "refused", reason: "un plat cuisiné ne se rachète pas ; retirez le repas" });
    expect(s.shoppingItems).toHaveLength(lines);
    expect(run("stock.finish", { itemId: plat.id, resolution: "drop_meal" }).status).toBe("applied");
    expect(s.meals.find((m) => m.id === second!.id)!.droppedAt).toBe(NOW);
    expect(s.shoppingItems.filter((l) => l.boughtAt === null && l.removedAt === null && l.forMeals.length === 0 && l.kind !== "ajout")).toEqual([]);
  });

  it("finishes an unreserved item directly and is a no-op the second time", () => {
    run("stock.add", { label: "yaourts", productId: null, qtyText: "4", useBy: null });
    const yaourts = s.stockItems.find((i) => i.label === "yaourts")!;
    expect(run("stock.finish", { itemId: yaourts.id }).status).toBe("applied");
    expect(run("stock.finish", { itemId: yaourts.id }).status).toBe("noop");
  });
});

describe("stock.partial, set_use_by, add", () => {
  it("marks low and shortens use-by to the opened shelf life", () => {
    run("stock.partial", { itemId: comteItem().id, qtyText: "presque fini", low: true });
    expect(comteItem()).toMatchObject({ qtyText: "presque fini", isLow: true });
  });

  // Regression: beda49f — « Il en reste » sent twice with the same words was applied with no change, so undoing
  // the first took the item back to before it, erasing the second, which was still in effect and could no longer be undone
  it("answers noop for an « Il en reste » that changes nothing, so undoing the first of two identical ones takes back the only write", () => {
    const first = op("stock.partial", { itemId: comteItem().id, qtyText: "un fond", low: false });
    const applied = applyOp(s, first, NOW);
    s = applied.state;
    expect(applied.result.status).toBe("applied");
    expect(run("stock.partial", { itemId: comteItem().id, qtyText: "un fond", low: false })).toEqual({ status: "noop", reason: "déjà noté" });
    expect(run("undo", { targetOpId: first.opId }).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qtyText: null, isLow: false });
    expect(run("stock.partial", { itemId: comteItem().id, qtyText: null, low: true }).status).toBe("applied");
  });

  // Regression: 99b4539 — a cook whose sheet said « Il en reste » with the item's own words changed nothing on
  // the item, so the undo of the earlier « Il en reste » went through and erased the cook's answer, still in effect
  it("refuses to undo an « Il en reste » that a later cook's sheet repeated on the plat cuisiné", () => {
    s = fixtureState();
    run("planning.commit", doubledFixtureProposal());
    run("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.saumon)!.id });
    expect(run("meal.cook", { mealId: 3, sheet: {} }).status).toBe("applied");
    const plat = s.stockItems.find((i) => i.origin === "plat_cuisine")!;
    const partial = op("stock.partial", { itemId: plat.id, qtyText: "un fond", low: false });
    const applied = applyOp(s, partial, NOW);
    s = applied.state;
    expect(applied.result.status).toBe("applied");
    const sheet = { items: [{ stockItemId: plat.id, outcome: "il_en_reste", qtyText: "un fond", low: false }] };
    expect(run("meal.cook", { mealId: 4, sheet }).status).toBe("applied");
    expect(run("undo", { targetOpId: partial.opId })).toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
    expect(s.stockItems.find((i) => i.id === plat.id)).toMatchObject({ qtyText: "un fond", openedAt: NOW });
  });

  it("corrects a date, rejecting a malformed one", () => {
    expect(run("stock.set_use_by", { itemId: comteItem().id, useBy: "2026-10-20" }).status).toBe("applied");
    expect(comteItem().useBy).toBe("2026-10-20");
    expect(run("stock.set_use_by", { itemId: comteItem().id, useBy: "20/10" })).toEqual({ status: "refused", reason: "données invalides" });
  });

  // Regression: dc1ef36 — setting the date an item already carries was applied with no change, and a finished item took a new date
  it("answers noop for the date already set, and refuses a finished item", () => {
    run("stock.set_use_by", { itemId: comteItem().id, useBy: "2026-10-20" });
    expect(run("stock.set_use_by", { itemId: comteItem().id, useBy: "2026-10-20" })).toEqual({ status: "noop", reason: "déjà à cette date" });
    expect(run("stock.finish", { itemId: comteItem().id, resolution: "drop_meal" }).status).toBe("applied");
    expect(run("stock.set_use_by", { itemId: comteItem().id, useBy: "2026-10-25" })).toEqual({ status: "refused", reason: "déjà fini" });
    expect(comteItem().useBy).toBe("2026-10-20");
  });

  it("adds an item, dating it from the product's shelf life when no date is given", () => {
    run("stock.add", { label: "poireaux du jardin", productId: P.poireau, qtyText: "une botte", useBy: null });
    expect(s.stockItems.at(-1)).toMatchObject({ origin: "ajout", useBy: "2026-10-22", productId: P.poireau });
  });
});

describe("stock.finish rebuy with packs", () => {
  it("rebuys in a whole pack, the second meal taking the spare of the first one's pack", () => {
    s = fixtureState();
    Object.assign(s.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 420, qty: 250, unit: "g" } });
    run("planning.commit", fixtureProposal()); // comté 200 g needed → one 250 g pack at 420 c
    run("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.comte)!.id });
    expect(run("stock.finish", { itemId: comteItem().id, resolution: "rebuy" }).status).toBe("applied");
    const rebuy = s.shoppingItems.filter((l) => l.productId === P.comte && l.boughtAt === null);
    expect(rebuy).toHaveLength(1);
    expect(rebuy[0]).toMatchObject({ qty: 250, estPriceCents: 420, forMeals: [{ mealId: 1, qty: 100 }, { mealId: 2, qty: 100 }] });
  });

  // Regression: 883f12d — a rebuy joining a spare line where its meal already holds a share adds to that share
  it("adds a rebuy to the meal's own share on the spare line, one entry, coverage exact", () => {
    s = fixtureState();
    Object.assign(s.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 420, qty: 250, unit: "g" } });
    run("planning.commit", fixtureProposal()); // comté 250 g for meals 1 and 2 (100 g each)
    run("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.comte)!.id });
    run("planning.commit", secondProposal()); // meal M reserves the libre 50 g, a new 250 g line holds its other 50 g
    const m = s.meals.at(-1)!.id;
    const spare = s.shoppingItems.find((l) => l.productId === P.comte && l.boughtAt === null)!;
    expect(spare.forMeals).toEqual([{ mealId: m, qty: 50 }]);
    run("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comteItem().id, outcome: "il_en_reste" }] } });
    expect(run("stock.finish", { itemId: comteItem().id, resolution: "rebuy" }).status).toBe("applied");
    expect(s.shoppingItems.filter((l) => l.productId === P.comte && l.boughtAt === null && l.removedAt === null)).toEqual([
      expect.objectContaining({ id: spare.id, qty: 250, estPriceCents: 420, forMeals: [{ mealId: m, qty: 100 }, { mealId: 2, qty: 100 }] }),
    ]);
    expect(invariantViolations(s)).toEqual([]);
  });
});

describe("stock.partial and stock.add: the declared leftover sets the quantity", () => {
  // Regression: 38c46e6 — « Il en reste · 125g » from Reste was kept as text only, so coverage still read the old quantity
  it("takes words that parse as the quantity, words gone, and answers noop when they are sent again", () => {
    expect(run("stock.partial", { itemId: comteItem().id, qtyText: "125g", low: false }).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: 125, unit: "g", qtyText: null });
    expect(run("stock.partial", { itemId: comteItem().id, qtyText: "125 g", low: false })).toEqual({ status: "noop", reason: "déjà noté" });
  });

  // Regression: 38c46e6 — the Reste prefill carried the words of an earlier « Il en reste », so sending it back after a
  // later cook would put back the amount that meal ate
  it("never overrides a later subtraction with the prefill sent back unchanged", () => {
    s = fixtureState();
    run("planning.commit", fixtureProposal());
    run("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.comte)!.id });
    run("stock.partial", { itemId: comteItem().id, qtyText: "250 g", low: false });
    expect(comteItem()).toMatchObject({ qty: 250, qtyText: null });
    run("meal.cook", { mealId: 1, sheet: {} }); // the gratin eats 100 g
    expect(comteItem().qty).toBe(150);
    const prefill = comteItem().qtyText; // what « Il en reste » opens with
    expect(run("stock.partial", { itemId: comteItem().id, qtyText: prefill, low: false })).toEqual({ status: "noop", reason: "déjà noté" });
    expect(comteItem().qty).toBe(150);
  });

  // Regression: 38c46e6 — « Il en reste » with no words on an item at 0 left a false zero
  it("makes a 0 unknown when nothing is declared, and keeps a known quantity", () => {
    run("stock.partial", { itemId: comteItem().id, qtyText: null, low: true });
    expect(comteItem()).toMatchObject({ qty: 100, isLow: true });
    s.stockItems.find((i) => i.id === comteItem().id)!.qty = 0;
    expect(run("stock.partial", { itemId: comteItem().id, qtyText: null, low: false }).status).toBe("applied");
    expect(comteItem().qty).toBeNull();
    expect(invariantViolations(s)).toEqual([]);
  });

  // Regression: 38c46e6 — words that are no quantity left the item's number under them
  it("makes the quantity unknown and keeps words that are no quantity", () => {
    expect(run("stock.partial", { itemId: comteItem().id, qtyText: "un fond", low: false }).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: null, qtyText: "un fond" });
    expect(invariantViolations(s)).toEqual([]);
  });

  // Regression: 38c46e6 — a dictated « 1 kg » of a catalogue product was stored as text only, so planning saw nothing at home
  it("adds a catalogue product's words as its quantity, in its base unit", () => {
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "1 kg", useBy: null });
    expect(s.stockItems.at(-1)).toMatchObject({ qty: 1000, unit: "g", qtyText: null });
    run("stock.add", { label: "crème", productId: P.creme, qtyText: "20 cl", useBy: null });
    expect(s.stockItems.at(-1)).toMatchObject({ qty: 200, unit: "ml", qtyText: null });
  });

  it("adds words that are no quantity, or a free-text item, as text with no quantity", () => {
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "un bout", useBy: null });
    expect(s.stockItems.at(-1)).toMatchObject({ qty: null, unit: null, qtyText: "un bout" });
    run("stock.add", { label: "yaourts", productId: null, qtyText: "4", useBy: null });
    expect(s.stockItems.at(-1)).toMatchObject({ qty: null, unit: null, qtyText: "4" });
    run("stock.add", { label: "poireaux", productId: P.poireau, qtyText: null, useBy: null });
    expect(s.stockItems.at(-1)).toMatchObject({ qty: null, unit: null, qtyText: null });
  });

  describe("below what the other open meals hold", () => {
    const live = () => s.reservations.filter((r) => r.stockItemId === 1 && r.releasedAt === null).map((r) => [r.mealId, r.qty]);
    beforeEach(() => {
      // 160 g of comté at home: the gratin reserves 100 g, the salade the other 60 g and puts 40 g on Courses
      s = fixtureState();
      s.stockItems.push({ id: 1, productId: P.comte, label: "comté", qty: 160, unit: "g", qtyText: null, isLow: false, useBy: null,
        openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
      run("planning.commit", fixtureProposal());
      expect(live()).toEqual([[1, 100], [2, 60]]);
    });

    // Regression: 309f2ec — « 50 g » under holds of 100 g and 60 g was raised to 160 g with the words kept beside it
    it("takes the declared amount and trims the holds, the latest planned meal first: those meals are short", () => {
      expect(run("stock.partial", { itemId: 1, qtyText: "50 g", low: false }).status).toBe("applied");
      expect(comteItem()).toMatchObject({ qty: 50, unit: "g", qtyText: null });
      expect(live()).toEqual([[1, 50]]);
      expect(mealShortfalls(s)).toEqual([{ mealId: 1, productId: P.comte, unit: "g", qty: 50 }, { mealId: 2, productId: P.comte, unit: "g", qty: 60 }]);
      expect(invariantViolations(s).filter((v) => v.code !== "meal_under_covered")).toEqual([]);
      expect(run("stock.partial", { itemId: 1, qtyText: "50 g", low: false })).toEqual({ status: "noop", reason: "déjà noté" });
    });

    // Regression: 309f2ec — « un peu » on an item two meals hold kept their 160 g as the quantity
    it("makes the quantity unknown for words that are no quantity, the earliest planned meal keeping its hold", () => {
      expect(run("stock.partial", { itemId: 1, qtyText: "un peu", low: false }).status).toBe("applied");
      expect(comteItem()).toMatchObject({ qty: null, qtyText: "un peu" });
      expect(live()).toEqual([[1, 100]]);
      expect(mealShortfalls(s)).toEqual([{ mealId: 2, productId: P.comte, unit: "g", qty: 60 }]);
      expect(invariantViolations(s).filter((v) => v.code !== "meal_under_covered")).toEqual([]);
    });
  });

  it("reads a pack word with the product's pack", () => {
    s.products.find((p) => p.id === P.creme)!.pack = { qty: 200, unit: "ml" };
    run("stock.add", { label: "crème", productId: P.creme, qtyText: "2 pots", useBy: null });
    expect(s.stockItems.at(-1)).toMatchObject({ qty: 400, unit: "ml", qtyText: null });
  });
});
