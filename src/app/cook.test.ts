import { describe, expect, it } from "vitest";
import { applyOp } from "../domain/ops/apply";
import { snapshot } from "../domain/snapshot";
import { NOW, doubledFixtureProposal, fixtureState, op } from "../domain/test-fixtures";
import type { State } from "../domain/types";
import { answerFor, cookPayload, FINI_IF_EMPTY, finiMeta, liveAsking, openingAnswers, othersHolding, unresolvedFini } from "./cook";
import { project, viewItems, type View, type ViewItem } from "./sync/project";
import type { OutboxEntry } from "./sync/types";

// meals 1 gratin and 2 salade share the comté, 3 is the saumon's first round, 4 its second round; every line bought
let stocked: State = applyOp(fixtureState(), op("planning.commit", doubledFixtureProposal()), NOW).state;
for (const line of [...stocked.shoppingItems]) stocked = applyOp(stocked, op("shopping.buy", { itemId: line.id }), NOW).state;
const firstCooked = applyOp(stocked, op("meal.cook", { mealId: 3, sheet: {} }), NOW).state;
const meal = (view: View, id: number) => view.menu.pool.find((m) => m.id === id)!;
const entry = (o: OutboxEntry["op"]): OutboxEntry => ({ op: o, label: o.type, seq: 1, sends: 0, unrecorded: 0, failed: false, lastReason: null });

describe("the Cuisiné sheet", () => {
  // a second round eats its first round's plat cuisiné, so its sheet opens with « Fini » on it
  it("opens a second round's sheet with « Fini » on its plat cuisiné, which the cook finishes; cleared, the plat stays", () => {
    const view = project(snapshot(firstCooked, NOW), []);
    const second = meal(view, 4);
    const plat = second.reservedItems[0]!.stockItemId;
    expect(second.reservedItems).toEqual([{ stockItemId: plat, label: "Saumon aux lentilles et poireaux", qty: null, unit: null }]);
    const answers = openingAnswers(second, viewItems(view));
    expect(answers).toEqual({ [plat]: { outcome: "fini", qtyText: "", low: false, resolution: null, heldBy: [] } });

    const payload = cookPayload(second, viewItems(view), null, "", answers);
    expect(payload).toEqual({ mealId: 4, sheet: { verdict: null, note: null, items: [{ stockItemId: plat, outcome: "fini" }] } });
    const cooked = applyOp(firstCooked, op("meal.cook", payload), NOW);
    expect(cooked.result.status).toBe("applied");
    expect(cooked.state.stockItems.find((i) => i.id === plat)!.finishedAt).toBe(NOW);

    // a tap on « Fini » clears it (Toggles): the sheet then says nothing of the plat, which stays in Reste
    const cleared = cookPayload(second, viewItems(view), null, "", { ...answers, [plat]: undefined });
    expect(cleared.sheet.items).toEqual([]);
    const kept = applyOp(firstCooked, op("meal.cook", cleared), NOW);
    expect(kept.result.status).toBe("applied");
    expect(kept.state.stockItems.find((i) => i.id === plat)!.finishedAt).toBeNull();
  });

  it("opens with « Fini » on an item the cook empties, never on one it leaves some of, of unknown quantity, or another meal holds", () => {
    const fini = { outcome: "fini", qtyText: "", low: false, resolution: null, heldBy: [], ifEmpty: true };
    const held = (stockItemId: number, qty: number | null, unit: "g" | null = "g") => ({ stockItemId, label: "x", qty, unit });
    const viewItem = (id: number, qty: number | null, others = false) =>
      ({ id, qty, unit: qty === null ? null : "g", reservations: [{ mealId: 9, mealTitle: "", qty, unit: "g" }, ...(others ? [{ mealId: 8, mealTitle: "", qty: 1, unit: "g" }] : [])] }) as unknown as ViewItem;
    const m = { id: 9, isSecondRound: false, reservedItems: [held(1, 200), held(2, 150), held(3, 100), held(4, 100), held(5, 100), held(5, 50), held(6, null, null), held(7, 0)] };
    const items = [viewItem(1, 200), viewItem(2, 200), viewItem(3, null), viewItem(4, 100, true), viewItem(5, 150), viewItem(6, 0), viewItem(7, 0)];
    // 1 emptied; 2 leaves 50 g; 3 unknown; 4 held by meal 8 too; 5 emptied through two reservations; 6 and 7 already at 0, held with no quantity in its unit:
    // the cook subtracts nothing, so finishing them is not its tap to make
    expect(openingAnswers(m, items)).toEqual({ 1: fini, 5: fini });

    // sent as ifEmpty, the server's to judge when the cook lands; a pre-made « Fini » never asks the warning
    const answers = openingAnswers(m, items);
    expect(cookPayload(m, items, null, "", answers).sheet.items).toEqual([
      { stockItemId: 1, outcome: "fini", ifEmpty: true }, { stockItemId: 5, outcome: "fini", ifEmpty: true },
    ]);
    const sharedNow = items.map((i) => i.id === 1 ? { ...i, reservations: [...i.reservations, { mealId: 8, mealTitle: "Salade", qty: 1, unit: "g" as const }] } : i);
    expect(unresolvedFini(m, sharedNow, answers)).toBeNull();
    expect(finiMeta(m, items, 1, answers[1])).toBe(FINI_IF_EMPTY);
    // another meal took hold since the sheet opened: the server will keep the item, and the sheet says so
    expect(finiMeta(m, sharedNow, 1, answers[1])).toBe("Réservé pour Salade : restera au Reste");
  });

  it("opens the shared and unsynced cases with nothing answered, a second round's whose plat is not synced yet too", () => {
    const view = project(snapshot(stocked, NOW), []);
    for (const id of [1, 2]) {
      const m = meal(view, id);
      const shared = m.reservedItems.filter((r) => viewItems(view).find((i) => i.id === r.stockItemId)!.reservations.some((h) => h.mealId !== id));
      expect(shared.length).toBeGreaterThan(0); // the comté both meals hold
      for (const r of shared) expect(openingAnswers(m, viewItems(view))[r.stockItemId]).toBeUndefined();
    }
    // the first round cooked offline: its plat cuisiné is « en attente » (negative id), which no op may name
    const offline = project(snapshot(stocked, NOW), [entry({ opId: "cook-3", type: "meal.cook", at: NOW, payload: { mealId: 3, sheet: {} } })]);
    const second = meal(offline, 4);
    expect(second.reservedItems[0]!.stockItemId).toBeLessThan(0);
    expect(openingAnswers(second, viewItems(offline))).toEqual({});
  });

  it("sends the verdict, the note trimmed, and each answered item once: words trimmed or null, the warning's resolution, nothing for an item gone", () => {
    const view = project(snapshot(stocked, NOW), []);
    const gratin = { ...meal(view, 1) };
    gratin.reservedItems = [...gratin.reservedItems, gratin.reservedItems[1]!]; // the comté held through two reservations
    const answers = {
      1: { outcome: "il_en_reste" as const, qtyText: "  un bout ", low: true, resolution: null, heldBy: [] },
      2: { outcome: "fini" as const, qtyText: "", low: false, resolution: "drop_meal" as const, heldBy: [2] },
      4: { outcome: "il_en_reste" as const, qtyText: "   ", low: false, resolution: null, heldBy: [] },
    };
    expect(cookPayload(gratin, viewItems(view), "a_refaire", "  un peu trop cuit ", answers)).toEqual({
      mealId: 1,
      sheet: {
        verdict: "a_refaire",
        note: "un peu trop cuit",
        items: [
          { stockItemId: 1, outcome: "il_en_reste", qtyText: "un bout", low: true },
          { stockItemId: 2, outcome: "fini", resolution: "drop_meal" },
          { stockItemId: 4, outcome: "il_en_reste", qtyText: null, low: false },
        ],
      },
    });
    // the crème fraîche finished on the other phone since the sheet opened: its answer names nothing
    const gone = viewItems(view).filter((i) => i.id !== 4);
    expect(cookPayload(gratin, gone, null, "", answers).sheet).toEqual({
      verdict: null, note: null, items: [{ stockItemId: 1, outcome: "il_en_reste", qtyText: "un bout", low: true }, { stockItemId: 2, outcome: "fini", resolution: "drop_meal" }],
    });
  });
});

describe("the Cuisiné sheet's answers", () => {
  it("opens « Il en reste » empty on an item that holds a number, and sends a bare number in the unit shown beside it", () => {
    const view = project(snapshot(stocked, NOW), []);
    const gratin = meal(view, 1);
    const comte = viewItems(view).find((i) => i.label === "comté")!;
    expect(comte).toMatchObject({ qty: 200, unit: "g", qtyText: null });
    const answer = answerFor(comte, "il_en_reste");
    expect(answer.qtyText).toBe("");
    const payload = cookPayload(gratin, viewItems(view), null, "", { [comte.id]: { ...answer, qtyText: " 125 " } });
    expect(payload.sheet.items).toEqual([{ stockItemId: comte.id, outcome: "il_en_reste", qtyText: "125 g", low: false }]);
    const cooked = applyOp(stocked, op("meal.cook", payload), NOW);
    expect(cooked.state.stockItems.find((i) => i.id === comte.id)).toMatchObject({ qty: 125, qtyText: null });
  });

  it("sends a bare number as typed on an item with no unit at all, a plat cuisiné", () => {
    const view = project(snapshot(firstCooked, NOW), []);
    const second = meal(view, 4);
    const plat = second.reservedItems[0]!.stockItemId;
    const payload = cookPayload(second, viewItems(view), null, "", { [plat]: { outcome: "il_en_reste", qtyText: "2", low: false, resolution: null, heldBy: [] } });
    expect(payload.sheet.items).toEqual([{ stockItemId: plat, outcome: "il_en_reste", qtyText: "2", low: false }]);
  });

  // a sheet's defaults change nothing the cook did not touch: « Il en reste » opens with the item's own words and « Presque fini »; a cook who types nothing keeps both
  it("keeps an item's words and « Presque fini » when « Il en reste » is chosen and nothing typed", () => {
    const comte = stocked.stockItems.find((i) => i.label.toLowerCase().includes("comté"))!;
    const marked = applyOp(stocked, op("stock.partial", { itemId: comte.id, qtyText: "un demi-pot", low: true }), NOW);
    expect(marked.result.status).toBe("applied");
    const view = project(snapshot(marked.state, NOW), []);
    const gratin = meal(view, 1);
    const item = viewItems(view).find((i) => i.id === comte.id);
    expect(item).toMatchObject({ qtyText: "un demi-pot", isLow: true });

    const payload = cookPayload(gratin, viewItems(view), null, "", { [comte.id]: answerFor(item, "il_en_reste") });
    const cooked = applyOp(marked.state, op("meal.cook", payload), NOW);
    expect(cooked.result.status).toBe("applied");
    expect(cooked.state.stockItems.find((i) => i.id === comte.id)).toMatchObject({ qtyText: "un demi-pot", isLow: true });
  });

  // a plat another open meal holds needs the §10.4 warning first, so « Fini » is never preselected on it
  it("preselects nothing on a second round's plat that another meal also holds", () => {
    const second = { id: 4, isSecondRound: true, reservedItems: [{ stockItemId: 9, label: "Saumon aux lentilles et poireaux", qty: null, unit: null }] };
    const plat: ViewItem = {
      id: 9, label: "Saumon aux lentilles et poireaux", qty: null, unit: null, qtyText: null, isLow: false, useBy: null, daysLeft: null, libreQty: null,
      reservations: [{ mealId: 4, mealTitle: "Saumon", qty: null, unit: null }, { mealId: 7, mealTitle: "Autre", qty: null, unit: null }],
      isStaple: false, pending: false,
    };
    expect(openingAnswers(second, [plat])).toEqual({});
    // control: held by the second round alone, the same plat opens with « Fini »
    expect(openingAnswers(second, [{ ...plat, reservations: [plat.reservations[0]!] }])).toEqual({ 9: { outcome: "fini", qtyText: "", low: false, resolution: null, heldBy: [] } });
  });
});

describe("the Cuisiné sheet's « Valider »", () => {
  // Regression: 5a8b2a9 — a « Fini » tapped while the item had no other holder was sent with no resolution
  // after a refresh showed another open meal holding it, and the domain refused the whole meal.cook, verdict and note too
  it("asks the warning for a « Fini » another open meal has taken hold of since the tap, and only for that", () => {
    const view = project(snapshot(stocked, NOW), []);
    const gratin = meal(view, 1);
    const comte = viewItems(view).find((i) => i.reservations.some((r) => r.mealId === 2))!;
    const fini = { [comte.id]: { outcome: "fini" as const, qtyText: "", low: false, resolution: null, heldBy: [] } };
    // when « Fini » was tapped, the gratin alone held the comté: no warning, no resolution
    const alone = viewItems(view).map((i) => (i.id === comte.id ? { ...i, reservations: i.reservations.filter((r) => r.mealId === 1) } : i));
    expect(unresolvedFini(gratin, alone, fini)).toBeNull();
    // since then the salade holds it too: sent as it stands, the domain refuses the whole cook
    expect(applyOp(stocked, op("meal.cook", cookPayload(gratin, viewItems(view), "a_refaire", "bon", fini)), NOW).result.status).toBe("refused");
    expect(unresolvedFini(gratin, viewItems(view), fini)).toBe(comte.id);
    // with the warning's resolution, or as « Il en reste », or « en attente », there is nothing to ask
    expect(unresolvedFini(gratin, viewItems(view), { [comte.id]: { ...fini[comte.id]!, resolution: "drop_meal", heldBy: [2] } })).toBeNull();
    expect(unresolvedFini(gratin, viewItems(view), { [comte.id]: answerFor(comte, "il_en_reste") })).toBeNull();
    expect(unresolvedFini(gratin, viewItems(view).filter((i) => i.id !== comte.id), fini)).toBeNull();
    const resolved = cookPayload(gratin, viewItems(view), "a_refaire", "bon", { [comte.id]: { ...fini[comte.id]!, resolution: "drop_meal", heldBy: [2] } });
    expect(applyOp(stocked, op("meal.cook", resolved), NOW).result.status).toBe("applied");
  });

  // Regression: c8dae8a — a resolution chosen while the salade alone held the comté covered a third meal planned on it
  // since: « Retirer le repas » would have dropped that meal too, never named by the warning
  it("asks again for a resolution chosen for fewer meals than hold the item now, and not for one that named them all", () => {
    const view = project(snapshot(stocked, NOW), []);
    const gratin = meal(view, 1);
    const comte = viewItems(view).find((i) => i.reservations.some((r) => r.mealId === 2))!;
    const chosen = { [comte.id]: { outcome: "fini" as const, qtyText: "", low: false, resolution: "drop_meal" as const, heldBy: [2] } };
    expect(unresolvedFini(gratin, viewItems(view), chosen)).toBeNull();
    // since then the other phone planned a third meal on the comté
    const third = { mealId: 7, mealTitle: "Quiche", qty: 50, unit: "g" as const };
    const grown = viewItems(view).map((i) => (i.id === comte.id ? { ...i, reservations: [...i.reservations, third] } : i));
    expect(unresolvedFini(gratin, grown, chosen)).toBe(comte.id);
    expect(unresolvedFini(gratin, grown, { [comte.id]: { ...chosen[comte.id]!, heldBy: [2, 7] } })).toBeNull();
    // fewer holders since (the salade dropped, the quiche alone named) never asks again: the resolution still covers it
    const shrunk = viewItems(view).map((i) => (i.id === comte.id ? { ...i, reservations: [...i.reservations.filter((r) => r.mealId !== 2), third] } : i));
    expect(unresolvedFini(gratin, shrunk, { [comte.id]: { ...chosen[comte.id]!, heldBy: [2, 7] } })).toBeNull();
  });
});

describe("the Cuisiné sheet's reservation warning", () => {
  // Regression: 19f9aac — a refresh that took the asked item out of the warning's reach (finished with « Racheter » or
  // its other holder dropped on the other phone) left the warning asked for no item, and « Valider » off for good
  it("is shown only while the meal holds the item and another open meal holds it too, judged against the view now", () => {
    const view = project(snapshot(stocked, NOW), []);
    const gratin = meal(view, 1);
    const comte = viewItems(view).find((i) => i.reservations.some((r) => r.mealId === 2))!;
    expect(liveAsking(gratin, viewItems(view), comte.id)).toBe(comte.id);
    expect(liveAsking(gratin, viewItems(view), null)).toBeNull();
    // the other phone finished the comté with « Racheter »: it left Reste, and the gratin no longer holds it
    const rebought = applyOp(stocked, op("stock.finish", { itemId: comte.id, resolution: "rebuy" }), NOW);
    expect(rebought.result.status).toBe("applied");
    const after = project(snapshot(rebought.state, NOW), []);
    expect(liveAsking(meal(after, 1), viewItems(after), comte.id)).toBeNull();
    // the other phone dropped the salade: the gratin alone holds the comté, there is nothing left to ask
    const dropped = project(snapshot(applyOp(stocked, op("meal.drop", { mealId: 2 }), NOW).state, NOW), []);
    expect(othersHolding(meal(dropped, 1), viewItems(dropped), comte.id)).toEqual([]);
    expect(liveAsking(meal(dropped, 1), viewItems(dropped), comte.id)).toBeNull();
  });
});

describe("the line under a « Fini » answered through the warning", () => {
  // Regression: 6ca8c91 — once a refresh showed no other meal holding the item, the line read « Fini ·  : retiré du menu »
  it("names the other meals holding the item now, and reads as a plain « Fini » once none does", () => {
    const view = project(snapshot(stocked, NOW), []);
    const comte = viewItems(view).find((i) => i.reservations.some((r) => r.mealId === 2))!;
    const salade = meal(view, 2).title;
    const dropMeal = { outcome: "fini" as const, qtyText: "", low: false, resolution: "drop_meal" as const, heldBy: [2] };
    expect(finiMeta(meal(view, 1), viewItems(view), comte.id, dropMeal)).toBe(`Fini · ${salade} : retiré du menu`);
    expect(finiMeta(meal(view, 1), viewItems(view), comte.id, { ...dropMeal, resolution: "rebuy" })).toBe(`Fini · racheté pour ${salade}`);
    expect(finiMeta(meal(view, 1), viewItems(view), comte.id, { ...dropMeal, resolution: null, heldBy: [] })).toBeNull();
    expect(finiMeta(meal(view, 1), viewItems(view), comte.id, undefined)).toBeNull();
    // the other phone dropped the salade: the resolution does nothing now, and the line says nothing of it
    const dropped = project(snapshot(applyOp(stocked, op("meal.drop", { mealId: 2 }), NOW).state, NOW), []);
    expect(finiMeta(meal(dropped, 1), viewItems(dropped), comte.id, dropMeal)).toBeNull();
  });
});
