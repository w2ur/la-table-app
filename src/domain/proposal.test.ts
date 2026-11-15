import { describe, expect, it } from "vitest";
import { parseProposal } from "./proposal";
import { fixtureProposal, secondProposal } from "./test-fixtures";

describe("parseProposal", () => {
  it("accepts the fixture proposal", () => {
    const r = parseProposal(fixtureProposal());
    expect(r.ok).toBe(true);
  });

  it("collects every schema error with its path", () => {
    const bad = { ...fixtureProposal(), meals: [{ recipe: 2, portions: 0, doubled: "no" }], prices: "x" };
    const r = parseProposal(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("meals[0].portions: entier ≥ 1 attendu");
      expect(r.errors).toContain("meals[0].doubled: booléen attendu");
      expect(r.errors).toContain("prices: liste attendue");
    }
  });

  it("rejects a new product with an unknown role, naming it", () => {
    const p = secondProposal();
    p.new_products = [{
      name: "cumin", category: "epicerie", is_staple: true, roles: ["vegetable", "assaisonement"], is_fresh_produce: false,
      season_months: null, shelf_life_days: null, opened_shelf_life_days: null, default_unit: "g",
    }];
    const r = parseProposal(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("new_products[0].roles: rôle inconnu assaisonement");
  });

  it("rejects a non-object", () => {
    expect(parseProposal(null).ok).toBe(false);
  });

  // Regression: d6862d6 — a recipe source of any scheme was accepted, then rendered as « Recette d'origine »
  it("rejects a recipe source that is not an http(s) address", () => {
    const p = secondProposal();
    (p.new_recipes as { source_url: string | null }[])[0]!.source_url = "javascript:alert(1)";
    const r = parseProposal(p);
    expect(r.ok ? [] : r.errors).toContain("new_recipes[0].source_url: adresse http(s) ou null attendue");
    (p.new_recipes as { source_url: string | null }[])[0]!.source_url = "https://example.org/saumon";
    expect(parseProposal(p).ok).toBe(true);
  });
});
