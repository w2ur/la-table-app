import { describe, expect, it } from "vitest";
import { RULES } from "../domain/rules.config";
import { applyOp } from "../domain/ops/apply";
import type { State } from "../domain/types";
import { NOW, fixtureProposal, fixtureState, op } from "../domain/test-fixtures";
import { renderStatus } from "./status";

function run(state: State, ...ops: ReturnType<typeof op>[]): State {
  return ops.reduce((s, o) => {
    const r = applyOp(s, o, NOW);
    expect(r.result.status, `${o.type}: ${r.result.reason}`).not.toBe("refused");
    return r.state;
  }, state);
}

describe("renderStatus", () => {
  it("prints the pool, Reste by urgency, envies, feedback, trips without total, lines to price and calibration", () => {
    // committed the evening before, so the meal cooked at NOW counts as feedback since the last planning
    let s = run(fixtureState(), op("planning.commit", fixtureProposal(), "2026-10-11T18:00:00.000Z"));
    const line = s.shoppingItems.find((l) => l.kind === "planning")!;
    s = run(s,
      op("shopping.buy", { itemId: line.id }),
      op("shopping.add", { label: "éponges", isFood: false }),
      op("envie.add", { text: "un curry de pois chiches", url: null }),
    );
    const ajout = s.shoppingItems.find((l) => l.label === "éponges")!;
    s = run(s,
      op("shopping.buy", { itemId: ajout.id }),
      op("trip.record", { place: "marche", totalCents: null, date: "2026-10-12", itemIds: [line.id, ajout.id] }),
      op("meal.cook", { mealId: s.meals[0]!.id, sheet: { verdict: "a_refaire", note: "plus de citron", items: [] } }),
    );
    const stock = (id: number, label: string, productId: number | null, extra: Partial<State["stockItems"][number]>) => ({
      id, productId, label, qty: 100, unit: "g" as const, qtyText: null, isLow: false, useBy: null, openedAt: null, finishedAt: null,
      origin: "ajout" as const, sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW, ...extra,
    });
    s.stockItems.push(
      stock(900, "lentilles vertes", 3, { isLow: true }),
      stock(901, "yaourts", null, { useBy: "2026-10-10" }),
      stock(902, "restes de riz", null, {}),
    );
    const leek = s.stockItems.find((i) => i.label === "poireau")!;
    leek.qty = (leek.qty ?? 0) + 200; // partly reserved: 200 g stay free
    s.meals[1]!.cookEarlyReason = "épinards fragiles";
    s.meals[1]!.doubledFrom = s.meals[0]!.id;
    const out = renderStatus(s, NOW);
    expect(out).toMatch(/Menu · 2 repas à cuisiner/);
    expect(out).toMatch(/  - #\d+ [^\n]* · réservé : poireau \d+ g/); // the pool shows what Reste holds for each meal (§7.1 step 3)
    expect(out).toContain("Reste");
    // Regression: 2620fff — Reste lines were untested; the per-item loop and its markers could vanish with the suite green
    expect(out).toMatch(/ Réservé :\n  - #\d+ poireau[^\n]* · réservé \d+ g pour /);
    expect(out).toMatch(/ Placard :\n  - #900 lentilles vertes[^\n]* · presque fini/);
    expect(out).toMatch(/ À utiliser vite :\n  - #901 yaourts[^\n]*\(dépassé\)/);
    expect(out).toContain("un curry de pois chiches");
    expect(out).toMatch(/Retours depuis la dernière planification[\s\S]*· À refaire · « plus de citron »/);
    expect(out).toMatch(/Passages sans total[\s\S]*#\d+ · lundi 12 octobre · marché/);
    expect(out).toMatch(/Lignes à chiffrer[\s\S]*#\d+ éponges/);
    expect(out).toMatch(/Calibrage : pas encore \(0 \/ 3 passages\)/);
    expect(out).toMatch(/Courses en cours : [^\n]+ estimés/);
    expect(out).toContain(" · second tour");
    expect(out).toContain(" · à cuisiner tôt : épinards fragiles");
    expect(out).toMatch(/ Libre :\n  - #902 restes de riz/);
    expect(out).toMatch(/réservé \d+ g pour [^\n]* · ≈ [^\n]+ libres/);
  });

  it("lists neither a trip without a receipt under « Passages sans total » nor its lines under « Lignes à chiffrer »", () => {
    const added = run(fixtureState(), op("shopping.add", { label: "éponges", isFood: false }), op("shopping.add", { label: "sacs", isFood: false }));
    const [a, b] = added.shoppingItems as [State["shoppingItems"][number], State["shoppingItems"][number]];
    const s = run(added,
      op("shopping.buy", { itemId: a.id }),
      op("shopping.buy", { itemId: b.id }),
      op("trip.record", { place: "marche", totalCents: null, date: "2026-10-12", itemIds: [a.id] }),
      op("trip.record", { place: "autre", noReceipt: true, date: "2026-10-12", itemIds: [b.id] }),
    );
    const [receiptTrip, noReceiptTrip] = s.trips as [State["trips"][number], State["trips"][number]];
    const out = renderStatus(s, NOW);
    expect(out).toContain(`  - #${receiptTrip.id} · lundi 12 octobre · marché`);
    expect(out).not.toContain(`#${noReceiptTrip.id} · lundi 12 octobre · autre`);
    expect(out).toContain(`#${a.id} éponges`);
    expect(out).not.toContain(`#${b.id} sacs`);
    expect(out).toContain(`(passage #${receiptTrip.id})`);
    expect(out).not.toContain(`(passage #${noReceiptTrip.id})`);
  });

  it("prints the calibration factor once enough trips are priced", () => {
    // Regression: 2620fff — only the "pas encore" calibration branch was tested
    const s = fixtureState();
    for (let n = 1; n <= RULES.calibrationMinTrips; n++) {
      s.trips.push({ id: n, date: `2026-10-0${n}`, place: "marche", totalCents: 1200, noReceipt: null, createdAt: NOW });
      s.shoppingItems.push({
        id: n, productId: null, label: `ligne ${n}`, qty: null, unit: null, plannedQty: null, estPriceCents: 1000, kind: "ajout", planningId: null,
        forMeals: [], isFood: true, boughtAt: NOW, tripId: n, removedAt: null, createdAt: NOW,
      });
    }
    expect(renderStatus(s, NOW)).toMatch(/Calibrage : × 1,20 sur 3 passages/);
  });

  it("does not pluralise a one-portion meal", () => {
    // Regression: 2620fff — « 1 portions » in the pool line
    const s = run(fixtureState(), op("planning.commit", fixtureProposal(), "2026-10-11T18:00:00.000Z"));
    s.meals[0]!.portions = 1;
    const out = renderStatus(s, NOW);
    expect(out).toMatch(/ · 1 portion(?!s)/);
    expect(out).toMatch(/ · 2 portions/);
  });

  it("says so when there is nothing to report in a section", () => {
    const out = renderStatus(fixtureState(), NOW);
    expect(out).toContain("Menu · 0 repas à cuisiner");
    expect(out).toContain("Retours depuis la dernière planification : aucun");
    expect(out).toContain("Passages sans total : aucun");
    expect(out).toContain("Lignes à chiffrer : aucune");
  });
});

describe("renderStatus Restes à préciser", () => {
  const stock = (id: number, label: string, productId: number | null, extra: Partial<State["stockItems"][number]>) => ({
    id, productId, label, qty: 0 as number | null, unit: "g" as const, qtyText: null, isLow: false, useBy: null, openedAt: null, finishedAt: null,
    origin: "ajout" as const, sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW, ...extra,
  });

  it("comes first, names each unknown leftover with its words, and leaves a staple out", () => {
    const s = fixtureState();
    s.stockItems.push(
      stock(64, "comté", 2, { qtyText: "125g" }),
      stock(65, "poireau", 1, { qty: null, unit: null, qtyText: "un fond" }),
      stock(66, "lentilles vertes", 3, {}),
    );
    const out = renderStatus(s, NOW);
    expect(out.startsWith("Restes à préciser :\n  - #64 comté · 0 g « 125g »\n  - #65 poireau · quantité inconnue « un fond »\n\nManques : aucun\n\nMenu")).toBe(true);
  });

  it("says aucun when every leftover is known", () => {
    expect(renderStatus(fixtureState(), NOW).startsWith("Restes à préciser : aucun\n\nManques : aucun\n\nMenu")).toBe(true);
  });
});

describe("renderStatus Manques", () => {
  // 160 g of comté at home: the gratin (meal 1) reserves 100 g, the salade (meal 2) the other 60 g and puts 40 g on Courses
  const held = (): State => {
    const s = fixtureState();
    s.stockItems.push({ id: 1, productId: 2, label: "comté", qty: 160, unit: "g", qtyText: null, isLow: false, useBy: null, openedAt: null,
      finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
    return run(s, op("planning.commit", fixtureProposal()));
  };
  const section = (out: string) => out.split("\n\n")[1];

  // Regression: 309f2ec, 5d56e5e — a declared leftover below the meals' holds was raised to them, so their shortage never showed
  it("lists, after Restes à préciser, each open meal a declared leftover left short, by product, amount and meal", () => {
    const s = run(held(), op("stock.partial", { itemId: 1, qtyText: "50 g", low: false }));
    expect(section(renderStatus(s, NOW))).toBe(
      "Manques :\n  - comté : 50 g manquent pour Gratin de poireaux au comté (#1)\n  - comté : 60 g manquent pour Salade d'endives au comté (#2)");
  });

  // Regression: 309f2ec, 5d56e5e — words that are no quantity on an item two meals held kept both holds behind a made-up number
  it("lists the meals released when the quantity becomes unknown, the earliest planned one keeping its hold", () => {
    const s = run(held(), op("stock.partial", { itemId: 1, qtyText: "un peu", low: false }));
    expect(section(renderStatus(s, NOW))).toBe("Manques :\n  - comté : 60 g manquent pour Salade d'endives au comté (#2)");
  });

  it("says aucun while every open meal is covered, and « manque » for a single unit", () => {
    expect(section(renderStatus(held(), NOW))).toBe("Manques : aucun");
    const s = run(held(), op("stock.partial", { itemId: 1, qtyText: "159 g", low: false }));
    expect(section(renderStatus(s, NOW))).toBe("Manques :\n  - comté : 1 g manque pour Salade d'endives au comté (#2)");
  });

  it("notes the free Reste stock of that product and unit beside a Manque, and nothing when none is free", () => {
    const s = run(held(), op("stock.partial", { itemId: 1, qtyText: "50 g", low: false }));
    expect(section(renderStatus(s, NOW))).not.toContain("libres");
    const withFree = run(s, op("stock.add", { label: "comté", productId: 2, qtyText: "950 g", useBy: null }));
    expect(section(renderStatus(withFree, NOW))).toBe(
      "Manques :\n  - comté : 50 g manquent pour Gratin de poireaux au comté (#1) (Reste : 950 g libres)\n  - comté : 60 g manquent pour Salade d'endives au comté (#2) (Reste : 950 g libres)");
  });
});

describe("renderStatus nutrition", () => {
  it("counts and names the products without nutrition values", () => {
    const s = fixtureState();
    for (const p of s.products) {
      if (p.name !== "poireau" && p.name !== "comté") p.nutrition = { ciqualCode: "T0001", per100g: { kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, saltG: 0 }, gramsPerPiece: null, gramsPerMl: null, ediblePct: 100 };
    }
    const out = renderStatus(s, NOW);
    expect(out).toContain("\nProduits sans valeurs nutritionnelles : 2\n  comté, poireau\n");
    for (const p of s.products) p.nutrition = s.products[2]!.nutrition;
    expect(renderStatus(s, NOW)).toContain("\nProduits sans valeurs nutritionnelles : 0\n");
  });

  it("leaves a seasoning out of the products without nutrition values", () => {
    const s = fixtureState();
    for (const p of s.products) p.nutrition = null;
    const before = renderStatus(s, NOW);
    s.products[0]!.roles = [...s.products[0]!.roles, "assaisonnement"];
    expect(renderStatus(s, NOW)).toContain(`\nProduits sans valeurs nutritionnelles : ${s.products.length - 1}\n`);
    expect(before).toContain(`\nProduits sans valeurs nutritionnelles : ${s.products.length}\n`);
    const nutritionBlock = renderStatus(s, NOW).split("\nProduits sans valeurs nutritionnelles")[1]!.split("\n\n")[0]!;
    expect(nutritionBlock).not.toContain(s.products[0]!.name + ",");
  });

  // Regression: 4643a86 — a history from an older server has no nutrition key, and `=== null` counted that product as having values
  it("counts a product without the nutrition key as without values", () => {
    const s = fixtureState();
    for (const p of s.products) delete (p as { nutrition?: unknown }).nutrition;
    expect(renderStatus(s, NOW)).toContain(`\nProduits sans valeurs nutritionnelles : ${s.products.length}\n`);
  });
});

describe("renderStatus reference prices", () => {
  it("counts and names the products without a reference price", () => {
    const s = fixtureState();
    for (const p of s.products) p.price = { cents: 100, qty: 1000, unit: "g" };
    s.products[0]!.price = null;
    delete (s.products[1] as { price?: unknown }).price;
    const names = [s.products[0]!.name, s.products[1]!.name].sort((a, b) => a.localeCompare(b, "fr")).join(", ");
    expect(renderStatus(s, NOW)).toContain(`\nProduits sans prix de référence : 2\n  ${names}\n`);
    for (const p of s.products) p.price = { cents: 100, qty: 1000, unit: "g" };
    expect(renderStatus(s, NOW)).toContain("\nProduits sans prix de référence : 0\n");
  });
});
