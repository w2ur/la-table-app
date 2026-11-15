import { describe, expect, it } from "vitest";
import { applyOp } from "../domain/ops/apply";
import { NOW, P, fixtureProposal, fixtureState, op } from "../domain/test-fixtures";
import type { State } from "../domain/types";
import { boughtText } from "./bought";
import { cliDeps as deps, fakeWorker as fakeServer } from "./fake-worker";

/** fixtureProposal() committed and its comté line (200 g, 100 g for the gratin and 100 g for the salade) bought. */
function boughtComte(): { state: State; lineId: number; itemId: number } {
  let s = fixtureState();
  s = applyOp(s, op("planning.commit", fixtureProposal()), NOW).state;
  const lineId = s.shoppingItems.find((l) => l.productId === P.comte)!.id;
  s = applyOp(s, op("shopping.buy", { itemId: lineId }), NOW).state;
  return { state: s, lineId, itemId: s.stockItems.find((i) => i.sourceShoppingItemId === lineId)!.id };
}
const ask = (lineId: number, words: string, confirmed = false) => ({ lineId, words, confirmed });

describe("plan bought", () => {
  it("parses the words in the line's unit, sends shopping.set_bought_qty and prints the line and its Reste item before and after", async () => {
    const { state, lineId, itemId } = boughtComte();
    const server = fakeServer(state);
    const r = await boughtText(ask(lineId, "1,2 kg"), deps(server.fetch));
    expect(server.posted).toEqual([{ type: "shopping.set_bought_qty", payload: { itemId: lineId, qty: 1200 } }]);
    expect(r).toEqual({ exitCode: 0, output: `~ comté : 200 g → 1,2 kg · Reste #${itemId} 200 g → 1,2 kg` });
    expect(server.state.shoppingItems.find((l) => l.id === lineId)).toMatchObject({ qty: 1200, plannedQty: 200 });
  });

  it("names each meal a lower quantity left short", async () => {
    const { state, lineId, itemId } = boughtComte();
    const r = await boughtText(ask(lineId, "150 g"), deps(fakeServer(state).fetch));
    expect(r).toEqual({
      exitCode: 0,
      output: `~ comté : 200 g → 150 g · Reste #${itemId} 200 g → 150 g\n  ! #2 Salade d'endives au comté : il manque comté 50 g (plan -- manques 2)`,
    });
  });

  it("prints = when the line already has that quantity", async () => {
    const { state, lineId } = boughtComte();
    const r = await boughtText(ask(lineId, "200g"), deps(fakeServer(state).fetch));
    expect(r).toEqual({ exitCode: 0, output: "= comté : 200 g" });
  });

  it("sends nothing and exits 1 for an unknown line, a line without a product, or words that are no quantity in its unit", async () => {
    const { state, lineId } = boughtComte();
    state.shoppingItems.push({ ...state.shoppingItems.find((l) => l.id === lineId)!, id: 90, productId: null, label: "pain", qty: null, unit: null });
    const server = fakeServer(state);
    const outputs = [];
    for (const [id, words] of [[99, "1 kg"], [90, "1 kg"], [lineId, "un gros bout"], [lineId, "1 l"], [lineId, "1200"]] as const) {
      const r = await boughtText(ask(id, words), deps(server.fetch));
      expect(r.exitCode).toBe(1);
      outputs.push(r.output);
    }
    expect(outputs).toEqual([
      "Rien n'est envoyé : #99 n'est pas sur Courses.",
      "Rien n'est envoyé : #90 pain est un article sans produit.",
      "Rien n'est envoyé : « un gros bout » n'est pas une quantité de comté en g.",
      "Rien n'est envoyé : « 1 l » n'est pas une quantité de comté en g.",
      "Rien n'est envoyé : « 1200 » n'est pas une quantité de comté en g.",
    ]);
    expect(server.posted).toEqual([]);
  });

  it("refuses more than 10 times the line without --oui, and sends it with", async () => {
    const { state, lineId } = boughtComte();
    const server = fakeServer(state);
    const r = await boughtText(ask(lineId, "2,1 kg"), deps(server.fetch));
    expect(r).toEqual({ exitCode: 1, output: "Rien n'est envoyé : 2,1 kg pour 200 g prévus, plus de 10 fois ; relancez avec --oui si le ticket le dit." });
    expect(server.posted).toEqual([]);
    // exactly 10 times needs no --oui
    expect((await boughtText(ask(lineId, "2 kg"), deps(server.fetch))).exitCode).toBe(0);
    expect((await boughtText(ask(lineId, "21 kg", true), deps(server.fetch))).exitCode).toBe(0);
    expect(server.posted.map((p) => p.payload)).toEqual([{ itemId: lineId, qty: 2000 }, { itemId: lineId, qty: 21000 }]);
  });

  it("measures the 10 times against the planned quantity, so a second correction cannot drift from the first", async () => {
    const { state, lineId } = boughtComte();
    const server = fakeServer(state);
    expect((await boughtText(ask(lineId, "1,2 kg"), deps(server.fetch))).exitCode).toBe(0);
    const r = await boughtText(ask(lineId, "2,1 kg"), deps(server.fetch));
    expect(r).toEqual({ exitCode: 1, output: "Rien n'est envoyé : 2,1 kg pour 200 g prévus, plus de 10 fois ; relancez avec --oui si le ticket le dit." });
    expect(server.posted).toHaveLength(1);
  });

  // Regression: e271ea7 — a downward typo (« 2 g » for « 200 g ») went straight into Reste and trimmed the meals' holds
  it("refuses less than a tenth of the planned quantity without --oui, and sends it with", async () => {
    const { state, lineId } = boughtComte();
    const server = fakeServer(state);
    const r = await boughtText(ask(lineId, "19 g"), deps(server.fetch));
    expect(r).toEqual({ exitCode: 1, output: "Rien n'est envoyé : 19 g pour 200 g prévus, plus de 10 fois moins ; relancez avec --oui si le ticket le dit." });
    expect(server.posted).toEqual([]);
    // exactly a tenth needs no --oui
    expect((await boughtText(ask(lineId, "20 g"), deps(server.fetch))).exitCode).toBe(0);
    // measured against the planned quantity, not the 20 g just sent
    expect((await boughtText(ask(lineId, "19 g"), deps(server.fetch))).exitCode).toBe(1);
    expect((await boughtText(ask(lineId, "2 g", true), deps(server.fetch))).exitCode).toBe(0);
    expect(server.posted.map((p) => p.payload)).toEqual([{ itemId: lineId, qty: 20 }, { itemId: lineId, qty: 2 }]);
  });

  // Regression: bf6fad8 — on an unpriced line (no plannedQty kept) the guard measured against the first correction, so
  // 1,2 kg then 11 kg, or 20 g then 2 g, went through without --oui
  it("measures an unpriced line against its planned shares too, both ways, after a first correction", async () => {
    const unpriced = () => {
      const { state, lineId } = boughtComte();
      state.shoppingItems.find((l) => l.id === lineId)!.estPriceCents = null;
      return { server: fakeServer(state), lineId };
    };
    const up = unpriced();
    expect((await boughtText(ask(up.lineId, "1,2 kg"), deps(up.server.fetch))).exitCode).toBe(0);
    expect(up.server.state.shoppingItems.find((l) => l.id === up.lineId)!.plannedQty).toBeNull();
    expect(await boughtText(ask(up.lineId, "11 kg"), deps(up.server.fetch))).toEqual({
      exitCode: 1, output: "Rien n'est envoyé : 11 kg pour 200 g prévus, plus de 10 fois ; relancez avec --oui si le ticket le dit.",
    });
    const down = unpriced();
    expect((await boughtText(ask(down.lineId, "20 g"), deps(down.server.fetch))).exitCode).toBe(0);
    expect(await boughtText(ask(down.lineId, "2 g"), deps(down.server.fetch))).toEqual({
      exitCode: 1, output: "Rien n'est envoyé : 2 g pour 200 g prévus, plus de 10 fois moins ; relancez avec --oui si le ticket le dit.",
    });
    expect(up.server.posted).toHaveLength(1);
    expect(down.server.posted).toHaveLength(1);
  });

  // Regression: bf6fad8 — the same drift on a line planned in packs: its basis is the pack, not the first correction
  it("measures a line planned in packs against its shares rounded up to the pack", async () => {
    let s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" }; // the 200 g of shares are one 250 g pack
    s = applyOp(s, op("planning.commit", fixtureProposal()), NOW).state;
    const lineId = s.shoppingItems.find((l) => l.productId === P.comte)!.id;
    s = applyOp(s, op("shopping.buy", { itemId: lineId }), NOW).state;
    s.shoppingItems.find((l) => l.id === lineId)!.estPriceCents = null;
    const server = fakeServer(s);
    expect((await boughtText(ask(lineId, "300 g"), deps(server.fetch))).exitCode).toBe(0);
    expect((await boughtText(ask(lineId, "2,6 kg"), deps(server.fetch))).output).toBe("Rien n'est envoyé : 2,6 kg pour 250 g prévus, plus de 10 fois ; relancez avec --oui si le ticket le dit.");
    expect((await boughtText(ask(lineId, "2,5 kg"), deps(server.fetch))).exitCode).toBe(0);
  });

  it("exits 1 when the server refuses, naming its reason", async () => {
    const { state, lineId, itemId } = boughtComte();
    const opened = applyOp(state, op("stock.partial", { itemId, qtyText: "150 g", low: false }), NOW).state;
    const r = await boughtText(ask(lineId, "1 kg"), deps(fakeServer(opened).fetch));
    expect(r).toEqual({ exitCode: 1, output: `✗ #${lineId} comté : refusé (reste déclaré depuis, à préciser avec reste)` });
  });

  it("exits 2 when the answer is not final", async () => {
    const { state, lineId } = boughtComte();
    const server = fakeServer(state, { loseAnswerOnPost: 1 });
    await expect(boughtText(ask(lineId, "1 kg"), deps(server.fetch))).rejects.toMatchObject({ exitCode: 2 });
  });
});
