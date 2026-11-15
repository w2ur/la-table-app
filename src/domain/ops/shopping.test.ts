import { beforeEach, describe, expect, it } from "vitest";
import { applyOp } from "./apply";
import { NOW, P, fixtureProposal, fixtureState, op, secondProposal, sharedComteProposal } from "../test-fixtures";
import { invariantViolations, mealShortfalls } from "../invariants";
import { resteItems, snapshot } from "../snapshot";
import type { State } from "../types";

let s: State;
const run = (type: string, payload: unknown, at = NOW) => {
  const r = applyOp(s, op(type, payload, at), NOW);
  s = r.state;
  return r.result;
};
const line = (productId: number) => s.shoppingItems.find((l) => l.productId === productId)!;

beforeEach(() => {
  s = fixtureState();
  run("planning.commit", fixtureProposal());
});

describe("shopping.buy", () => {
  it("creates a Reste item dated from the shelf life and reserves it for each meal (cheese story)", () => {
    expect(run("shopping.buy", { itemId: line(P.comte).id })).toEqual({ status: "applied", reason: null });
    const item = s.stockItems.find((i) => i.productId === P.comte)!;
    expect(item).toMatchObject({ qty: 200, unit: "g", origin: "achat", useBy: "2026-11-11" });
    expect(s.reservations.filter((r) => r.stockItemId === item.id).map((r) => [r.mealId, r.qty])).toEqual([[1, 100], [2, 100]]);
  });

  it("dates use-by from the Paris day of the tick, not the UTC day", () => {
    run("shopping.buy", { itemId: line(P.comte).id }, "2026-10-11T23:30:00Z");
    expect(s.stockItems.find((i) => i.productId === P.comte)!.useBy).toBe("2026-11-11");
  });

  it("is a no-op the second time (two phones tick the same line)", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    expect(run("shopping.buy", { itemId: line(P.comte).id }).status).toBe("noop");
    expect(s.stockItems.filter((i) => i.productId === P.comte)).toHaveLength(1);
  });

  // Regression: b7dbf78 — buying a shared line handed a meal its whole remaining need although its own rebuy line still carried part of it, leaving the other meal short
  it("splits a shared line by each meal's share on it, whatever order the meal's other lines are bought in", () => {
    for (const rebuyFirst of [false, true]) {
      s = fixtureState();
      run("planning.commit", fixtureProposal());
      run("shopping.buy", { itemId: line(P.comte).id });
      const bought = s.stockItems.find((i) => i.productId === P.comte)!;
      run("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: bought.id, outcome: "il_en_reste" }] } });
      run("meal.drop", { mealId: 2 }); // the gratin ate its 100 g; dropping the salade leaves the other 100 g libre
      expect(run("planning.commit", sharedComteProposal()).status).toBe("applied");
      const [a, b] = s.meals.slice(-2).map((m) => m.id) as [number, number];
      const shared = s.shoppingItems.find((l) => l.productId === P.comte && l.boughtAt === null)!;
      expect(shared.forMeals).toEqual([{ mealId: a, qty: 100 }, { mealId: b, qty: 100 }]);
      expect(run("stock.finish", { itemId: bought.id, resolution: "rebuy" }).status).toBe("applied");
      const rebuy = s.shoppingItems.find((l) => l.productId === P.comte && l.boughtAt === null && l.id !== shared.id && l.forMeals[0]!.mealId === a)!;
      for (const l of rebuyFirst ? [rebuy, shared] : [shared, rebuy]) run("shopping.buy", { itemId: l.id });
      const held = (mealId: number) => s.reservations.filter((r) => r.mealId === mealId && r.releasedAt === null).reduce((n, r) => n + r.qty!, 0);
      expect({ rebuyFirst, a: held(a), b: held(b) }).toEqual({ rebuyFirst, a: 200, b: 100 });
    }
  });

  it("refuses ops on missing ids instead of throwing", () => {
    expect(run("shopping.buy", { itemId: 999 })).toEqual({ status: "refused", reason: "article introuvable" });
    expect(run("shopping.buy", { itemId: "x" })).toEqual({ status: "refused", reason: "données invalides" });
  });
});

describe("ajouts, trips and envies", () => {
  it("adds and buys a non-food ajout without creating Reste", () => {
    run("shopping.add", { label: "éponges", isFood: false });
    const ajout = s.shoppingItems.find((l) => l.label === "éponges")!;
    expect(ajout).toMatchObject({ kind: "ajout", productId: null, isFood: false });
    run("shopping.buy", { itemId: ajout.id });
    expect(s.stockItems.find((i) => i.label === "éponges")).toBeUndefined();
  });

  it("records a trip and attaches the bought lines not yet on a trip", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    run("shopping.buy", { itemId: line(P.endive).id });
    run("trip.record", { place: "marche", totalCents: null, date: "2026-10-12", itemIds: [line(P.comte).id, line(P.endive).id] });
    const trip = s.trips[0]!;
    expect(line(P.comte).tripId).toBe(trip.id);
    expect(line(P.poireau).tripId).toBeNull();
    run("trip.set_total", { tripId: trip.id, totalCents: 1840 });
    expect(s.trips[0]!.totalCents).toBe(1840);
  });

  // Regression: dc1ef36 — setting the total a trip already carries was applied with no change
  it("answers noop for the total a trip already carries", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    run("trip.record", { place: "marche", totalCents: 1840, date: "2026-10-12", itemIds: [line(P.comte).id] });
    expect(run("trip.set_total", { tripId: s.trips[0]!.id, totalCents: 1840 })).toEqual({ status: "noop", reason: "déjà ce total" });
    expect(run("trip.set_total", { tripId: s.trips[0]!.id, totalCents: 1900 }).status).toBe("applied");
  });

  // Regression: f07c791 — trip.record refused a payload without totalCents although spec §6.5 makes it optional
  it("records a trip without a total, and rejects a negative or fractional one", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    expect(run("trip.record", { place: "supermarche", date: "2026-10-12", itemIds: [line(P.comte).id] }).status).toBe("applied");
    expect(s.trips[0]).toMatchObject({ totalCents: null, place: "supermarche" });
    expect(line(P.comte).tripId).toBe(s.trips[0]!.id);
    expect(run("trip.record", { place: "marche", totalCents: -1, date: "2026-10-12", itemIds: [line(P.comte).id] }).reason).toBe("données invalides");
    expect(run("trip.record", { place: "marche", totalCents: 9.5, date: "2026-10-12", itemIds: [line(P.comte).id] }).reason).toBe("données invalides");
  });

  describe("a trip without a receipt", () => {
    const bought = () => {
      run("shopping.buy", { itemId: line(P.comte).id });
      run("shopping.buy", { itemId: line(P.endive).id });
    };

    it("records the listed lines on a trip with no total, and leaves the others in the basket", () => {
      bought();
      expect(run("trip.record", { place: "autre", date: "2026-10-12", noReceipt: true, itemIds: [line(P.comte).id] }).status).toBe("applied");
      expect(s.trips[0]).toMatchObject({ place: "autre", totalCents: null, noReceipt: true });
      expect(line(P.comte).tripId).toBe(s.trips[0]!.id);
      expect(line(P.endive).tripId).toBeNull();
    });

    it("stores no flag on a trip recorded with noReceipt false or absent", () => {
      bought();
      run("trip.record", { place: "marche", date: "2026-10-12", totalCents: 500, noReceipt: false, itemIds: [line(P.comte).id] });
      run("trip.record", { place: "marche", date: "2026-10-12", totalCents: 500, itemIds: [line(P.endive).id] });
      expect(s.trips.map((t) => t.noReceipt)).toEqual([null, null]);
    });

    it("rejects a total with it, and a flag that is no boolean, changing nothing", () => {
      bought();
      const record = (extra: Record<string, unknown>) => run("trip.record", { place: "autre", date: "2026-10-12", itemIds: [line(P.comte).id], ...extra });
      expect(record({ noReceipt: true, totalCents: 1200 }).reason).toBe("données invalides");
      expect(record({ noReceipt: true, totalCents: 0 }).reason).toBe("données invalides");
      for (const noReceipt of ["true", 1, 0, null, []]) expect(record({ noReceipt }).reason, JSON.stringify(noReceipt)).toBe("données invalides");
      expect(s.trips).toHaveLength(0);
      expect(line(P.comte).tripId).toBeNull();
      expect(record({ noReceipt: true, totalCents: null }).status).toBe("applied");
    });

    it("refuses a total on it", () => {
      bought();
      run("trip.record", { place: "autre", date: "2026-10-12", noReceipt: true, itemIds: [line(P.comte).id] });
      expect(run("trip.set_total", { tripId: s.trips[0]!.id, totalCents: 1200 })).toEqual({ status: "refused", reason: "passage sans ticket" });
      expect(s.trips[0]!.totalCents).toBeNull();
    });

    it("is taken back by its undo: the lines return to the basket and the trip goes", () => {
      bought();
      const record = op("trip.record", { place: "autre", date: "2026-10-12", noReceipt: true, itemIds: [line(P.comte).id, line(P.endive).id] });
      s = applyOp(s, record, NOW).state;
      expect(line(P.comte).tripId).not.toBeNull();
      const r = applyOp(s, op("undo", { targetOpId: record.opId }), NOW);
      s = r.state;
      expect(r.result.status).toBe("applied");
      expect(s.trips).toHaveLength(0);
      expect(line(P.comte)).toMatchObject({ boughtAt: NOW, tripId: null });
      expect(line(P.endive)).toMatchObject({ boughtAt: NOW, tripId: null });
    });
  });

  // Regression: 6913337 — trip.record attached every bought line the server held, so a line the other phone bought after this phone's last refresh went on this receipt
  it("attaches only the lines the checkout listed; a line the other phone bought since stays in the basket", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    run("shopping.buy", { itemId: line(P.endive).id }); // the other phone, after this one opened its checkout
    expect(run("trip.record", { place: "marche", totalCents: 1840, date: "2026-10-12", itemIds: [line(P.comte).id] }).status).toBe("applied");
    expect(line(P.comte).tripId).toBe(s.trips[0]!.id);
    expect(line(P.endive)).toMatchObject({ tripId: null, boughtAt: NOW });
  });

  it("refuses a checkout listing a line no longer in the basket, and attaches nothing", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    run("shopping.buy", { itemId: line(P.endive).id });
    run("trip.record", { place: "autre", totalCents: null, date: "2026-10-12", itemIds: [line(P.comte).id] }); // the other phone's checkout
    const record = (itemIds: unknown) => run("trip.record", { place: "marche", totalCents: 1840, date: "2026-10-12", itemIds });
    expect(record([line(P.comte).id, line(P.endive).id])).toEqual({ status: "refused", reason: "panier modifié depuis" }); // on a trip already
    expect(record([line(P.poireau).id])).toEqual({ status: "refused", reason: "panier modifié depuis" }); // not bought
    expect(record([999])).toEqual({ status: "refused", reason: "panier modifié depuis" });
    run("shopping.add", { label: "pain", isFood: true });
    const pain = s.shoppingItems.find((l) => l.label === "pain")!;
    run("shopping.buy", { itemId: pain.id });
    run("shopping.add", { label: "lait", isFood: true });
    expect(record([s.shoppingItems.find((l) => l.label === "lait")!.id])).toEqual({ status: "refused", reason: "panier modifié depuis" });
    expect(s.trips).toHaveLength(1);
    expect(line(P.endive).tripId).toBeNull();
    for (const bad of [undefined, [], ["x"], [1.5], [line(P.endive).id, line(P.endive).id], "1"]) expect(record(bad), String(bad)).toEqual({ status: "refused", reason: "données invalides" });
    expect(record([line(P.endive).id, pain.id]).status).toBe("applied");
  });

  it("adds an envie", () => {
    run("envie.add", { text: "quelque chose avec des poireaux", url: null });
    expect(s.envies.at(-1)).toMatchObject({ status: "ouverte", text: "quelque chose avec des poireaux" });
  });

  // Regression: d6862d6 — an envie took any text as its address, and Menu rendered it as a link: a « javascript: » one ran on a tap
  it("refuses an envie whose address is not an http(s) one", () => {
    const count = s.envies.length;
    for (const url of ["javascript:alert(1)", "data:text/html,x", "tarte", 3]) {
      expect(run("envie.add", { text: "piège", url }), String(url)).toEqual({ status: "refused", reason: "données invalides" });
    }
    expect(s.envies).toHaveLength(count);
    expect(run("envie.add", { text: "tarte", url: "https://example.org/tarte" }).status).toBe("applied");
  });
});

describe("shopping.set_price", () => {
  it("prices an unpriced ajout, bought or not, and is a no-op at the same price", () => {
    run("shopping.add", { label: "éponges", isFood: false });
    const ajout = () => s.shoppingItems.find((l) => l.label === "éponges")!;
    expect(run("shopping.set_price", { itemId: ajout().id, estPriceCents: 250 })).toEqual({ status: "applied", reason: null });
    expect(ajout().estPriceCents).toBe(250);
    run("shopping.buy", { itemId: ajout().id });
    run("trip.record", { place: "supermarche", totalCents: 4200, date: "2026-10-12", itemIds: [ajout().id] });
    expect(run("shopping.set_price", { itemId: ajout().id, estPriceCents: 0 }).status).toBe("applied");
    expect(ajout().estPriceCents).toBe(0);
    expect(run("shopping.set_price", { itemId: ajout().id, estPriceCents: 0 }).status).toBe("noop");
  });

  // Regression: 4308375 — set_price priced a removed, emptied line (a meal dropped off it), breaking « an emptied line costs nothing »
  it("refuses a removed line, and a planning line the planning already priced", () => {
    const endive = line(P.endive); // the salade's only
    run("meal.drop", { mealId: 2 });
    expect(line(P.endive)).toMatchObject({ qty: 0, estPriceCents: 0, removedAt: NOW });
    expect(run("shopping.set_price", { itemId: endive.id, estPriceCents: 300 })).toEqual({ status: "refused", reason: "article retiré" });
    run("shopping.add", { label: "éponges", isFood: false });
    const ajout = s.shoppingItems.at(-1)!;
    run("shopping.remove", { itemId: ajout.id });
    expect(run("shopping.set_price", { itemId: ajout.id, estPriceCents: 300 })).toEqual({ status: "refused", reason: "article retiré" });
    for (const productId of [P.comte, P.riz]) { // a planning line and a staple line, both priced at commit
      expect(run("shopping.set_price", { itemId: line(productId).id, estPriceCents: 300 })).toEqual({ status: "refused", reason: "déjà chiffré par la planification" });
    }
    expect(invariantViolations(s)).toEqual([]);
    expect(s.shoppingItems.find((l) => l.id === ajout.id)!.estPriceCents).toBeNull();
  });

  it("refuses an emptied line even while it is still listed", () => {
    run("shopping.add", { label: "levure", isFood: true });
    s.shoppingItems.at(-1)!.qty = 0; // no op leaves a listed line at 0 today; the guard keeps « an emptied line costs nothing » if one ever does
    expect(run("shopping.set_price", { itemId: s.shoppingItems.at(-1)!.id, estPriceCents: 300 })).toEqual({ status: "refused", reason: "article vide" });
  });

  it("prices a rebuy line that had no known price", () => {
    run("shopping.buy", { itemId: line(P.poireau).id });
    s.shoppingItems.find((l) => l.productId === P.poireau)!.estPriceCents = null; // no price basis left for the rebuy
    run("stock.finish", { itemId: s.stockItems.find((i) => i.productId === P.poireau)!.id, resolution: "rebuy" });
    expect(s.shoppingItems.at(-1)).toMatchObject({ productId: P.poireau, kind: "planning", estPriceCents: null, boughtAt: null });
    expect(run("shopping.set_price", { itemId: s.shoppingItems.at(-1)!.id, estPriceCents: 420 }).status).toBe("applied");
    expect(s.shoppingItems.at(-1)!.estPriceCents).toBe(420);
  });

  it("refuses a missing line and rejects a price that is not a non-negative integer", () => {
    expect(run("shopping.set_price", { itemId: 999, estPriceCents: 100 })).toEqual({ status: "refused", reason: "article introuvable" });
    for (const estPriceCents of [-1, 1.5, "100", null, undefined]) {
      expect(run("shopping.set_price", { itemId: line(P.comte).id, estPriceCents })).toEqual({ status: "refused", reason: "données invalides" });
    }
    expect(line(P.comte).estPriceCents).toBe(500);
  });
});

describe("shopping.set_bought_qty", () => {
  const send = (o: ReturnType<typeof op>) => { const r = applyOp(s, o, NOW); s = r.state; return r.result; };
  const bought = (qty: number) => run("shopping.set_bought_qty", { itemId: line(P.comte).id, qty });
  const comteItem = () => s.stockItems.find((i) => i.productId === P.comte)!;
  const holds = () => s.reservations.filter((r) => r.stockItemId === comteItem().id && r.releasedAt === null).map((r) => [r.mealId, r.qty]);
  const refusedWith = (reason: string) => ({ status: "refused", reason });

  it("refuses a malformed quantity", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    for (const qty of [0, -5, 1.5, "260", null, 2 ** 53]) {
      expect(run("shopping.set_bought_qty", { itemId: line(P.comte).id, qty }), String(qty)).toEqual(refusedWith("données invalides"));
    }
    expect(run("shopping.set_bought_qty", { itemId: "2", qty: 260 })).toEqual(refusedWith("données invalides"));
  });

  it("refuses an unknown or removed line, a line not bought yet, and a line without a product", () => {
    expect(run("shopping.set_bought_qty", { itemId: 999, qty: 260 })).toEqual(refusedWith("article introuvable"));
    const saumon = line(P.saumon).id;
    run("meal.drop", { mealId: 3 });
    expect(run("shopping.set_bought_qty", { itemId: saumon, qty: 260 })).toEqual(refusedWith("article introuvable"));
    expect(bought(260)).toEqual(refusedWith("pas encore acheté"));
    run("shopping.add", { label: "pain", isFood: true });
    const pain = s.shoppingItems.find((l) => l.label === "pain")!.id;
    run("shopping.buy", { itemId: pain });
    expect(run("shopping.set_bought_qty", { itemId: pain, qty: 2 })).toEqual(refusedWith("article sans produit"));
  });

  it("refuses a non-food line, which put nothing in Reste", () => {
    s.shoppingItems.find((l) => l.productId === P.comte)!.isFood = false;
    run("shopping.buy", { itemId: line(P.comte).id });
    expect(bought(260)).toEqual(refusedWith("pas d'article en Reste"));
    expect(line(P.comte)).toMatchObject({ qty: 200, plannedQty: null });
  });

  it("refuses once its Reste item is finished, or declared since the purchase", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    run("stock.partial", { itemId: comteItem().id, qtyText: "150 g", low: false });
    expect(bought(260)).toEqual(refusedWith("reste déclaré depuis, à préciser avec reste"));
    run("stock.finish", { itemId: comteItem().id, resolution: "drop_meal" });
    expect(bought(260)).toEqual(refusedWith("déjà fini"));
    expect(line(P.comte)).toMatchObject({ qty: 200, plannedQty: null });
  });

  it("is a noop for the quantity the line already has", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    expect(bought(200)).toEqual({ status: "noop", reason: "déjà cette quantité" });
    bought(260);
    expect(bought(260)).toEqual({ status: "noop", reason: "déjà cette quantité" });
  });

  it("sets the line's quantity, moves its Reste item by the difference and keeps the price and the planned quantity", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    const price = line(P.comte).estPriceCents;
    const useBy = comteItem().useBy;
    expect(bought(260)).toEqual({ status: "applied", reason: null });
    expect(line(P.comte)).toMatchObject({ qty: 260, plannedQty: 200, estPriceCents: price });
    expect(comteItem()).toMatchObject({ qty: 260, openedAt: null, useBy });
    expect(holds()).toEqual([[1, 100], [2, 100]]);
    // a second correction is absolute too, and the planned quantity stays the planning's
    bought(220);
    expect(line(P.comte)).toMatchObject({ qty: 220, plannedQty: 200 });
    expect(comteItem().qty).toBe(220);
    expect(holds()).toEqual([[1, 100], [2, 100]]);
    expect(invariantViolations(s)).toEqual([]);
  });

  it("raises an item a cook already ate from by what the receipt adds", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    run("meal.cook", { mealId: 1, sheet: {} });
    run("meal.cook", { mealId: 2, sheet: {} });
    expect(comteItem().qty).toBe(0);
    expect(bought(1150)).toEqual({ status: "applied", reason: null });
    expect(comteItem().qty).toBe(950);
  });

  // Regression: d549005 — a receipt below what a cook already ate left the Reste item at an unknown quantity
  // Regression: c1063e7 — that receipt was then refused, though true: the line could never take what was really bought
  // Regression: 582eda2 — it then clamped the item at 0, a false zero that forgot what was eaten
  it("takes a quantity at or below what was already eaten, the item then unknown (never a false zero), one hold kept", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    run("meal.cook", { mealId: 1, sheet: {} });
    expect(comteItem().qty).toBe(100);
    expect(bought(50)).toEqual({ status: "applied", reason: null });
    expect(comteItem()).toMatchObject({ qty: null, openedAt: null, finishedAt: null });
    expect(line(P.comte)).toMatchObject({ qty: 50, plannedQty: 200 });
    expect(holds()).toEqual([[2, 100]]); // an unknown quantity is held by one meal at most, the earliest planned
    expect(invariantViolations(s)).toEqual([]);
  });

  // Regression: 582eda2 — 200 g planned, 100 g eaten, receipts 50 g then 100 g: the clamp lost the 100 g eaten and showed 50 g of phantom stock
  it("leaves an item unknown through every later correction, so no phantom stock appears", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    run("meal.cook", { mealId: 1, sheet: {} });
    expect(comteItem().qty).toBe(100);
    expect(bought(50)).toEqual({ status: "applied", reason: null });
    expect(comteItem().qty).toBeNull();
    expect(bought(100)).toEqual({ status: "applied", reason: null });
    expect(comteItem().qty).toBeNull();
    expect(line(P.comte).qty).toBe(100);
  });

  // Regression: 0b46d23 — a resend after the item was finished answered « déjà fini » instead of noop, reading as a failure
  it("is a noop on a resend at the same quantity, even once the item was finished or declared since", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    expect(bought(260).status).toBe("applied");
    run("stock.partial", { itemId: comteItem().id, qtyText: "150 g", low: false });
    expect(bought(260)).toEqual({ status: "noop", reason: "déjà cette quantité" });
    run("stock.finish", { itemId: comteItem().id, resolution: "drop_meal" });
    expect(bought(260)).toEqual({ status: "noop", reason: "déjà cette quantité" });
    expect(bought(300)).toEqual(refusedWith("déjà fini"));
  });

  it("keeps an item of unknown quantity unknown", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    comteItem().qty = null;
    expect(bought(260)).toEqual({ status: "applied", reason: null });
    expect(comteItem().qty).toBeNull();
    expect(line(P.comte).qty).toBe(260);
  });

  it("trims the other meals' holds below the new quantity, latest planned first, without opening the item", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    const useBy = comteItem().useBy;
    expect(bought(150)).toEqual({ status: "applied", reason: null });
    expect(comteItem()).toMatchObject({ qty: 150, openedAt: null, useBy });
    expect(holds()).toEqual([[1, 100], [2, 50]]);
    expect(mealShortfalls(s)).toEqual([{ mealId: 2, productId: P.comte, unit: "g", qty: 50 }]);
    bought(90);
    expect(holds()).toEqual([[1, 90]]);
  });

  it("allows a packed line, two packs bought instead of one", () => {
    s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
    run("planning.commit", fixtureProposal());
    run("shopping.buy", { itemId: line(P.comte).id });
    expect(line(P.comte).qty).toBe(250);
    expect(bought(500)).toEqual({ status: "applied", reason: null });
    expect(comteItem().qty).toBe(500);
  });

  // Regression: d549005 — a rebuy priced per unit against the quantity a receipt corrected, not the one the price was for
  it("prices a later rebuy from the planned quantity's price per unit, not the quantity bought", () => {
    run("shopping.buy", { itemId: line(P.comte).id });
    const source = line(P.comte);
    const price = source.estPriceCents!;
    bought(1200);
    expect(run("stock.finish", { itemId: comteItem().id, resolution: "rebuy" })).toEqual({ status: "applied", reason: null });
    const rebuys = s.shoppingItems.filter((l) => l.productId === P.comte && l.id !== source.id);
    expect(rebuys.map((l) => [l.qty, l.estPriceCents])).toEqual([[100, Math.round((price * 100) / 200)], [100, Math.round((price * 100) / 200)]]);
  });

  describe("price basis", () => {
    /** A bought poireau rebuy line the planning could not price (no basis left), its Reste item held by the meal it serves. */
    const unpricedBought = () => {
      run("shopping.buy", { itemId: line(P.poireau).id });
      s.shoppingItems.find((l) => l.productId === P.poireau)!.estPriceCents = null;
      run("stock.finish", { itemId: s.stockItems.find((i) => i.productId === P.poireau)!.id, resolution: "rebuy" });
      const rebuy = s.shoppingItems.at(-1)!;
      expect(rebuy).toMatchObject({ kind: "planning", estPriceCents: null, boughtAt: null });
      run("shopping.buy", { itemId: rebuy.id });
      return { lineId: rebuy.id, qty: rebuy.qty!, itemId: () => s.stockItems.find((i) => i.sourceShoppingItemId === rebuy.id)!.id };
    };
    const rebuyOf = (itemId: number) => {
      expect(run("stock.finish", { itemId, resolution: "rebuy" })).toEqual({ status: "applied", reason: null });
      return s.shoppingItems.at(-1)!;
    };

    // Regression: 32111f8 — a receipt quantity on an unpriced line kept the old quantity as the basis of a price typed later for the new one
    it("bought then priced: the price typed from the receipt is for the quantity bought, so a rebuy prices per unit from it", () => {
      const { lineId, qty, itemId } = unpricedBought();
      expect(run("shopping.set_bought_qty", { itemId: lineId, qty: qty * 2 })).toEqual({ status: "applied", reason: null });
      expect(s.shoppingItems.find((l) => l.id === lineId)!.plannedQty).toBeNull();
      expect(run("shopping.set_price", { itemId: lineId, estPriceCents: 600 })).toEqual({ status: "applied", reason: null });
      const rebuy = rebuyOf(itemId());
      expect(rebuy.estPriceCents).toBe(Math.round((600 * rebuy.qty!) / (qty * 2)));
    });

    // Regression: 32111f8 — a price typed for a line's current quantity kept an older planned quantity as its basis
    it("a price typed on a line clears a planned quantity left from before, so it is read against the line's quantity", () => {
      const { lineId, qty, itemId } = unpricedBought();
      Object.assign(s.shoppingItems.find((l) => l.id === lineId)!, { qty: qty * 2, plannedQty: qty }); // a correction recorded before this rule
      s.stockItems.find((i) => i.id === itemId())!.qty = qty * 2;
      expect(run("shopping.set_price", { itemId: lineId, estPriceCents: 600 })).toEqual({ status: "applied", reason: null });
      expect(s.shoppingItems.find((l) => l.id === lineId)!.plannedQty).toBeNull();
      const rebuy = rebuyOf(itemId());
      expect(rebuy.estPriceCents).toBe(Math.round((600 * rebuy.qty!) / (qty * 2)));
    });

    it("priced then bought (the skill's order inverted): the price stays the quantity's before the receipt", () => {
      const { lineId, qty, itemId } = unpricedBought();
      run("shopping.set_price", { itemId: lineId, estPriceCents: 600 });
      expect(run("shopping.set_bought_qty", { itemId: lineId, qty: qty * 2 })).toEqual({ status: "applied", reason: null });
      expect(s.shoppingItems.find((l) => l.id === lineId)).toMatchObject({ qty: qty * 2, plannedQty: qty, estPriceCents: 600 });
      const rebuy = rebuyOf(itemId());
      expect(rebuy.estPriceCents).toBe(Math.round((600 * rebuy.qty!) / qty));
    });
  });

  describe("undo", () => {
    it("puts the line, its planned quantity, the item and the trimmed holds back", () => {
      run("shopping.buy", { itemId: line(P.comte).id });
      const before = structuredClone({ line: line(P.comte), item: comteItem(), holds: holds() });
      const set = op("shopping.set_bought_qty", { itemId: line(P.comte).id, qty: 150 });
      expect(send(set)).toEqual({ status: "applied", reason: null });
      expect(run("undo", { targetOpId: set.opId })).toEqual({ status: "applied", reason: null });
      expect({ line: line(P.comte), item: comteItem(), holds: holds() }).toEqual(before);
      expect(mealShortfalls(s)).toEqual([]);
    });

    it("of a later purchase whose surplus went to the trimmed meal, brings its shortfall back as it was before that purchase", () => {
      // found by ops.property: saumon in packs of 3 g, so the gratiné's 250 g sits on line 8 (249 g) and 2 g of line 7's spare
      s = fixtureState();
      run("product.pack", { name: "pavé de saumon", pack: { qty: 3, unit: "g" }, price: null });
      run("planning.commit", fixtureProposal());
      run("planning.commit", secondProposal());
      run("shopping.buy", { itemId: 8 });
      run("meal.drop", { mealId: 3 });
      expect(run("shopping.set_bought_qty", { itemId: 8, qty: 1 })).toEqual({ status: "applied", reason: null });
      const short = () => mealShortfalls(s).find((x) => x.mealId === 4 && x.productId === P.saumon)?.qty;
      const trimmed = short();
      const buy = op("shopping.buy", { itemId: 7 });
      send(buy);
      expect(short()).toBeLessThan(trimmed!);
      expect(run("undo", { targetOpId: buy.opId })).toEqual({ status: "applied", reason: null });
      expect(short()).toBe(trimmed);
    });

    it("is refused once the trimmed meal's shortfall was covered since", () => {
      run("shopping.buy", { itemId: line(P.comte).id });
      const set = op("shopping.set_bought_qty", { itemId: line(P.comte).id, qty: 150 });
      send(set);
      expect(run("meal.cover_shortfalls", { mealId: 2 })).toEqual({ status: "applied", reason: null });
      expect(run("undo", { targetOpId: set.opId })).toEqual(refusedWith("couvert depuis : impossible d'annuler"));
      expect(line(P.comte).qty).toBe(150);
    });
  });
});

describe("shopping.remove", () => {
  const comte = () => line(P.comte);
  const shortOf = (productId: number) => mealShortfalls(s).filter((x) => x.productId === productId).map((x) => [x.mealId, x.qty]);
  const held = (itemId: number) => s.reservations.filter((r) => r.stockItemId === itemId && r.releasedAt === null).map((r) => [r.mealId, r.qty]);
  const withComtePack = (qty: number) => {
    s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty, unit: "g" };
    run("planning.commit", fixtureProposal());
  };

  it("« On n'en prend pas »: the line leaves Courses with its quantity and price, its open meals' shares off it, and each meal it served is short by its share", () => {
    const before = structuredClone(comte());
    expect(before.forMeals).toEqual([{ mealId: 1, qty: 100 }, { mealId: 2, qty: 100 }]);
    expect(run("shopping.remove", { itemId: before.id, reason: "pas_achete" })).toEqual({ status: "applied", reason: null });
    expect(comte()).toEqual({ ...before, forMeals: [], removedAt: NOW });
    expect(shortOf(P.comte)).toEqual([[1, 100], [2, 100]]);
    expect(s.stockItems).toEqual([]);
    expect(invariantViolations(s).filter((v) => v.code !== "meal_under_covered")).toEqual([]);
    expect(snapshot(s, NOW).courses.lines.some((l) => l.id === before.id)).toBe(false);
  });

  it("« On en a déjà »: the line leaves Courses and its food enters Reste as a purchase would, each meal reserved its need, on no trip", () => {
    const before = structuredClone(comte());
    expect(run("shopping.remove", { itemId: before.id, reason: "a_la_maison" })).toEqual({ status: "applied", reason: null });
    expect(comte()).toEqual({ ...before, forMeals: [], removedAt: NOW });
    const item = s.stockItems.find((i) => i.productId === P.comte)!;
    expect(item).toMatchObject({ qty: 200, unit: "g", origin: "ajout", useBy: "2026-11-11", sourceShoppingItemId: null, finishedAt: null, openedAt: null });
    expect(held(item.id)).toEqual([[1, 100], [2, 100]]);
    expect(mealShortfalls(s)).toEqual([]);
    expect(invariantViolations(s)).toEqual([]);
    expect(snapshot(s, NOW).courses.lines.some((l) => l.id === before.id)).toBe(false);
    expect(run("trip.record", { place: "marche", date: "2026-10-12", itemIds: [before.id] })).toEqual({ status: "refused", reason: "panier modifié depuis" });
    expect(comte().tripId).toBeNull();
  });

  it("« On en a déjà » on a line whose pack exceeds its shares: the item holds what the meals need, not the pack, each reserved its share", () => {
    // Regression: c8ae3fe — the item took the pack-rounded line quantity, a pack nobody bought, so Reste showed 50 g libre
    withComtePack(250);
    expect(comte()).toMatchObject({ qty: 250, forMeals: [{ mealId: 1, qty: 100 }, { mealId: 2, qty: 100 }] });
    run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" });
    const item = s.stockItems.find((i) => i.productId === P.comte)!;
    expect(item.qty).toBe(200);
    expect(snapshot(s, NOW).reste.reserved.find((i) => i.id === item.id)!.libreQty).toBe(0);
    expect(held(item.id)).toEqual([[1, 100], [2, 100]]);
    expect(invariantViolations(s)).toEqual([]);
  });

  // Regression: 48a5c68 — « On en a déjà » on a line no open meal held a share of put its pack-rounded quantity in Reste, a quantity nobody counted
  it("« On en a déjà » on a line no open meal holds a share of puts an item of unknown quantity in Reste, unreserved", () => {
    withComtePack(250);
    run("meal.cook", { mealId: 1, sheet: {} });
    run("meal.cook", { mealId: 2, sheet: {} });
    const removed = comte();
    expect(removed.qty).toBe(250);
    run("shopping.remove", { itemId: removed.id, reason: "a_la_maison" });
    const item = s.stockItems.find((i) => i.productId === P.comte)!;
    expect(item).toMatchObject({ qty: null, unit: "g", qtyText: null, origin: "ajout" });
    expect(held(item.id)).toEqual([]);
    expect(invariantViolations(s)).toEqual([]);
  });

  it("« On en a déjà » puts in Reste only the shares its open meals hold, so a meal the line carried stays short beyond its share", () => {
    // 160 g at home reserved for the gratin (100) and the salade (60), a 250 g pack for the salade's other 40; a declared
    // 50 g then leaves the gratin holding 50 and the salade nothing at home: short 60 beyond its 40 on the line
    s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
    run("stock.add", { label: "comté", productId: P.comte, qtyText: "160 g", useBy: null });
    run("planning.commit", fixtureProposal());
    run("stock.partial", { itemId: s.stockItems[0]!.id, qtyText: "50 g", low: false });
    expect(comte()).toMatchObject({ qty: 250, forMeals: [{ mealId: 2, qty: 40 }] });
    expect(shortOf(P.comte)).toEqual([[1, 50], [2, 60]]);
    run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" });
    expect(s.stockItems).toHaveLength(2);
    const item = s.stockItems.at(-1)!;
    expect(item.qty).toBe(40);
    expect(held(item.id)).toEqual([[2, 40]]);
    // no pack bought, so no surplus: what the salade lacked beyond its share stays for « Manques », as the gratin's does
    expect(shortOf(P.comte)).toEqual([[1, 50], [2, 60]]);
  });

  describe("« On en a déjà » with free Reste stock", () => {
    // Regression: b6bb1ab — « On en a déjà » created a new item for the line's shares beside free stock of that product
    // already in Reste, so Reste showed the comté twice, the free item still libre
    const addComte = (qtyText: string, useBy: string | null = null) => {
      run("stock.add", { label: "comté", productId: P.comte, qtyText, useBy });
      return s.stockItems[s.stockItems.length - 1]!;
    };

    it("reserves free stock that covers every share and creates no item", () => {
      const free = addComte("250 g");
      const removed = comte().id;
      run("shopping.remove", { itemId: removed, reason: "a_la_maison" });
      expect(s.stockItems.map((i) => i.id)).toEqual([free.id]);
      expect(held(free.id)).toEqual([[1, 100], [2, 100]]);
      expect(mealShortfalls(s)).toEqual([]);
      expect(invariantViolations(s)).toEqual([]);
    });

    it("reserves what free stock holds, earliest use-by first, flags a meal « à cuisiner tôt », and puts only the remainder in a new item", () => {
      const late = addComte("60 g");
      const early = addComte("90 g", "2026-10-14");
      const removed = comte().id;
      run("shopping.remove", { itemId: removed, reason: "a_la_maison" });
      expect(held(early.id)).toEqual([[1, 90]]);
      expect(held(late.id)).toEqual([[1, 10], [2, 50]]);
      expect(s.stockItems).toHaveLength(3);
      const item = s.stockItems.at(-1)!;
      expect(item.qty).toBe(50);
      expect(held(item.id)).toEqual([[2, 50]]);
      expect(s.meals.find((m) => m.id === 1)!.cookEarlyReason).toBe("comté à utiliser avant mercredi 14");
      expect(s.meals.find((m) => m.id === 2)!.cookEarlyReason).toBeNull();
      expect(mealShortfalls(s)).toEqual([]);
      expect(invariantViolations(s)).toEqual([]);
    });

    it("gives the new item to each meal only what free stock left of its share, so an earlier meal never takes a later one's", () => {
      // Regression: b4cae6e — the new item's first pass capped each meal at its whole share, not its share less what free
      // stock gave it, so the gratin took the salade's food (over-covered) and the salade stayed short
      // the comté line holds 50 for the gratin and 100 for the salade; the gratin's other 50 is on a second unbought line
      const first = comte();
      first.qty = 150;
      first.forMeals = [{ mealId: 1, qty: 50 }, { mealId: 2, qty: 100 }];
      const secondId = Math.max(...s.shoppingItems.map((l) => l.id)) + 1;
      s.shoppingItems.push({ ...structuredClone(first), id: secondId, qty: 50, forMeals: [{ mealId: 1, qty: 50 }] });
      expect(invariantViolations(s)).toEqual([]);
      const free = addComte("60 g");
      run("shopping.remove", { itemId: first.id, reason: "a_la_maison" });
      expect(held(free.id)).toEqual([[1, 50], [2, 10]]);
      expect(s.stockItems).toHaveLength(2);
      const item = s.stockItems.at(-1)!;
      expect(item.qty).toBe(90);
      expect(held(item.id)).toEqual([[2, 90]]);
      expect(mealShortfalls(s)).toEqual([]);
      expect(invariantViolations(s)).toEqual([]);
    });

    it("leaves a Reste item marked « presque fini » of known quantity alone: an almost empty item must not cover a share", () => {
      // Regression: 287b132 — free stock reserved a share on a low item of known quantity, as a commit never does
      const low = addComte("150 g");
      low.isLow = true;
      run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" });
      expect(held(low.id)).toEqual([]);
      expect(s.stockItems).toHaveLength(2);
      const item = s.stockItems.at(-1)!;
      expect(item.qty).toBe(200);
      expect(held(item.id)).toEqual([[1, 100], [2, 100]]);
      expect(invariantViolations(s)).toEqual([]);
    });

    it("puts in Reste only what each meal still needs, whatever its share on the line", () => {
      // Regression: 287b132 — a share above the meal's remaining need put the excess in Reste, reserved for no one
      const line = comte();
      line.qty = 300;
      line.forMeals = [{ mealId: 1, qty: 200 }, { mealId: 2, qty: 100 }];
      run("shopping.remove", { itemId: line.id, reason: "a_la_maison" });
      expect(s.stockItems).toHaveLength(1);
      const item = s.stockItems[0]!;
      expect(item.qty).toBe(200);
      expect(held(item.id)).toEqual([[1, 100], [2, 100]]);
      expect(s.stockItems.every((i) => i.qty === 0 || held(i.id).reduce((n, [, q]) => n + q!, 0) === i.qty)).toBe(true);
    });

    describe("an item of unknown quantity", () => {
      // Regression: dbf5d1c — « On en a déjà » put a new item in Reste beside an unheld comté of unknown quantity
      // already there, so Reste showed the comté twice (the owners chose: the one meal still owed is reserved
      // on it; an unknown item holds one reservation at most)
      it("reserves the one meal still owed after known free stock on an unheld unknown item, and creates no item", () => {
        const free = addComte("100 g");
        const unknown = addComte("un morceau");
        expect(unknown.qty).toBeNull();
        run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" });
        expect(held(free.id)).toEqual([[1, 100]]);
        expect(held(unknown.id)).toEqual([[2, 100]]);
        expect(s.stockItems.map((i) => i.id)).toEqual([free.id, unknown.id]);
        expect(mealShortfalls(s)).toEqual([]);
        expect(invariantViolations(s)).toEqual([]);
      });

      it("takes the oldest unheld unknown item by creation, whatever their use-by, and flags an early one « à cuisiner tôt »", () => {
        const free = addComte("100 g");
        run("stock.add", { label: "comté", productId: P.comte, qtyText: "un bout", useBy: null }, "2026-10-12T09:00:00.000Z");
        const later = s.stockItems.at(-1)!;
        run("stock.add", { label: "comté", productId: P.comte, qtyText: "un morceau", useBy: "2026-10-14" }, "2026-10-12T08:00:00.000Z");
        const older = s.stockItems.at(-1)!;
        run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" });
        expect(held(free.id)).toEqual([[1, 100]]);
        expect(held(older.id)).toEqual([[2, 100]]);
        expect(held(later.id)).toEqual([]);
        expect(s.stockItems).toHaveLength(3);
        expect(s.meals.find((m) => m.id === 2)!.cookEarlyReason).toBe("comté à utiliser avant mercredi 14");
        expect(invariantViolations(s)).toEqual([]);
      });

      it("leaves an item marked « presque fini » alone: an almost empty item must not cover a whole share", () => {
        // Regression: e655752 — a low item of unknown quantity covered a meal's whole share
        const free = addComte("100 g");
        const unknown = addComte("un fond");
        unknown.isLow = true;
        run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" });
        expect(held(free.id)).toEqual([[1, 100]]);
        expect(held(unknown.id)).toEqual([]);
        expect(s.stockItems).toHaveLength(3);
        const item = s.stockItems.at(-1)!;
        expect(item.qty).toBe(100);
        expect(held(item.id)).toEqual([[2, 100]]);
        expect(invariantViolations(s)).toEqual([]);
      });

      it("leaves it alone when two meals are still owed: a new item holds both, as before", () => {
        const unknown = addComte("un morceau");
        run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" });
        expect(held(unknown.id)).toEqual([]);
        expect(s.stockItems).toHaveLength(2);
        const item = s.stockItems.at(-1)!;
        expect(item.qty).toBe(200);
        expect(held(item.id)).toEqual([[1, 100], [2, 100]]);
        expect(invariantViolations(s)).toEqual([]);
      });

      it("leaves it alone when a meal already holds it: a new item holds the one meal owed", () => {
        // the planning reserved the unknown comté for the gratin, so the line serves the salade alone
        s = fixtureState();
        run("stock.add", { label: "comté", productId: P.comte, qtyText: "un morceau", useBy: null });
        const unknown = s.stockItems[0]!;
        run("planning.commit", fixtureProposal());
        expect(held(unknown.id)).toEqual([[1, 100]]);
        expect(comte().forMeals).toEqual([{ mealId: 2, qty: 100 }]);
        run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" });
        expect(held(unknown.id)).toEqual([[1, 100]]);
        expect(s.stockItems).toHaveLength(2);
        const item = s.stockItems.at(-1)!;
        expect(item.qty).toBe(100);
        expect(held(item.id)).toEqual([[2, 100]]);
        expect(invariantViolations(s)).toEqual([]);
      });
    });
  });

  it("removes a staple line either way with no shortfall, and « On en a déjà » leaves its item unreserved", () => {
    const lentilles = () => line(P.lentilles);
    expect(lentilles().kind).toBe("staple_hors_budget");
    expect(lentilles().forMeals.length).toBeGreaterThan(0);
    expect(run("shopping.remove", { itemId: lentilles().id, reason: "pas_achete" }).status).toBe("applied");
    expect(mealShortfalls(s)).toEqual([]);
    expect(invariantViolations(s)).toEqual([]);

    s = fixtureState();
    run("planning.commit", fixtureProposal());
    expect(run("shopping.remove", { itemId: lentilles().id, reason: "a_la_maison" }).status).toBe("applied");
    // Regression: 48a5c68 — a staple line's item took the line's quantity, rounded to packs, though nobody counted what was home
    const item = s.stockItems.find((i) => i.productId === P.lentilles)!;
    expect(item).toMatchObject({ qty: null, unit: lentilles().unit, origin: "ajout" });
    expect(s.reservations).toEqual([]);
    expect(mealShortfalls(s)).toEqual([]);
  });

  it("« On en a déjà » puts no empty item in Reste: a line at 0, or one whose open meals' shares sum to 0", () => {
    // Regression: 9551f86 — a line with nothing left to put in Reste (quantity 0, nothing taken from free stock) entered
    // it as a 0 g item
    // no op leaves a listed line at 0 today; the guard keeps Reste free of empty items if one ever does
    const lentilles = line(P.lentilles);
    lentilles.qty = 0;
    run("shopping.remove", { itemId: lentilles.id, reason: "a_la_maison" });
    const shared = comte();
    shared.forMeals = shared.forMeals.map((f) => ({ ...f, qty: 0 }));
    run("shopping.remove", { itemId: shared.id, reason: "a_la_maison" });
    expect(s.stockItems).toEqual([]);
  });

  it("asks an old build to update when a planned line comes without a reason, and rejects any other reason", () => {
    expect(run("shopping.remove", { itemId: comte().id })).toEqual({ status: "refused", reason: "mettez l'application à jour" });
    expect(run("shopping.remove", { itemId: line(P.lentilles).id })).toEqual({ status: "refused", reason: "mettez l'application à jour" });
    for (const reason of [null, "", "A_LA_MAISON", "autre", 1, true]) {
      expect(run("shopping.remove", { itemId: comte().id, reason }), JSON.stringify(reason)).toEqual({ status: "refused", reason: "données invalides" });
    }
    expect(comte().removedAt).toBeNull();
  });

  it("refuses a bought line, refuses a removed planned one as already removed, and refuses a missing one", () => {
    // Regression: 900cae2 — an « On en a déjà » that lost a race to « On n'en prend pas » was answered noop, invisible on the phone
    run("shopping.buy", { itemId: comte().id });
    for (const reason of ["a_la_maison", "pas_achete"]) expect(run("shopping.remove", { itemId: comte().id, reason })).toEqual({ status: "refused", reason: "déjà acheté" });
    run("shopping.remove", { itemId: line(P.endive).id, reason: "pas_achete" });
    for (const reason of ["a_la_maison", "pas_achete", undefined]) {
      expect(run("shopping.remove", { itemId: line(P.endive).id, reason })).toEqual({ status: "refused", reason: "déjà retiré des courses" });
    }
    expect(s.stockItems.filter((i) => i.productId === P.endive)).toEqual([]);
    expect(run("shopping.remove", { itemId: 999, reason: "pas_achete" })).toEqual({ status: "refused", reason: "article introuvable" });
  });

  it("answers « déjà acheté » to an old build's removal of a bought planned line, not « mettez l'application à jour »", () => {
    // Regression: 6a8fcee — the missing-reason refusal came before the bought check, asking for an update that changes nothing
    run("shopping.buy", { itemId: comte().id });
    expect(run("shopping.remove", { itemId: comte().id })).toEqual({ status: "refused", reason: "déjà acheté" });
    expect(run("shopping.remove", { itemId: comte().id, reason: "autre" })).toEqual({ status: "refused", reason: "données invalides" });
  });

  it("rejects a malformed reason on an already removed planned line instead of answering noop", () => {
    // Regression: 6027cf8 — a present-but-invalid reason was answered « déjà retiré » once the line was removed
    run("shopping.remove", { itemId: line(P.endive).id, reason: "pas_achete" });
    for (const reason of [null, "", "autre", 1, true]) {
      expect(run("shopping.remove", { itemId: line(P.endive).id, reason }), JSON.stringify(reason)).toEqual({ status: "refused", reason: "données invalides" });
    }
    expect(run("shopping.remove", { itemId: line(P.endive).id })).toEqual({ status: "refused", reason: "déjà retiré des courses" });
  });

  it("rejects a malformed reason whatever the line: unknown, ajout or planned, changing nothing", () => {
    // Regression: a78dffe — an ajout and an unknown id were answered before a malformed reason was looked at
    run("shopping.add", { label: "lait", isFood: true });
    const ajout = s.shoppingItems.at(-1)!;
    const rows = () => structuredClone({ lines: s.shoppingItems, stock: s.stockItems, reservations: s.reservations, meals: s.meals });
    const before = rows();
    for (const reason of [null, "", "autre", "A_LA_MAISON", 1, true]) {
      for (const itemId of [999, ajout.id, comte().id]) {
        expect(run("shopping.remove", { itemId, reason }), `${itemId} ${JSON.stringify(reason)}`).toEqual({ status: "refused", reason: "données invalides" });
      }
    }
    expect(rows()).toEqual(before);
  });

  it("removes an unbought ajout without a reason, and never puts it in Reste", () => {
    run("shopping.add", { label: "lait", isFood: true });
    const ajout = s.shoppingItems.at(-1)!;
    expect(run("shopping.remove", { itemId: ajout.id })).toEqual({ status: "applied", reason: null });
    expect(s.shoppingItems.find((l) => l.id === ajout.id)!.removedAt).toBe(NOW);
    expect(s.stockItems).toEqual([]);
    run("shopping.add", { label: "pain", isFood: true });
    const pain = s.shoppingItems.at(-1)!;
    run("shopping.buy", { itemId: pain.id });
    expect(run("shopping.remove", { itemId: pain.id })).toEqual({ status: "refused", reason: "déjà acheté" });
  });

  describe("a tick in the shop that lands after the removal", () => {
    // Regression: eb5f0ee — a tick on a planned line the other phone removed bought it back; the owners chose to refuse it, so they re-add it as an ajout if they did buy it
    it("refuses the tick on a line removed either way: « retiré des courses », the line stays removed and nothing more enters Reste", () => {
      for (const reason of ["pas_achete", "a_la_maison"] as const) {
        s = fixtureState();
        run("planning.commit", fixtureProposal());
        const id = comte().id;
        run("shopping.remove", { itemId: id, reason });
        const removed = structuredClone(comte());
        const stock = structuredClone(s.stockItems);
        const reservations = structuredClone(s.reservations);
        expect(run("shopping.buy", { itemId: id }), reason).toEqual({ status: "refused", reason: "retiré des courses" });
        expect(comte()).toEqual(removed);
        expect(s.stockItems).toEqual(stock);
        expect(s.reservations).toEqual(reservations);
      }
    });

    it("refuses the tick on a line a drop removed, emptied or with a spare left, and puts nothing in Reste", () => {
      const saumon = line(P.saumon).id;
      run("meal.drop", { mealId: 3 });
      expect(line(P.saumon)).toMatchObject({ qty: 0, forMeals: [], removedAt: NOW });
      expect(run("shopping.buy", { itemId: saumon })).toEqual({ status: "refused", reason: "retiré des courses" });
      expect(line(P.saumon)).toMatchObject({ removedAt: NOW, boughtAt: null });
      s = fixtureState();
      s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
      run("planning.commit", fixtureProposal());
      const id = comte().id;
      // a pack changed since: 250 g is no multiple of it, so each drop cuts the line exactly and its 50 g spare stays
      s.products.find((p) => p.id === P.comte)!.pack = { qty: 300, unit: "g" };
      run("meal.drop", { mealId: 1 });
      run("meal.drop", { mealId: 2 });
      expect(comte()).toMatchObject({ qty: 50, forMeals: [], removedAt: NOW });
      expect(run("shopping.buy", { itemId: id })).toEqual({ status: "refused", reason: "retiré des courses" });
      expect(comte()).toMatchObject({ removedAt: NOW, boughtAt: null });
      expect(s.stockItems).toEqual([]);
    });

    it("refuses the tick on a removed ajout « article introuvable », as on an unknown line", () => {
      run("shopping.add", { label: "lait", isFood: true });
      const ajout = s.shoppingItems.at(-1)!;
      run("shopping.remove", { itemId: ajout.id });
      expect(run("shopping.buy", { itemId: ajout.id })).toEqual({ status: "refused", reason: "article introuvable" });
      expect(s.shoppingItems.find((l) => l.id === ajout.id)).toMatchObject({ removedAt: NOW, boughtAt: null });
      expect(run("shopping.buy", { itemId: 999 })).toEqual({ status: "refused", reason: "article introuvable" });
    });
  });

  // Regression: c19119b — the item « On en a déjà » put in Reste carried the line as its purchase link, though nothing was bought, so every reader of that link had to tell the two items apart
  it("« On en a déjà » links its item to no line: the purchase link names a bought item alone", () => {
    const id = comte().id;
    run("shopping.remove", { itemId: id, reason: "a_la_maison" });
    expect(s.stockItems).toHaveLength(1);
    expect(s.stockItems[0]).toMatchObject({ origin: "ajout", sourceShoppingItemId: null });
  });

  it("prices the rebuy of the item « On en a déjà » put in Reste from the product's priced lines, with no purchase link", () => {
    const removed = comte();
    expect(removed.estPriceCents).not.toBeNull();
    run("shopping.remove", { itemId: removed.id, reason: "a_la_maison" });
    const home = s.stockItems[0]!;
    expect(run("stock.finish", { itemId: home.id, resolution: "rebuy" }).status).toBe("applied");
    const rebuys = s.shoppingItems.filter((l) => l.productId === P.comte && l.id !== removed.id);
    expect(rebuys.map((l) => [l.qty, l.estPriceCents])).toEqual([[100, Math.round(removed.estPriceCents! / 2)], [100, Math.round(removed.estPriceCents! / 2)]]);
    expect(invariantViolations(s)).toEqual([]);
  });

  // Regression: 9b51474 — an ajout removed with a reason was applied, though the phone never sends one and « On en a déjà » means nothing for it
  it("rejects a reason on an ajout's removal, valid or not, before or after it was removed, changing nothing", () => {
    run("shopping.add", { label: "lait", isFood: true });
    const ajout = s.shoppingItems.at(-1)!;
    const rows = () => structuredClone({ lines: s.shoppingItems, stock: s.stockItems });
    const before = rows();
    for (const reason of ["a_la_maison", "pas_achete"]) {
      expect(run("shopping.remove", { itemId: ajout.id, reason }), reason).toEqual({ status: "refused", reason: "données invalides" });
    }
    expect(rows()).toEqual(before);
    run("shopping.remove", { itemId: ajout.id });
    expect(run("shopping.remove", { itemId: ajout.id, reason: "pas_achete" })).toEqual({ status: "refused", reason: "données invalides" });
    expect(run("shopping.remove", { itemId: ajout.id })).toEqual({ status: "noop", reason: "déjà retiré" });
  });

  it("removes a cooked meal's line: its share stays on the removed line, and nothing is short", () => {
    run("meal.cook", { mealId: 3, sheet: {} });
    expect(run("shopping.remove", { itemId: line(P.saumon).id, reason: "pas_achete" }).status).toBe("applied");
    expect(line(P.saumon).forMeals).toEqual([{ mealId: 3, qty: 250 }]);
    // a shared line keeps the cooked meal's share only: the open one's left with the removal
    run("meal.cook", { mealId: 1, sheet: {} });
    expect(run("shopping.remove", { itemId: comte().id, reason: "a_la_maison" }).status).toBe("applied");
    expect(comte().forMeals).toEqual([{ mealId: 1, qty: 100 }]);
    expect(mealShortfalls(s)).toEqual([]);
  });

  it("never lets a later planning, a cover or a drop's merge take a removed line's spare", () => {
    withComtePack(400);
    const removed = comte();
    expect(removed).toMatchObject({ qty: 400, forMeals: [{ mealId: 1, qty: 100 }, { mealId: 2, qty: 100 }] });
    run("shopping.remove", { itemId: removed.id, reason: "pas_achete" });
    const frozen = structuredClone(s.shoppingItems.find((l) => l.id === removed.id)!);
    const unchanged = () => expect(s.shoppingItems.find((l) => l.id === removed.id)).toEqual(frozen);
    const open = () => s.shoppingItems.filter((l) => l.productId === P.comte && l.removedAt === null);

    // planShopping: the new meal's 100 g fit the removed line's 200 g spare, yet go on a new line
    expect(run("planning.commit", secondProposal()).status).toBe("applied");
    unchanged();
    const meal4 = s.meals.at(-1)!.id;
    expect(open().map((l) => [l.qty, l.forMeals])).toEqual([[400, [{ mealId: meal4, qty: 100 }]]]);

    // coverNeed: the gratin's 100 g go into the open line's spare, never the removed one's
    expect(run("meal.cover_shortfalls", { mealId: 1 }).status).toBe("applied");
    unchanged();
    expect(open().map((l) => l.forMeals)).toEqual([[{ mealId: meal4, qty: 100 }, { mealId: 1, qty: 100 }]]);

    // mergeIntoSpare: dropping the gratin leaves the open line's share for the new meal, which fits the removed spare
    expect(run("meal.drop", { mealId: 1 }).status).toBe("applied");
    unchanged();
    expect(open().map((l) => l.forMeals)).toEqual([[{ mealId: meal4, qty: 100 }]]);
  });
});
