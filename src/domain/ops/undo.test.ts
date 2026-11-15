import { beforeEach, describe, expect, it } from "vitest";
import { applyOp } from "./apply";
import { NOW, P, R, doubledFixtureProposal, fixtureProposal, fixtureState, op, secondProposal } from "../test-fixtures";
import { invariantViolations, mealShortfalls } from "../invariants";
import type { State } from "../types";

let s: State;
const run = (o: ReturnType<typeof op>) => {
  const r = applyOp(s, o, NOW);
  s = r.state;
  return r.result;
};
const comteLine = () => s.shoppingItems.find((l) => l.productId === P.comte)!;

beforeEach(() => {
  s = fixtureState();
  run(op("planning.commit", fixtureProposal()));
});

describe("undo", () => {
  it("restores a buy: the line is unbought, the Reste item and its reservations disappear", () => {
    const buy = op("shopping.buy", { itemId: comteLine().id });
    run(buy);
    expect(run(op("undo", { targetOpId: buy.opId })).status).toBe("applied");
    expect(comteLine().boughtAt).toBeNull();
    expect(s.stockItems).toEqual([]);
    expect(s.reservations).toEqual([]);
    expect(s.appliedOps[buy.opId]!.undoneBy).not.toBeNull();
  });

  it("refuses once a row the op changed has changed since", () => {
    const buy = op("shopping.buy", { itemId: comteLine().id });
    run(buy);
    run(op("meal.cook", { mealId: 1, sheet: {} })); // releases a reservation created by the buy
    expect(run(op("undo", { targetOpId: buy.opId }))).toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
  });

  it("refuses unknown targets, a second undo, and undoing a planning", () => {
    expect(run(op("undo", { targetOpId: "nope" })).reason).toBe("action introuvable");
    const add = op("envie.add", { text: "soupe", url: null });
    run(add);
    run(op("undo", { targetOpId: add.opId }));
    expect(run(op("undo", { targetOpId: add.opId })).reason).toBe("déjà annulée");
    const commitId = Object.values(s.appliedOps).find((r) => r.type === "planning.commit")!.opId;
    expect(run(op("undo", { targetOpId: commitId })).reason).toBe("cette action ne s'annule pas");
  });
});

describe("undo guards against later rows", () => {
  // Regression: 106a490 — undoing a stock.add deleted an item a later planning had reserved (dangling reservation, D1 FK error)
  it("refuses to undo a stock.add once a later planning reserved the item", () => {
    const add = op("stock.add", { label: "comté", productId: P.comte, qtyText: "un bon bout", useBy: null });
    run(add);
    run(op("planning.commit", secondProposal()));
    const item = s.stockItems.find((i) => i.productId === P.comte)!;
    expect(s.reservations.some((r) => r.stockItemId === item.id && r.releasedAt === null)).toBe(true);
    expect(run(op("undo", { targetOpId: add.opId }))).toEqual({ status: "refused", reason: "utilisé depuis : impossible d'annuler" });
    expect(s.stockItems.find((i) => i.id === item.id)).toBeDefined();
  });

  /** A comté of unknown quantity, reserved by the first planning for one meal: a cook frees it whole, and leaves the item's row alone. */
  const unknownComte = () => {
    s = fixtureState();
    run(op("stock.add", { label: "comté", productId: P.comte, qtyText: "un bout", useBy: null }));
    run(op("planning.commit", fixtureProposal()));
    const item = s.stockItems[0]!;
    return { item, mealId: s.reservations.find((r) => r.stockItemId === item.id && r.releasedAt === null)!.mealId };
  };

  // Regression: 106a490 — undoing a cook put back a reservation a later planning had already handed to another meal (an item of unknown quantity reserved twice)
  it("refuses to undo a cook when a later planning took the quantity it freed", () => {
    const { item, mealId } = unknownComte();
    const cook = op("meal.cook", { mealId, sheet: {} });
    run(cook);
    expect(run(op("planning.commit", secondProposal())).status).toBe("applied");
    expect(s.reservations.filter((r) => r.stockItemId === item.id && r.releasedAt === null).map((r) => r.mealId)).not.toContain(mealId);
    expect(run(op("undo", { targetOpId: cook.opId }))).toEqual({ status: "refused", reason: "réservé depuis pour un autre repas : impossible d'annuler" });
    expect(s.reservations.filter((r) => r.stockItemId === item.id && r.releasedAt === null)).toHaveLength(1);
  });

  it("undoes a cook after a later planning took stock that was libre: the eaten quantity comes back with the reservation", () => {
    run(op("shopping.buy", { itemId: comteLine().id }));
    run(op("meal.drop", { mealId: 2 })); // the salade's 100 g become libre
    const cook = op("meal.cook", { mealId: 1, sheet: {} });
    run(cook);
    expect(run(op("planning.commit", secondProposal())).status).toBe("applied");
    const item = () => s.stockItems.find((i) => i.productId === P.comte)!;
    const held = () => s.reservations.filter((r) => r.stockItemId === item().id && r.releasedAt === null).map((r) => [r.mealId, r.qty]);
    expect({ qty: item().qty, held: held() }).toEqual({ qty: 100, held: [[4, 100]] });
    expect(run(op("undo", { targetOpId: cook.opId })).status).toBe("applied");
    expect({ qty: item().qty, held: held() }).toEqual({ qty: 200, held: [[1, 100], [4, 100]] });
  });

  // Regression: 106a490 — undoing a cook could put a live reservation back on an item finished since
  it("refuses to undo a cook when the item it would reserve again was finished since", () => {
    const { item, mealId } = unknownComte();
    const cook = op("meal.cook", { mealId, sheet: {} });
    run(cook);
    expect(run(op("stock.finish", { itemId: item.id })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: cook.opId }))).toEqual({ status: "refused", reason: "article fini depuis : impossible d'annuler" });
  });

  // Regression: ce2a0ef — undoing a rebuy after the meal was cooked left a live reservation for a cooked meal, never released
  it("refuses to undo a stock.finish when a reservation it would put back belongs to a meal cooked since", () => {
    run(op("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.poireau)!.id }));
    const finish = op("stock.finish", { itemId: s.stockItems.find((i) => i.productId === P.poireau)!.id, resolution: "rebuy" });
    expect(run(finish).status).toBe("applied");
    run(op("meal.cook", { mealId: 1, sheet: {} }));
    expect(run(op("undo", { targetOpId: finish.opId }))).toEqual({ status: "refused", reason: "repas cuisiné ou retiré depuis : impossible d'annuler" });
    expect(s.reservations.filter((r) => r.releasedAt === null && r.mealId === 1)).toEqual([]);
  });

  // Regression: 408b6c3 — un-buying a line attached to a recorded trip was refused only by accident of the row guard
  it("refuses to un-buy a line already attached to a recorded trip", () => {
    const buy = op("shopping.buy", { itemId: comteLine().id });
    run(buy);
    run(op("trip.record", { place: "marche", totalCents: 1840, date: "2026-10-12", itemIds: [comteLine().id] }));
    expect(run(op("undo", { targetOpId: buy.opId }))).toEqual({ status: "refused", reason: "déjà passé en caisse" });
    expect(comteLine().boughtAt).toBe(NOW);
  });

  // Regression: f6a1f81 — an older trip.record was refused its undo once a later trip existed, on a reason made false once each trip listed its own lines
  it("undoes an older trip after a later one: its lines go back to the basket and join no other trip", () => {
    const lineIds = s.shoppingItems.filter((l) => l.kind === "planning").slice(0, 3).map((l) => l.id);
    expect(lineIds).toHaveLength(3);
    run(op("shopping.buy", { itemId: lineIds[0] }));
    const t1 = op("trip.record", { place: "marche", totalCents: 1000, date: "2026-10-12", itemIds: [lineIds[0]] });
    run(t1);
    run(op("shopping.buy", { itemId: lineIds[1] }));
    const t2 = op("trip.record", { place: "marche", totalCents: 2000, date: "2026-10-13", itemIds: [lineIds[1]] });
    run(t2);
    expect(run(op("undo", { targetOpId: t1.opId })).status).toBe("applied");
    const line = (id: number) => s.shoppingItems.find((l) => l.id === id)!;
    expect(line(lineIds[0]!)).toMatchObject({ boughtAt: NOW, tripId: null });
    expect(line(lineIds[1]!).tripId).toBe(s.trips[0]!.id);
    run(op("shopping.buy", { itemId: lineIds[2] }));
    run(op("trip.record", { place: "marche", totalCents: 500, date: "2026-10-14", itemIds: [lineIds[2]] }));
    const t3Id = s.trips.at(-1)!.id;
    expect(s.shoppingItems.filter((l) => l.tripId === t3Id).map((l) => l.id)).toEqual([lineIds[2]]);
    expect(line(lineIds[0]!).tripId).toBeNull();
    expect(s.trips.map((t) => t.totalCents)).toEqual([2000, 500]);
  });
});

describe("ids after an undo", () => {
  // Regression: ac71541 — an undone trip freed its id, so the next trip took it and a trip.set_total queued for the undone trip landed on the new one
  it("never gives an undone trip's id to a later trip, so a total queued for it is refused", () => {
    run(op("shopping.buy", { itemId: comteLine().id }));
    const first = op("trip.record", { place: "marche", totalCents: null, date: "2026-10-12", itemIds: [comteLine().id] });
    run(first);
    const undoneId = s.trips[0]!.id;
    expect(run(op("undo", { targetOpId: first.opId })).status).toBe("applied");
    expect(s.trips).toEqual([]);
    run(op("trip.record", { place: "supermarche", totalCents: null, date: "2026-10-12", itemIds: [comteLine().id] }));
    expect(s.trips.map((t) => t.id)).toEqual([undoneId + 1]);
    expect(run(op("trip.set_total", { tripId: undoneId, totalCents: 4250 }))).toEqual({ status: "refused", reason: "passage en caisse introuvable" });
    expect(s.trips[0]!.totalCents).toBeNull();
  });

  it("never reuses the id of any undone row (an ajout here)", () => {
    const add = op("shopping.add", { label: "pain", isFood: true });
    run(add);
    const undoneId = s.shoppingItems.find((l) => l.label === "pain")!.id;
    run(op("undo", { targetOpId: add.opId }));
    run(op("shopping.add", { label: "lait", isFood: true }));
    expect(s.shoppingItems.find((l) => l.label === "lait")!.id).toBe(undoneId + 1);
    expect(run(op("shopping.buy", { itemId: undoneId }))).toEqual({ status: "refused", reason: "article introuvable" });
  });
});

describe("undo of meal.cook (§6.3 uncook)", () => {
  it("uncooks the first round of a doubled pair: meal open, recipe status back, reservations live, plat cuisiné gone", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.poulet, portions: 2, doubled: true }];
    p.prices = [...(p.prices as unknown[]), { product: "filet de poulet", unit: "g", est_price_cents: 900 }];
    run(op("planning.commit", p));
    run(op("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.poulet)!.id }));
    const first = s.meals.find((m) => m.recipeId === R.poulet && m.doubledFrom === null)!;
    const before = structuredClone(s);
    const cook = op("meal.cook", { mealId: first.id, sheet: { verdict: "a_refaire", note: "parfait" } });
    run(cook);
    expect(s.stockItems.some((i) => i.origin === "plat_cuisine")).toBe(true);
    expect(s.recipes.find((r) => r.id === R.poulet)!.status).toBe("favourite");

    expect(run(op("undo", { targetOpId: cook.opId })).status).toBe("applied");
    expect(s.meals).toEqual(before.meals);
    expect(s.recipes).toEqual(before.recipes);
    expect(s.stockItems).toEqual(before.stockItems);
    expect(s.reservations).toEqual(before.reservations);
  });

  // Regression: e0aeb79 — undoing a cook after the meal's line was bought reopened it with nothing reserved and nothing on Courses
  it("refuses to uncook a meal whose line was bought while it was cooked", () => {
    const creme = s.shoppingItems.find((l) => l.productId === P.creme)!;
    expect(creme.forMeals).toEqual([{ mealId: 1, qty: 100 }]);
    const cook = op("meal.cook", { mealId: 1, sheet: {} });
    run(cook);
    expect(run(op("shopping.buy", { itemId: creme.id })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: cook.opId }))).toEqual({ status: "refused", reason: "acheté depuis : impossible d'annuler" });
    expect(s.meals.find((m) => m.id === 1)!.cookedAt).toBe(NOW);
  });

  // Regression: e0aeb79 — undoing a first round's cook after its second round was dropped put back its 2× share on Courses
  it("refuses to uncook a first round whose second round was dropped since", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = (p.meals as { recipe: number }[]).map((m, i) => (i === 2 ? { ...m, doubled: true } : m));
    run(op("planning.commit", p));
    const saumon = () => s.shoppingItems.find((l) => l.productId === P.saumon)!;
    expect(saumon().qty).toBe(500);
    const cookFirst = op("meal.cook", { mealId: 3, sheet: {} });
    run(cookFirst);
    // cooking the second round first is refused since the second-round fix, so the drop now releases the plat cuisiné the
    // cook made, and the row check refuses before the over-coverage guard is reached
    expect(run(op("meal.drop", { mealId: 4 })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: cookFirst.opId }))).toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
    expect(saumon().qty).toBe(500);
    expect(s.meals.find((m) => m.id === 3)!.cookedAt).toBe(NOW);
  });

  it("still uncooks a meal when nothing it relies on changed since", () => {
    const cook = op("meal.cook", { mealId: 1, sheet: {} });
    run(cook);
    expect(run(op("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.saumon)!.id })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: cook.opId })).status).toBe("applied");
  });
});

describe("undo reopening a second round", () => {
  const doubled = () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = (p.meals as { recipe: number }[]).map((m, i) => (i === 2 ? { ...m, doubled: true } : m));
    run(op("planning.commit", p));
  };
  const saumon = () => s.shoppingItems.find((l) => l.productId === P.saumon)!;

  // Regression: 8057e97 — undoing a second round's drop after its first round was cooked reopened it with no plat cuisiné and put the first round's 2× shares back on Courses
  it("refuses to reopen a second round whose first round was cooked since", () => {
    doubled();
    const drop = op("meal.drop", { mealId: 4 });
    expect(run(drop).status).toBe("applied");
    expect(saumon()).toMatchObject({ qty: 250, forMeals: [{ mealId: 3, qty: 250 }] });
    expect(run(op("meal.cook", { mealId: 3, sheet: {} })).status).toBe("applied");
    expect(s.stockItems.some((i) => i.origin === "plat_cuisine")).toBe(false);
    expect(run(op("undo", { targetOpId: drop.opId }))).toEqual({ status: "refused", reason: "repas cuisiné ou retiré depuis : impossible d'annuler" });
    expect(s.meals.find((m) => m.id === 4)!.droppedAt).toBe(NOW);
    expect(saumon()).toMatchObject({ qty: 250, forMeals: [{ mealId: 3, qty: 250 }] });
  });

  // Regression: 8057e97 — the same hole through meal.cook: uncooking a second round after its first round was cooked reopened it with no plat cuisiné
  it("refuses to uncook a first round once its second round is cooked", () => {
    doubled();
    const cookFirst = op("meal.cook", { mealId: 3, sheet: {} });
    run(cookFirst);
    expect(run(op("meal.cook", { mealId: 4, sheet: {} })).status).toBe("applied");
    // the second round can no longer be cooked first, so the hole is now the reverse order; its cook released the plat
    // cuisiné, so the row check refuses (the second_round_cooked_first invariant backs it)
    expect(run(op("undo", { targetOpId: cookFirst.opId }))).toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
    expect(s.meals.find((m) => m.id === 3)!.cookedAt).toBe(NOW);
  });

  it("refuses to put shares back on Courses for a first round closed since, even when the second round holds a plat", () => {
    doubled();
    const drop = op("meal.drop", { mealId: 4 });
    run(drop);
    run(op("meal.cook", { mealId: 3, sheet: {} }));
    // a plat cuisiné held by meal 4 cannot arise through ops here; it isolates the first round's share check
    s.stockItems.push({ id: 99, productId: null, label: "saumon", qty: null, unit: null, qtyText: null, isLow: false, useBy: null,
      openedAt: null, finishedAt: null, origin: "plat_cuisine", sourceShoppingItemId: null, sourceMealId: 3, createdAt: NOW });
    s.reservations.push({ id: 99, stockItemId: 99, mealId: 4, qty: null, unit: null, releasedAt: null, createdAt: NOW });
    expect(run(op("undo", { targetOpId: drop.opId }))).toEqual({ status: "refused", reason: "repas cuisiné ou retiré depuis : impossible d'annuler" });
    expect(saumon().qty).toBe(250);
  });

  it("reopens a second round dropped after its first round was cooked: the plat cuisiné holds it again", () => {
    doubled();
    run(op("meal.cook", { mealId: 3, sheet: {} }));
    const drop = op("meal.drop", { mealId: 4 });
    run(drop);
    expect(run(op("undo", { targetOpId: drop.opId })).status).toBe("applied");
    const plat = s.stockItems.find((i) => i.origin === "plat_cuisine")!;
    expect(s.reservations.filter((r) => r.mealId === 4 && r.releasedAt === null).map((r) => r.stockItemId)).toEqual([plat.id]);
  });

  it("reopens a second round while its first round is still open, its 2× shares back", () => {
    doubled();
    const drop = op("meal.drop", { mealId: 4 });
    run(drop);
    expect(run(op("undo", { targetOpId: drop.opId })).status).toBe("applied");
    expect(saumon()).toMatchObject({ qty: 500, forMeals: [{ mealId: 3, qty: 500 }] });
  });
});

describe("undo against a meal dropped since", () => {
  // Regression: 4e7332a — un-buying a staple line after one of its meals was dropped put that meal's share back on Courses
  it("refuses to un-buy a staple line whose meal was dropped since", () => {
    const lentilles = () => s.shoppingItems.find((l) => l.productId === P.lentilles)!;
    expect(lentilles().kind).toBe("staple_hors_budget");
    const share = lentilles().forMeals.find((f) => f.mealId === 2);
    expect(share).toBeDefined();
    const buy = op("shopping.buy", { itemId: lentilles().id });
    run(buy);
    expect(s.reservations).toEqual([]); // a staple line reserves nothing, so the row guard has nothing to see
    expect(run(op("meal.drop", { mealId: 2 })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: buy.opId }))).toEqual({ status: "refused", reason: "repas cuisiné ou retiré depuis : impossible d'annuler" });
    expect(lentilles().boughtAt).toBe(NOW);
  });
});

describe("undo and violations it did not cause", () => {
  it("still undoes when the state already broke an invariant the undo leaves alone", () => {
    const comte = comteLine();
    comte.forMeals = comte.forMeals.map((f) => (f.mealId === 1 ? { ...f, qty: f.qty - 10 } : f)); // meal 1 short, by hand
    const add = op("envie.add", { text: "soupe", url: null });
    run(add);
    expect(run(op("undo", { targetOpId: add.opId })).status).toBe("applied");
  });

  // Regression: ebcb1f8 — undoing a staple purchase made before a second round was dropped alone put back its first
  // round's 2× share: Courses asked for 400 g of lentilles (1,50 €) where meal 3 needed 150 g (line 250 g, 0,94 €)
  it("refuses to put back a staple share its first round no longer needs, once its second round was dropped alone", () => {
    s = fixtureState();
    run(op("planning.commit", doubledFixtureProposal()));
    const lentilles = () => s.shoppingItems.find((l) => l.productId === P.lentilles)!;
    expect(lentilles()).toMatchObject({ kind: "staple_hors_budget", qty: 400, forMeals: [{ mealId: 2, qty: 100 }, { mealId: 3, qty: 300 }] });
    const buy = op("shopping.buy", { itemId: lentilles().id });
    run(buy);
    expect(run(op("meal.drop", { mealId: 4 })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: buy.opId }))).toEqual({ status: "refused", reason: "repas doublé retiré depuis : impossible d'annuler" });
    expect(lentilles().boughtAt).not.toBeNull();
  });

  // Regression: 9020707 — the staple bound covered open meals only, so cooking the first round after its
  // second round was dropped let the same undo put the 2× share back: 400 g of lentilles (1,50 €) on Courses again
  it("refuses it too once that first round was cooked at 1×, after its second round was dropped", () => {
    s = fixtureState();
    run(op("planning.commit", doubledFixtureProposal()));
    const lentilles = () => s.shoppingItems.find((l) => l.productId === P.lentilles)!;
    const buy = op("shopping.buy", { itemId: lentilles().id });
    run(buy);
    expect(run(op("meal.drop", { mealId: 4 })).status).toBe("applied");
    expect(run(op("meal.cook", { mealId: 3 })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: buy.opId }))).toEqual({ status: "refused", reason: "repas doublé retiré depuis : impossible d'annuler" });
    expect(lentilles().boughtAt).not.toBeNull();
  });

  it("still undoes it when the first round was cooked at 2× before its second round was dropped: that share was eaten", () => {
    s = fixtureState();
    run(op("planning.commit", doubledFixtureProposal()));
    const lentilles = () => s.shoppingItems.find((l) => l.productId === P.lentilles)!;
    const buy = op("shopping.buy", { itemId: lentilles().id });
    run(buy);
    expect(run(op("meal.cook", { mealId: 3 })).status).toBe("applied");
    expect(run(op("meal.drop", { mealId: 4 })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: buy.opId })).status).toBe("applied");
    expect(lentilles()).toMatchObject({ boughtAt: null, qty: 400, forMeals: [{ mealId: 2, qty: 100 }, { mealId: 3, qty: 300 }] });
  });
});

describe("undo of a declared leftover", () => {
  const comteItem = () => s.stockItems.find((i) => i.productId === P.comte)!;
  beforeEach(() => {
    run(op("shopping.buy", { itemId: comteLine().id })); // 200 g, held 100 g each by the gratin and the salade
  });

  it("puts back the quantity a cook's « Il en reste » set, and the reservation it released", () => {
    run(op("meal.cook", { mealId: 1, sheet: {} }));
    const cook = op("meal.cook", { mealId: 2, sheet: { items: [{ stockItemId: comteItem().id, outcome: "il_en_reste", qtyText: "125g" }] } });
    run(cook);
    expect(comteItem()).toMatchObject({ qty: 125, qtyText: null });
    expect(run(op("undo", { targetOpId: cook.opId })).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: 100, qtyText: null, openedAt: null });
    expect(s.reservations.filter((r) => r.stockItemId === comteItem().id && r.releasedAt === null).map((r) => r.mealId)).toEqual([2]);
  });

  it("puts back the quantity a stock.partial set", () => {
    run(op("meal.cook", { mealId: 1, sheet: {} })); // 100 g left, held by the salade
    const partial = op("stock.partial", { itemId: comteItem().id, qtyText: "un fond", low: false });
    run(partial);
    expect(comteItem()).toMatchObject({ qty: null, qtyText: "un fond" }); // one meal holds it: unknown is allowed
    expect(run(op("undo", { targetOpId: partial.opId })).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: 100, qtyText: null });
  });

  // Regression: 309f2ec — a declared amount below the meals' holds now trims them; its undo must give them back
  it("puts back the holds a declared leftover trimmed, so the meals it left short are covered again", () => {
    const partial = op("stock.partial", { itemId: comteItem().id, qtyText: "50 g", low: false });
    run(partial);
    const live = () => s.reservations.filter((r) => r.stockItemId === comteItem().id && r.releasedAt === null).map((r) => [r.mealId, r.qty]);
    expect(live()).toEqual([[1, 50]]); // the salade, planned later in the same planning, released first
    expect(mealShortfalls(s)).toEqual([{ mealId: 1, productId: P.comte, unit: "g", qty: 50 }, { mealId: 2, productId: P.comte, unit: "g", qty: 100 }]);
    expect(run(op("undo", { targetOpId: partial.opId })).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: 200, qtyText: null });
    expect(live()).toEqual([[1, 100], [2, 100]]);
    expect(mealShortfalls(s)).toEqual([]);
  });

  it("uncooks a meal a declared leftover left short, as short as it was", () => {
    run(op("stock.partial", { itemId: comteItem().id, qtyText: "50 g", low: false }));
    const cook = op("meal.cook", { mealId: 1, sheet: {} });
    run(cook);
    expect(run(op("undo", { targetOpId: cook.opId })).status).toBe("applied");
    expect(s.meals.find((m) => m.id === 1)!.cookedAt).toBeNull();
    expect(mealShortfalls(s).filter((x) => x.mealId === 1)).toEqual([{ mealId: 1, productId: P.comte, unit: "g", qty: 50 }]);
  });

  it("refuses to undo a stock.partial whose raised quantity a later planning reserved", () => {
    const partial = op("stock.partial", { itemId: comteItem().id, qtyText: "300 g", low: false });
    run(partial);
    expect(comteItem().qty).toBe(300);
    run(op("planning.commit", secondProposal())); // the saumon gratiné takes the 100 g libre
    expect(s.reservations.filter((r) => r.stockItemId === comteItem().id && r.releasedAt === null).map((r) => r.qty)).toEqual([100, 100, 100]);
    expect(run(op("undo", { targetOpId: partial.opId }))).toEqual({ status: "refused", reason: "réservé depuis pour un autre repas : impossible d'annuler" });
    expect(comteItem().qty).toBe(300);
  });
});

describe("undo of shopping.remove, and of a cook around one", () => {
  const EARLIER = "2026-10-12T09:00:00.000Z";
  const LATER = "2026-10-12T11:00:00.000Z";
  const comteItem = () => s.stockItems.find((i) => i.productId === P.comte);

  it("puts a line removed « On n'en prend pas » back on Courses, its meals covered again", () => {
    const before = structuredClone(s.shoppingItems);
    const remove = op("shopping.remove", { itemId: comteLine().id, reason: "pas_achete" });
    run(remove);
    expect(mealShortfalls(s).map((x) => x.mealId)).toEqual([1, 2]);
    expect(run(op("undo", { targetOpId: remove.opId })).status).toBe("applied");
    expect(s.shoppingItems).toEqual(before);
    expect(mealShortfalls(s)).toEqual([]);
  });

  it("puts a line removed « On en a déjà » back on Courses and takes its Reste item and reservations away", () => {
    const before = structuredClone(s.shoppingItems);
    const remove = op("shopping.remove", { itemId: comteLine().id, reason: "a_la_maison" });
    run(remove);
    expect(comteItem()).toBeDefined();
    expect(run(op("undo", { targetOpId: remove.opId })).status).toBe("applied");
    expect(s.shoppingItems).toEqual(before);
    expect(s.stockItems).toEqual([]);
    expect(s.reservations).toEqual([]);
  });

  it("refuses to undo a removal once a meal whose share it would put back is cooked or dropped, and undoes it while they are open", () => {
    // Regression: 0c031ad — undoing « On n'en prend pas » after a cook put the cooked meal's share back on Courses
    const remove = op("shopping.remove", { itemId: comteLine().id, reason: "pas_achete" });
    run(remove);
    run(op("meal.cook", { mealId: 1, sheet: {} }));
    expect(run(op("undo", { targetOpId: remove.opId }))).toEqual({ status: "refused", reason: "repas cuisiné ou retiré depuis : impossible d'annuler" });
    expect(comteLine().removedAt).toBe(NOW);

    s = fixtureState();
    run(op("planning.commit", fixtureProposal()));
    const removeThenDrop = op("shopping.remove", { itemId: comteLine().id, reason: "pas_achete" });
    run(removeThenDrop);
    run(op("meal.drop", { mealId: 2 }));
    expect(run(op("undo", { targetOpId: removeThenDrop.opId }))).toEqual({ status: "refused", reason: "repas cuisiné ou retiré depuis : impossible d'annuler" });

    s = fixtureState();
    run(op("planning.commit", fixtureProposal()));
    const removeAlone = op("shopping.remove", { itemId: comteLine().id, reason: "a_la_maison" });
    run(removeAlone);
    expect(run(op("undo", { targetOpId: removeAlone.opId })).status).toBe("applied");
    expect(comteLine().removedAt).toBeNull();
  });

  it("refuses to undo « On en a déjà » once a cook took from its item", () => {
    const remove = op("shopping.remove", { itemId: comteLine().id, reason: "a_la_maison" });
    run(remove);
    run(op("meal.cook", { mealId: 1, sheet: {} }));
    expect(comteItem()!.qty).toBe(100);
    expect(run(op("undo", { targetOpId: remove.opId }))).toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
    expect(comteLine().removedAt).toBe(NOW);
  });

  it("refuses to uncook a meal whose line was removed since, either way, in its own words, whatever the phones' clocks say", () => {
    // Regression: f3764c2 — removedAt >= cookedAt let a removal stamped by a slow clock reopen a meal shorter than it closed
    for (const reason of ["pas_achete", "a_la_maison"]) {
      s = fixtureState();
      run(op("planning.commit", fixtureProposal()));
      const cook = op("meal.cook", { mealId: 1, sheet: {} });
      run(cook);
      // the removal lands after the cook, stamped before it: only the row tells
      expect(run(op("shopping.remove", { itemId: comteLine().id, reason }, EARLIER)).status).toBe("applied");
      expect(comteLine().forMeals, reason).toEqual([{ mealId: 1, qty: 100 }]);
      expect(run(op("undo", { targetOpId: cook.opId })), reason).toEqual({ status: "refused", reason: "retiré des courses depuis : impossible d'annuler" });
      expect(s.meals.find((m) => m.id === 1)!.cookedAt).toBe(NOW);
    }
  });

  it("counts a removal at the cook's own time as since: the meal never reopens shorter than it closed", () => {
    const cook = op("meal.cook", { mealId: 1, sheet: {} });
    run(cook);
    run(op("shopping.remove", { itemId: comteLine().id, reason: "pas_achete" }));
    expect(run(op("undo", { targetOpId: cook.opId }))).toEqual({ status: "refused", reason: "retiré des courses depuis : impossible d'annuler" });
  });

  // Regression: 91d4533 — a staple line removed « On n'en prend pas » after a cook refused the uncook « retiré des courses depuis », though a staple share never leaves a meal short (185930c had made it refuse)
  // Regression: be5d537 — the removal kept the cooked meal's share on the staple line, so the uncook left an open meal's share there, a state no fold of the ops in effect gives (the removal alone strips it)
  it("uncooks a meal whose staple line was removed since: a staple share never leaves a meal short, and the line ends as the removal alone leaves it", () => {
    const lentilles = () => s.shoppingItems.find((l) => l.productId === P.lentilles)!;
    expect(lentilles().kind).toBe("staple_hors_budget");
    const alone = structuredClone(s);
    const cook = op("meal.cook", { mealId: 2, sheet: {} });
    expect(run(cook).status).toBe("applied");
    const remove = op("shopping.remove", { itemId: lentilles().id, reason: "pas_achete" });
    expect(run(remove).status).toBe("applied");
    expect(lentilles().forMeals).toEqual([]);
    expect(run(op("undo", { targetOpId: cook.opId }))).toEqual({ status: "applied", reason: null });
    expect(s.meals.find((m) => m.id === 2)!.cookedAt).toBeNull();
    expect(invariantViolations(s).filter((v) => v.code !== "meal_under_covered")).toEqual([]);
    const removedAlone = applyOp(alone, remove, NOW).state.shoppingItems.find((l) => l.productId === P.lentilles)!;
    expect(lentilles()).toEqual(removedAlone);
  });

  // Regression: 241a269 — undoing a staple line's removal after a meal it served was cooked was refused « repas cuisiné ou retiré depuis », though a staple share never leaves a meal short (a removed staple line keeps no share since be5d537, so no uncook reopens one on it)
  it("undoes a staple line's removal after a meal it served was cooked: its share comes back on Courses", () => {
    const lentilles = () => s.shoppingItems.find((l) => l.productId === P.lentilles)!;
    const before = structuredClone(lentilles());
    expect(before.forMeals.map((f) => f.mealId)).toContain(2);
    const remove = op("shopping.remove", { itemId: before.id, reason: "pas_achete" });
    expect(run(remove).status).toBe("applied");
    expect(run(op("meal.cook", { mealId: 2, sheet: {} })).status).toBe("applied");
    expect(run(op("undo", { targetOpId: remove.opId }))).toEqual({ status: "applied", reason: null });
    expect(lentilles()).toEqual(before);
    expect(invariantViolations(s)).toEqual([]);
    // a dropped meal holds no share on Courses (dropped_meal_share): that undo stays refused
    s = fixtureState();
    run(op("planning.commit", fixtureProposal()));
    const removeThenDrop = op("shopping.remove", { itemId: lentilles().id, reason: "pas_achete" });
    run(removeThenDrop);
    run(op("meal.drop", { mealId: 2 }));
    expect(run(op("undo", { targetOpId: removeThenDrop.opId }))).toEqual({ status: "refused", reason: "repas cuisiné ou retiré depuis : impossible d'annuler" });
  });

  it("uncooks a meal whose line was removed « On n'en prend pas » before the cook, stamped after it: it reopens as short as it closed", () => {
    // Regression: f3764c2 — a removal that landed first but was stamped after the cook refused the uncook
    run(op("shopping.remove", { itemId: comteLine().id, reason: "pas_achete" }, LATER));
    expect(comteLine().forMeals).toEqual([]);
    const cook = op("meal.cook", { mealId: 1, sheet: {} });
    run(cook);
    expect(run(op("undo", { targetOpId: cook.opId })).status).toBe("applied");
    expect(s.meals.find((m) => m.id === 1)!.cookedAt).toBeNull();
    expect(mealShortfalls(s).filter((x) => x.mealId === 1)).toEqual([{ mealId: 1, productId: P.comte, unit: "g", qty: 100 }]);
  });

  // Regression: 0baed55 — the undo of a meal.drop that merged a cooked meal's share into another line's spare, its emptied line removed, was refused as if the line had left Courses by shopping.remove
  it("undoes a drop that moved a cooked meal's share into another line's spare: only a removal's undo reads a removed line's shares", () => {
    s = fixtureState();
    Object.assign(s.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 420, qty: 250, unit: "g" } });
    run(op("planning.commit", fixtureProposal())); // line A: 250 g for meals 1 and 2 (100 g each), 50 g spare
    run(op("planning.commit", secondProposal())); // meal M: 50 g of A's spare, line B 250 g for its other 50 g
    const [a, b] = s.shoppingItems.filter((l) => l.productId === P.comte).map((l) => l.id);
    const line = (id: number) => s.shoppingItems.find((l) => l.id === id)!;
    expect(run(op("meal.cook", { mealId: 1, sheet: {} })).status).toBe("applied");
    const before = structuredClone(s.shoppingItems);
    const drop = op("meal.drop", { mealId: 2 });
    expect(run(drop).status).toBe("applied");
    // A kept meal 1 (cooked) and M: 150 g fit in B's 200 g spare, so A handed them over and left Courses
    expect(line(a!)).toMatchObject({ forMeals: [], removedAt: NOW });
    expect(line(b!).forMeals.map((f) => f.mealId).sort()).toEqual([1, s.meals.at(-1)!.id]);
    expect(run(op("undo", { targetOpId: drop.opId })).status).toBe("applied");
    expect(s.shoppingItems).toEqual(before);
    expect(s.meals.find((m) => m.id === 2)!.droppedAt).toBeNull();
  });

  it("uncooks a meal whose line was removed « On en a déjà » before the cook, stamped after it: its reservation comes back", () => {
    run(op("shopping.remove", { itemId: comteLine().id, reason: "a_la_maison" }, LATER));
    const cook = op("meal.cook", { mealId: 1, sheet: {} });
    run(cook);
    expect(run(op("undo", { targetOpId: cook.opId })).status).toBe("applied");
    expect(mealShortfalls(s)).toEqual([]);
  });
});
