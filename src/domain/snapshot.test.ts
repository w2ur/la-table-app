import { describe, expect, it } from "vitest";
import { applyOp } from "./ops/apply";
import { mealLabels, resteItems, resteSection, snapshot } from "./snapshot";
import { GRATIN_RECIPE, NOW, P, R, doubledFixtureProposal, fixtureProposal, fixtureState, op } from "./test-fixtures";
import type { ProductNutrition } from "./types";

describe("snapshot", () => {
  it("projects the cheese story: pool, courses grouped, Reste sections", () => {
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    const comteLine = s.shoppingItems.find((l) => l.productId === P.comte)!;
    s = applyOp(s, op("shopping.buy", { itemId: comteLine.id }), NOW).state;
    const comteItem = s.stockItems.find((i) => i.productId === P.comte)!;
    s = applyOp(s, op("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comteItem.id, outcome: "il_en_reste" }] } }), NOW).state;

    const snap = snapshot(s, NOW);
    expect(snap.menu.pool.map((m) => m.title)).toEqual(["Salade d'endives au comté", "Saumon aux lentilles et poireaux"]);
    expect(snap.menu.recentlyCooked.map((m) => m.title)).toEqual(["Gratin de poireaux au comté"]);
    expect(snap.menu.pool[0]!.ingredients.find((i) => i.productId === P.comte)).toMatchObject({ qty: 100, reserved: true });
    expect(snap.reste.reserved.map((r) => [r.label, r.reservations.map((x) => [x.mealTitle, x.qty])])).toEqual([
      ["comté", [["Salade d'endives au comté", 100]]],
    ]);
    // the gratin ate its 100 g: what is left is the salade's, none of it libre
    expect(snap.reste.reserved[0]!).toMatchObject({ qty: 100, libreQty: 0 });
    expect(snap.courses.lines.find((l) => l.id === comteLine.id)).toMatchObject({ group: "cremerie", boughtAt: NOW });
    expect(snap.courses.budgetCents).toBe(3000);
  });

  it("puts items within 2 days (and past dates) in urgent, staples in placard", () => {
    const s = fixtureState();
    const base = { qty: null, unit: null, qtyText: null, isLow: false, openedAt: null, finishedAt: null, origin: "ajout" as const,
      sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW };
    s.stockItems.push(
      { ...base, id: 1, productId: P.creme, label: "crème", useBy: "2026-10-11" },
      { ...base, id: 2, productId: P.riz, label: "riz complet", useBy: null },
      { ...base, id: 3, productId: P.endive, label: "endives", useBy: "2026-10-20" },
    );
    const snap = snapshot(s, NOW);
    expect(snap.reste.urgent.map((i) => [i.label, i.daysLeft])).toEqual([["crème", -1]]);
    expect(snap.reste.placard.map((i) => i.label)).toEqual(["riz complet"]);
    expect(snap.reste.libre.map((i) => i.label)).toEqual(["endives"]);
  });

  it("names the op that can undo a bought line or a cooked meal from its row, never an undone op, and none past the window", () => {
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    const comte = s.shoppingItems.find((l) => l.productId === P.comte)!;
    const poireau = s.shoppingItems.find((l) => l.productId === P.poireau)!;
    const step = (o: ReturnType<typeof op>) => {
      const applied = applyOp(s, o, NOW);
      expect(applied.result, o.type).toEqual({ status: "applied", reason: null });
      s = applied.state;
    };
    const buyComte = op("shopping.buy", { itemId: comte.id });
    const firstPoireau = op("shopping.buy", { itemId: poireau.id });
    const secondPoireau = op("shopping.buy", { itemId: poireau.id });
    const cookGratin = op("meal.cook", { mealId: 1, sheet: {} });
    step(buyComte);
    step(firstPoireau);
    step(op("undo", { targetOpId: firstPoireau.opId }));
    step(secondPoireau);
    step(cookGratin);

    const snap = snapshot(s, NOW);
    const line = (id: number) => snap.courses.lines.find((l) => l.id === id)!;
    expect(line(comte.id).buyOpId).toBe(buyComte.opId);
    expect(line(poireau.id).buyOpId).toBe(secondPoireau.opId);
    expect(snap.courses.lines.filter((l) => l.boughtAt === null).map((l) => l.buyOpId)).toEqual(
      snap.courses.lines.filter((l) => l.boughtAt === null).map(() => null),
    );
    expect(snap.menu.recentlyCooked).toEqual([{ mealId: 1, cookedAt: NOW, cookOpId: cookGratin.opId, ...GRATIN_RECIPE }]);

    // 15 days later the records are outside the window: the rows no longer offer undo
    expect(snapshot(s, "2026-10-27T10:00:00.000Z").courses.lines.find((l) => l.id === comte.id)!.buyOpId).toBeNull();
  });

  it("names on each Courses line the open meals it serves, each once, and none for an ajout", () => {
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    s = applyOp(s, op("shopping.add", { label: "savon", isFood: false }), NOW).state;
    const meals = (id: number) => snapshot(s, NOW).courses.lines.find((l) => l.id === id)!.mealRefs?.map((m) => m.title);
    const comte = s.shoppingItems.find((l) => l.productId === P.comte)!;
    const savon = s.shoppingItems.find((l) => l.label === "savon")!;
    expect(comte.forMeals.map((m) => m.mealId)).toEqual([1, 2]);
    expect(meals(comte.id)).toEqual(["Gratin de poireaux au comté", "Salade d'endives au comté"]);
    expect(meals(savon.id)).toEqual([]);
    // a meal cooked is no longer one the line is bought for
    s = applyOp(s, op("meal.cook", { mealId: 1, sheet: {} }), NOW).state;
    expect(s.shoppingItems.find((l) => l.id === comte.id)!.forMeals.map((m) => m.mealId)).toContain(1);
    expect(meals(comte.id)).toEqual(["Salade d'endives au comté"]);
  });

  it("names a recipe once with its count when two open meals of it share a line", () => {
    // Regression: 12b1dfd — a line serving two open meals of one recipe named that recipe once, as if it served one
    const s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    const comte = s.shoppingItems.find((l) => l.productId === P.comte)!;
    const gratin = s.meals.find((m) => m.id === 1)!;
    s.meals.push({ ...structuredClone(gratin), id: 99 });
    comte.forMeals.push({ mealId: 99, qty: 50 });
    const refs = snapshot(s, NOW).courses.lines.find((l) => l.id === comte.id)!.mealRefs!;
    expect(refs.map((r) => r.id)).toEqual([1, 2, 99]);
    expect(mealLabels(refs)).toEqual(["Gratin de poireaux au comté ×2", "Salade d'endives au comté"]);
  });

  it("names no meals on a staple line that holds shares, nor on a bought line", () => {
    // Regression: 6027cf8 — CourseLine.mealRefs is empty for a staple line, as its doc says
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    const comte = s.shoppingItems.find((l) => l.productId === P.comte)!;
    const meals = () => snapshot(s, NOW).courses.lines.find((l) => l.id === comte.id)!.mealRefs;
    expect(meals()).toHaveLength(2);
    comte.kind = "staple_hors_budget";
    expect(comte.forMeals.length).toBeGreaterThan(0);
    expect(meals()).toEqual([]);
    comte.kind = "planning";
    s = applyOp(s, op("shopping.buy", { itemId: comte.id }), NOW).state;
    expect(snapshot(s, NOW).courses.lines.find((l) => l.id === comte.id)!.mealRefs).toEqual([]);
  });

  it("names a second round's open first round, until that round is cooked", () => {
    let s = applyOp(fixtureState(), op("planning.commit", doubledFixtureProposal()), NOW).state;
    const second = () => snapshot(s, NOW).menu.pool.find((m) => m.id === 4)!;
    expect(snapshot(s, NOW).menu.pool.map((m) => [m.id, m.isSecondRound, m.firstRoundId])).toEqual([[1, false, null], [2, false, null], [3, false, null], [4, true, 3]]);
    s = applyOp(s, op("meal.cook", { mealId: 3, sheet: {} }), NOW).state;
    expect(second()).toMatchObject({ isSecondRound: true, firstRoundId: null });
    expect(second().reservedItems).toEqual([{ stockItemId: expect.any(Number), label: "Saumon aux lentilles et poireaux", qty: null, unit: null }]);
  });

  it("marks a staple, and sorts every Reste item by one rule the phone shares", () => {
    const s = fixtureState();
    const base = { qty: null, unit: null, qtyText: null, isLow: false, openedAt: null, finishedAt: null, origin: "ajout" as const,
      sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW };
    s.stockItems.push({ ...base, id: 1, productId: P.riz, label: "riz complet", useBy: "2026-10-13" }, { ...base, id: 2, productId: P.riz, label: "riz", useBy: null });
    const snap = snapshot(s, NOW);
    expect(snap.reste.urgent.map((i) => [i.label, i.isStaple])).toEqual([["riz complet", true]]);
    expect(snap.reste.placard.map((i) => [i.label, i.isStaple])).toEqual([["riz", true]]);
    const held = [{ mealId: 1, mealTitle: "Gratin", qty: 100, unit: "g" as const }];
    expect(resteSection({ daysLeft: 2, reservations: held, isStaple: false })).toBe("urgent");
    expect(resteSection({ daysLeft: -4, reservations: [], isStaple: true })).toBe("urgent");
    expect(resteSection({ daysLeft: 3, reservations: held, isStaple: false })).toBe("reserved");
    expect(resteSection({ daysLeft: null, reservations: [], isStaple: true })).toBe("placard");
    expect(resteSection({ daysLeft: null, reservations: [], isStaple: false })).toBe("libre");
  });

  // Regression: b4cd6b8 — the last trip was the latest by date, so a forgotten marché recorded with a past date
  // after a later-dated trip never became it, and its ticket was never offered on the phone
  it("takes the trip recorded last as the last trip, whatever its date", () => {
    const s = fixtureState();
    s.trips.push(
      { id: 1, date: "2026-10-06", place: "supermarche", totalCents: 4200, noReceipt: null, createdAt: "2026-10-06T18:00:00.000Z" },
      { id: 2, date: "2026-10-05", place: "marche", totalCents: null, noReceipt: null, createdAt: NOW },
    );
    expect(snapshot(s, NOW).lastTrip).toMatchObject({ id: 2, date: "2026-10-05", totalCents: null });
  });

  it("skips a trip without a receipt: the real trip stays the last one, with its total to enter", () => {
    const s = fixtureState();
    s.trips.push(
      { id: 1, date: "2026-10-06", place: "supermarche", totalCents: null, noReceipt: null, createdAt: "2026-10-06T18:00:00.000Z" },
      { id: 2, date: "2026-10-06", place: "autre", totalCents: null, noReceipt: true, createdAt: NOW },
    );
    expect(snapshot(s, NOW).lastTrip).toMatchObject({ id: 1, place: "supermarche" });
    s.trips.shift();
    expect(snapshot(s, NOW).lastTrip).toBeNull();
  });
});

describe("snapshot shortfalls", () => {
  const bought = () => {
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    for (const line of [...s.shoppingItems]) s = applyOp(s, op("shopping.buy", { itemId: line.id }), NOW).state;
    return s;
  };

  it("lists, per pool meal, what a declared leftover below the holds leaves it short of, by product name", () => {
    let s = bought();
    expect(snapshot(s, NOW).menu.pool.map((m) => m.shortfalls)).toEqual([[], [], []]);
    const comte = s.stockItems.find((i) => i.productId === P.comte)!;
    s = applyOp(s, op("stock.partial", { itemId: comte.id, qtyText: "50 g", low: false }), NOW).state;
    const byMeal = snapshot(s, NOW).menu.pool.map((m) => [m.id, m.shortfalls]);
    expect(byMeal.filter(([, short]) => (short as unknown[]).length > 0)).toEqual([
      [1, [{ label: "comté", qty: 50, unit: "g" }]],
      [2, [{ label: "comté", qty: 100, unit: "g" }]],
    ]);
  });
});

describe("snapshot nutrition", () => {
  const POIREAU: ProductNutrition = { ciqualCode: "20018", per100g: { kcal: 30, proteinG: 1.5, carbsG: 4.6, fatG: 0.3, fibreG: 3.2, saltG: 0.02 }, gramsPerPiece: null, gramsPerMl: null, ediblePct: 100 };
  const COMTE: ProductNutrition = { ciqualCode: "12726", per100g: { kcal: 400, proteinG: 28, carbsG: 0, fatG: 32, fibreG: 0, saltG: 1 }, gramsPerPiece: null, gramsPerMl: null, ediblePct: 100 };
  const withNutrition = () => {
    const s = fixtureState();
    s.products.find((p) => p.id === P.poireau)!.nutrition = POIREAU;
    s.products.find((p) => p.id === P.comte)!.nutrition = COMTE;
    return s;
  };

  it("gives each pool meal its recipe's nutrition per base portion, whatever the meal's portions", () => {
    const s = applyOp(withNutrition(), op("planning.commit", fixtureProposal()), NOW).state;
    s.meals.find((m) => m.recipeId === R.gratin)!.portions = 4;
    const gratin = snapshot(s, NOW).menu.pool.find((m) => m.title === "Gratin de poireaux au comté")!;
    // (400 g poireau + 100 g comté) / 2 base portions; riz and crème have no values
    expect(gratin.nutrition).toEqual({
      perPortion: { kcal: expect.closeTo(260, 9), proteinG: expect.closeTo(17, 9), carbsG: expect.closeTo(9.2, 9), fatG: expect.closeTo(16.6, 9), fibreG: expect.closeTo(6.4, 9), saltG: expect.closeTo(0.54, 9) },
      missing: ["riz complet", "crème fraîche"],
    });
    expect(gratin.portions).toBe(4);
  });

  it("gives a second round the same per-portion values as its first", () => {
    const s = applyOp(withNutrition(), op("planning.commit", doubledFixtureProposal()), NOW).state;
    const saumon = snapshot(s, NOW).menu.pool.filter((m) => m.title === "Saumon aux lentilles et poireaux");
    expect(saumon.map((m) => m.isSecondRound).sort()).toEqual([false, true]);
    expect(saumon[0]!.nutrition?.perPortion.kcal).toBeGreaterThan(0);
    expect(saumon[1]!.nutrition).toEqual(saumon[0]!.nutrition);
  });

  it("is null when no ingredient of the recipe has values", () => {
    const s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    expect(snapshot(s, NOW).menu.pool.map((m) => m.nutrition)).toEqual([null, null, null]);
  });

  it("gives a meal cooked recently its recipe read-only: ingredients for the portions cooked, per-portion nutrition at base portions", () => {
    let s = applyOp(withNutrition(), op("planning.commit", fixtureProposal()), NOW).state;
    s.meals.find((m) => m.recipeId === R.gratin)!.portions = 4;
    const planned = snapshot(s, NOW).menu.pool.find((m) => m.title === "Gratin de poireaux au comté")!;
    s = applyOp(s, op("meal.cook", { mealId: planned.id, sheet: {} }), NOW).state;
    const cooked = snapshot(s, NOW).menu.recentlyCooked.find((m) => m.mealId === planned.id)!;
    expect(cooked).toMatchObject({
      title: planned.title, portions: 4, activeMin: planned.activeMin, totalMin: planned.totalMin, steps: planned.steps,
      sourceUrl: planned.sourceUrl, isSecondRound: false, nutrition: planned.nutrition,
    });
    // the pool's scaling (4 portions of a 2-portion recipe), without the « réservé » mark a cooked meal no longer has
    expect(cooked.ingredients).toEqual(planned.ingredients.map(({ reserved: _, ...i }) => i));
    expect(cooked.ingredients!.find((i) => i.label === "poireau")).toEqual({ productId: P.poireau, label: "poireau", qty: 800, unit: "g" });
    expect(cooked.nutrition!.perPortion.kcal).toBeCloseTo(260, 9);
  });

  it("keeps a first round at the double it was cooked for, even once its second round is dropped; a second round cooked shows no recipe to gather", () => {
    const LATER = "2026-10-12T19:00:00.000Z";
    const committed = applyOp(withNutrition(), op("planning.commit", doubledFixtureProposal()), NOW).state;
    const planned = snapshot(committed, NOW).menu.pool.find((m) => m.id === 3)!;
    const saumon = (s: typeof committed) => snapshot(s, LATER).menu.recentlyCooked.find((m) => m.mealId === 3)!;
    let s = applyOp(committed, op("meal.cook", { mealId: 3, sheet: {} }), NOW).state;
    expect(saumon(s).ingredients).toEqual(planned.ingredients.map(({ reserved: _, ...i }) => i));
    expect(saumon(s).ingredients!.find((i) => i.productId === P.saumon)!.qty).toBe(500); // 2 portions, twice
    s = applyOp(s, op("meal.drop", { mealId: 4 }, LATER), LATER).state;
    expect(saumon(s).ingredients!.find((i) => i.productId === P.saumon)!.qty).toBe(500);
    // a second round dropped before its first round was cooked: cooked once
    let once = applyOp(committed, op("meal.drop", { mealId: 4 }), NOW).state;
    once = applyOp(once, op("meal.cook", { mealId: 3, sheet: {} }, LATER), LATER).state;
    expect(saumon(once).ingredients!.find((i) => i.productId === P.saumon)!.qty).toBe(250);
    // the second round ate the plat cuisiné: neither ingredients nor nutrition, as its view says
    s = applyOp(applyOp(committed, op("meal.cook", { mealId: 3, sheet: {} }), NOW).state, op("meal.cook", { mealId: 4, sheet: {} }, LATER), LATER).state;
    const second = snapshot(s, LATER).menu.recentlyCooked.find((m) => m.mealId === 4)!;
    expect(second).toMatchObject({ isSecondRound: true, portions: 2 });
    expect("ingredients" in second || "nutrition" in second).toBe(false);
  });
});

describe("resteItems", () => {
  it("lists every Reste item, a section after the other: urgent, reserved, libre, placard", () => {
    expect(resteItems({ reste: { urgent: [1], reserved: [2, 3], libre: [], placard: [4] } })).toEqual([1, 2, 3, 4]);
  });
});
