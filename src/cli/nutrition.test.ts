import { describe, expect, it } from "vitest";
import { P, fixtureState } from "../domain/test-fixtures";
import type { FetchLike } from "./client";
import { cliDeps as deps, fakeWorker } from "./fake-worker";
import { nutritionText, parseNutritionFile } from "./nutrition";

const nutrition = (over: Record<string, unknown> = {}) => ({
  ciqual_code: "20049",
  per_100g: { kcal: 31, protein_g: 2.1, carbs_g: 3.5, fat_g: 0.3, fibre_g: 2.2, salt_g: 0.02 },
  grams_per_piece: 150, grams_per_ml: null, edible_pct: 100, ...over,
});
const file = (products: unknown[]) => JSON.stringify({ products });

describe("plan nutrition", () => {
  it("sets the nutrition of the named products, one op each, and reruns as noops", async () => {
    const server = fakeWorker(fixtureState());
    const text = file([{ name: "Poireau", nutrition: nutrition() }, { name: "oignon", nutrition: nutrition({ ciqual_code: "20034", edible_pct: 75 }) }]);
    const opIds: string[] = [];
    const spy: FetchLike = (url, init) => { if (init?.body) opIds.push(...JSON.parse(String(init.body)).ops.map((o: { opId: string }) => o.opId)); return server.fetch(url, init); };
    const r = await nutritionText(text, deps(spy));
    expect(r).toEqual({ exitCode: 0, output: "~ poireau\n~ oignon" });
    expect(server.posted.map((p) => p.type)).toEqual(["product.nutrition", "product.nutrition"]);
    expect(opIds).toHaveLength(2);
    expect(opIds.every((id) => id.startsWith("nutrition-"))).toBe(true);
    expect(server.state.products.find((p) => p.id === P.poireau)!.nutrition?.ciqualCode).toBe("20049");
    expect(server.state.products.find((p) => p.id === P.poireau)!.nutrition?.ediblePct).toBe(100);
    expect(server.state.products.find((p) => p.id === P.oignon)!.nutrition?.ediblePct).toBe(75);
    const again = await nutritionText(text, deps(server.fetch));
    expect(again).toEqual({ exitCode: 0, output: "= poireau\n= oignon" });
  });

  it("clears a nutrition with null", async () => {
    const server = fakeWorker(fixtureState());
    await nutritionText(file([{ name: "poireau", nutrition: nutrition() }]), deps(server.fetch));
    const r = await nutritionText(file([{ name: "poireau", nutrition: null }]), deps(server.fetch));
    expect(r.output).toBe("~ poireau");
    expect(server.state.products.find((p) => p.id === P.poireau)!.nutrition).toBeNull();
  });

  it("refuses the whole file before reading the state when an entry is wrong", async () => {
    const urls: string[] = [];
    const cases: [unknown[], RegExp][] = [
      [[], /liste non vide/],
      [[{ name: " ", nutrition: null }], /products\[0\]\.name: texte non vide/],
      [[{ name: "poireau" }], /products\[0\]\.nutrition: objet attendu/],
      [[{ name: "poireau", nutrition: nutrition({ ciqual_code: "" }) }], /products\[0\]\.nutrition\.ciqual_code/],
      [[{ name: "poireau", nutrition: nutrition({ edible_pct: 0 }) }], /products\[0\]\.nutrition\.edible_pct/],
      [[{ name: "poireau", nutrition: nutrition({ edible_pct: 101 }) }], /products\[0\]\.nutrition\.edible_pct/],
      [[{ name: "poireau", nutrition: { ...nutrition(), edible_pct: undefined } }], /products\[0\]\.nutrition\.edible_pct/],
      [[{ name: "poireau", nutrition: null, id: 1 }], /products\[0\]: champ inconnu id/],
      [[{ name: "poireau", nutrition: null }, { name: "Poireau", nutrition: null }], /figure deux fois/],
    ];
    for (const [products, message] of cases) {
      const server = fakeWorker(fixtureState());
      const r = await nutritionText(file(products), deps((url, init) => { urls.push(url); return server.fetch(url, init); }));
      expect(r.exitCode, String(message)).toBe(1);
      expect(r.output).toMatch(message);
      expect(urls).toEqual([]);
      expect(r.output).toMatch(/Rien n'est envoyé/);
      expect(server.posted).toEqual([]);
    }
  });

  it("shows a server refusal and exits 1", async () => {
    const server = fakeWorker(fixtureState());
    const refuse: FetchLike = async (url, init) => {
      const res = await server.fetch(url, init);
      if (!init?.body) return res;
      const body = await res.json() as { results: { opId: string; status: string; reason: string | null }[] };
      body.results = body.results.map((r, i) => (i === 0 ? { ...r, status: "refused", reason: "produit inconnu : poireau" } : r));
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const r = await nutritionText(file([{ name: "poireau", nutrition: nutrition() }]), deps(refuse));
    expect(r).toEqual({ exitCode: 1, output: "✗ poireau : refusé (produit inconnu : poireau)" });
  });

  it("sends nothing when a name is not in the catalogue, naming it", async () => {
    const server = fakeWorker(fixtureState());
    const r = await nutritionText(file([{ name: "poireau", nutrition: nutrition() }, { name: "kiwi", nutrition: nutrition() }]), deps(server.fetch));
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe("✗ kiwi : pas au catalogue\n\nRien n'est envoyé.");
    expect(server.posted).toEqual([]);
  });

  it("an exit 2 mid-run says what landed and that the same command finishes it", async () => {
    const server = fakeWorker(fixtureState(), { loseAnswerOnPost: 2 });
    const text = file([{ name: "poireau", nutrition: nutrition() }, { name: "oignon", nutrition: nutrition() }, { name: "endive", nutrition: nutrition() }]);
    await expect(nutritionText(text, deps(server.fetch))).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/^~ poireau\noignon : [\s\S]*Relancez la même commande/) });
    expect((await nutritionText(text, deps(server.fetch))).output).toBe("= poireau\n= oignon\n~ endive");
  });

  it("parses a valid file into its entries", () => {
    const parsed = parseNutritionFile(file([{ name: "poireau", nutrition: nutrition() }]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
  });
});
