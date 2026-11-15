import { describe, expect, it } from "vitest";
import { P, fixtureState } from "../domain/test-fixtures";
import type { FetchLike } from "./client";
import { cliDeps as deps, fakeWorker } from "./fake-worker";
import { packsText, parsePacksFile } from "./packs";

const pack = { qty: 250, unit: "g" };
const price = { cents: 287, qty: 250, unit: "g" };
const file = (products: unknown[]) => JSON.stringify({ products });

describe("parsePacksFile", () => {
  it("parses a packs file and refuses a bad line, an unknown key, a duplicate or an empty list", () => {
    const ok = parsePacksFile(file([{ name: "ricotta", pack, price }, { name: "poireau", pack: null, price: { cents: 369, qty: 1000, unit: "g" } }]));
    expect(ok.errors).toEqual([]);
    expect(ok.entries).toHaveLength(2);
    expect(parsePacksFile("{").errors[0]).toMatch(/^JSON illisible/);
    expect(parsePacksFile(file([])).errors).toEqual(["« products » doit être une liste non vide"]);
    expect(parsePacksFile(file([{ name: "x", pack: null, price: null, extra: 1 }])).errors).toEqual(["products[0]: champ inconnu extra"]);
    expect(parsePacksFile(file([{ name: "x" }])).errors).toEqual(["products[0]: « pack » ou « price » attendu (null pour effacer, absent pour garder)"]);
    expect(parsePacksFile(file([{ name: "x", price: { cents: 1, qty: 0, unit: "g" } }])).errors).toHaveLength(1);
    expect(parsePacksFile(file([{ name: "x", pack, price: { cents: 1, qty: 1, unit: "piece" } }])).errors).toEqual(["products[0]: le paquet et le prix doivent être dans la même unité"]);
    expect(parsePacksFile(file([{ name: "x", pack: { qty: 0, unit: "g" }, price: null }])).errors).toHaveLength(1);
    expect(parsePacksFile(file([{ name: "Ricotta", pack: null, price: null }, { name: "ricotta", pack: null, price: null }])).errors).toEqual(["products[1]: « ricotta » figure deux fois"]);
  });
});

describe("plan packs", () => {
  it("sends one product.pack op per entry, and reruns as noops", async () => {
    const server = fakeWorker(fixtureState());
    const text = file([{ name: "Poireau", pack, price }, { name: "oignon", pack: null, price: { cents: 199, qty: 1000, unit: "g" } }]);
    const r = await packsText(text, deps(server.fetch));
    expect(r).toEqual({ exitCode: 0, output: "~ poireau : paquet aucun → 250 g, prix aucun → 2,87 € / 250 g\n~ oignon : prix aucun → 1,99 € / 1 kg" });
    expect(server.posted.map((p) => p.type)).toEqual(["product.pack", "product.pack"]);
    expect(server.posted[0]!.payload).toEqual({ name: "Poireau", pack, price });
    expect(server.state.products.find((p) => p.id === P.poireau)!.pack).toEqual(pack);
    expect(server.state.products.find((p) => p.id === P.oignon)!.pack).toBeNull();
    expect(await packsText(text, deps(server.fetch))).toEqual({ exitCode: 0, output: "= poireau\n= oignon" });
  });

  // Regression: 7d324cb — the output said only « ~ comté », so a pack cleared by a price-only receipt update went unseen
  it("shows each changed field before and after, from the state read before posting", async () => {
    const state = fixtureState();
    Object.assign(state.products.find((p) => p.id === P.comte)!, { pack, price: { cents: 420, qty: 250, unit: "g" } });
    const server = fakeWorker(state);
    const r = await packsText(file([{ name: "comté", pack: null, price: { cents: 435, qty: 250, unit: "g" } }, { name: "endive", pack: null, price: null }]), deps(server.fetch));
    expect(r).toEqual({ exitCode: 0, output: "~ comté : paquet 250 g → aucun, prix 4,20 € / 250 g → 4,35 € / 250 g\n= endive" });
    const pieces = await packsText(file([{ name: "comté", pack: { qty: 6, unit: "piece" }, price: { cents: 50, qty: 1, unit: "piece" } }]), deps(server.fetch));
    expect(pieces.output).toBe("~ comté : paquet aucun → 6 pièces, prix 4,35 € / 250 g → 0,50 € / 1 pièce");
  });

  // Regression: 95376f7 — a packs file needed both « pack » and « price » for every product, so a price update meant resending the pack
  it("keeps the field an entry leaves out, and prints only the fields it sends", async () => {
    const state = fixtureState();
    Object.assign(state.products.find((p) => p.id === P.comte)!, { pack, price: { cents: 420, qty: 250, unit: "g" } });
    const server = fakeWorker(state);
    const priceOnly = { cents: 435, qty: 250, unit: "g" };
    const r = await packsText(file([{ name: "comté", price: priceOnly }]), deps(server.fetch));
    expect(r).toEqual({ exitCode: 0, output: "~ comté : prix 4,20 € / 250 g → 4,35 € / 250 g" });
    expect(server.posted[0]!.payload).toEqual({ name: "comté", price: priceOnly });
    expect(server.state.products.find((p) => p.id === P.comte)).toMatchObject({ pack, price: priceOnly });
    const packOnly = await packsText(file([{ name: "comté", pack: { qty: 500, unit: "g" } }]), deps(server.fetch));
    expect(packOnly.output).toBe("~ comté : paquet 250 g → 500 g");
    expect(server.state.products.find((p) => p.id === P.comte)).toMatchObject({ pack: { qty: 500, unit: "g" }, price: priceOnly });
  });

  it("shows the server's refusal when the pair left would be in two units", async () => {
    const state = fixtureState();
    Object.assign(state.products.find((p) => p.id === P.comte)!, { pack, price: { cents: 420, qty: 250, unit: "g" } });
    const r = await packsText(file([{ name: "comté", price: { cents: 50, qty: 1, unit: "piece" } }]), deps(fakeWorker(state).fetch));
    expect(r).toEqual({ exitCode: 1, output: "✗ comté : refusé (le paquet et le prix doivent être dans la même unité)" });
  });

  it("refuses the whole file before reading the state when an entry is wrong", async () => {
    const urls: string[] = [];
    const server = fakeWorker(fixtureState());
    const r = await packsText(file([{ name: "poireau" }]), deps((url, init) => { urls.push(url); return server.fetch(url, init); }));
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/Rien n'est envoyé/);
    expect(urls).toEqual([]);
    expect(server.posted).toEqual([]);
  });

  it("shows a server refusal and exits 1", async () => {
    const server = fakeWorker(fixtureState());
    const refuse: FetchLike = async (url, init) => {
      const res = await server.fetch(url, init);
      if (!init?.body) return res;
      const body = await res.json() as { results: { opId: string; status: string; reason: string | null }[] };
      body.results = body.results.map((x, i) => (i === 0 ? { ...x, status: "refused", reason: "produit inconnu : poireau" } : x));
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const r = await packsText(file([{ name: "poireau", pack, price }]), deps(refuse));
    expect(r).toEqual({ exitCode: 1, output: "✗ poireau : refusé (produit inconnu : poireau)" });
  });

  it("sends nothing when a name is not in the catalogue, naming it", async () => {
    const server = fakeWorker(fixtureState());
    const r = await packsText(file([{ name: "poireau", pack, price }, { name: "kiwi", pack, price }]), deps(server.fetch));
    expect(r).toEqual({ exitCode: 1, output: "✗ kiwi : pas au catalogue\n\nRien n'est envoyé." });
    expect(server.posted).toEqual([]);
  });
});
