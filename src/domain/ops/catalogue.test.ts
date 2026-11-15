import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyOp } from "./apply";
import { NOW, P, fixtureProposal, fixtureState, op } from "../test-fixtures";
import type { ProposalProduct } from "../proposal";
import type { Product, ProductNutrition, State } from "../types";

const pantry = (over: Partial<ProposalProduct> = {}): ProposalProduct => ({
  name: "huile de sésame", category: "epicerie", is_staple: true, roles: [], is_fresh_produce: false,
  season_months: null, shelf_life_days: null, opened_shelf_life_days: null, default_unit: "ml", ...over,
});
const upsert = (s: State, payload: unknown) => applyOp(s, op("product.upsert", payload), NOW);

describe("product.upsert", () => {
  it("adds an unknown product under the next id, past any id an undo left issued", () => {
    const s = fixtureState();
    s.lastIds = { products: 40 };
    const r = upsert(s, pantry());
    expect(r.result.status).toBe("applied");
    expect(r.state.products.at(-1)).toEqual({ id: 41, name: "huile de sésame", category: "epicerie", isStaple: true, roles: [],
      isFreshProduce: false, seasonMonths: null, shelfLifeDays: null, openedShelfLifeDays: null, defaultUnit: "ml", nutrition: null, pack: null, price: null });
    expect(r.state.lastIds.products).toBe(41);
  });

  // a synthetic Ciqual code, never a real one
  const NUTRITION: ProductNutrition = { ciqualCode: "T0001", per100g: { kcal: 30, proteinG: 1.5, carbsG: 4.6, fatG: 0.3, fibreG: 3.2, saltG: 0.02 }, gramsPerPiece: 250, gramsPerMl: null, ediblePct: 100 };
  const wireOf = (p: Product): ProposalProduct => ({ name: p.name, category: p.category, is_staple: p.isStaple, roles: p.roles,
    is_fresh_produce: p.isFreshProduce, season_months: p.seasonMonths, shelf_life_days: p.shelfLifeDays,
    opened_shelf_life_days: p.openedShelfLifeDays, default_unit: p.defaultUnit });

  it("keeps a product's nutrition when product.upsert updates its other fields", () => {
    const s = fixtureState();
    const leek = s.products.find((p) => p.id === P.poireau)!;
    leek.nutrition = NUTRITION;
    const r = upsert(s, { ...wireOf(leek), shelf_life_days: 9 });
    expect(r.result.status).toBe("applied");
    const after = r.state.products.find((p) => p.id === leek.id)!;
    expect(after.shelfLifeDays).toBe(9);
    expect(after.nutrition).toEqual(NUTRITION);
  });

  it("answers noop for a product with nutrition upserted with its own fields", () => {
    const s = fixtureState();
    const leek = s.products.find((p) => p.id === P.poireau)!;
    leek.nutrition = NUTRITION;
    expect(upsert(s, wireOf(leek)).result.status).toBe("noop");
  });

  it("adds a new product with no nutrition", () => {
    expect(upsert(fixtureState(), pantry({ name: "poivre noir" })).state.products.at(-1)!.nutrition).toBeNull();
  });

  it("answers noop for a product already there with the same fields, its name matched as a planning matches it", () => {
    const s = upsert(fixtureState(), pantry()).state;
    const r = upsert(s, pantry({ name: "  Huile  de SÉSAME " }));
    expect(r.result).toEqual({ status: "noop", reason: "déjà au catalogue" });
    expect(r.state.products).toHaveLength(s.products.length);
  });

  it("updates the fields of a product already there, keeping its id and name", () => {
    const s = fixtureState();
    const r = upsert(s, pantry({ name: "Riz complet", default_unit: "g", roles: ["fibre"], is_staple: false }));
    expect(r.result.status).toBe("applied");
    const riz = r.state.products.find((p) => p.id === P.riz)!;
    expect(riz).toMatchObject({ name: "riz complet", isStaple: false, roles: ["fibre"] });
    expect(r.changes).toEqual([expect.objectContaining({ table: "products", id: P.riz })]);
  });

  it("refuses an update that would leave a planned meal under-covered", () => {
    // a bought staple shared by the meals: made non-staple, its share no longer counts toward their coverage
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    for (const l of s.shoppingItems) s = applyOp(s, op("shopping.buy", { itemId: l.id }), NOW).state;
    const r = upsert(s, pantry({ name: "riz complet", default_unit: "g", roles: ["fibre"], is_staple: false }));
    expect(r.result).toEqual({ status: "refused", reason: "produit utilisé par un repas en cours : à modifier après ce planning" });
    expect(r.state.products.find((p) => p.id === P.riz)!.isStaple).toBe(true);
  });

  it("refuses turning a product staple while a meal in progress counts on it: its unbought line, then its reservation", () => {
    // Regression: review of product.upsert — the invariants alone let a reserved product turn staple, and a staple is never reserved
    const comte = pantry({ name: "comté", category: "cremerie", is_staple: true, roles: ["protein:laitier"], shelf_life_days: 30, opened_shelf_life_days: 21, default_unit: "g" });
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    const IN_USE = { status: "refused", reason: "produit utilisé par un repas en cours : à modifier après ce planning" };
    expect(upsert(s, comte).result).toEqual(IN_USE);
    s = applyOp(s, op("shopping.buy", { itemId: s.shoppingItems.find((l) => l.productId === P.comte)!.id }), NOW).state;
    expect(s.reservations.some((r) => r.releasedAt === null)).toBe(true);
    expect(upsert(s, comte).result).toEqual(IN_USE);
    // a field other than the flag is no such change
    expect(upsert(s, { ...comte, is_staple: false, shelf_life_days: 25 }).result.status).toBe("applied");
    // nor is the flag of a product no meal uses
    expect(upsert(s, pantry({ name: "bœuf haché", category: "boucherie-volaille", is_staple: true, roles: ["protein:viande_rouge"], shelf_life_days: 1, default_unit: "g" })).result.status).toBe("applied");
  });

  it("refuses a product that breaks a catalogue rule, from the same rules the seed keeps", () => {
    // Regression: review of product.upsert — the seed's season and shelf-life rules were left behind with the seed path
    expect(upsert(fixtureState(), pantry({ name: "panais", category: "fruits-legumes", is_staple: false, is_fresh_produce: true, shelf_life_days: 10, default_unit: "g" })).result)
      .toEqual({ status: "refused", reason: "règle du catalogue : produit frais sans mois de saison" });
    expect(upsert(fixtureState(), pantry({ name: "ricotta", category: "cremerie", is_staple: false, default_unit: "g" })).result)
      .toEqual({ status: "refused", reason: "règle du catalogue : produit périssable sans durée de conservation" });
    expect(upsert(fixtureState(), pantry({ name: "gingembre", category: "fruits-legumes", is_staple: false, is_fresh_produce: true, default_unit: "g" })).result.status).toBe("applied");
  });

  it("refuses a malformed product, an unknown role or a blank name", () => {
    for (const bad of [null, { ...pantry(), category: "boulangerie" }, pantry({ roles: ["sauce"] }), pantry({ name: "  " }), { ...pantry(), default_unit: "litre" }]) {
      expect(upsert(fixtureState(), bad).result, JSON.stringify(bad)).toEqual({ status: "refused", reason: "données invalides" });
    }
  });

  it("cannot be undone", () => {
    const s = fixtureState();
    const added = applyOp(s, { ...op("product.upsert", pantry()), opId: "add-1" }, NOW).state;
    expect(applyOp(added, op("undo", { targetOpId: "add-1" }), NOW).result).toEqual({ status: "refused", reason: "cette action ne s'annule pas" });
  });

  it("upserting the same product twice is upserting it once", () => {
    const name = fc.stringMatching(/^[a-zà-ÿ][a-zà-ÿ ]{0,20}$/).filter((n) => n.trim().length > 0);
    fc.assert(fc.property(name, fc.boolean(), fc.constantFrom("g", "ml", "piece"), (n, staple, unit) => {
      const p = pantry({ name: n, is_staple: staple, default_unit: unit as ProposalProduct["default_unit"] });
      const once = upsert(fixtureState(), p).state;
      const twice = upsert(once, p);
      expect(twice.result.status).toBe("noop");
      expect(twice.state.products).toEqual(once.products);
    }));
  });
});

describe("product.nutrition", () => {
  // synthetic Ciqual code, never a real one
  const wire = (over: Record<string, unknown> = {}) => ({
    ciqual_code: "T0001",
    per_100g: { kcal: 30, protein_g: 1.5, carbs_g: 4.6, fat_g: 0.3, fibre_g: 3.2, salt_g: 0.02 },
    grams_per_piece: 250, grams_per_ml: null, edible_pct: 100, ...over,
  });
  const STORED: ProductNutrition = { ciqualCode: "T0001", per100g: { kcal: 30, proteinG: 1.5, carbsG: 4.6, fatG: 0.3, fibreG: 3.2, saltG: 0.02 }, gramsPerPiece: 250, gramsPerMl: null, ediblePct: 100 };
  const setNutrition = (s: State, name: string, nutrition: unknown) => applyOp(s, op("product.nutrition", { name, nutrition }), NOW);
  const leek = (s: State) => s.products.find((p) => p.id === P.poireau)!;

  it("sets the nutrition of a product matched by normalized name, and changes no other field", () => {
    const s = fixtureState();
    const before = structuredClone(leek(s));
    const r = setNutrition(s, " Poireau  ", wire());
    expect(r.result.status).toBe("applied");
    expect(leek(r.state)).toEqual({ ...before, nutrition: STORED });
    expect(r.state.products).toHaveLength(s.products.length);
  });

  it("is a noop when the product already carries that nutrition", () => {
    const once = setNutrition(fixtureState(), "poireau", wire()).state;
    expect(setNutrition(once, "poireau", wire()).result).toEqual({ status: "noop", reason: "déjà à jour" });
  });

  it("clears the nutrition with null, and is a noop when there is none", () => {
    const s = fixtureState();
    leek(s).nutrition = STORED;
    const cleared = setNutrition(s, "poireau", null);
    expect(cleared.result.status).toBe("applied");
    expect(leek(cleared.state).nutrition).toBeNull();
    expect(setNutrition(cleared.state, "poireau", null).result.status).toBe("noop");
  });

  it("refuses an unknown product by name", () => {
    expect(setNutrition(fixtureState(), "licorne", wire()).result).toEqual({ status: "refused", reason: "produit inconnu : licorne" });
  });

  it("refuses a malformed payload as invalid data", () => {
    const per = (over: Record<string, unknown>) => wire({ per_100g: { ...wire().per_100g, ...over } });
    const { kcal: _kcal, ...withoutKcal } = wire().per_100g;
    const bad: unknown[] = [
      per({ kcal: -1 }), per({ kcal: "30" }), per({ salt_g: Number.NaN }), per({ fat_g: null }), per({ kcal: 1e999 }),
      wire({ per_100g: withoutKcal }), wire({ per_100g: { ...wire().per_100g, sugar_g: 1 } }), wire({ extra: 1 }),
      wire({ grams_per_piece: 0 }), wire({ grams_per_ml: -2 }), wire({ grams_per_piece: "250" }), wire({ ciqual_code: "" }), wire({ ciqual_code: 7 }),
      wire({ edible_pct: 0 }), wire({ edible_pct: -5 }), wire({ edible_pct: 100.5 }), wire({ edible_pct: "75" }), wire({ edible_pct: Number.NaN }), wire({ edible_pct: 1e999 }), wire({ edible_pct: null }), wire({ edible_pct: undefined }),
      "poireau", [], undefined,
    ];
    for (const nutrition of bad) {
      expect(setNutrition(fixtureState(), "poireau", nutrition).result, JSON.stringify(nutrition)).toEqual({ status: "refused", reason: "données invalides" });
    }
    for (const payload of [null, [], { nutrition: wire() }, { name: "poireau" }, { name: " ", nutrition: null }, { name: "poireau", nutrition: null, extra: 1 }]) {
      expect(applyOp(fixtureState(), op("product.nutrition", payload), NOW).result, JSON.stringify(payload)).toEqual({ status: "refused", reason: "données invalides" });
    }
  });

  it("stores the edible share of the bought weight", () => {
    const { state } = setNutrition(fixtureState(), "poireau", wire({ edible_pct: 62.5 }));
    expect(leek(state).nutrition?.ediblePct).toBe(62.5);
    expect(setNutrition(fixtureState(), "poireau", wire({ edible_pct: 100 })).result.status).toBe("applied");
  });

  it("refuses a nutrition without its edible share", () => {
    const { edible_pct: _edible, ...without } = wire();
    expect(setNutrition(fixtureState(), "poireau", without).result).toEqual({ status: "refused", reason: "données invalides" });
  });

  it("cannot be undone", () => {
    const added = applyOp(fixtureState(), { ...op("product.nutrition", { name: "poireau", nutrition: wire() }), opId: "nut-1" }, NOW).state;
    expect(applyOp(added, op("undo", { targetOpId: "nut-1" }), NOW).result).toEqual({ status: "refused", reason: "cette action ne s'annule pas" });
  });
});

describe("product.pack", () => {
  const setPack = (s: State, name: string, pack: unknown, price: unknown) => applyOp(s, op("product.pack", { name, pack, price }), NOW);
  const comte = (s: State) => s.products.find((p) => p.id === P.comte)!;
  const PACK = { qty: 200, unit: "g" } as const;
  const PRICE = { cents: 420, qty: 200, unit: "g" } as const;

  it("sets pack and price of a product matched by normalized name, and changes no other field", () => {
    const s = fixtureState();
    const before = structuredClone(comte(s));
    const r = setPack(s, " Comté ", PACK, PRICE);
    expect(r.result.status).toBe("applied");
    expect(comte(r.state)).toEqual({ ...before, pack: PACK, price: PRICE });
  });

  it("is a noop when nothing changes, and clears with null", () => {
    const once = setPack(fixtureState(), "comté", PACK, PRICE).state;
    expect(setPack(once, "comté", PACK, PRICE).result).toEqual({ status: "noop", reason: "déjà à jour" });
    const cleared = setPack(once, "comté", null, null);
    expect(cleared.result.status).toBe("applied");
    expect(comte(cleared.state)).toMatchObject({ pack: null, price: null });
  });

  it("refuses an unknown product, and a malformed payload as invalid data", () => {
    expect(setPack(fixtureState(), "licorne", PACK, PRICE).result).toEqual({ status: "refused", reason: "produit inconnu : licorne" });
    for (const payload of [null, { name: "comté" }, { name: " ", pack: null, price: null }, { name: "comté", pack: null, price: null, extra: 1 },
      { name: "comté", pack: { qty: 0, unit: "g" } }, { name: "comté", price: { cents: -1, qty: 200, unit: "g" } }]) {
      expect(applyOp(fixtureState(), op("product.pack", payload), NOW).result, JSON.stringify(payload)).toEqual({ status: "refused", reason: "données invalides" });
    }
  });

  // Regression: 95376f7 — product.pack needed both fields, so changing a price meant resending the pack and a pack the caller could not read was lost
  it("leaves an absent field unchanged and clears a field set to null", () => {
    const set = setPack(fixtureState(), "comté", PACK, PRICE).state;
    const send = (s: State, payload: unknown) => applyOp(s, op("product.pack", { name: "comté", ...(payload as object) }), NOW);
    const priceOnly = send(set, { price: { cents: 500, qty: 200, unit: "g" } });
    expect(priceOnly.result.status).toBe("applied");
    expect(comte(priceOnly.state)).toMatchObject({ pack: PACK, price: { cents: 500, qty: 200, unit: "g" } });
    const packOnly = send(set, { pack: { qty: 250, unit: "g" } });
    expect(comte(packOnly.state)).toMatchObject({ pack: { qty: 250, unit: "g" }, price: PRICE });
    expect(comte(send(set, { price: null }).state)).toMatchObject({ pack: PACK, price: null });
    expect(comte(send(set, { pack: null }).state)).toMatchObject({ pack: null, price: PRICE });
    expect(send(set, { pack: PACK }).result).toEqual({ status: "noop", reason: "déjà à jour" });
  });

  it("refuses a resulting pack and price in two units, whichever field was sent", () => {
    const refusal = { status: "refused", reason: "le paquet et le prix doivent être dans la même unité" };
    const set = setPack(fixtureState(), "comté", PACK, PRICE).state;
    const send = (s: State, payload: unknown) => applyOp(s, op("product.pack", { name: "comté", ...(payload as object) }), NOW);
    expect(send(set, { price: { cents: 100, qty: 1, unit: "piece" } }).result).toEqual(refusal);
    expect(send(set, { pack: { qty: 2, unit: "piece" } }).result).toEqual(refusal);
    expect(send(fixtureState(), { pack: PACK, price: { cents: 100, qty: 1, unit: "piece" } }).result).toEqual(refusal);
    expect(comte(send(set, { pack: { qty: 2, unit: "piece" } }).state)).toMatchObject({ pack: PACK, price: PRICE });
  });

  it("survives a product.upsert of the same product", () => {
    const packed = setPack(fixtureState(), "comté", PACK, PRICE).state;
    const c = comte(packed);
    const r = upsert(packed, pantry({ name: "comté", category: "cremerie", is_staple: false, roles: ["protein:laitier"], shelf_life_days: 40, opened_shelf_life_days: 21, default_unit: "g" }));
    expect(r.result.status).toBe("applied");
    expect(comte(r.state)).toMatchObject({ id: c.id, shelfLifeDays: 40, pack: PACK, price: PRICE });
  });

  it("cannot be undone", () => {
    const added = applyOp(fixtureState(), { ...op("product.pack", { name: "comté", pack: PACK, price: PRICE }), opId: "pack-1" }, NOW).state;
    expect(applyOp(added, op("undo", { targetOpId: "pack-1" }), NOW).result).toEqual({ status: "refused", reason: "cette action ne s'annule pas" });
  });
});
