import { describe, expect, it } from "vitest";
import { NOW, fixtureState } from "../domain/test-fixtures";
import type { State, StockItem } from "../domain/types";
import { cliDeps as deps, fakeWorker as fakeServer } from "./fake-worker";
import { finiText } from "./fini";

const item = (over: Partial<StockItem>): StockItem => ({
  id: 101, productId: 2, label: "comté", qty: 0, unit: "g", qtyText: null, isLow: false, useBy: null, openedAt: null, finishedAt: null,
  origin: "achat", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW, ...over,
});
const withStock = (...items: StockItem[]): State => { const s = fixtureState(); s.stockItems.push(...items); return s; };

/** Item 101 held by an open meal of recipe 2. */
function reserved(): State {
  const s = withStock(item({ qty: 100 }));
  s.meals.push({ id: 7, planningId: 1, recipeId: 2, portions: 2, doubledFrom: null, cookEarlyReason: null, cookedAt: null, droppedAt: null, verdict: null, note: null });
  s.reservations.push({ id: 1, stockItemId: 101, mealId: 7, qty: 100, unit: "g", releasedAt: null, createdAt: NOW });
  return s;
}

describe("plan fini", () => {
  it("sends stock.finish for each item and prints it finished", async () => {
    const server = fakeServer(withStock(item({}), item({ id: 102, label: "lait", productId: null })));
    const r = await finiText([101, 102], deps(server.fetch));
    expect(r).toEqual({ exitCode: 0, output: "✓ #101 comté : fini\n✓ #102 lait : fini" });
    expect(server.posted).toEqual([{ type: "stock.finish", payload: { itemId: 101 } }, { type: "stock.finish", payload: { itemId: 102 } }]);
    expect(server.state.stockItems.find((i) => i.id === 101)!.finishedAt).toBe(NOW);
  });

  it("answers an item already finished with =, exit 0, so a rerun is safe", async () => {
    const server = fakeServer(withStock(item({ finishedAt: NOW })));
    expect(await finiText([101], deps(server.fetch))).toEqual({ exitCode: 0, output: "= #101 comté : déjà fini" });
  });

  it("sends nothing and exits 1 when an item is unknown or held by an open meal, naming the meal", async () => {
    const a = fakeServer(withStock(item({})));
    const unknown = await finiText([101, 99], deps(a.fetch));
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toMatch(/#99 n'est pas au Reste/);
    expect(a.posted).toEqual([]);

    const b = fakeServer(reserved());
    const held = await finiText([101], deps(b.fetch));
    expect(held.exitCode).toBe(1);
    expect(held.output).toMatch(/#101 comté est réservé pour Gratin de poireaux au comté : à marquer fini sur le téléphone/);
    expect(b.posted).toEqual([]);
  });

  it("finishes an item whose reservation was released", async () => {
    const s = reserved();
    s.reservations[0]!.releasedAt = NOW;
    const server = fakeServer(s);
    expect((await finiText([101], deps(server.fetch))).exitCode).toBe(0);
  });

  it("sends a repeated id once", async () => {
    const server = fakeServer(withStock(item({})));
    expect(await finiText([101, 101], deps(server.fetch))).toEqual({ exitCode: 0, output: "✓ #101 comté : fini" });
    expect(server.posted).toHaveLength(1);
  });

  it("exits 2 when an answer is not final, keeping the lines already printed", async () => {
    const server = fakeServer(withStock(item({}), item({ id: 102, label: "lait", productId: null })), { loseAnswerOnPost: 2 });
    const error = await finiText([101, 102], deps(server.fetch)).catch((e: unknown) => e);
    expect(error).toMatchObject({ exitCode: 2 });
    expect((error as Error).message).toMatch(/^✓ #101 comté : fini\n#102 lait : .*\nRelancez la même commande/s);
  });
});
