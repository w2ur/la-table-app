import { describe, expect, it } from "vitest";
import { applyOp } from "../domain/ops/apply";
import { NOW, P, fixtureProposal, fixtureState, op } from "../domain/test-fixtures";
import { catalogueText } from "./catalogue";
import { cliDeps as deps, fakeWorker } from "./fake-worker";

const product = (over: Record<string, unknown> = {}) => ({
  name: "huile de sésame", category: "epicerie", is_staple: true, roles: [], is_fresh_produce: false,
  season_months: null, shelf_life_days: null, opened_shelf_life_days: null, default_unit: "ml", ...over,
});
const file = (products: unknown[]) => JSON.stringify({ products });

describe("plan catalogue", () => {
  it("adds the unknown products, updates the changed ones naming the fields, and leaves the rest", async () => {
    const server = fakeWorker(fixtureState());
    const r = await catalogueText(file([
      product(),
      product({ name: "Riz complet", is_staple: false, roles: ["fibre"], default_unit: "g" }),
      product({ name: "lentilles vertes", roles: ["legume", "fibre", "protein:legumineuse"], default_unit: "g" }),
    ]), deps(server.fetch));
    expect(r).toEqual({ exitCode: 0, output: "+ huile de sésame\n~ riz complet : is_staple\n= lentilles vertes" });
    expect(server.posted.map((p) => p.type)).toEqual(["product.upsert", "product.upsert", "product.upsert"]);
    expect(server.state.products.find((p) => p.id === P.riz)!.isStaple).toBe(false);
  });

  it("a second run of the same file changes nothing", async () => {
    const server = fakeWorker(fixtureState());
    const text = file([product(), product({ name: "riz complet", is_staple: false, roles: ["fibre"], default_unit: "g" })]);
    await catalogueText(text, deps(server.fetch));
    const products = server.state.products;
    const r = await catalogueText(text, deps(server.fetch));
    expect(r.output).toBe("= huile de sésame\n= riz complet");
    expect(server.state.products).toEqual(products);
  });

  it("shows a refusal and exits 1, the other products still sent", async () => {
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    for (const l of s.shoppingItems) s = applyOp(s, op("shopping.buy", { itemId: l.id }), NOW).state;
    const server = fakeWorker(s);
    const r = await catalogueText(file([product({ name: "riz complet", is_staple: false, roles: ["fibre"], default_unit: "g" }), product()]), deps(server.fetch));
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe("✗ riz complet : refusé (produit utilisé par un repas en cours : à modifier après ce planning)\n+ huile de sésame");
  });

  it("an exit 2 mid-run says what landed and that the same command finishes it", async () => {
    const server = fakeWorker(fixtureState(), { loseAnswerOnPost: 2 });
    const text = file([product(), product({ name: "za'atar", default_unit: "g" }), product({ name: "origan", default_unit: "g" })]);
    await expect(catalogueText(text, deps(server.fetch))).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/^\+ huile de sésame\nza'atar : [\s\S]*Relancez la même commande/) });
    expect((await catalogueText(text, deps(server.fetch))).output).toBe("= huile de sésame\n= za'atar\n+ origan");
  });

  it("refuses the whole file before reading the state when a product is wrong", async () => {
    const cases: [unknown[], RegExp][] = [
      [[product({ category: "boulangerie" })], /products\[0\]\.category: catégorie inconnue/],
      [[product({ roles: ["sauce"] })], /rôle inconnu sauce/],
      [[product({ name: " " })], /texte non vide/],
      [[product(), product({ name: "Huile de Sésame" })], /figure deux fois/],
      [[], /liste non vide/],
      [[product({ id: 137 })], /products\[0\]: champ inconnu id/], // Regression: review of this command — an extra key was dropped, not refused
      [[product({ name: "ricotta", category: "cremerie", is_staple: false })], /sans durée de conservation/],
    ];
    for (const [products, message] of cases) {
      const server = fakeWorker(fixtureState());
      const r = await catalogueText(file(products), deps(server.fetch));
      expect(r.exitCode, String(message)).toBe(1);
      expect(r.output).toMatch(message);
      expect(r.output).toMatch(/Rien n'est envoyé/);
      expect(server.posted).toEqual([]);
    }
  });
});
