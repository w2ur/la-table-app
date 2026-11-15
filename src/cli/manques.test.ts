import { describe, expect, it } from "vitest";
import { applyOp } from "../domain/ops/apply";
import { mealShortfalls } from "../domain/invariants";
import type { State } from "../domain/types";
import { NOW, P, fixtureProposal, fixtureState, op } from "../domain/test-fixtures";
import { cliDeps as deps, fakeWorker as fakeServer } from "./fake-worker";
import { freeStock, manquesText } from "./manques";

function apply(state: State, ...ops: ReturnType<typeof op>[]): State {
  return ops.reduce((s, o) => {
    const r = applyOp(s, o, NOW);
    expect(r.result.status, `${o.type}: ${r.result.reason}`).not.toBe("refused");
    return r.state;
  }, state);
}

/** 160 g of comté at home, two meals planned on it, then « 50 g » declared: the gratin (#1) lacks 50 g, the salade (#2) 60 g. */
function declaredShort(pack: boolean = false): State {
  const s = fixtureState();
  if (pack) Object.assign(s.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 435, qty: 250, unit: "g" } });
  s.stockItems.push({ id: 1, productId: P.comte, label: "comté", qty: 160, unit: "g", qtyText: null, isLow: false, useBy: null,
    openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
  return apply(s, op("planning.commit", fixtureProposal()), op("stock.partial", { itemId: 1, qtyText: "50 g", low: false }));
}

describe("freeStock", () => {
  it("sums the libre quantity of unfinished items of that product and unit, never a held, finished, unknown or other-unit one", () => {
    const s = apply(declaredShort(), op("stock.add", { label: "comté", productId: P.comte, qtyText: "30 g", useBy: null }), op("stock.add", { label: "comté bis", productId: P.comte, qtyText: null, useBy: null }));
    expect(freeStock(s, P.comte, "g")).toBe(30);
    expect(freeStock(s, P.comte, "ml")).toBe(0);
    expect(freeStock(s, P.poireau, "g")).toBe(0);
  });
});

describe("plan manques", () => {
  it("covers every short meal with a new line when no id is given, and prints where each amount went", async () => {
    const server = fakeServer(declaredShort(true));
    const r = await manquesText([], deps(server.fetch));
    expect(r.exitCode).toBe(0);
    expect(server.posted).toEqual([{ type: "meal.cover_shortfalls", payload: { mealId: 1 } }, { type: "meal.cover_shortfalls", payload: { mealId: 2 } }]);
    expect(r.output.split("\n")[0]).toMatch(/^\+ #1 Gratin de poireaux au comté : comté 50 g → /);
    expect(mealShortfalls(server.state)).toEqual([]);
  });

  it("names a new line with its size and price, or « prix inconnu » when it has none", async () => {
    const packed = declaredShort(); // the salade's 40 g line was planned before comté had a pack: no spare
    Object.assign(packed.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 435, qty: 250, unit: "g" } });
    const priced = fakeServer(packed);
    expect((await manquesText([2], deps(priced.fetch))).output).toBe("+ #2 Salade d'endives au comté : comté 60 g → nouvelle ligne comté 250 g, 4,35 €");
    const unpriced = declaredShort();
    for (const l of unpriced.shoppingItems) l.estPriceCents = null;
    const server = fakeServer(unpriced);
    expect((await manquesText([2], deps(server.fetch))).output).toMatch(/→ nouvelle ligne comté 60 g, prix inconnu$/);
  });

  it("names the spare of a line already on Courses, then of the same line for the next meal", async () => {
    const server = fakeServer(declaredShort(true));
    await manquesText([2], deps(server.fetch));
    const line = server.state.shoppingItems.find((l) => l.productId === P.comte && l.kind === "planning" && l.boughtAt === null)!;
    const r = await manquesText([1], deps(server.fetch));
    expect(r.output).toBe(`+ #1 Gratin de poireaux au comté : comté 50 g → ligne #${line.id} (réserve)`);
  });

  it("names the Reste item reserved for what is free, then the line for the rest", async () => {
    const s = apply(declaredShort(true), op("stock.add", { label: "comté", productId: P.comte, qtyText: "30 g", useBy: null }));
    const added = s.stockItems.at(-1)!.id;
    const server = fakeServer(s);
    const r = await manquesText([2], deps(server.fetch));
    expect(r.output).toBe(`+ #2 Salade d'endives au comté : comté 60 g → Reste #${added} (réservé), ligne #${server.state.shoppingItems.find((l) => l.productId === P.comte && l.forMeals.some((f) => f.mealId === 2))!.id} (réserve)`);
  });

  it("restricts itself to the ids given", async () => {
    const server = fakeServer(declaredShort(true));
    await manquesText([2], deps(server.fetch));
    expect(server.posted).toEqual([{ type: "meal.cover_shortfalls", payload: { mealId: 2 } }]);
    expect(mealShortfalls(server.state).map((x) => x.mealId)).toEqual([1]);
  });

  it("says « rien ne manque » for an id not short, and exits 0", async () => {
    const server = fakeServer(declaredShort(true));
    await manquesText([2], deps(server.fetch));
    const r = await manquesText([2], deps(server.fetch));
    expect(r).toEqual({ output: "= #2 : rien ne manque", exitCode: 0 });
  });

  it("sends nothing and says « Manques : aucun » when no meal is short and no id is given", async () => {
    const server = fakeServer(fixtureState());
    expect(await manquesText([], deps(server.fetch))).toEqual({ output: "Manques : aucun", exitCode: 0 });
    expect(server.posted).toEqual([]);
  });

  it("exits 1 for a refused op (an unknown meal) while still covering the others", async () => {
    const server = fakeServer(declaredShort(true));
    const r = await manquesText([99, 2], deps(server.fetch));
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe(`✗ #99 : refusé (repas introuvable)\n${r.output.split("\n").slice(1).join("\n")}`);
    expect(r.output).toMatch(/\n\+ #2 /);
    expect(mealShortfalls(server.state).map((x) => x.mealId)).toEqual([1]);
  });

  it("exits 2 for an answer that is not final, still sends the others, and a rerun is safe", async () => {
    const server = fakeServer(declaredShort(true), { loseAnswerOnPost: 1 });
    const r = await manquesText([], deps(server.fetch));
    expect(r.exitCode).toBe(2);
    expect(server.posted.map((p) => p.payload)).toEqual([{ mealId: 1 }, { mealId: 2 }]);
    expect(r.output).toMatch(/^✗ #1 : .*\n.*\n\+ #2 /s);
    const again = await manquesText([], deps(server.fetch));
    expect(again).toEqual({ output: "Manques : aucun", exitCode: 0 });
  });

  // Regression: 56f52c7 — an Access refusal carried « Relancez la même commande », though no rerun can change it
  it("gives the rerun hint only to an answer that may have landed, not to an Access refusal", async () => {
    const server = fakeServer(declaredShort(true));
    const refusing: typeof server.fetch = async (url, init) => (init?.method === "POST" ? new Response("", { status: 403 }) : server.fetch(url, init));
    const r = await manquesText([1], deps(refusing));
    expect(r).toEqual({ exitCode: 2, output: "✗ #1 : meal.cover_shortfalls : accès refusé (403), vérifiez le jeton Access" });
    const lost = await manquesText([1], deps(fakeServer(declaredShort(true), { loseAnswerOnPost: 1 }).fetch));
    expect(lost.output).toMatch(/\nRelancez la même commande : un repas déjà couvert répond « rien ne manque »\.$/);
  });

  // Regression: 4c16f6a — « réponse non définitive » already says « relancez la même commande », and the hint said it again
  it("says to rerun once on an answer the server did not record", async () => {
    const server = fakeServer(declaredShort(true));
    const unrecorded: typeof server.fetch = async (url, init) => {
      const res = await server.fetch(url, init);
      if (init?.method !== "POST") return res;
      const body = await res.json() as { results: { opId: string }[] };
      return new Response(JSON.stringify({ ...body, unrecorded: body.results.map((r) => r.opId) }), { headers: { "content-type": "application/json" } });
    };
    const r = await manquesText([1], deps(unrecorded));
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/^✗ #1 : meal\.cover_shortfalls : réponse non définitive, rien n'est confirmé \(.*\) ; relancez la même commande : un repas déjà couvert répond « rien ne manque »\.$/);
    expect(r.output.match(/elancez/g)).toHaveLength(1);
  });

  it("exits 2 over 1 in a mixed run", async () => {
    const server = fakeServer(declaredShort(true), { loseAnswerOnPost: 2 });
    expect((await manquesText([99, 2], deps(server.fetch))).exitCode).toBe(2);
  });
});
