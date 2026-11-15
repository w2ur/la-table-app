import { beforeEach, describe, expect, it } from "vitest";
import { applyOp } from "./apply";
import { libreQty } from "../quantities";
import { invariantViolations, mealShortfalls } from "../invariants";
import { snapshot } from "../snapshot";
import { NOW, P, R, fixtureProposal, fixtureState, op, secondProposal, sharedComteProposal } from "../test-fixtures";
import type { Product, State } from "../types";

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
});

describe("meal.cook", () => {
  it("releases this meal's reservations and keeps the other meal's (cheese story)", () => {
    expect(run("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comteItem().id, outcome: "il_en_reste", qtyText: "la moitié" }] } }).status).toBe("applied");
    const live = s.reservations.filter((r) => r.stockItemId === comteItem().id && r.releasedAt === null);
    expect(live.map((r) => [r.mealId, r.qty])).toEqual([[2, 100]]);
    expect(comteItem()).toMatchObject({ qtyText: "la moitié", openedAt: NOW, finishedAt: null, useBy: "2026-11-02" });
  });

  // Regression: 0deaa54 — a cook sheet's « fini » finished the comté while the salade still held 100 g of it, so the salade kept a reservation on stock that no longer existed and nothing was put back on the list
  it("treats « fini » on an item another open meal holds like stock.finish (cheese story through the cook sheet)", () => {
    const fini = (resolution?: string) => ({ mealId: 1, sheet: { items: [{ stockItemId: comteItem().id, outcome: "fini", ...(resolution ? { resolution } : {}) }] } });
    expect(run("meal.cook", fini())).toEqual({ status: "refused", reason: "comté : réservé pour Salade d'endives au comté" });
    expect(s.meals[0]!.cookedAt).toBeNull();

    expect(run("meal.cook", fini("rebuy")).status).toBe("applied");
    expect(comteItem().finishedAt).toBe(NOW);
    expect(s.reservations.filter((r) => r.stockItemId === comteItem().id && r.releasedAt === null)).toEqual([]);
    expect(s.shoppingItems.at(-1)).toMatchObject({ productId: P.comte, qty: 100, forMeals: [{ mealId: 2, qty: 100 }], boughtAt: null });
  });

  it("applies a pre-made « fini » (ifEmpty) only to an item the cook leaves at a known 0 that no other open meal holds", () => {
    const premade = (mealId: number) => ({ mealId, sheet: { items: [{ stockItemId: comteItem().id, outcome: "fini", ifEmpty: true }] } });
    // the salade still holds 100 g: no refusal, no warning, the item stays
    expect(run("meal.cook", premade(1)).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: 100, finishedAt: null });
    // raised since the sheet opened (a receipt correction): the cook leaves 50 g, so the item stays
    comteItem().qty = 150;
    expect(applyOp(s, op("meal.cook", premade(2)), NOW).state.stockItems.find((i) => i.id === comteItem().id)).toMatchObject({ qty: 50, finishedAt: null });
    // emptied: finished
    comteItem().qty = 100;
    expect(run("meal.cook", premade(2)).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: 0, finishedAt: NOW });
  });

  it("judges a pre-made « fini » after the tapped ones, whose resolution may free its item, whatever the sheet order", () => {
    // the comté down to what the gratin holds, the salade still holding it too; a jar both meals hold, which the gratin's
    // cook finishes with drop_meal: the salade is dropped and its hold on the comté released before the pre-made answer
    for (const order of ["premade-first", "tapped-first"]) {
      const before = structuredClone(s);
      comteItem().qty = 100;
      const jar = { ...comteItem(), id: 99, label: "bocal", productId: null, qty: null, unit: null, sourceShoppingItemId: null };
      s.stockItems.push(jar);
      for (const mealId of [1, 2]) s.reservations.push({ id: 900 + mealId, stockItemId: 99, mealId, qty: null, unit: null, releasedAt: null, createdAt: NOW });
      const premade = { stockItemId: comteItem().id, outcome: "fini", ifEmpty: true };
      const tapped = { stockItemId: 99, outcome: "fini", resolution: "drop_meal" };
      const items = order === "premade-first" ? [premade, tapped] : [tapped, premade];
      expect(run("meal.cook", { mealId: 1, sheet: { items } }).status).toBe("applied");
      expect(s.meals.find((m) => m.id === 2)!.droppedAt).toBe(NOW);
      expect(comteItem()).toMatchObject({ qty: 0, finishedAt: NOW });
      s = before;
    }
  });

  it("refuses ifEmpty on anything but a « fini », or other than true", () => {
    for (const bad of [{ outcome: "il_en_reste", ifEmpty: true }, { outcome: "fini", ifEmpty: false }]) {
      expect(run("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comteItem().id, ...bad }] } }).status).toBe("refused");
    }
  });

  it("drops the other meal when the cook sheet's « fini » carries drop_meal", () => {
    expect(run("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comteItem().id, outcome: "fini", resolution: "drop_meal" }] } }).status).toBe("applied");
    expect(s.meals.find((m) => m.id === 2)!.droppedAt).toBe(NOW);
    expect(s.reservations.filter((r) => r.releasedAt === null && r.stockItemId === comteItem().id)).toEqual([]);
  });

  it("stores verdict and note, and turns verdicts into recipe status", () => {
    run("meal.cook", { mealId: 1, sheet: { verdict: "a_refaire", note: "doubler la sauce" } });
    expect(s.meals[0]).toMatchObject({ cookedAt: NOW, verdict: "a_refaire", note: "doubler la sauce" });
    expect(s.recipes.find((r) => r.id === R.gratin)!.status).toBe("favourite");
    run("meal.cook", { mealId: 2, sheet: { verdict: "pas_pour_nous" } });
    expect(s.recipes.find((r) => r.id === R.salade)!.status).toBe("banned");
  });

  it("creates a plat cuisiné reserved for the second round of a doubled pair", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.poulet, portions: 2, doubled: true }];
    p.prices = [...(p.prices as unknown[]), { product: "filet de poulet", unit: "g", est_price_cents: 900 }];
    run("planning.commit", p);
    const [first, second] = s.meals.filter((m) => m.recipeId === R.poulet);
    run("meal.cook", { mealId: first!.id, sheet: {} });
    const plat = s.stockItems.find((i) => i.origin === "plat_cuisine")!;
    expect(plat).toMatchObject({ label: "Poulet aux poireaux", useBy: "2026-10-15", sourceMealId: first!.id });
    expect(s.reservations.find((r) => r.stockItemId === plat.id)).toMatchObject({ mealId: second!.id, qty: null });
  });

  // Regression: 7e6ea76 — a second round could be cooked while its first round was still open, eating leftovers of a dish not yet made
  it("refuses to cook a second round before its first round, and cooks it once the first round is cooked", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = (p.meals as { recipe: number }[]).map((m, i) => (i === 2 ? { ...m, doubled: true } : m));
    run("planning.commit", p);
    const before = structuredClone(s.meals);
    expect(run("meal.cook", { mealId: 4, sheet: {} })).toEqual({ status: "refused", reason: "cuisinez d'abord le premier tour" });
    expect(s.meals).toEqual(before);
    expect(run("meal.cook", { mealId: 3, sheet: {} }).status).toBe("applied");
    expect(run("meal.cook", { mealId: 4, sheet: {} }).status).toBe("applied");
  });

  // Regression: 8e9c785 — cooking released the meal's reservation but left the item's qty, so what the meal ate read as libre and a later planning reserved stock that no longer existed
  it("takes what the meal ate off the item, so a later planning cannot reserve it (cheese story)", () => {
    expect(run("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comteItem().id, outcome: "il_en_reste" }] } }).status).toBe("applied");
    expect(comteItem().qty).toBe(100);
    expect(libreQty(comteItem(), s.reservations)).toBe(0);
    expect(run("planning.commit", secondProposal()).status).toBe("applied");
    const held = s.reservations.filter((r) => r.stockItemId === comteItem().id && r.releasedAt === null);
    expect(held.map((r) => [r.mealId, r.qty])).toEqual([[2, 100]]);
    expect(s.shoppingItems.find((l) => l.planningId === 2 && l.productId === P.comte)).toMatchObject({ qty: 100, boughtAt: null });
  });

  it("leaves an item of unknown quantity and the plat cuisiné's quantity alone", () => {
    s = fixtureState();
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "un bout", useBy: null });
    run("planning.commit", fixtureProposal());
    const item = s.stockItems[0]!;
    const meal = s.reservations.find((r) => r.stockItemId === item.id && r.releasedAt === null)!.mealId;
    expect(run("meal.cook", { mealId: meal, sheet: {} }).status).toBe("applied");
    expect(s.stockItems[0]).toMatchObject({ qty: null, unit: null, finishedAt: null });
  });

  it("is a no-op when already cooked and refused when dropped or missing", () => {
    run("meal.cook", { mealId: 1, sheet: {} });
    expect(run("meal.cook", { mealId: 1, sheet: {} }).status).toBe("noop");
    run("meal.drop", { mealId: 2 });
    expect(run("meal.cook", { mealId: 2, sheet: {} })).toEqual({ status: "refused", reason: "repas retiré du menu" });
    expect(run("meal.cook", { mealId: 99, sheet: {} })).toEqual({ status: "refused", reason: "repas introuvable" });
  });
});

describe("meal.drop", () => {
  it("releases reservations and removes this meal's share from unbought lines", () => {
    run("meal.drop", { mealId: 3 });
    expect(s.meals[2]!.droppedAt).toBe(NOW);
    expect(s.shoppingItems.find((l) => l.productId === P.saumon)!.removedAt).toBe(NOW);
    const poireau = s.shoppingItems.find((l) => l.productId === P.poireau)!;
    expect(poireau.qty).toBe(400 + 0); // gratin 400 remains, saumon's 300 removed
    expect(poireau.forMeals.map((f) => f.mealId)).toEqual([1]);
  });
});

describe("meal.drop keeps prices consistent", () => {
  // Regression: 082346e — dropping a meal cut a shared line's quantity but kept its full price (comté 100 g at 500 c)
  it("pro-rates each shared line's price, so the Courses total drops by the meal's cost", () => {
    s = fixtureState();
    run("planning.commit", fixtureProposal());
    expect(snapshot(s, NOW).courses.estimateCents).toBe(280 + 500 + 190 + 260 + 650);
    run("meal.drop", { mealId: 1 }); // the gratin: 400 g of the 700 g poireau line, 100 g of the 200 g comté line, all the crème
    const comte = s.shoppingItems.find((l) => l.productId === P.comte)!;
    const poireau = s.shoppingItems.find((l) => l.productId === P.poireau)!;
    expect([comte.qty, comte.estPriceCents]).toEqual([100, 250]);
    expect([poireau.qty, poireau.estPriceCents]).toEqual([300, 280 - Math.round((280 * 400) / 700)]);
    expect(snapshot(s, NOW).courses.estimateCents).toBe(250 + 120 + 260 + 650);
  });

  // Regression: 082346e — dropping only the second round of a doubled pair left the first round's lines at 2× quantity and price
  it("takes the 1× need off the first round's lines when only the second round is dropped", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.poulet, portions: 2, doubled: true }];
    p.prices = [...(p.prices as unknown[]), { product: "filet de poulet", unit: "g", est_price_cents: 900 }];
    run("planning.commit", p);
    const [first, second] = s.meals.filter((m) => m.recipeId === R.poulet);
    const poulet = () => s.shoppingItems.find((l) => l.productId === P.poulet)!;
    expect([poulet().qty, poulet().estPriceCents]).toEqual([600, 900]);
    run("meal.drop", { mealId: second!.id });
    expect(poulet()).toMatchObject({ qty: 300, estPriceCents: 450, forMeals: [{ mealId: first!.id, qty: 300 }], removedAt: null });
    expect(s.meals.find((m) => m.id === first!.id)!.droppedAt).toBeNull();
  });

  // Regression: 5894084 — dropping a second round alone after its first round's line was bought kept the 2× reservation, so the freed half read as 0 libre until the first round was cooked
  it("shrinks the first round's reservations to its 1× need when only the second round is dropped after buying", () => {
    s = fixtureState();
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.poulet, portions: 2, doubled: true }];
    p.prices = [...(p.prices as unknown[]), { product: "filet de poulet", unit: "g", est_price_cents: 900 }];
    run("planning.commit", p);
    const [first, second] = s.meals.filter((m) => m.recipeId === R.poulet);
    run("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.poulet)!.id });
    const poulet = s.stockItems.find((i) => i.productId === P.poulet)!;
    run("meal.drop", { mealId: second!.id });
    const live = s.reservations.filter((r) => r.stockItemId === poulet.id && r.releasedAt === null);
    expect(live.map((r) => [r.mealId, r.qty])).toEqual([[first!.id, 300]]);
    const reste = Object.values(snapshot(s, NOW).reste).flat();
    expect(reste.find((i) => i.id === poulet.id)!.libreQty).toBe(300);
  });

  // Regression: 8e6bae0 — dropping a second round alone took its first round's whole 1× need off every unbought line, so a first round carried by a planning line and a rebuy line lost the 1× need twice and was left with nothing on Courses
  it("takes the 1× need once across a first round's unbought lines when only the second round is dropped", () => {
    s = fixtureState();
    run("planning.commit", fixtureProposal());
    run("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.poireau)!.id });
    run("meal.drop", { mealId: 3 });
    const p = secondProposal();
    p.meals = [{ recipe: "s", portions: 2, doubled: true }];
    run("planning.commit", p);
    const [first, second] = s.meals.filter((m) => m.planningId === 2);
    const poireau = s.stockItems.find((i) => i.productId === P.poireau)!;
    expect(run("stock.finish", { itemId: poireau.id, resolution: "rebuy" }).status).toBe("applied");
    const open = () => s.shoppingItems.filter((l) => l.productId === P.poireau && l.boughtAt === null && l.removedAt === null && l.forMeals.some((f) => f.mealId === first!.id));
    expect(open()).toHaveLength(2);
    const costBefore = open().reduce((n, l) => n + l.estPriceCents!, 0);

    expect(run("meal.drop", { mealId: second!.id }).status).toBe("applied");
    const shares = open().flatMap((l) => l.forMeals).filter((f) => f.mealId === first!.id).reduce((n, f) => n + f.qty, 0);
    const reserved = s.reservations.filter((r) => r.mealId === first!.id && r.releasedAt === null && r.stockItemId === poireau.id);
    expect(shares + reserved.reduce((n, r) => n + r.qty!, 0)).toBe(300);
    const costAfter = open().reduce((n, l) => n + l.estPriceCents!, 0);
    expect(costBefore - costAfter).toBeLessThanOrEqual(costBefore / 2 + 1);
  });
});

describe("meal.drop with packs", () => {
  it("re-rounds the line to whole packs for the shares left, price pro rata", () => {
    let st = fixtureState();
    Object.assign(st.products.find((p) => p.id === P.comte)!, { pack: { qty: 150, unit: "g" }, price: { cents: 300, qty: 150, unit: "g" } });
    st = applyOp(st, op("planning.commit", fixtureProposal()), NOW).state; // comté 200 g needed → 300 g (2 packs) at 600 c
    const line = () => st.shoppingItems.find((l) => l.productId === P.comte)!;
    expect(line()).toMatchObject({ qty: 300, estPriceCents: 600 });
    st = applyOp(st, op("meal.drop", { mealId: 1 }), NOW).state; // 100 g left → 1 pack
    expect(line()).toMatchObject({ qty: 150, estPriceCents: 300, removedAt: null });
    st = applyOp(st, op("meal.drop", { mealId: 2 }), NOW).state;
    expect(line()).toMatchObject({ qty: 0, estPriceCents: 0, removedAt: NOW });
  });

  // Regression: e5694c2 — dropping the two meals of a first comté pack left a later meal's 50 g on it and 50 g on a second pack: 500 g bought for 100 g
  it("moves the shares left on a dropped line into another line's spare, so one pack holds them", () => {
    let st = fixtureState();
    Object.assign(st.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 420, qty: 250, unit: "g" } });
    st = applyOp(st, op("planning.commit", fixtureProposal()), NOW).state; // line A: 250 g for meals 1 and 2 (100 g each)
    st = applyOp(st, op("planning.commit", secondProposal()), NOW).state; // meal M: 50 g of A's spare, line B 250 g for its other 50 g
    const [a, b] = st.shoppingItems.filter((l) => l.productId === P.comte).map((l) => l.id);
    const m = st.meals.at(-1)!.id;
    const line = (id: number) => st.shoppingItems.find((l) => l.id === id)!;
    st = applyOp(st, op("meal.drop", { mealId: 1 }), NOW).state;
    st = applyOp(st, op("meal.drop", { mealId: 2 }), NOW).state;
    const kept = [line(a!), line(b!)].filter((l) => l.removedAt === null);
    expect(kept).toEqual([expect.objectContaining({ qty: 250, estPriceCents: 420, forMeals: [{ mealId: m, qty: 100 }] })]);
    expect([line(a!), line(b!)].filter((l) => l.removedAt !== null)).toEqual([expect.objectContaining({ qty: 0, estPriceCents: 0, forMeals: [], removedAt: NOW })]);
    expect(invariantViolations(st)).toEqual([]);
  });

  it("takes a meal's share off a line created before its product had a pack with the exact arithmetic", () => {
    let st = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state; // comté 200 g exact
    const line = () => st.shoppingItems.find((l) => l.productId === P.comte)!;
    const price = line().estPriceCents!;
    st.products.find((p) => p.id === P.comte)!.pack = { qty: 150, unit: "g" };
    st = applyOp(st, op("meal.drop", { mealId: 1 }), NOW).state; // 200 g is no whole number of 150 g packs: 100 g left, not a pack
    expect(line()).toMatchObject({ qty: 100, estPriceCents: price - Math.round((price * 100) / 200) });
  });

  // Regression: bac1ff6 — a line planned without a pack kept its quantity on a drop once the product got a pack that its quantity is no multiple of (300 g, shares 200 + 100, pack 500 g: dropping the 100 g share left 300 g)
  it("drops the share exactly from a line whose qty is no whole multiple of a pack set since", () => {
    let st = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    const line = () => st.shoppingItems.find((l) => l.productId === P.comte)!;
    Object.assign(line(), { qty: 300, estPriceCents: 600, forMeals: [{ mealId: 1, qty: 200 }, { mealId: 2, qty: 100 }] });
    st.products.find((p) => p.id === P.comte)!.pack = { qty: 500, unit: "g" };
    st = applyOp(st, op("meal.drop", { mealId: 2 }), NOW).state;
    expect(line()).toMatchObject({ qty: 200, estPriceCents: 400, forMeals: [{ mealId: 1, qty: 200 }] });
  });
});

describe("meal.cook « Il en reste »: the declared leftover sets the quantity", () => {
  const cookComte = (mealId: number, answer: Record<string, unknown>) =>
    run("meal.cook", { mealId, sheet: { items: [{ stockItemId: comteItem().id, outcome: "il_en_reste", ...answer }] } });
  const live = () => s.reservations.filter((r) => r.stockItemId === comteItem().id && r.releasedAt === null);

  // Regression: 38c46e6 — the ricotta story: the meal's need was taken off (to 0) and « 125g » was kept as text only, so Reste read 0 and planning rebought it
  it("takes the declared words as the quantity once the meal ate the rest, words gone", () => {
    cookComte(1, {});
    expect(cookComte(2, { qtyText: "125g" }).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: 125, unit: "g", qtyText: null, finishedAt: null });
    expect(libreQty(comteItem(), s.reservations)).toBe(125);
    expect(invariantViolations(s)).toEqual([]);
  });

  // Regression: 38c46e6 — the citron story: « Il en reste » with no words left the 0 the subtraction reached, a false « nothing left »
  it("makes the quantity unknown when nothing is declared and the meal ate it all", () => {
    cookComte(1, {});
    expect(cookComte(2, {}).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: null, finishedAt: null });
  });

  // Regression: 38c46e6 — words that are no quantity (« un fond ») left the 0 under them, so coverage read nothing left
  it("makes the quantity unknown and keeps the words when they are no quantity", () => {
    cookComte(1, {});
    expect(cookComte(2, { qtyText: "un fond" }).status).toBe("applied");
    expect(comteItem()).toMatchObject({ qty: null, qtyText: "un fond" });
  });

  it("keeps what the subtraction left when nothing is declared and something is left", () => {
    cookComte(1, {});
    expect(comteItem()).toMatchObject({ qty: 100, qtyText: null });
  });

  it("reads « 2 tranches » on an item in grams as no quantity", () => {
    cookComte(1, {});
    cookComte(2, { qtyText: "2 tranches" });
    expect(comteItem()).toMatchObject({ qty: null, qtyText: "2 tranches" });
  });

  describe("what is declared prevails over what other open meals hold", () => {
    beforeEach(() => {
      // 600 g of comté in Reste: the gratin and the salade take 100 g each, the two shared-comté meals 200 g and 100 g
      s = fixtureState();
      s.stockItems.push({ id: 1, productId: P.comte, label: "comté", qty: 600, unit: "g", qtyText: null, isLow: false, useBy: null,
        openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
      expect(run("planning.commit", fixtureProposal()).status).toBe("applied");
      expect(run("planning.commit", sharedComteProposal()).status).toBe("applied");
      expect(live().map((r) => [r.mealId, r.qty])).toEqual([[1, 100], [2, 100], [4, 200], [5, 100]]);
    });

    // Regression: 309f2ec — a declared amount below what other open meals hold was raised to their sum (400 g for « 50 g »),
    // so once those meals were dropped Reste showed 400 g libre that was never there
    it("takes a declared amount below the other meals' holds as it is, trims them latest planned first, and frees no phantom stock on a drop", () => {
      expect(cookComte(1, { qtyText: "50 g" }).status).toBe("applied");
      expect(comteItem()).toMatchObject({ qty: 50, qtyText: null });
      expect(live().map((r) => [r.mealId, r.qty])).toEqual([[2, 50]]);
      expect(invariantViolations(s).filter((v) => v.code !== "meal_under_covered")).toEqual([]);
      for (const mealId of [2, 4, 5]) expect(run("meal.drop", { mealId }).status).toBe("applied");
      expect(libreQty(comteItem(), s.reservations)).toBe(50);
    });

    // Regression: 309f2ec — words that are no quantity on an item three other meals hold kept their 400 g as the
    // quantity, a number the owners never gave
    it("makes the quantity unknown for words that are no quantity and keeps only the earliest planned meal's hold", () => {
      expect(cookComte(1, { qtyText: "un peu" }).status).toBe("applied");
      expect(comteItem()).toMatchObject({ qty: null, qtyText: "un peu" });
      expect(live().map((r) => [r.mealId, r.qty])).toEqual([[2, 100]]);
      expect(invariantViolations(s).filter((v) => v.code !== "meal_under_covered")).toEqual([]);
    });

    // Regression: 47db9e5 — the answers applied in sheet order, so an « Il en reste » listed before a « Fini » that drops a
    // meal counted that meal's hold: the other meals were trimmed for it, and 100 g read as libre once it was dropped
    it("settles a sheet's « Fini » answers, and the meals they drop, before its « Il en reste »", () => {
      // the same 600 g of comté, and 400 g of endive at home that the salade (meal 2) holds alone
      s = fixtureState();
      s.stockItems.push({ id: 1, productId: P.comte, label: "comté", qty: 600, unit: "g", qtyText: null, isLow: false, useBy: null,
        openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW },
      { id: 9, productId: P.endive, label: "endive", qty: 400, unit: "g", qtyText: null, isLow: false, useBy: null,
        openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
      expect(run("planning.commit", fixtureProposal()).status).toBe("applied");
      expect(run("planning.commit", sharedComteProposal()).status).toBe("applied");
      expect(s.reservations.filter((r) => r.stockItemId === 9).map((r) => [r.mealId, r.qty])).toEqual([[2, 400]]);
      expect(run("meal.cook", { mealId: 1, sheet: { items: [
        { stockItemId: comteItem().id, outcome: "il_en_reste", qtyText: "250 g" },
        { stockItemId: 9, outcome: "fini", resolution: "drop_meal" },
      ] } }).status).toBe("applied");
      expect(s.meals.find((m) => m.id === 2)!.droppedAt).toBe(NOW);
      expect(comteItem()).toMatchObject({ qty: 250, qtyText: null });
      expect(live().map((r) => [r.mealId, r.qty])).toEqual([[4, 200], [5, 50]]);
      expect(libreQty(comteItem(), s.reservations)).toBe(0);
    });

    it("takes a declared amount above the other meals' holding as it is", () => {
      expect(cookComte(1, { qtyText: "450 g" }).status).toBe("applied");
      expect(comteItem()).toMatchObject({ qty: 450, qtyText: null });
      expect(libreQty(comteItem(), s.reservations)).toBe(50);
    });
  });
});

describe("meal.cover_shortfalls", () => {
  const comteLines = () => s.shoppingItems.filter((l) => l.productId === P.comte && l.boughtAt === null && l.removedAt === null);
  const held = (mealId: number) => s.reservations.filter((r) => r.mealId === mealId && r.releasedAt === null).map((r) => [r.stockItemId, r.qty, r.unit]);
  const shortOf = (mealId: number) => mealShortfalls(s).filter((x) => x.mealId === mealId);
  const added = () => s.stockItems.at(-1)!.id;

  /**
   * `qty` g of comté at home, the gratin (meal 1) and the salade (meal 2) planned on it at 100 g each, then « 50 g »
   * declared: the gratin keeps a 50 g hold, the salade's is trimmed to nothing. At 160 g the salade also has a 40 g line.
   */
  function declaredShort(qty: number, comte: Partial<Product> = {}): void {
    s = fixtureState();
    Object.assign(s.products.find((p) => p.id === P.comte)!, comte);
    s.stockItems.push({ id: 1, productId: P.comte, label: "comté", qty, unit: "g", qtyText: null, isLow: false, useBy: null,
      openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
    expect(run("planning.commit", fixtureProposal()).status).toBe("applied");
    expect(run("stock.partial", { itemId: 1, qtyText: "50 g", low: false }).status).toBe("applied");
    expect(held(1)).toEqual([[1, 50, "g"]]);
  }

  it("covers a shortfall from libre stock first, putting nothing on Courses", () => {
    declaredShort(160);
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "200 g", useBy: null });
    const lines = structuredClone(s.shoppingItems);
    expect(run("meal.cover_shortfalls", { mealId: 1 }).status).toBe("applied");
    expect(held(1)).toEqual([[1, 50, "g"], [added(), 50, "g"]]);
    expect(s.shoppingItems).toEqual(lines);
    expect(shortOf(1)).toEqual([]);
  });

  // Regression: 4e1fdbe — a cover reserved stock near its use-by without flagging the meal « à cuisiner tôt », as planning.commit does
  it("flags the meal to cook early when it reserves stock near its use-by, as planning.commit does", () => {
    declaredShort(160);
    const salade = () => s.meals.find((m) => m.id === 2)!;
    expect(salade().cookEarlyReason).toBeNull();
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "200 g", useBy: "2026-10-30" });
    run("stock.add", { label: "comté frais", productId: P.comte, qtyText: "20 g", useBy: "2026-10-15" });
    expect(run("meal.cover_shortfalls", { mealId: 2 }).status).toBe("applied");
    expect(held(2)).toEqual([[added(), 20, "g"], [added() - 1, 40, "g"]]);
    expect(salade().cookEarlyReason).toBe("comté frais à utiliser avant jeudi 15");
  });

  it("leaves the flag alone when the stock it reserves is far from its use-by, and keeps a reason the meal already had", () => {
    declaredShort(160);
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "200 g", useBy: "2026-10-30" });
    expect(run("meal.cover_shortfalls", { mealId: 2 }).status).toBe("applied");
    expect(s.meals.find((m) => m.id === 2)!.cookEarlyReason).toBeNull();
    const reason = "poireau à utiliser avant mardi 13";
    s.meals.find((m) => m.id === 1)!.cookEarlyReason = reason; // flagged by the planning that made it
    run("stock.add", { label: "comté frais", productId: P.comte, qtyText: "200 g", useBy: "2026-10-13" });
    s.reservations.filter((r) => r.mealId === 1).forEach((r) => (r.releasedAt = NOW)); // the gratin short of its comté
    expect(run("meal.cover_shortfalls", { mealId: 1 }).status).toBe("applied");
    expect(s.meals.find((m) => m.id === 1)!.cookEarlyReason).toBe(reason);
  });

  it("takes what is libre and puts only the rest on Courses, priced from the latest priced line without a reference", () => {
    declaredShort(160);
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "30 g", useBy: null });
    expect(run("meal.cover_shortfalls", { mealId: 2 }).status).toBe("applied");
    expect(held(2)).toEqual([[added(), 30, "g"]]);
    expect(comteLines()).toEqual([
      expect.objectContaining({ qty: 40, estPriceCents: 500, forMeals: [{ mealId: 2, qty: 40 }] }),
      expect.objectContaining({ label: "comté", qty: 30, unit: "g", estPriceCents: 375, kind: "planning", planningId: 1, forMeals: [{ mealId: 2, qty: 30 }] }),
    ]);
    expect(shortOf(2)).toEqual([]);
  });

  it("never takes stock another meal holds", () => {
    declaredShort(160);
    expect(run("meal.cover_shortfalls", { mealId: 2 }).status).toBe("applied");
    expect(held(1)).toEqual([[1, 50, "g"]]);
    expect(held(2)).toEqual([]);
    expect(comteLines().at(-1)).toMatchObject({ qty: 60, estPriceCents: 750, forMeals: [{ mealId: 2, qty: 60 }] }); // 60 g at the 40 g line's 500 c
    expect(shortOf(2)).toEqual([]);
    expect(invariantViolations(s).filter((v) => !v.subject.startsWith("meal:1|"))).toEqual([]);
  });

  it("leaves a new line unpriced with neither a reference price nor a priced line of that product", () => {
    declaredShort(200);
    expect(comteLines()).toEqual([]);
    expect(run("meal.cover_shortfalls", { mealId: 2 }).status).toBe("applied");
    expect(comteLines()).toEqual([expect.objectContaining({ qty: 100, estPriceCents: null, forMeals: [{ mealId: 2, qty: 100 }] })]);
  });

  it("puts the whole amount in the spare of a line already on Courses, the meal's own share growing", () => {
    declaredShort(160, { pack: { qty: 250, unit: "g" } }); // the salade's 40 g line is a 250 g pack
    const [line] = comteLines();
    expect(line).toMatchObject({ qty: 250, forMeals: [{ mealId: 2, qty: 40 }] });
    expect(run("meal.cover_shortfalls", { mealId: 2 }).status).toBe("applied");
    expect(run("meal.cover_shortfalls", { mealId: 1 }).status).toBe("applied");
    expect(comteLines()).toEqual([{ ...line, forMeals: [{ mealId: 2, qty: 100 }, { mealId: 1, qty: 50 }] }]);
    expect(mealShortfalls(s)).toEqual([]);
    expect(invariantViolations(s)).toEqual([]);
  });

  it("buys a new line in whole packs at the reference price, whose spare the next meal then takes", () => {
    declaredShort(200, { pack: { qty: 250, unit: "g" }, price: { cents: 420, qty: 250, unit: "g" } });
    expect(run("meal.cover_shortfalls", { mealId: 2 }).status).toBe("applied");
    expect(comteLines()).toEqual([expect.objectContaining({ qty: 250, estPriceCents: 420, planningId: 1, forMeals: [{ mealId: 2, qty: 100 }] })]);
    expect(run("meal.cover_shortfalls", { mealId: 1 }).status).toBe("applied");
    expect(comteLines()).toEqual([expect.objectContaining({ qty: 250, estPriceCents: 420, forMeals: [{ mealId: 2, qty: 100 }, { mealId: 1, qty: 50 }] })]);
    expect(invariantViolations(s)).toEqual([]);
  });

  it("covers two shortfalls of one meal in two units with two lines, rounding only the unit the pack is in", () => {
    s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
    s.recipeIngredients.push({ id: 17, recipeId: R.salade, productId: P.comte, qty: 2, unit: "piece", note: null });
    const item = (id: number, qty: number, unit: "g" | "piece") => ({ id, productId: P.comte, label: "comté", qty, unit, qtyText: null, isLow: false,
      useBy: null, openedAt: null, finishedAt: null, origin: "ajout" as const, sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
    s.stockItems.push(item(1, 200, "g"), item(2, 2, "piece"));
    expect(run("planning.commit", fixtureProposal()).status).toBe("applied");
    expect(held(2)).toEqual([[1, 100, "g"], [2, 2, "piece"]]);
    run("stock.partial", { itemId: 1, qtyText: "100 g", low: false }); // the salade's 100 g hold released
    run("stock.partial", { itemId: 2, qtyText: "1", low: false }); // its 2 pieces trimmed to 1
    expect(shortOf(2)).toEqual([{ mealId: 2, productId: P.comte, unit: "piece", qty: 1 }, { mealId: 2, productId: P.comte, unit: "g", qty: 100 }]);
    expect(run("meal.cover_shortfalls", { mealId: 2 }).status).toBe("applied");
    expect(comteLines()).toEqual([
      expect.objectContaining({ qty: 1, unit: "piece", forMeals: [{ mealId: 2, qty: 1 }] }),
      expect.objectContaining({ qty: 250, unit: "g", forMeals: [{ mealId: 2, qty: 100 }] }),
    ]);
    expect(mealShortfalls(s)).toEqual([]);
  });

  it("answers noop « rien ne manque » once covered, and to a meal never short", () => {
    declaredShort(160);
    const cover = op("meal.cover_shortfalls", { mealId: 2 });
    s = applyOp(s, cover, NOW).state;
    const after = structuredClone(s.shoppingItems);
    expect(run("meal.cover_shortfalls", { mealId: 2 })).toEqual({ status: "noop", reason: "rien ne manque" });
    expect(applyOp(s, cover, NOW).result).toEqual({ status: "applied", reason: null }); // the resend gets its first answer back
    expect(s.shoppingItems).toEqual(after);
    expect(run("meal.cover_shortfalls", { mealId: 3 })).toEqual({ status: "noop", reason: "rien ne manque" });
  });

  it("refuses a malformed meal id, an unknown meal, a cooked one and a dropped one", () => {
    declaredShort(160);
    for (const mealId of ["2", 2.5, null, 2 ** 53]) expect(run("meal.cover_shortfalls", { mealId })).toEqual({ status: "refused", reason: "données invalides" });
    expect(run("meal.cover_shortfalls", {})).toEqual({ status: "refused", reason: "données invalides" });
    expect(run("meal.cover_shortfalls", { mealId: 99 })).toEqual({ status: "refused", reason: "repas introuvable" });
    run("meal.cook", { mealId: 1, sheet: {} });
    expect(run("meal.cover_shortfalls", { mealId: 1 })).toEqual({ status: "refused", reason: "repas déjà cuisiné" });
    run("meal.drop", { mealId: 2 });
    expect(run("meal.cover_shortfalls", { mealId: 2 })).toEqual({ status: "refused", reason: "repas retiré du menu" });
  });

  describe("undo", () => {
    const undo = (cover: ReturnType<typeof op>) => run("undo", { targetOpId: cover.opId });

    it("removes the new line and gives the meal back the same shortfall", () => {
      declaredShort(160);
      const lines = structuredClone(s.shoppingItems);
      const short = mealShortfalls(s);
      const cover = op("meal.cover_shortfalls", { mealId: 2 });
      s = applyOp(s, cover, NOW).state;
      expect(undo(cover)).toEqual({ status: "applied", reason: null });
      expect(s.shoppingItems).toEqual(lines);
      expect(mealShortfalls(s)).toEqual(short);
    });

    it("takes back the stock it reserved and the share it added to a spare line", () => {
      declaredShort(160, { pack: { qty: 250, unit: "g" } });
      run("stock.add", { label: "comté", productId: P.comte, qtyText: "30 g", useBy: null });
      const before = structuredClone({ lines: s.shoppingItems, reservations: s.reservations });
      const cover = op("meal.cover_shortfalls", { mealId: 2 });
      s = applyOp(s, cover, NOW).state;
      expect(held(2)).toEqual([[added(), 30, "g"]]);
      expect(comteLines()[0]!.forMeals).toEqual([{ mealId: 2, qty: 70 }]);
      expect(undo(cover)).toEqual({ status: "applied", reason: null });
      expect({ lines: s.shoppingItems, reservations: s.reservations }).toEqual(before);
      expect(shortOf(2)).toEqual([{ mealId: 2, productId: P.comte, unit: "g", qty: 60 }]);
    });

    it("is refused once the line it added is bought", () => {
      declaredShort(160);
      const cover = op("meal.cover_shortfalls", { mealId: 2 });
      s = applyOp(s, cover, NOW).state;
      run("shopping.buy", { itemId: comteLines().at(-1)!.id });
      expect(undo(cover)).toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
      expect(shortOf(2)).toEqual([]);
    });
  });
});
