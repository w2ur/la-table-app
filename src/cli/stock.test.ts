import { describe, expect, it } from "vitest";
import { fixtureState } from "../domain/test-fixtures";
import type { FetchLike } from "./client";
import { cliDeps as deps, fakeWorker as fakeServer } from "./fake-worker";
import { stockText } from "./stock";

const file = (items: unknown[]) => JSON.stringify({ items });
const INVENTORY = file([
  { product: "riz complet", qty: "120 g" },
  { product: "Poireau", qty: "2" },
  { product: null, label: "zaatar", qty: "un peu", low: true },
]);

describe("plan stock", () => {
  it("adds each item as one stock.add, linked to its catalogue product, the use-by drawn from its shelf life", async () => {
    const server = fakeServer(fixtureState());
    const r = await stockText(INVENTORY, deps(server.fetch));
    expect(r.exitCode).toBe(0);
    expect(server.posted.map((p) => p.type)).toEqual(["stock.add", "stock.add", "stock.add", "stock.partial"]);
    const rows = server.state.stockItems;
    // the words of a catalogue product become its quantity when they parse in its unit (spec §6.5); « 2 » on a product
    // in grams does not, nor anything on a free-text item, so those keep their words with no quantity
    expect(rows.map((s) => [s.label, s.productId, s.qty, s.unit, s.qtyText])).toEqual([
      ["riz complet", 6, 120, "g", null], ["poireau", 1, null, null, "2"], ["zaatar", null, null, null, "un peu"],
    ]);
    expect(rows[1]!.useBy).toBe("2026-10-22"); // poireau keeps 10 days
    expect(rows.map((s) => s.isLow)).toEqual([false, false, true]);
    expect(r.output).toBe("+ riz complet · 120 g\n+ poireau · 2\n+ zaatar · un peu\n↓ zaatar : bientôt fini");
  });

  it("a second run adds nothing and marks nothing again", async () => {
    const server = fakeServer(fixtureState());
    await stockText(INVENTORY, deps(server.fetch));
    const before = server.posted.length;
    const r = await stockText(INVENTORY, deps(server.fetch));
    expect(r.exitCode).toBe(0);
    expect(server.posted.length).toBe(before);
    expect(server.state.stockItems).toHaveLength(3);
    expect(r.output).toMatch(/^= riz complet : déjà au Reste\n= poireau : déjà au Reste\n= zaatar : déjà au Reste$/);
  });

  it("a run cut by a lost answer exits 2, and the same command then finishes it without a duplicate", async () => {
    const server = fakeServer(fixtureState(), { loseAnswerOnPost: 2 });
    await expect(stockText(INVENTORY, deps(server.fetch))).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/Relancez la même commande/) });
    expect(server.state.stockItems).toHaveLength(2); // the Worker applied the second add

    const r = await stockText(INVENTORY, deps(server.fetch));
    expect(r.exitCode).toBe(0);
    expect(server.state.stockItems.map((s) => s.label)).toEqual(["riz complet", "poireau", "zaatar"]);
    expect(server.state.stockItems[2]!.isLow).toBe(true);
  });

  it("does not add again what the phone already put in Reste under the same name, whatever its case", async () => {
    const server = fakeServer(fixtureState());
    await stockText(file([{ product: null, label: "Riz Complet" }]), deps(server.fetch));
    const r = await stockText(file([{ product: "riz complet" }]), deps(server.fetch));
    expect(r.output).toBe("= riz complet : déjà au Reste");
    expect(server.state.stockItems).toHaveLength(1);
  });

  it("reads a phone's ’ as ', in a Reste label and in a product name", async () => {
    // Regression: review of this command — iOS smart punctuation stored « crème d’amande », so the dictated one was added twice
    const server = fakeServer(fixtureState());
    await stockText(file([{ product: null, label: "crème d’amande" }]), deps(server.fetch));
    const r = await stockText(file([{ product: null, label: "crème d'amande" }, { product: "crème fraîche" }]), deps(server.fetch));
    expect(r.output).toMatch(/^= crème d'amande : déjà au Reste$/m);
    expect(server.state.stockItems).toHaveLength(2);
    const s = fixtureState();
    s.products.push({ ...s.products[0]!, id: 99, name: "piment d'Espelette" });
    expect((await stockText(file([{ product: "piment d’Espelette" }]), deps(fakeServer(s).fetch))).exitCode).toBe(0);
  });

  it("marks « bientôt fini » only on rows it added, never on a row the phone already held", async () => {
    // Regression: review of this command — stock.partial opens the row, so a phone row got opened and its date shortened
    const server = fakeServer(fixtureState());
    await stockText(file([{ product: "crème fraîche" }]), deps(server.fetch));
    const before = server.posted.length;
    const r = await stockText(file([{ product: "crème fraîche", qty: "un fond", low: true }]), deps(server.fetch));
    expect(server.posted.length).toBe(before);
    expect(server.state.stockItems[0]!).toMatchObject({ isLow: false, openedAt: null });
    expect(r.output).toBe("= crème fraîche : déjà au Reste, « bientôt fini » à mettre sur le téléphone s'il le faut");
  });

  it("an exit 2 on the read before « bientôt fini » still says what landed and that the same command finishes it", async () => {
    // Regression: review of this command — that read's error came out bare, with no list and no hint
    const server = fakeServer(fixtureState());
    let reads = 0;
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith("/api/history") && ++reads === 2) throw new TypeError("fetch failed");
      return server.fetch(url, init);
    };
    await expect(stockText(INVENTORY, deps(fetch))).rejects.toMatchObject({
      exitCode: 2, message: expect.stringMatching(/^\+ riz complet · 120 g\n[\s\S]*\+ zaatar · un peu\n[\s\S]*Relancez la même commande/),
    });
  });

  it("refuses the whole file before sending anything when a line is wrong", async () => {
    const cases: [unknown[], RegExp][] = [
      [[{ product: "safran" }], /produit inconnu du catalogue : safran/],
      [[{ product: null }], /« label » requis sans produit/],
      [[{ product: "riz complet" }, { product: null, label: "RIZ complet" }], /figure deux fois/],
      [[{ product: "riz complet", quantite: "1" }], /champ inconnu quantite/],
      [[{ product: "riz complet", useBy: "31/10" }], /date AAAA-MM-JJ/],
      [[{ product: "riz complet", useBy: "2026-02-31" }], /date AAAA-MM-JJ/], // Regression: review of this command — a day that does not exist was stored
      [[{ product: "riz complet", qty: "" }], /« qty » texte non vide/],
      [[], /liste non vide/],
    ];
    for (const [items, message] of cases) {
      const server = fakeServer(fixtureState());
      const r = await stockText(file(items), deps(server.fetch));
      expect(r.exitCode, String(message)).toBe(1);
      expect(r.output).toMatch(message);
      expect(r.output).toMatch(/Rien n'est envoyé/);
      expect(server.posted).toEqual([]);
    }
  });

  it("refuses a file that is not JSON", async () => {
    const server = fakeServer(fixtureState());
    const r = await stockText("{ items", deps(server.fetch));
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/JSON illisible/);
  });
});
