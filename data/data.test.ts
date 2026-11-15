import { describe, expect, it } from "vitest";
import seed from "./products.seed.json";
import exceptions from "./season-exceptions.json";
import { catalogueRuleErrors } from "../src/domain/catalogue-rules";
import type { Category } from "../src/domain/types";
import { CATEGORIES, isKnownRole } from "../src/domain/vocabulary";
import { normalizeName } from "../src/domain/text";
import { isUnit } from "../src/domain/units";

const products = seed.products;
const exempt = new Set(exceptions.map(normalizeName));

describe("products.seed.json", () => {
  it("records the calendar source and the date it was checked", () => {
    expect(seed.source.calendar).toMatch(/^https:\/\//);
    expect(seed.source.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has unique normalised names", () => {
    const names = products.map((p) => normalizeName(p.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses only known categories, roles and units", () => {
    for (const p of products) {
      expect(CATEGORIES, p.name).toContain(p.category);
      for (const role of p.roles) expect(isKnownRole(role), `${p.name}: ${role}`).toBe(true);
      expect(isUnit(p.defaultUnit), p.name).toBe(true);
    }
  });

  it("keeps the catalogue rules a product.upsert keeps: season months on fresh produce, a shelf life on perishables", () => {
    for (const p of products) {
      expect(catalogueRuleErrors({ ...p, category: p.category as Category }), p.name).toEqual([]);
      for (const m of p.seasonMonths ?? []) expect(m >= 1 && m <= 12, p.name).toBe(true);
    }
  });

  it("lists every exception as a fresh produce product in the catalogue", () => {
    const fresh = new Set(products.filter((p) => p.isFreshProduce).map((p) => normalizeName(p.name)));
    for (const name of exempt) expect(fresh.has(name), name).toBe(true);
  });

  it("has at least one product per protein role used by the rules", () => {
    for (const role of ["protein:volaille", "protein:poisson", "protein:legumineuse", "legume", "fibre", "vegetable"]) {
      expect(products.some((p) => p.roles.includes(role)), role).toBe(true);
    }
  });
});
