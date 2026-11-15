import { describe, expect, it } from "vitest";
import { checkProposal } from "./check";
import { BLOCK_FIXTURES, WARN_FIXTURE, withPastPlanning } from "./check-fixtures";
import { NOW, P, R, fixtureProposal, fixtureState } from "./test-fixtures";

const ids = (vs: { ruleId: string }[]) => vs.map((v) => v.ruleId);

describe("checkProposal", () => {
  it("passes the fixture proposal and summarises cost against budget", () => {
    const r = checkProposal(fixtureState(), fixtureProposal(), NOW);
    expect(r.blocks).toEqual([]);
    expect(r.warns).toEqual([]);
    expect(r.mealsAdded).toBe(3);
    expect(r.budgetCents).toBe(3000); // 3 meals × 2 portions × 500
    expect(r.estimateCents).toBe(280 + 500 + 260 + 650 + 190); // planning lines only, staples excluded
    expect(r.lines.find((l) => l.productId === P.lentilles)).toMatchObject({ kind: "staple_hors_budget", estPriceCents: 150 });
    expect(r.mealCostsCents).toHaveLength(3);
  });

  it("blocks schema and resolution errors before evaluating rules", () => {
    expect(ids(checkProposal(fixtureState(), { meals: [] }, NOW).blocks)).toContain("schema");
    const p = fixtureProposal();
    p.meals = [{ recipe: 99, portions: 2, doubled: false }];
    expect(ids(checkProposal(fixtureState(), p, NOW).blocks)).toEqual(["resolve"]);
  });

  it("blocks a meal missing a protein, a vegetable or a fibre", () => {
    const p = fixtureProposal();
    p.new_recipes = [{ key: "r1", title: "Riz nature", source_url: null, base_portions: 2, active_min: 15, total_min: 20,
      main_protein: "protein:oeuf", steps: [], ingredients: [{ product: "riz complet", qty: 150, unit: "g" }] }];
    p.meals = [{ recipe: "r1", portions: 2, doubled: false }, { recipe: R.saumonLentilles, portions: 2, doubled: false }];
    const r = checkProposal(fixtureState(), p, NOW);
    expect(ids(r.blocks)).toEqual(expect.arrayContaining(["meal-protein", "meal-vegetable"]));
    expect(r.blocks.find((b) => b.ruleId === "meal-vegetable")?.mealIndex).toBe(0);
  });

  it("scales the legume and fish minimums to the number of meals", () => {
    const p = fixtureProposal();
    p.meals = [{ recipe: R.gratin, portions: 2, doubled: false }, { recipe: R.poulet, portions: 2, doubled: false }];
    expect(ids(checkProposal(fixtureState(), p, NOW).blocks)).toEqual(expect.arrayContaining(["planning-legume", "planning-fish"]));
  });

  it("blocks red meat unless requested, and then allows one", () => {
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.courgettes, portions: 2, doubled: false }];
    p.prices = [...(p.prices as unknown[]), { product: "courgette", unit: "g", est_price_cents: 300 }, { product: "bœuf haché", unit: "g", est_price_cents: 400 }];
    expect(ids(checkProposal(fixtureState(), p, NOW).blocks)).toContain("red-meat");
    (p.params as { red_meat_requested: boolean }).red_meat_requested = true;
    expect(ids(checkProposal(fixtureState(), p, NOW).blocks)).not.toContain("red-meat");
  });

  it("blocks out-of-season fresh produce but not exceptions", () => {
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.courgettes, portions: 2, doubled: false }];
    p.params = { portions: 2, red_meat_requested: true, constraints: "" };
    p.prices = [...(p.prices as unknown[]), { product: "courgette", unit: "g", est_price_cents: 300 }, { product: "bœuf haché", unit: "g", est_price_cents: 400 }];
    const r = checkProposal(fixtureState(), p, NOW);
    expect(r.blocks.find((b) => b.ruleId === "season")?.message).toBe("hors saison : courgette (Courgettes farcies)");
  });

  it("blocks a recipe repeated within the last 4 plannings, unless favourite, and a favourite two plannings in a row", () => {
    const s = withPastPlanning(fixtureState(), [R.gratin]);
    expect(ids(checkProposal(s, fixtureProposal(), NOW).blocks)).toContain("no-repeat");
    s.recipes.find((r) => r.id === R.gratin)!.status = "favourite";
    const r = checkProposal(s, fixtureProposal(), NOW);
    expect(ids(r.blocks)).not.toContain("no-repeat");
    expect(ids(r.blocks)).toContain("favourite-gap");
  });

  // Regression: 1c0385f — the same recipe could be proposed twice as two meals instead of being doubled
  it("blocks the same recipe twice in one proposal, by id or by new-recipe title, and lets a doubled recipe through", () => {
    const p = fixtureProposal();
    p.meals = [{ recipe: R.gratin, portions: 2, doubled: false }, { recipe: R.saumonLentilles, portions: 2, doubled: false }, { recipe: R.saumonLentilles, portions: 2, doubled: false }];
    const repeat = checkProposal(fixtureState(), p, NOW).blocks.filter((b) => b.ruleId === "no-repeat");
    expect(repeat).toEqual([{ ruleId: "no-repeat", mealIndex: 2, message: "Saumon aux lentilles et poireaux : déjà proposée dans cette planification" }]);

    const recipe = (key: string, title: string) => ({ key, title, source_url: null, base_portions: 2, active_min: 20, total_min: 30, main_protein: "protein:poisson",
      steps: [], ingredients: [{ product: "pavé de saumon", qty: 250, unit: "g" }, { product: "poireau", qty: 300, unit: "g" }, { product: "lentilles vertes", qty: 150, unit: "g" }] });
    p.new_recipes = [recipe("a", "Saumon vapeur"), recipe("b", "saumon vapeur ")];
    p.meals = [{ recipe: R.gratin, portions: 2, doubled: false }, { recipe: "a", portions: 2, doubled: false }, { recipe: "b", portions: 2, doubled: false }];
    expect(ids(checkProposal(fixtureState(), p, NOW).blocks)).toContain("no-repeat");

    p.new_recipes = [];
    p.meals = [{ recipe: R.gratin, portions: 2, doubled: false }, { recipe: R.saumonLentilles, portions: 2, doubled: true }];
    expect(ids(checkProposal(fixtureState(), p, NOW).blocks)).not.toContain("no-repeat");
  });

  it("blocks banned recipes and new recipes that duplicate a known title", () => {
    const s = fixtureState();
    s.recipes.find((r) => r.id === R.salade)!.status = "banned";
    expect(ids(checkProposal(s, fixtureProposal(), NOW).blocks)).toContain("banned");
    const p = fixtureProposal();
    p.new_recipes = [{ key: "r1", title: "  gratin de poireaux au Comté", source_url: null, base_portions: 2, active_min: 10,
      total_min: 10, main_protein: "protein:laitier", steps: [], ingredients: [] }];
    p.meals = [...(p.meals as unknown[]), { recipe: "r1", portions: 2, doubled: false }];
    expect(ids(checkProposal(fixtureState(), p, NOW).blocks)).toContain("duplicate-recipe");
  });

  it("blocks more than 2 meals sharing a main protein across the pool after commit", () => {
    const s = withPastPlanning(fixtureState(), [R.poulet], { cooked: false, longAgo: true });
    const p = fixtureProposal();
    p.meals = [...(p.meals as unknown[]), { recipe: R.poulet, portions: 2, doubled: true }];
    p.prices = [...(p.prices as unknown[]), { product: "filet de poulet", unit: "g", est_price_cents: 900 }];
    expect(ids(checkProposal(s, p, NOW).blocks)).toContain("protein-rotation");
  });

  it("blocks a list line without a price", () => {
    const p = fixtureProposal();
    p.prices = (p.prices as { product: string }[]).filter((x) => x.product !== "endive");
    expect(checkProposal(fixtureState(), p, NOW).blocks.find((b) => b.ruleId === "price-missing")?.message).toBe("prix manquant : endive (400 g)");
  });

  it("warns on budget overrun, long meals, unused perishables and reliance on unknown-quantity stock", () => {
    const { state: s, proposal: p } = WARN_FIXTURE();
    const r = checkProposal(s, p, NOW);
    expect(ids(r.warns)).toEqual(expect.arrayContaining(["budget", "perishable-unused", "unknown-qty-stock"]));
    expect(r.blocks).toEqual([]);
  });

  // Regression: 81bd3a6 — budget and perishable warns printed raw cents and ISO dates
  it("writes warn amounts with formatEuros and dates with formatDay", () => {
    const { state: s, proposal: p } = WARN_FIXTURE();
    const r = checkProposal(s, p, NOW);
    const budget = r.warns.find((w) => w.ruleId === "budget")!.message;
    const perishable = r.warns.find((w) => w.ruleId === "perishable-unused")!.message;
    expect(budget).toContain("€");
    expect(budget).not.toMatch(/\d c(\s|\)|$)/);
    expect(perishable).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  // Regression: c1299e8 — protein-rotation printed the raw role id (protein:laitier)
  it("names the main protein in French in the protein-rotation block", () => {
    const { state, proposal } = BLOCK_FIXTURES["protein-rotation"]!();
    const message = checkProposal(state, proposal, NOW).blocks.find((b) => b.ruleId === "protein-rotation")!.message;
    expect(message).not.toMatch(/protein:/);
    expect(message).toMatch(/avec [\p{L} ]+ au menu/u);
  });

  // Regression: 2171e87 — protein labels lost their accents (legumineuse, oeuf)
  it("spells accented protein labels in French", () => {
    const { state, proposal } = BLOCK_FIXTURES["protein-rotation"]!();
    const resolved = (role: string) => {
      const s = structuredClone(state);
      for (const r of s.recipes) r.mainProtein = role;
      return checkProposal(s, proposal, NOW).blocks.find((b) => b.ruleId === "protein-rotation")?.message;
    };
    expect(resolved("protein:legumineuse")).toMatch(/avec légumineuses au menu/);
    expect(resolved("protein:oeuf")).toMatch(/avec œuf au menu/);
  });

  // Regression: 2171e87 — price-missing printed the raw unit id (piece)
  it("spells the piece unit in French in the price-missing block", () => {
    const p = fixtureProposal();
    p.new_recipes = [{ key: "r1", title: "Poireau entier", source_url: null, base_portions: 2, active_min: 15, total_min: 20,
      main_protein: "protein:oeuf", steps: [], ingredients: [{ product: "poireau", qty: 2, unit: "piece" }] }];
    p.meals = [...(p.meals as unknown[]), { recipe: "r1", portions: 2, doubled: false }];
    const message = checkProposal(fixtureState(), p, NOW).blocks.find((b) => b.ruleId === "price-missing")!.message;
    expect(message).toBe("prix manquant : poireau (2 pièces)");
  });

  // Regression: 2171e87 — perishable warn had no month and said "avant" for an expired item
  it("adds the month and words an expired item as périmé", () => {
    const { state, proposal } = WARN_FIXTURE();
    const message = (useBy: string) => {
      const s = structuredClone(state);
      s.stockItems[0]!.useBy = useBy;
      return checkProposal(s, proposal, NOW).warns.find((w) => w.ruleId === "perishable-unused")!.message;
    };
    expect(message("2026-10-14")).toContain("avant mercredi 14 octobre");
    expect(message("2026-09-30")).toContain("périmé depuis mercredi 30 septembre");
  });

  // Regression: c1299e8 — envie block numbered meals from 0 while the printed list starts at 1
  it("numbers the missing meal from 1 in the envie block", () => {
    const p = fixtureProposal();
    p.envies = { placed: [{ envie_id: 99, meal_index: 5 }], kept: [] };
    const message = checkProposal(fixtureState(), p, NOW).blocks.find((b) => b.message.includes("inexistant"))!.message;
    expect(message).toBe("envie #99 : repas 6 inexistant");
  });

  // Regression: c1299e8 — uncalibrated budget warn read "(calibrée —)"
  it("leaves the calibration out of the budget warn when there is none", () => {
    const { state, proposal } = WARN_FIXTURE();
    const message = checkProposal(state, proposal, NOW).warns.find((w) => w.ruleId === "budget")!.message;
    expect(message).not.toContain("calibrée");
    expect(message).not.toContain("—");
  });
});

describe("check with packs and reference prices", () => {
  it("prices a line from the reference, ignoring and naming the proposal's price for it", () => {
    const s = fixtureState();
    Object.assign(s.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 420, qty: 250, unit: "g" } });
    const r = checkProposal(s, fixtureProposal(), NOW);
    expect(r.lines.find((l) => l.productId === P.comte)).toMatchObject({ qty: 250, estPriceCents: 420 });
    expect(r.warns).toContainEqual(expect.objectContaining({ ruleId: "price-reference", message: "prix de référence utilisé pour comté (prix de la proposition ignoré)" }));
  });

  // Regression: bbc2a25 — a proposal price equal to the reference was still named as ignored
  it("says nothing of a proposal price equal to the reference", () => {
    const s = fixtureState();
    Object.assign(s.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 420, qty: 250, unit: "g" } });
    const input = fixtureProposal();
    input.prices = (input.prices as { product: string }[]).map((p) => (p.product === "comté" ? { ...p, est_price_cents: 420 } : p));
    expect(checkProposal(s, input, NOW).warns.filter((w) => w.ruleId === "price-reference")).toEqual([]);
  });

  // Regression: 4261e77, f52ada8 — a meal pays its share of a rounded line; the pack surplus counts in the estimate only
  it("charges each meal its share of a rounded line, the surplus in no meal", () => {
    const plain = checkProposal(fixtureState(), fixtureProposal(), NOW); // comté 200 g exact at 500 c: 250 c a meal
    const s = fixtureState();
    Object.assign(s.products.find((p) => p.id === P.comte)!, { pack: { qty: 250, unit: "g" }, price: { cents: 420, qty: 250, unit: "g" } });
    const r = checkProposal(s, fixtureProposal(), NOW); // comté 250 g at 420 c, shares 100 + 100: 168 c a meal
    expect(r.mealCostsCents.map((c, i) => c - plain.mealCostsCents[i]!)).toEqual([168 - 250, 168 - 250, 0]);
    expect(r.estimateCents - plain.estimateCents).toBe(420 - 500);
  });

  it("prices a loose product per kilo, and falls back to the proposal without a reference", () => {
    const s = fixtureState();
    s.products.find((p) => p.id === P.poireau)!.price = { cents: 369, qty: 1000, unit: "g" };
    const input = fixtureProposal();
    input.prices = (input.prices as { product: string }[]).filter((p) => p.product !== "poireau");
    const r = checkProposal(s, input, NOW);
    // gratin 400 g + saumon 300 g, loose: 700 g × 3,69 €/kg
    expect(r.lines.find((l) => l.productId === P.poireau)).toMatchObject({ qty: 700, estPriceCents: 258 });
    expect(r.lines.find((l) => l.productId === P.endive)!.estPriceCents).toBe(260);
    expect(r.blocks).toEqual([]);
  });

  // Regression: fdcad2a — price-missing named only the unit, so the price Claude supplied was for the need, not for the line rounded to the pack
  it("names the rounded quantity and the pack of a line without a price", () => {
    const s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
    const input = fixtureProposal();
    input.prices = (input.prices as { product: string }[]).filter((p) => p.product !== "comté" && p.product !== "poireau");
    const messages = checkProposal(s, input, NOW).blocks.filter((b) => b.ruleId === "price-missing").map((b) => b.message);
    expect(messages).toEqual(["prix manquant : poireau (700 g)", "prix manquant : comté (250 g, paquet de 250 g)"]);
  });

  // Regression: 1adc60f — a history from a server without the price key (before migration 0007) made check throw on every line
  it("reads a product without the pack and price keys as having neither", () => {
    const s = fixtureState();
    for (const p of s.products) {
      delete (p as Partial<typeof p>).pack;
      delete (p as Partial<typeof p>).price;
    }
    const r = checkProposal(s, fixtureProposal(), NOW);
    expect(r.blocks).toEqual([]);
    expect(r.lines.find((l) => l.productId === P.comte)).toMatchObject({ qty: 200, estPriceCents: 500 });
  });

  it("warns of a pack's surplus with no planned use, never of a staple's", () => {
    const s = fixtureState();
    s.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
    s.products.find((p) => p.id === P.lentilles)!.pack = { qty: 500, unit: "g" };
    const r = checkProposal(s, fixtureProposal(), NOW);
    expect(r.warns.filter((w) => w.ruleId === "pack-leftover").map((w) => w.message)).toEqual(["≈ 50 g de comté resteront, sans emploi prévu"]);
    expect(r.blocks).toEqual([]);
  });
});
