import { describe, expect, it } from "vitest";
import { applyOp } from "../../domain/ops/apply";
import { snapshot } from "../../domain/snapshot";
import { GRATIN_RECIPE, NOW, P, doubledFixtureProposal, fixtureProposal, fixtureState, op, sharedComteProposal } from "../../domain/test-fixtures";
import type { State } from "../../domain/types";
import { shortfallMeta } from "../format";
import { canRebuy, project, type View } from "./project";
import type { OutboxEntry } from "./types";

const base = snapshot(applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state, NOW);
const find = <L extends { label: string }>(lines: readonly L[], label: string): L => lines.find((l) => l.label === label)!;
const id = (label: string) => find(base.courses.lines, label).id;
let n = 0;
const entry = (type: string, payload: unknown, extra: Partial<OutboxEntry> = {}): OutboxEntry => {
  n += 1;
  return {
    op: { opId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, type, at: "2026-10-12T09:30:00.000Z", payload },
    label: type, seq: n, sends: 0, unrecorded: 0, failed: false, lastReason: null, ...extra,
  };
};

describe("project", () => {
  it("shows a waiting buy as bought, named by its own op id, and never touches the stored snapshot", () => {
    const before = structuredClone(base);
    const buy = entry("shopping.buy", { itemId: id("comté") });
    const view = project(base, [buy]);
    expect(find(view.courses.lines, "comté")).toMatchObject({ boughtAt: buy.op.at, buyOpId: buy.op.opId, pending: false });
    expect(base).toEqual(before);
  });

  // a row created offline has no server id, so nothing may name it until the server answers
  it("shows an ajout made offline as pending, with an id no server row has", () => {
    const view = project(base, [entry("shopping.add", { label: "  sel  ", isFood: false })]);
    const added = find(view.courses.lines, "sel");
    expect(added).toMatchObject({ pending: true, kind: "ajout", group: "ajouts", isFood: false, boughtAt: null, estPriceCents: null, buyOpId: null });
    expect(added.id).toBeLessThan(0);
    expect(base.courses.lines.every((l) => l.id > 0)).toBe(true);
  });

  it("shows neither a waiting op nor its undo; an undo of a buy the server holds puts the line back", () => {
    const buy = entry("shopping.buy", { itemId: id("comté") });
    expect(find(project(base, [buy, entry("undo", { targetOpId: buy.op.opId })]).courses.lines, "comté").boughtAt).toBeNull();
    // an undo the projection does not model (an ajout, a checkout) only works by skipping its target
    const add = entry("shopping.add", { label: "sel", isFood: false });
    expect(project(base, [add, entry("undo", { targetOpId: add.op.opId })]).courses.lines.some((l) => l.label === "sel")).toBe(false);
    const kept = entry("shopping.buy", { itemId: id("comté") });
    const trip = entry("trip.record", { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [id("comté")] });
    const undoneTrip = project(base, [kept, trip, entry("undo", { targetOpId: trip.op.opId })]);
    expect(find(undoneTrip.courses.lines, "comté")).toMatchObject({ boughtAt: kept.op.at, buyOpId: kept.op.opId });
    expect(undoneTrip.lastTrip).toEqual(base.lastTrip);
    const served = {
      ...base,
      courses: {
        ...base.courses,
        lines: base.courses.lines.map((l) =>
          l.label === "poireau" ? { ...l, boughtAt: NOW, buyOpId: "server-buy" } : l.label === "comté" ? { ...l, boughtAt: NOW, buyOpId: "other-buy" } : l),
      },
    };
    const undoneServed = project(served, [entry("undo", { targetOpId: "server-buy" })]).courses.lines;
    expect(find(undoneServed, "poireau")).toMatchObject({ boughtAt: null, buyOpId: null });
    expect(find(undoneServed, "comté")).toMatchObject({ boughtAt: NOW, buyOpId: "other-buy" });
  });

  // Regression: 56ff5cf — an undo the server refuses (its buy or trip is behind a checkout) still hid its target
  it("keeps a waiting buy or checkout shown when a checkout queued before its undo makes the server refuse it", () => {
    const buy = entry("shopping.buy", { itemId: id("comté") });
    const trip = entry("trip.record", { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [id("comté")] });
    const refusedUndo = project(base, [buy, trip, entry("undo", { targetOpId: buy.op.opId })]);
    expect(refusedUndo.courses.lines.some((l) => l.label === "comté")).toBe(false);
    expect(refusedUndo.lastTrip).toMatchObject({ id: -1, totalCents: 1250 });
    // a checkout taken back before the undo blocks nothing
    const tripBack = project(base, [buy, trip, entry("undo", { targetOpId: trip.op.opId }), entry("undo", { targetOpId: buy.op.opId })]);
    expect(find(tripBack.courses.lines, "comté")).toMatchObject({ boughtAt: null, buyOpId: null });
    expect(tripBack.lastTrip).toEqual(base.lastTrip);
    const poireau = entry("shopping.buy", { itemId: id("poireau") });
    const later = entry("trip.record", { place: "supermarche", totalCents: 800, date: "2026-10-12", itemIds: [id("poireau")] });
    expect(project(base, [buy, trip, poireau, later, entry("undo", { targetOpId: trip.op.opId })]).lastTrip).toMatchObject({ place: "supermarche", totalCents: 800 });
    // a checkout that does not list the bought line leaves its buy undoable
    const other = entry("trip.record", { place: "supermarche", totalCents: 800, date: "2026-10-12", itemIds: [id("poireau")] });
    expect(find(project(base, [buy, poireau, other, entry("undo", { targetOpId: buy.op.opId })]).courses.lines, "comté")).toMatchObject({ boughtAt: null, buyOpId: null });
    // an ajout is not on any trip until bought, so a checkout does not block undoing its add
    const add = entry("shopping.add", { label: "sel", isFood: false });
    expect(project(base, [add, trip, entry("undo", { targetOpId: add.op.opId })]).courses.lines.some((l) => l.label === "sel")).toBe(false);
  });

  // Regression: f6a1f81 — a checkout undone after a later checkout stayed shown, though the server undoes it
  it("takes an older waiting checkout off when it is undone after a later one", () => {
    const buy = entry("shopping.buy", { itemId: id("comté") });
    const trip = entry("trip.record", { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [id("comté")] });
    const poireau = entry("shopping.buy", { itemId: id("poireau") });
    const later = entry("trip.record", { place: "supermarche", totalCents: 800, date: "2026-10-12", itemIds: [id("poireau")] });
    const view = project(base, [buy, trip, poireau, later, entry("undo", { targetOpId: trip.op.opId })]);
    expect(find(view.courses.lines, "comté")).toMatchObject({ boughtAt: buy.op.at, buyOpId: buy.op.opId });
    expect(view.courses.lines.some((l) => l.label === "poireau")).toBe(false);
    expect(view.lastTrip).toMatchObject({ place: "supermarche", totalCents: 800 });
  });

  // Regression: 56ff5cf — a removal the server refuses (a planning line, a bought ajout) still took the line off
  it("takes off only an ajout not yet bought on a waiting removal", () => {
    const withAjouts = {
      ...base,
      courses: {
        ...base.courses,
        lines: [
          ...base.courses.lines.map((l) => ({ ...l, pending: undefined })),
          { ...find(base.courses.lines, "comté"), id: 98, label: "sel", kind: "ajout" as const, group: "ajouts" as const, qty: null, unit: null, estPriceCents: null },
          { ...find(base.courses.lines, "comté"), id: 99, label: "poivre", kind: "ajout" as const, group: "ajouts" as const, qty: null, unit: null, estPriceCents: null },
        ],
      },
    };
    const view = project(withAjouts, [
      entry("shopping.remove", { itemId: id("comté") }),
      entry("shopping.buy", { itemId: 98 }),
      entry("shopping.remove", { itemId: 98 }),
      entry("shopping.remove", { itemId: 99 }),
    ]);
    expect(find(view.courses.lines, "comté").boughtAt).toBeNull();
    expect(find(view.courses.lines, "sel").boughtAt).not.toBeNull();
    expect(view.courses.lines.some((l) => l.label === "poivre")).toBe(false);
  });

  it("takes a planned line off Courses on a waiting removal with a reason, and nothing else, but not one without or one bought", () => {
    for (const reason of ["a_la_maison", "pas_achete"]) {
      const view = project(base, [entry("shopping.remove", { itemId: id("comté"), reason })]);
      expect(view.courses.lines.some((l) => l.label === "comté")).toBe(false);
      expect(view.courses.lines).toHaveLength(base.courses.lines.length - 1);
      expect(view.reste).toEqual(project(base, []).reste);
      expect(view.menu.pool.map((m) => m.shortfalls)).toEqual(project(base, []).menu.pool.map((m) => m.shortfalls));
    }
    expect(find(project(base, [entry("shopping.remove", { itemId: id("comté"), reason: "autre" })]).courses.lines, "comté").boughtAt).toBeNull();
    const bought = project(base, [entry("shopping.buy", { itemId: id("comté") }), entry("shopping.remove", { itemId: id("comté"), reason: "pas_achete" })]);
    expect(find(bought.courses.lines, "comté").boughtAt).not.toBeNull();
  });

  // Regression: 9b51474 — the phone predicted an ajout gone under a valid reason, which the server now answers invalid
  it("keeps an ajout on Courses under a waiting removal with any reason, as the server answers it invalid", () => {
    const sel = project(base, [entry("shopping.add", { label: "sel", isFood: false })]).courses.lines.find((l) => l.label === "sel")!;
    const served = { ...base, courses: { ...base.courses, lines: [...base.courses.lines, { ...sel, id: 99, pending: undefined }] } };
    for (const reason of ["a_la_maison", "pas_achete"]) {
      expect(project(served, [entry("shopping.remove", { itemId: 99, reason })]).courses.lines.some((l) => l.label === "sel"), reason).toBe(true);
    }
    expect(project(served, [entry("shopping.remove", { itemId: 99 })]).courses.lines.some((l) => l.label === "sel")).toBe(false);
  });

  it("keeps an ajout on Courses under a waiting removal whose reason is malformed, as the server answers it invalid", () => {
    // Regression: 284d31c — the phone predicted an ajout gone under any reason, though the server refuses a malformed one
    const sel = project(base, [entry("shopping.add", { label: "sel", isFood: false })]).courses.lines.find((l) => l.label === "sel")!;
    const served = { ...base, courses: { ...base.courses, lines: [...base.courses.lines, { ...sel, id: 99, pending: undefined }] } };
    for (const reason of [null, "", "autre", 1]) {
      expect(project(served, [entry("shopping.remove", { itemId: 99, reason })]).courses.lines.some((l) => l.label === "sel"), JSON.stringify(reason)).toBe(true);
    }
  });

  it("takes the listed lines off on a trip without a receipt and leaves lastTrip alone; refuses a total beside it", () => {
    const real = { id: 4, date: "2026-10-10", place: "supermarche" as const, totalCents: null, noReceipt: null, createdAt: NOW };
    const withTrip = { ...base, lastTrip: real };
    const buy = entry("shopping.buy", { itemId: id("comté") });
    const view = project(withTrip, [buy, entry("trip.record", { place: "autre", date: "2026-10-12", itemIds: [id("comté")], noReceipt: true })]);
    expect(view.courses.lines.some((l) => l.label === "comté")).toBe(false);
    expect(view.lastTrip).toEqual(real);
    const withTotal = project(withTrip, [buy, entry("trip.record", { place: "autre", totalCents: 500, date: "2026-10-12", itemIds: [id("comté")], noReceipt: true })]);
    expect(find(withTotal.courses.lines, "comté").boughtAt).not.toBeNull();
    expect(withTotal.lastTrip).toEqual(real);
    // a real trip recorded first, then one without a receipt: the real one stays the last
    const poireau = entry("shopping.buy", { itemId: id("poireau") });
    const both = project(base, [
      buy, entry("trip.record", { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [id("comté")] }),
      poireau, entry("trip.record", { place: "autre", date: "2026-10-12", itemIds: [id("poireau")], noReceipt: true }),
    ]);
    expect(both.lastTrip).toMatchObject({ id: -1, place: "marche", totalCents: 1250 });
    expect(both.courses.lines.some((l) => l.label === "poireau")).toBe(false);
  });

  it("predicts nothing for a trip whose noReceipt is not a boolean, as the server refuses it", () => {
    // Regression: 26bb1a9 — a non-boolean noReceipt was projected as a receipt trip
    const buy = entry("shopping.buy", { itemId: id("comté") });
    for (const noReceipt of ["true", 1, 0, null, []]) {
      const view = project(base, [buy, entry("trip.record", { place: "marche", date: "2026-10-12", itemIds: [id("comté")], noReceipt })]);
      expect(find(view.courses.lines, "comté").boughtAt, JSON.stringify(noReceipt)).not.toBeNull();
      expect(view.lastTrip).toEqual(base.lastTrip);
    }
  });

  it("keeps a line another phone bought under that phone's buy when a waiting buy targets it", () => {
    const served = { ...base, courses: { ...base.courses, lines: base.courses.lines.map((l) => (l.label === "comté" ? { ...l, boughtAt: NOW, buyOpId: "other" } : l)) } };
    expect(find(project(served, [entry("shopping.buy", { itemId: id("comté") })]).courses.lines, "comté")).toMatchObject({ boughtAt: NOW, buyOpId: "other" });
  });

  it("leaves out an op en échec", () => {
    expect(find(project(base, [entry("shopping.buy", { itemId: id("comté") }, { failed: true })]).courses.lines, "comté").boughtAt).toBeNull();
  });

  it("on a checkout, drops the bought lines, keeps the estimate equal to the planning lines left, and shows the trip", () => {
    const view = project(base, [
      entry("shopping.buy", { itemId: id("comté") }),
      entry("trip.record", { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [id("comté")] }),
    ]);
    expect(view.courses.lines.some((l) => l.label === "comté")).toBe(false);
    expect(view.courses.estimateCents).toBe(base.courses.estimateCents - find(base.courses.lines, "comté").estPriceCents!);
    expect(view.courses.estimateCents).toBe(view.courses.lines.filter((l) => l.kind === "planning").reduce((s, l) => s + (l.estPriceCents ?? 0), 0));
    expect(view.lastTrip).toMatchObject({ id: -1, place: "marche", totalCents: 1250, date: "2026-10-12" });
  });

  // Regression: 1cd8641 — the projected receipt trip carried noReceipt false where the server stores null (shopping.ts recordTrip)
  it("projects a receipt trip with noReceipt null, as the server stores it, whether noReceipt was absent or false", () => {
    for (const noReceipt of [undefined, false]) {
      const payload = { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [id("comté")], ...(noReceipt === undefined ? {} : { noReceipt }) };
      const view = project(base, [entry("shopping.buy", { itemId: id("comté") }), entry("trip.record", payload)]);
      expect(view.lastTrip?.noReceipt, String(noReceipt)).toBeNull();
    }
  });

  // Regression: 6913337 — a checkout took every bought line off the basket, so a line the other phone bought, which the server now leaves there, vanished until the next snapshot
  it("on a checkout, drops only the lines it lists, and shows nothing when a listed line is not in the basket", () => {
    const served = { ...base, courses: { ...base.courses, lines: base.courses.lines.map((l) => (l.label === "poireau" ? { ...l, boughtAt: NOW, buyOpId: "other" } : l)) } };
    const view = project(served, [
      entry("shopping.buy", { itemId: id("comté") }),
      entry("trip.record", { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [id("comté")] }),
    ]);
    expect(view.courses.lines.some((l) => l.label === "comté")).toBe(false);
    expect(find(view.courses.lines, "poireau")).toMatchObject({ boughtAt: NOW, buyOpId: "other" });
    const refused = project(served, [entry("trip.record", { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [id("comté"), id("poireau")] })]);
    expect(find(refused.courses.lines, "poireau").boughtAt).toBe(NOW);
    expect(refused.lastTrip).toEqual(base.lastTrip);
  });

  it("sets a ticket total on the trip it names, and takes an ajout off the list", () => {
    const withTrip = { ...base, lastTrip: { id: 4, date: "2026-10-10", place: "supermarche" as const, totalCents: null, noReceipt: null, createdAt: NOW } };
    expect(project(withTrip, [entry("trip.set_total", { tripId: 4, totalCents: 4250 })]).lastTrip?.totalCents).toBe(4250);
    expect(project(withTrip, [entry("trip.set_total", { tripId: 3, totalCents: 4250 })]).lastTrip?.totalCents).toBeNull();
    const withAjout = project(base, [entry("shopping.add", { label: "sel", isFood: true })]);
    const sel = find(withAjout.courses.lines, "sel");
    const served = { ...base, courses: { ...base.courses, lines: [...base.courses.lines, { ...sel, id: 99, pending: undefined }] } };
    expect(project(served, [entry("shopping.remove", { itemId: 99 })]).courses.lines.some((l) => l.label === "sel")).toBe(false);
  });
});

describe("project: Menu and Reste", () => {
  // the doubled fixture planning with every line bought: comté (200 g) held 100 g each for the gratin (1) and the salade
  // (2), the saumon for the first round (3) of the doubled pair (4)
  let state: State = applyOp(fixtureState(), op("planning.commit", doubledFixtureProposal()), NOW).state;
  for (const line of [...state.shoppingItems]) state = applyOp(state, op("shopping.buy", { itemId: line.id }), NOW).state;
  const stocked = snapshot(state, NOW);
  const items = (v: View) => [...v.reste.urgent, ...v.reste.reserved, ...v.reste.libre, ...v.reste.placard];
  const item = (v: View, label: string) => items(v).find((i) => i.label === label);
  const comte = item(project(stocked, []), "comté")!;

  // a declared leftover of 50 g leaves the gratin (1) short of 50 g of comté and the salade (2) of 100 g (domain snapshot test)
  const short = applyOp(state, op("stock.partial", { itemId: comte.id, qtyText: "50 g", low: false }), NOW).state;
  const shortBase = snapshot(short, NOW);
  const shortOf = (v: View, mealId: number) => v.menu.pool.find((m) => m.id === mealId)?.shortfalls;

  it("clears the « manque » of the meal a waiting « Ajouter aux courses » covers, and of that meal alone", () => {
    expect(shortOf(project(shortBase, []), 2)).toEqual([{ label: "comté", qty: 100, unit: "g" }]);
    const view = project(shortBase, [entry("meal.cover_shortfalls", { mealId: 2 })]);
    expect(shortOf(view, 2)).toEqual([]);
    expect(shortOf(view, 1)).toEqual([{ label: "comté", qty: 50, unit: "g" }]);
    const served = snapshot(applyOp(short, op("meal.cover_shortfalls", { mealId: 2 }), NOW).state, NOW);
    expect(view.menu.pool.map((m) => [m.id, m.shortfalls])).toEqual(served.menu.pool.map((m) => [m.id, m.shortfalls]));
    expect(shortOf(project(shortBase, [entry("meal.cover_shortfalls", { mealId: 99 })]), 2)).toHaveLength(1);
  });

  it("shows the « manque » again when the waiting cover is undone, and reads a snapshot stored before the field as short of nothing", () => {
    const cover = entry("meal.cover_shortfalls", { mealId: 2 });
    expect(shortOf(project(shortBase, [cover, entry("undo", { targetOpId: cover.op.opId })]), 2)).toHaveLength(1);
    const older = structuredClone(shortBase);
    for (const m of older.menu.pool) delete m.shortfalls;
    expect(project(older, []).menu.pool.map((m) => m.shortfalls)).toEqual([undefined, undefined, undefined, undefined]);
    expect(shortfallMeta(project(older, []).menu.pool[1]!)).toBe("");
  });

  // the cheese story with no network, as the server will tell it
  it("cooks the gratin offline: the comté it ate leaves the item, which stays held 100 g for the salade, none of it libre", () => {
    const cook = entry("meal.cook", { mealId: 1, sheet: { verdict: "a_refaire", items: [] } });
    const view = project(stocked, [cook]);
    expect(view.menu.pool.map((m) => m.id)).toEqual([2, 3, 4]);
    expect(view.menu.recentlyCooked).toEqual([{ mealId: 1, cookedAt: cook.op.at, cookOpId: cook.op.opId, undoing: false, ...GRATIN_RECIPE }]);
    expect(item(view, "comté")).toMatchObject({ qty: 100, libreQty: 0, reservations: [{ mealId: 2, mealTitle: "Salade d'endives au comté", qty: 100, unit: "g" }] });
    expect(view.reste.reserved.some((i) => i.label === "comté")).toBe(true);
  });

  it("predicts a pre-made « Fini » (ifEmpty) as the server judges it: kept while the salade holds the comté, gone once emptied", () => {
    const premade = (mealId: number) => entry("meal.cook", { mealId, sheet: { items: [{ stockItemId: item(project(stocked, []), "comté")!.id, outcome: "fini", ifEmpty: true }] } });
    const first = premade(1);
    expect(item(project(stocked, [first]), "comté")).toMatchObject({ qty: 100 });
    expect(Object.values(project(stocked, [first, premade(2)]).reste).flat().some((i) => i.label === "comté")).toBe(false);
  });

  it("keeps a meal cooked offline readable: the recent meal carries the pool meal's recipe, without its « réservé » marks", () => {
    const gratin = project(stocked, []).menu.pool.find((m) => m.id === 1)!;
    expect(gratin.ingredients.some((i) => i.reserved)).toBe(true);
    const cook = entry("meal.cook", { mealId: 1, sheet: {} });
    const recent = project(stocked, [cook]).menu.recentlyCooked.find((m) => m.mealId === 1)!;
    expect(recent).toMatchObject({
      title: gratin.title, portions: gratin.portions, activeMin: gratin.activeMin, totalMin: gratin.totalMin, steps: gratin.steps,
      sourceUrl: gratin.sourceUrl, isSecondRound: false, nutrition: gratin.nutrition, cookOpId: cook.op.opId,
    });
    expect(recent.ingredients).toEqual(gratin.ingredients.map(({ reserved: _, ...i }) => i));
    // a pool meal an older app stored has no nutrition: the cooked one has none either, rather than a made-up null
    const older = { ...stocked, menu: { ...stocked.menu, pool: stocked.menu.pool.map(({ nutrition: _, ...m }) => m) } };
    expect("nutrition" in project(older, [cook]).menu.recentlyCooked.find((m) => m.mealId === 1)!).toBe(false);
  });

  it("agrees with the server on a doubled pair cooked offline: the first round stays at the double, the second has no recipe to gather", () => {
    const first = project(stocked, []).menu.pool.find((m) => m.id === 3)!;
    const cookFirst = entry("meal.cook", { mealId: 3, sheet: {} });
    const dropSecond = entry("meal.drop", { mealId: 4 });
    expect(project(stocked, [cookFirst, dropSecond]).menu.recentlyCooked.find((m) => m.mealId === 3)!.ingredients)
      .toEqual(first.ingredients.map(({ reserved: _, ...i }) => i));
    const second = project(stocked, [cookFirst, entry("meal.cook", { mealId: 4, sheet: {} })]).menu.recentlyCooked.find((m) => m.mealId === 4)!;
    expect(second).toMatchObject({ isSecondRound: true });
    expect("ingredients" in second || "nutrition" in second).toBe(false);
  });

  // a « fini » on an item another open meal holds needs a resolution, as the server decides
  it("shows nothing of a cook or a finish the server would refuse, and drops the holding meal on « Retirer le repas »", () => {
    const refusedCook = project(stocked, [entry("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comte.id, outcome: "fini" }] } })]);
    expect(refusedCook.menu.pool.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(refusedCook.menu.recentlyCooked).toEqual([]);
    expect(item(refusedCook, "comté")).toMatchObject({ qty: 200, reservations: [{ mealId: 1 }, { mealId: 2 }] });
    expect(item(project(stocked, [entry("stock.finish", { itemId: comte.id })]), "comté")).toBeDefined();
    const dropped = project(stocked, [entry("meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comte.id, outcome: "fini", resolution: "drop_meal" }] } })]);
    expect(dropped.menu.pool.map((m) => m.id)).toEqual([3, 4]);
    expect(item(dropped, "comté")).toBeUndefined();
    const rebought = project(stocked, [entry("stock.finish", { itemId: comte.id, resolution: "rebuy" })]);
    expect(rebought.menu.pool.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(item(rebought, "comté")).toBeUndefined();
    expect(rebought.menu.pool.find((m) => m.id === 1)!.reservedItems.some((r) => r.stockItemId === comte.id)).toBe(false);
  });

  it("refuses « Racheter » for a plat cuisiné, as the server does, and offers « Retirer le repas » only", () => {
    expect(canRebuy([{ qty: 100, unit: "g" }])).toBe(true);
    expect(canRebuy([{ qty: 100, unit: "g" }, { qty: null, unit: null }])).toBe(false);
    const cooked = project(stocked, [entry("meal.cook", { mealId: 3, sheet: {} })]);
    const plat = item(cooked, "Saumon aux lentilles et poireaux")!;
    expect(plat).toMatchObject({ pending: true, qty: null, reservations: [{ mealId: 4, qty: null }] });
    expect(canRebuy(plat.reservations)).toBe(false);
  });

  // a second round is cooked after its first round, never before
  it("cooks a second round only once its first round is cooked, and gives it the plat cuisiné in between", () => {
    expect(project(stocked, [entry("meal.cook", { mealId: 4, sheet: {} })]).menu.pool.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    const view = project(stocked, [entry("meal.cook", { mealId: 3, sheet: {} })]);
    const second = view.menu.pool.find((m) => m.id === 4)!;
    expect(second.firstRoundId).toBeNull();
    expect(second.reservedItems).toEqual([{ stockItemId: expect.any(Number), label: "Saumon aux lentilles et poireaux", qty: null, unit: null }]);
    expect(second.reservedItems[0]!.stockItemId).toBeLessThan(0);
    expect(item(view, "Saumon aux lentilles et poireaux")).toMatchObject({ useBy: "2026-10-15", daysLeft: 3 });
    // dropping the first round takes its open second round with it
    expect(project(stocked, [entry("meal.drop", { mealId: 3 })]).menu.pool.map((m) => m.id)).toEqual([1, 2]);
  });

  // a row created offline has no server id, so nothing may name it until the server answers
  it("shows an addition and an envie made offline as pending, with ids no server row has", () => {
    const view = project(stocked, [
      entry("stock.add", { label: "  olives ", productId: null, qtyText: null, useBy: null }),
      entry("envie.add", { text: "tarte aux poireaux", url: "https://example.org/tarte" }),
    ]);
    expect(item(view, "olives")).toMatchObject({ pending: true, reservations: [], useBy: null });
    expect(item(view, "olives")!.id).toBeLessThan(0);
    expect(view.reste.libre.at(-1)!.label).toBe("olives");
    expect(view.menu.envies.at(-1)).toMatchObject({ text: "tarte aux poireaux", url: "https://example.org/tarte", status: "ouverte", pending: true });
    // an op that names a pending row (a guessed id) changes nothing
    const pendingId = item(view, "olives")!.id;
    expect(item(project(stocked, [entry("stock.add", { label: "olives", productId: null, qtyText: null, useBy: null }), entry("stock.finish", { itemId: pendingId })]), "olives")).toBeDefined();
  });

  // Regression: 9076b77 — a malformed sheet entry was skipped and the cook still projected, and a blank envie, a
  // non-date use-by or a bad resolution were projected, though the server refuses each of them whole as « données invalides »
  it("shows nothing of an op whose payload the server refuses as invalid", () => {
    const untouched = project(stocked, []);
    const poireau = item(untouched, "poireau")!;
    const free = items(untouched).find((i) => i.reservations.length === 0)!;
    const malformed: [string, unknown][] = [
      ["meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: comte.id, outcome: "il_en_reste", qtyText: "un fond" }, { stockItemId: poireau.id }] } }],
      ["meal.cook", { mealId: 1, sheet: { verdict: "bof", items: [] } }],
      ["meal.cook", { mealId: 1, sheet: { note: 3 } }],
      ["meal.cook", { mealId: 1, sheet: { items: [{ stockItemId: poireau.id, outcome: "il_en_reste", low: "oui" }] } }],
      ["envie.add", { text: "   ", url: null }],
      ["envie.add", { text: "piège", url: "javascript:alert(1)" }],
      ["stock.set_use_by", { itemId: poireau.id, useBy: "demain" }],
      ["stock.finish", { itemId: free.id, resolution: "jeter" }],
      ["stock.add", { label: " ", productId: null, qtyText: null, useBy: null }],
      ["stock.add", { label: "olives", productId: null, qtyText: null, useBy: "bientôt" }],
    ];
    for (const [type, payload] of malformed) {
      expect(applyOp(state, op(type, payload), NOW).result, type).toEqual({ status: "refused", reason: "données invalides" });
      expect(project(stocked, [entry(type, payload)]), type).toEqual(untouched);
    }
  });

  it("moves an item between sections as its date or its holders change, by the server's rule", () => {
    const poireau = item(project(stocked, []), "poireau")!;
    const soon = project(stocked, [entry("stock.set_use_by", { itemId: poireau.id, useBy: "2026-10-13" })]);
    expect(soon.reste.urgent.map((i) => i.label)).toContain("poireau");
    expect(item(soon, "poireau")).toMatchObject({ useBy: "2026-10-13", daysLeft: 1 });
    const used = project(stocked, [entry("stock.partial", { itemId: poireau.id, qtyText: "un fond", low: true })]);
    expect(item(used, "poireau")).toMatchObject({ qtyText: "un fond", isLow: true });
    // both meals that held the comté gone: what is left of it is libre
    const freed = project(stocked, [entry("meal.drop", { mealId: 1 }), entry("meal.drop", { mealId: 2 })]);
    expect(freed.reste.libre.find((i) => i.label === "comté")).toMatchObject({ qty: 200, libreQty: 200, reservations: [] });
  });

  // Regression: beda49f — an « Il en reste » repeating the item's words is answered noop, so the undo of the
  // earlier one takes the item back to before both; the projection kept showing the later one
  it("shows nothing of an « Il en reste » repeating the last waiting one, as the server answers it noop", () => {
    const poireau = item(project(stocked, []), "poireau")!;
    const words = { itemId: poireau.id, qtyText: "un fond", low: false };
    const first = entry("stock.partial", words);
    const outbox = [first, entry("stock.partial", words), entry("undo", { targetOpId: first.op.opId })];
    const served = outbox.reduce((s, e) => applyOp(s, e.op, NOW).state, state);
    expect(item(project(stocked, outbox), "poireau")).toEqual(item(project(snapshot(served, NOW), []), "poireau"));
    expect(item(project(stocked, outbox), "poireau")).toMatchObject({ qtyText: poireau.qtyText, isLow: poireau.isLow });
    // a write in between and the server judges the repeat against it: shown, as applied
    const dated = [first, entry("stock.set_use_by", { itemId: poireau.id, useBy: "2026-10-30" }), entry("stock.partial", words), entry("undo", { targetOpId: first.op.opId })];
    expect(item(project(stocked, dated), "poireau")).toMatchObject({ qtyText: "un fond", isLow: false });
  });

  // Regression: 3f7d5b9 — a repeat was predicted noop only on identical words, though the server answers noop whenever the
  // row it leaves is unchanged: « 125 g » after « 125g » was shown applied, so the undo of the first seemed to keep it
  it("shows nothing of an « Il en reste » that leaves the item as the last waiting one did, in other words", () => {
    const poireau = item(project(stocked, []), "poireau")!;
    const amount = (v: View) => { const { qty, unit, qtyText, isLow } = item(v, "poireau")!; return { qty, unit, qtyText, isLow }; };
    for (const [said, again] of [["125g", "125 g"], ["1 kg", "1000 g"], ["un fond", "  un fond "]] as const) {
      const first = entry("stock.partial", { itemId: poireau.id, qtyText: said, low: false });
      const outbox = [first, entry("stock.partial", { itemId: poireau.id, qtyText: again, low: false }), entry("undo", { targetOpId: first.op.opId })];
      const served = outbox.reduce((s, e) => applyOp(s, e.op, NOW).state, state);
      expect(amount(project(stocked, outbox)), said).toEqual(amount(project(snapshot(served, NOW), [])));
      expect(amount(project(stocked, outbox)), said).toMatchObject({ qty: poireau.qty, qtyText: poireau.qtyText });
    }
  });

  it("marks a cooked meal whose undo waits, and never touches the stored snapshot", () => {
    const cookedState = applyOp(state, op("meal.cook", { mealId: 1, sheet: {} }), NOW).state;
    const base2 = snapshot(cookedState, NOW);
    const before = structuredClone(base2);
    const cookOpId = base2.menu.recentlyCooked[0]!.cookOpId!;
    expect(project(base2, [entry("undo", { targetOpId: cookOpId })]).menu.recentlyCooked[0]).toMatchObject({ mealId: 1, undoing: true });
    expect(project(base2, []).menu.recentlyCooked[0]).toMatchObject({ mealId: 1, undoing: false });
    expect(base2).toEqual(before);
  });

  // Regression: 484ac66 — every waiting cook counted as a write to every item, so an « Il en reste » repeated across the
  // cook of a meal that does not hold the item was shown applied, though the server answers it noop « déjà noté »
  it("still sees a repeated « Il en reste » as noop across a cook or a drop that does not touch its item", () => {
    const gratinCooked = applyOp(state, op("meal.cook", { mealId: 1, sheet: {} }), NOW).state; // comté: 100 g, the salade's
    const base2 = snapshot(gratinCooked, NOW);
    const words = { itemId: comte.id, qtyText: "un fond", low: false };
    const amount = (v: View) => { const { qty, unit, qtyText, libreQty } = item(v, "comté")!; return { qty, unit, qtyText, libreQty }; };
    for (const between of [entry("meal.cook", { mealId: 3, sheet: {} }), entry("meal.drop", { mealId: 3 })]) {
      const first = entry("stock.partial", words);
      const outbox = [first, between, entry("stock.partial", words), entry("undo", { targetOpId: first.op.opId })];
      const served = outbox.reduce((s, e) => applyOp(s, e.op, NOW).state, gratinCooked);
      expect(amount(project(base2, outbox)), between.op.type).toEqual(amount(project(snapshot(served, NOW), [])));
      expect(amount(project(base2, outbox)), between.op.type).toMatchObject({ qty: 100, qtyText: null });
    }
    // the salade, which holds it, cooked in between: « 50 g » trims its hold to 50 g, then 0 once it ate them, then 50 g;
    // the repeat lands, the undo is refused « modifié depuis », and the phone shows the 50 g
    const amountWords = { itemId: comte.id, qtyText: "50 g", low: false };
    const first = entry("stock.partial", amountWords);
    const outbox = [first, entry("meal.cook", { mealId: 2, sheet: {} }), entry("stock.partial", amountWords), entry("undo", { targetOpId: first.op.opId })];
    const served = outbox.reduce((s, e) => applyOp(s, e.op, NOW).state, gratinCooked);
    expect(amount(project(base2, outbox))).toEqual(amount(project(snapshot(served, NOW), [])));
    expect(amount(project(base2, outbox))).toMatchObject({ qty: 50, qtyText: null });
  });

  // Regression: 38c46e6 — the phone showed a declared « Il en reste » as text over the 0 the cook left, as the server did
  it("predicts a declared leftover as the server reads it: the words set the quantity, never a false zero", () => {
    const served = (outbox: OutboxEntry[]) => snapshot(outbox.reduce((s, e) => applyOp(s, e.op, NOW).state, state), NOW);
    const cases: OutboxEntry[][] = [
      // the gratin eats 100 g, the salade the other 100 g, « 125g » left: the ricotta story
      [entry("meal.cook", { mealId: 1, sheet: {} }), entry("meal.cook", { mealId: 2, sheet: { items: [{ stockItemId: comte.id, outcome: "il_en_reste", qtyText: "125g" }] } })],
      // nothing said once it was all eaten: unknown, not 0
      [entry("meal.cook", { mealId: 1, sheet: {} }), entry("meal.cook", { mealId: 2, sheet: { items: [{ stockItemId: comte.id, outcome: "il_en_reste" }] } })],
      // below what the gratin and the salade hold: taken as it is, their holds trimmed
      [entry("stock.partial", { itemId: comte.id, qtyText: "50 g", low: false })],
      // « 50 g » again after a cook took 100 g off: the server applies it, so the phone shows it
      [entry("stock.partial", { itemId: comte.id, qtyText: "250 g", low: false }), entry("meal.cook", { mealId: 1, sheet: {} }),
        entry("stock.partial", { itemId: comte.id, qtyText: "250 g", low: false })],
    ];
    // the shorter date an opened item gets from its product is not predicted
    const amount = (v: View) => { const { qty, unit, qtyText, libreQty } = item(v, "comté")!; return { qty, unit, qtyText, libreQty }; };
    for (const outbox of cases) expect(amount(project(stocked, outbox))).toEqual(amount(project(served(outbox), [])));
    expect(item(project(stocked, cases[0]!), "comté")).toMatchObject({ qty: 125, qtyText: null, libreQty: 125 });
    expect(item(project(stocked, cases[1]!), "comté")).toMatchObject({ qty: null, libreQty: null });
    expect(item(project(stocked, cases[2]!), "comté")).toMatchObject({ qty: 50, qtyText: null, libreQty: 0 });
    expect(item(project(stocked, cases[3]!), "comté")).toMatchObject({ qty: 250, qtyText: null });
  });

  // Regression: 309f2ec — a declared leftover below the meals' holds now trims them; the phone kept showing the old holds
  // on the Reste row and in the recipe views until the answer came
  it("trims the holds a declared leftover leaves no room for, on the Reste row and in the recipe views, as the server does", () => {
    const served = (outbox: OutboxEntry[]) => snapshot(outbox.reduce((s, e) => applyOp(s, e.op, NOW).state, state), NOW);
    const holds = (v: View) => ({
      item: item(v, "comté")!.reservations,
      pool: v.menu.pool.map((m) => [m.id, m.reservedItems.filter((r) => r.stockItemId === comte.id)]),
    });
    for (const outbox of [
      [entry("stock.partial", { itemId: comte.id, qtyText: "50 g", low: false })],
      [entry("stock.partial", { itemId: comte.id, qtyText: "un peu", low: false })],
      [entry("meal.cook", { mealId: 3, sheet: { items: [{ stockItemId: comte.id, outcome: "il_en_reste", qtyText: "150 g" }] } })],
    ]) {
      expect(holds(project(stocked, outbox))).toEqual(holds(project(served(outbox), [])));
    }
    expect(holds(project(stocked, [entry("stock.partial", { itemId: comte.id, qtyText: "50 g", low: false })])).item)
      .toEqual([expect.objectContaining({ mealId: 1, qty: 50 })]);
  });

  // Regression: 47db9e5 — the phone applied a sheet's answers in order, so an « Il en reste » before a « Fini » that drops
  // the salade counted its hold, as the server did
  it("settles a sheet's « Fini » answers before its « Il en reste », as the server does", () => {
    let s = fixtureState();
    s.stockItems.push({ id: 1, productId: P.comte, label: "comté", qty: 300, unit: "g", qtyText: null, isLow: false, useBy: null,
      openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW },
    { id: 9, productId: P.endive, label: "endive", qty: 400, unit: "g", qtyText: null, isLow: false, useBy: null,
      openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
    s = applyOp(s, op("planning.commit", fixtureProposal()), NOW).state; // the gratin (1) and the salade (2) hold 100 g of comté each
    s = applyOp(s, op("planning.commit", sharedComteProposal()), NOW).state; // the saumon gratiné (4) 100 g, the poulet (5) none left
    const cook = entry("meal.cook", { mealId: 1, sheet: { items: [
      { stockItemId: 1, outcome: "il_en_reste", qtyText: "50 g" }, { stockItemId: 9, outcome: "fini", resolution: "drop_meal" },
    ] } });
    const served = snapshot(applyOp(s, cook.op, NOW).state, NOW);
    const holds = (v: View) => item(v, "comté")!.reservations.map((r) => [r.mealId, r.qty]);
    expect(holds(project(snapshot(s, NOW), [cook]))).toEqual(holds(project(served, [])));
    expect(holds(project(served, []))).toEqual([[4, 50]]);
  });

  it("adds a free-text item with its words, no quantity, as the server does", () => {
    const view = project(stocked, [entry("stock.add", { label: "olives", productId: null, qtyText: "200 g", useBy: null })]);
    expect(item(view, "olives")).toMatchObject({ qty: null, unit: null, qtyText: "200 g" });
  });
});
