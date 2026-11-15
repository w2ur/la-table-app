import { describe, expect, it } from "vitest";
import { NOW, fixtureState } from "../domain/test-fixtures";
import type { State, StockItem } from "../domain/types";
import { cliDeps as deps, fakeWorker as fakeServer } from "./fake-worker";
import { resteText, unknownLeftovers } from "./reste";

const item = (over: Partial<StockItem>): StockItem => ({
  id: 64, productId: 2, label: "comté", qty: 0, unit: "g", qtyText: "125g", isLow: false, useBy: null, openedAt: null, finishedAt: null,
  origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW, ...over,
});
const withStock = (...items: StockItem[]): State => { const s = fixtureState(); s.stockItems.push(...items); return s; };
const ask = (itemId: number, words: string, low: boolean | null = null) => ({ itemId, words, low });

describe("unknownLeftovers", () => {
  it("lists a zero, an unknown quantity with no words and one whose words do not parse, never a staple, a known quantity, a finished item or free text", () => {
    const s = withStock(
      item({ id: 1, qty: 0 }),
      item({ id: 2, productId: 1, qty: null, unit: null, qtyText: null }),
      item({ id: 3, qty: null, unit: null, qtyText: "un fond" }),
      item({ id: 4, productId: 3, qty: 0 }), // lentilles vertes: a staple
      item({ id: 5, qty: 200, qtyText: null }),
      item({ id: 6, qty: 0, finishedAt: NOW }),
      item({ id: 7, productId: null, qty: null, unit: null, qtyText: null }),
    );
    expect(unknownLeftovers(s).map((i) => i.id)).toEqual([1, 2, 3]);
  });

  // Regression: 03e177e — an unknown quantity whose words parse (a row kept as text before the server read them) was left
  // out, so nothing ever asked for it and Reste kept counting nothing
  it("lists an unknown quantity whose words parse, which plan reste then turns into its number", async () => {
    const s = withStock(
      item({ id: 1, qty: null, unit: null, qtyText: "125g" }),
      item({ id: 2, qty: null, unit: null, qtyText: "2 tranches" }),
    );
    expect(unknownLeftovers(s).map((i) => i.id)).toEqual([1, 2]);
    const server = fakeServer(s);
    expect((await resteText(ask(1, "125g"), deps(server.fetch))).output).toBe("~ #1 comté : quantité inconnue « 125g » → 125 g");
    expect(unknownLeftovers(server.state).map((i) => i.id)).toEqual([2]);
  });
});

describe("plan reste", () => {
  it("sends the words as stock.partial and prints before and after", async () => {
    const server = fakeServer(withStock(item({})));
    const r = await resteText(ask(64, "125g"), deps(server.fetch));
    expect(r.exitCode).toBe(0);
    expect(server.posted).toEqual([{ type: "stock.partial", payload: { itemId: 64, qtyText: "125g", low: false } }]);
    expect(server.state.stockItems.find((i) => i.id === 64)).toMatchObject({ qty: 125, qtyText: null });
    expect(r.output).toBe("~ #64 comté : 0 g « 125g » → 125 g");
  });

  it("says the quantity stays unknown when the words do not parse", async () => {
    const server = fakeServer(withStock(item({ qty: 0, qtyText: null })));
    const r = await resteText(ask(64, "un fond"), deps(server.fetch));
    expect(r.output).toBe("~ #64 comté : 0 g → quantité inconnue « un fond »");
  });

  it("keeps the item's own « presque fini » when no flag is given, and sets it either way when one is", async () => {
    const server = fakeServer(withStock(item({ isLow: true })));
    await resteText(ask(64, "125g"), deps(server.fetch));
    expect(server.state.stockItems.find((i) => i.id === 64)!.isLow).toBe(true);
    await resteText(ask(64, "130g", false), deps(server.fetch));
    expect(server.state.stockItems.find((i) => i.id === 64)!.isLow).toBe(false);
    await resteText(ask(64, "130g", true), deps(server.fetch));
    expect(server.state.stockItems.find((i) => i.id === 64)!.isLow).toBe(true);
  });

  it("is a noop, printed with =, when the same answer is sent again", async () => {
    const server = fakeServer(withStock(item({})));
    await resteText(ask(64, "125g"), deps(server.fetch));
    const r = await resteText(ask(64, "125g"), deps(server.fetch));
    expect(r).toMatchObject({ exitCode: 0, output: "= #64 comté : 125 g → 125 g" });
  });

  it("sends nothing and exits 1 for an unknown id or a finished item", async () => {
    const server = fakeServer(withStock(item({ finishedAt: NOW })));
    const a = await resteText(ask(99, "125g"), deps(server.fetch));
    const b = await resteText(ask(64, "125g"), deps(server.fetch));
    expect(a.exitCode).toBe(1);
    expect(a.output).toMatch(/#99 n'est pas au Reste/);
    expect(b.exitCode).toBe(1);
    expect(b.output).toMatch(/est fini/);
    expect(server.posted).toEqual([]);
  });

  it("exits 1 when the server refuses", async () => {
    const server = fakeServer(withStock(item({})));
    const post = server.fetch;
    const refusing: typeof post = async (url, init) => {
      if (!url.endsWith("/api/ops")) return post(url, init);
      const [o] = JSON.parse(String(init?.body)).ops as { opId: string }[];
      return new Response(JSON.stringify({ results: [{ opId: o!.opId, status: "refused", reason: "déjà fini" }], unrecorded: [], snapshot: { menu: { pool: [] }, courses: { lines: [], estimateCents: 0, budgetCents: 0 } } }), { headers: { "content-type": "application/json" } });
    };
    const r = await resteText(ask(64, "125g"), deps(refusing));
    expect(r).toEqual({ output: "✗ #64 comté : refusé (déjà fini)", exitCode: 1 });
  });

  it("exits 2 when the answer is not final", async () => {
    const server = fakeServer(withStock(item({})), { loseAnswerOnPost: 1 });
    await expect(resteText(ask(64, "125g"), deps(server.fetch))).rejects.toMatchObject({ exitCode: 2 });
  });
});
