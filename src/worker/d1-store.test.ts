import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("has the migrated schema and the seed", async () => {
  const row = await env.DB.prepare("SELECT version FROM meta WHERE id = 1").first<{ version: number }>();
  expect(row?.version).toBe(0);
  const products = await env.DB.prepare("SELECT COUNT(*) AS n FROM products").first<{ n: number }>();
  expect(products!.n).toBeGreaterThan(100);
});

import { CONFLICT, applyOpsAndPersist, loadState, persist } from "./d1-store";
import { HANDLERS, applyOp } from "../domain/ops/apply";
import { NOT_UNDOABLE } from "../domain/ops/undo";
import { undoWindowStart } from "../domain/snapshot";
import { fixtureProposal } from "../domain/test-fixtures";

const NOW = "2026-10-12T10:00:00.000Z";
const applyAndPersist = async (db: D1Database, raw: unknown, now: string) => (await applyOpsAndPersist(db, [raw], now)).results[0]!;
const version = async () => (await env.DB.prepare("SELECT version FROM meta WHERE id = 1").first<{ version: number }>())!.version;
const proposalAgainstSeed = () => {
  // Same shape as the fixture, against seeded product names; recipes are created inline.
  const p = fixtureProposal();
  p.new_recipes = [
    { key: "a", title: "Gratin de poireaux au comté", source_url: null, base_portions: 2, active_min: 20, total_min: 40, main_protein: "protein:laitier",
      steps: ["Cuire."], ingredients: [{ product: "poireau", qty: 400, unit: "g" }, { product: "comté", qty: 100, unit: "g" }, { product: "riz complet", qty: 150, unit: "g" }] },
    { key: "b", title: "Salade d'endives au comté", source_url: null, base_portions: 2, active_min: 15, total_min: 15, main_protein: "protein:laitier",
      steps: ["Mélanger."], ingredients: [{ product: "endive", qty: 400, unit: "g" }, { product: "comté", qty: 100, unit: "g" }, { product: "lentilles vertes", qty: 100, unit: "g" }] },
    { key: "c", title: "Saumon aux lentilles", source_url: null, base_portions: 2, active_min: 25, total_min: 40, main_protein: "protein:poisson",
      steps: ["Cuire."], ingredients: [{ product: "pavé de saumon", qty: 250, unit: "g" }, { product: "lentilles vertes", qty: 150, unit: "g" }, { product: "poireau", qty: 300, unit: "g" }] },
  ];
  p.meals = [{ recipe: "a", portions: 2, doubled: false }, { recipe: "b", portions: 2, doubled: false }, { recipe: "c", portions: 2, doubled: false }];
  return p;
};

it("applies a commit and a buy, and loadState reads them back", async () => {
  expect((await applyAndPersist(env.DB, { opId: "c1", type: "planning.commit", at: NOW, payload: proposalAgainstSeed() }, NOW)).status).toBe("applied");
  let state = await loadState(env.DB, []);
  expect(state.meals).toHaveLength(3);
  expect(state.version).toBe(1);
  const comte = state.shoppingItems.find((l) => l.label === "comté")!;
  expect(comte.forMeals).toEqual([{ mealId: 1, qty: 100 }, { mealId: 2, qty: 100 }]);

  expect((await applyAndPersist(env.DB, { opId: "b1", type: "shopping.buy", at: NOW, payload: { itemId: comte.id } }, NOW)).status).toBe("applied");
  state = await loadState(env.DB, ["b1"]);
  expect(state.stockItems).toHaveLength(1);
  expect(state.appliedOps.b1!.changes.length).toBeGreaterThan(0);
  expect((await applyAndPersist(env.DB, { opId: "b1", type: "shopping.buy", at: NOW, payload: { itemId: comte.id } }, NOW))).toEqual({ status: "applied", reason: null });
});

it("round-trips a product's nutrition, and a product without, through write and load", async () => {
  const state = await loadState(env.DB, []);
  const [withNutrition, without] = state.products;
  const nutrition = { ciqualCode: "T0001", per100g: { kcal: 30, proteinG: 1.5, carbsG: 4.6, fatG: 0.3, fibreG: 3.2, saltG: 0.02 }, gramsPerPiece: 250, gramsPerMl: null, ediblePct: 100 };
  expect(without!.nutrition).toBeNull();
  const updated = { ...withNutrition!, nutrition };
  expect(await persist(env.DB, state.version, [{ table: "products", id: updated.id, before: { ...withNutrition! }, after: { ...updated } }], [])).not.toBeNull();
  const reloaded = (await loadState(env.DB, [])).products;
  expect(reloaded.find((p) => p.id === updated.id)).toEqual(updated);
  expect(reloaded.find((p) => p.id === without!.id)!.nutrition).toBeNull();
});

it("persists a line's planned quantity in migration 0008's column, and writes it back to null on undo", async () => {
  // the comté line the first test bought
  const comte = (await loadState(env.DB, [])).shoppingItems.find((l) => l.label === "comté" && l.boughtAt !== null)!;
  expect(comte).toMatchObject({ qty: 200, plannedQty: null });
  const row = () => env.DB.prepare("SELECT qty, planned_qty FROM shopping_items WHERE id = ?").bind(comte.id).first<{ qty: number; planned_qty: number | null }>();
  expect((await applyAndPersist(env.DB, { opId: "pq-q", type: "shopping.set_bought_qty", at: NOW, payload: { itemId: comte.id, qty: 260 } }, NOW)).status).toBe("applied");
  const state = await loadState(env.DB, []);
  expect(state.shoppingItems.find((l) => l.id === comte.id)).toMatchObject({ qty: 260, plannedQty: 200 });
  expect(state.stockItems.find((i) => i.sourceShoppingItemId === comte.id)).toMatchObject({ qty: 260 });
  expect(await row()).toEqual({ qty: 260, planned_qty: 200 });
  expect((await applyAndPersist(env.DB, { opId: "pq-u", type: "undo", at: NOW, payload: { targetOpId: "pq-q" } }, NOW)).status).toBe("applied");
  expect(await row()).toEqual({ qty: 200, planned_qty: null });
});

// Regression: 0739f8d — a record written before migration 0008 carries no plannedQty in its line rows, so the undo of a
// buy made before the deploy was refused « modifié depuis » although nothing had changed
it("undoes a buy recorded before a migration added a column to its rows", async () => {
  const endive = (await loadState(env.DB, [])).shoppingItems.find((l) => l.label === "endive" && l.boughtAt === null)!;
  expect((await applyAndPersist(env.DB, { opId: "premig-b", type: "shopping.buy", at: NOW, payload: { itemId: endive.id } }, NOW)).status).toBe("applied");
  // the record as a Worker before 0008 wrote it: no plannedQty in any shopping_items row
  const stored = await env.DB.prepare("SELECT changes FROM applied_ops WHERE op_id = ?").bind("premig-b").first<{ changes: string }>();
  const changes = (JSON.parse(stored!.changes) as { table: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[]).map((c) => {
    if (c.table !== "shoppingItems") return c;
    const strip = (row: Record<string, unknown> | null) => { if (row === null) return null; const { plannedQty: _p, ...rest } = row; return rest; };
    return { ...c, before: strip(c.before), after: strip(c.after) };
  });
  expect(JSON.stringify(changes)).not.toContain("plannedQty");
  await env.DB.prepare("UPDATE applied_ops SET changes = ? WHERE op_id = ?").bind(JSON.stringify(changes), "premig-b").run();
  expect(await applyAndPersist(env.DB, { opId: "premig-u", type: "undo", at: NOW, payload: { targetOpId: "premig-b" } }, NOW)).toEqual({ status: "applied", reason: null });
  const after = await loadState(env.DB, []);
  expect(after.shoppingItems.find((l) => l.id === endive.id)).toMatchObject({ boughtAt: null, plannedQty: null });
  expect(after.stockItems.some((i) => i.sourceShoppingItemId === endive.id)).toBe(false);
});

// Migration 0009 precedent (see 0739f8d for 0008): a trip.record written before migration 0009 carries no noReceipt in its trip row, so its undo
// would read « modifié depuis » on a trip nothing has touched
it("undoes a trip recorded before migration 0009 added no_receipt, and stores a trip without a receipt in the column", async () => {
  const poireau = (await loadState(env.DB, [])).shoppingItems.find((l) => l.label === "poireau" && l.boughtAt === null)!;
  expect((await applyAndPersist(env.DB, { opId: "t0-b", type: "shopping.buy", at: NOW, payload: { itemId: poireau.id } }, NOW)).status).toBe("applied");
  expect((await applyAndPersist(env.DB, { opId: "t0-r", type: "trip.record", at: NOW, payload: { place: "marche", date: "2026-10-12", totalCents: 900, itemIds: [poireau.id] } }, NOW)).status).toBe("applied");
  const tripRow = (id: number) => env.DB.prepare("SELECT no_receipt FROM trips WHERE id = ?").bind(id).first<{ no_receipt: number | null }>();
  const trip = (await loadState(env.DB, [])).trips.at(-1)!;
  expect(trip).toMatchObject({ totalCents: 900, noReceipt: null });
  expect(await tripRow(trip.id)).toEqual({ no_receipt: null });
  // the record as a Worker before 0009 wrote it: no noReceipt in the trip row
  const stored = await env.DB.prepare("SELECT changes FROM applied_ops WHERE op_id = ?").bind("t0-r").first<{ changes: string }>();
  const changes = (JSON.parse(stored!.changes) as { table: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[]).map((c) => {
    if (c.table !== "trips") return c;
    const strip = (row: Record<string, unknown> | null) => { if (row === null) return null; const { noReceipt: _n, ...rest } = row; return rest; };
    return { ...c, before: strip(c.before), after: strip(c.after) };
  });
  expect(JSON.stringify(changes)).not.toContain("noReceipt");
  await env.DB.prepare("UPDATE applied_ops SET changes = ? WHERE op_id = ?").bind(JSON.stringify(changes), "t0-r").run();
  expect(await applyAndPersist(env.DB, { opId: "t0-u", type: "undo", at: NOW, payload: { targetOpId: "t0-r" } }, NOW)).toEqual({ status: "applied", reason: null });
  expect((await loadState(env.DB, [])).shoppingItems.find((l) => l.id === poireau.id)).toMatchObject({ boughtAt: NOW, tripId: null });

  // a trip without a receipt round-trips through the column, and its undo restores the line
  expect((await applyAndPersist(env.DB, { opId: "t0-n", type: "trip.record", at: NOW, payload: { place: "autre", date: "2026-10-12", noReceipt: true, itemIds: [poireau.id] } }, NOW)).status).toBe("applied");
  const none = (await loadState(env.DB, [])).trips.at(-1)!;
  expect(none).toMatchObject({ totalCents: null, noReceipt: true });
  expect(await tripRow(none.id)).toEqual({ no_receipt: 1 });
  expect(await applyAndPersist(env.DB, { opId: "t0-nu", type: "undo", at: NOW, payload: { targetOpId: "t0-n" } }, NOW)).toEqual({ status: "applied", reason: null });
  expect((await loadState(env.DB, [])).shoppingItems.find((l) => l.id === poireau.id)).toMatchObject({ tripId: null });
});

it("rejects a persist with a stale version and writes nothing", async () => {
  const before = await loadState(env.DB, []);
  const ok = await persist(env.DB, before.version - 1, [{ table: "envies", id: 99, before: null,
    after: { id: 99, text: "x", url: null, createdAt: NOW, status: "ouverte", mealId: null } }], []);
  expect(ok).toBeNull();
  expect((await loadState(env.DB, [])).envies.find((e) => e.id === 99)).toBeUndefined();
});

it("concurrent persist conflicts once then retries, losing no op", async () => {
  const results = await Promise.all([
    applyAndPersist(env.DB, { opId: "e1", type: "envie.add", at: NOW, payload: { text: "soupe", url: null } }, NOW),
    applyAndPersist(env.DB, { opId: "e2", type: "envie.add", at: NOW, payload: { text: "curry", url: null } }, NOW),
  ]);
  expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
  const texts = (await loadState(env.DB, [])).envies.map((e) => e.text);
  expect(texts).toEqual(expect.arrayContaining(["soupe", "curry"]));
});

it("an undo restores the rows in D1", async () => {
  await applyAndPersist(env.DB, { opId: "e3", type: "envie.add", at: NOW, payload: { text: "tarte", url: null } }, NOW);
  await applyAndPersist(env.DB, { opId: "u3", type: "undo", at: NOW, payload: { targetOpId: "e3" } }, NOW);
  const state = await loadState(env.DB, ["e3"]);
  expect(state.envies.find((e) => e.text === "tarte")).toBeUndefined();
  expect(state.appliedOps.e3!.undoneBy).toBe("u3");
});

// Regression: 106a490 — the undo deleted a reserved stock item, D1's foreign key threw inside the batch and the request failed with a 500
it("refuses, without throwing, to undo a stock.add once a later planning reserved the item", async () => {
  const comteId = (await loadState(env.DB, [])).products.find((p) => p.name === "comté")!.id;
  const add = { opId: "sa1", type: "stock.add", at: NOW, payload: { label: "comté", productId: comteId, qtyText: "un bon bout", useBy: null } };
  expect((await applyAndPersist(env.DB, add, NOW)).status).toBe("applied");
  const p = fixtureProposal();
  p.new_recipes = [{ key: "s", title: "Saumon gratiné au comté", source_url: null, base_portions: 2, active_min: 25, total_min: 40,
    main_protein: "protein:poisson", steps: ["Cuire."], ingredients: [{ product: "pavé de saumon", qty: 250, unit: "g" },
      { product: "lentilles vertes", qty: 150, unit: "g" }, { product: "poireau", qty: 300, unit: "g" }, { product: "comté", qty: 100, unit: "g" }] }];
  p.meals = [{ recipe: "s", portions: 2, doubled: false }];
  expect((await applyAndPersist(env.DB, { opId: "sc1", type: "planning.commit", at: NOW, payload: p }, NOW)).status).toBe("applied");

  const result = await applyAndPersist(env.DB, { opId: "su1", type: "undo", at: NOW, payload: { targetOpId: "sa1" } }, NOW);
  expect(result).toEqual({ status: "refused", reason: "utilisé depuis : impossible d'annuler" });
  const state = await loadState(env.DB, ["sa1"]);
  expect(state.stockItems.some((i) => i.label === "comté" && i.origin === "ajout")).toBe(true);
  expect(state.appliedOps.sa1!.undoneBy).toBeNull();
});

// Regression: c3f190e — a noop or a refusal bumped meta.version, so a phone tapping a stale row made the other writer retry
it("stores a noop and a refusal without bumping the version, and replays them as they were", async () => {
  const before = await version();
  const lineId = (await loadState(env.DB, [])).shoppingItems.find((l) => l.label === "comté")!.id;
  const again = { opId: "b2", type: "shopping.buy", at: NOW, payload: { itemId: lineId } };
  const missing = { opId: "m1", type: "meal.cook", at: NOW, payload: { mealId: 999, sheet: {} } };
  const { results } = await applyOpsAndPersist(env.DB, [again, missing], NOW);
  expect(results).toEqual([{ status: "noop", reason: "déjà acheté" }, { status: "refused", reason: "repas introuvable" }]);
  expect(await version()).toBe(before);
  const stored = await loadState(env.DB, ["b2", "m1"]);
  expect(stored.appliedOps.b2).toMatchObject({ status: "noop", reason: "déjà acheté", changes: [] });
  expect(stored.appliedOps.m1).toMatchObject({ status: "refused", reason: "repas introuvable" });
  expect((await applyOpsAndPersist(env.DB, [missing], NOW)).results).toEqual([{ status: "refused", reason: "repas introuvable" }]);
  expect(await version()).toBe(before);
});

it("does not store a refusal computed on a state another writer changed since", async () => {
  const loaded = await loadState(env.DB, []);
  await applyAndPersist(env.DB, { opId: "e9", type: "envie.add", at: NOW, payload: { text: "pho", url: null } }, NOW);
  const record = { opId: "r9", type: "meal.cook", appliedAt: NOW, status: "refused" as const, reason: "repas introuvable", changes: [], undoneBy: null, seq: 1 };
  expect(await persist(env.DB, loaded.version, [], [record])).toBeNull();
  expect((await loadState(env.DB, ["r9"])).appliedOps.r9).toBeUndefined();
});

it("applies a request's ops in order on one state: an op and its undo in one request, one version bump", async () => {
  const before = await version();
  const { results, state } = await applyOpsAndPersist(env.DB, [
    { opId: "e10", type: "envie.add", at: NOW, payload: { text: "dahl", url: null } },
    { opId: "u10", type: "undo", at: NOW, payload: { targetOpId: "e10" } },
    { opId: "e11", type: "envie.add", at: NOW, payload: { text: "ramen", url: null } },
  ], NOW);
  expect(results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);
  expect(await version()).toBe(before + 1);
  const fresh = await loadState(env.DB, ["e10"]);
  expect(fresh.appliedOps.e10!.undoneBy).toBe("u10");
  expect(fresh.envies.map((e) => e.text)).toContain("ramen");
  expect(fresh.envies.map((e) => e.text)).not.toContain("dahl");
  expect(state!.version).toBe(fresh.version);
  expect(state!.envies).toEqual(fresh.envies);
});

it("reads back more op records than D1 binds in one statement", async () => {
  const adds = Array.from({ length: 60 }, (_, i) => ({ opId: `bulk${i}`, type: "envie.add", at: NOW, payload: { text: `plat ${i}`, url: null } }));
  await applyOpsAndPersist(env.DB, adds, NOW);
  const undos = adds.map((a, i) => ({ opId: `bulk-undo${i}`, type: "undo", at: NOW, payload: { targetOpId: a.opId } }));
  const { results } = await applyOpsAndPersist(env.DB, undos, NOW);
  expect(results.every((r) => r.status === "applied")).toBe(true);
  expect(Object.keys((await loadState(env.DB, [...adds, ...undos].map((o) => o.opId))).appliedOps)).toHaveLength(120);
});

// Regression: 62dc4b5 — an op that threw failed the whole request
it("refuses an op that throws alone, records it nowhere, and still persists the others", async () => {
  const flaky: typeof applyOp = (state, raw, now) => {
    if ((raw as { opId: string }).opId === "t2") throw new Error("boum");
    return applyOp(state, raw, now);
  };
  const ops = ["t1", "t2", "t3"].map((opId) => ({ opId, type: "envie.add", at: NOW, payload: { text: opId, url: null } }));
  const { results } = await applyOpsAndPersist(env.DB, ops, NOW, { apply: flaky });
  expect(results).toEqual([{ status: "applied", reason: null }, { status: "refused", reason: "erreur interne : boum" }, { status: "applied", reason: null }]);
  const state = await loadState(env.DB, ["t1", "t2", "t3"]);
  expect(Object.keys(state.appliedOps).sort()).toEqual(["t1", "t3"]);
  expect((await applyOpsAndPersist(env.DB, [ops[1]], NOW)).results).toEqual([{ status: "applied", reason: null }]);
});

// Regression: e53e00b — a throw inside a real handler was stored as refused « erreur interne », so every resend replayed it
it("records nowhere an op whose handler throws, so a resend applies it once the handler works", async () => {
  const add = { opId: "hthrow", type: "envie.add", at: NOW, payload: { text: "hthrow", url: null } };
  const real = HANDLERS["envie.add"]!;
  HANDLERS["envie.add"] = () => { throw new Error("boum"); };
  try {
    expect((await applyOpsAndPersist(env.DB, [add], NOW)).results).toEqual([{ status: "refused", reason: "erreur interne : boum" }]);
  } finally {
    HANDLERS["envie.add"] = real;
  }
  expect((await loadState(env.DB, ["hthrow"])).appliedOps.hthrow).toBeUndefined();
  expect((await applyOpsAndPersist(env.DB, [add], NOW)).results).toEqual([{ status: "applied", reason: null }]);
});

/** A D1 whose `nth` batch call first runs `before` to completion: another writer commits between this one's load and its write. */
function interleaved(nth: number, before: () => Promise<unknown>): D1Database {
  let calls = 0;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") return async (s: D1PreparedStatement[]) => { calls += 1; if (calls === nth) await before(); return target.batch(s); };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

// Regression: 947e3d4 — a record insert skipped by ON CONFLICT DO NOTHING still let the batch commit, so D1 held the price under another writer's refusal
it("re-applies a request when another writer recorded one of its op ids without bumping, so each record matches what D1 holds", async () => {
  const lineId = Math.max(0, ...(await loadState(env.DB, [])).shoppingItems.map((l) => l.id)) + 1;
  const add = { opId: "race-add", type: "shopping.add", at: NOW, payload: { label: "pain de mie", isFood: true } };
  const price = { opId: "race-price", type: "shopping.set_price", at: NOW, payload: { itemId: lineId, estPriceCents: 350 } };
  // the other writer sends the price alone: refused « article introuvable », recorded without a bump
  const db = interleaved(2, () => applyOpsAndPersist(env.DB, [price], NOW));
  const { results } = await applyOpsAndPersist(db, [add, price], NOW);
  const after = await loadState(env.DB, ["race-price"]);
  const line = after.shoppingItems.find((l) => l.id === lineId);
  expect(after.appliedOps["race-price"]).toMatchObject({ status: "refused", reason: "article introuvable" });
  expect(results).toEqual([{ status: "applied", reason: null }, { status: "refused", reason: "article introuvable" }]);
  expect(line?.estPriceCents ?? null).toBeNull();
});

// Regression: 947e3d4 — an op and its undo raced by a lone undo left the target's undone_by naming an undo recorded as refused
it("never marks a target undone by an undo that another writer recorded as refused", async () => {
  const add = { opId: "race-e", type: "envie.add", at: NOW, payload: { text: "race", url: null } };
  const undo = { opId: "race-u", type: "undo", at: NOW, payload: { targetOpId: "race-e" } };
  const db = interleaved(2, () => applyOpsAndPersist(env.DB, [undo], NOW));
  const { results } = await applyOpsAndPersist(db, [add, undo], NOW);
  const after = await loadState(env.DB, ["race-e", "race-u"]);
  expect(after.appliedOps["race-u"]!.status).toBe("refused");
  expect(after.appliedOps["race-e"]!.undoneBy).toBeNull();
  expect(results.map((r) => r.status)).toEqual(["applied", "refused"]);
  expect(after.envies.map((e) => e.text)).toContain("race");
});

/** A D1 on which another writer bumps the version right before every write: each attempt conflicts. */
function alwaysConflicting(): D1Database {
  let calls = 0;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (s: D1PreparedStatement[]) => {
          calls += 1;
          if (calls % 2 === 0) await target.prepare("UPDATE meta SET version = version + 1 WHERE id = 1").run(); // load, write, load, write…
          return target.batch(s);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

// Regression: b9957d8 — an op refused because it threw or because every attempt conflicted read like a final refusal, though D1 recorded nothing
it("says which ops D1 holds a record for: a landed op and a replay do, a throw, a malformed op and an exhausted conflict do not", async () => {
  const envie = (opId: string) => ({ opId, type: "envie.add", at: NOW, payload: { text: opId, url: null } });
  await applyOpsAndPersist(env.DB, [envie("rec-old")], NOW);
  const flaky: typeof applyOp = (state, raw, now) => {
    if ((raw as { opId: string }).opId === "rec-throw") throw new Error("boum");
    return applyOp(state, raw, now);
  };
  const landed = await applyOpsAndPersist(env.DB, [envie("rec-old"), envie("rec-new"), envie("rec-throw"), { ...envie("rec-bad"), at: "hier" }], NOW, { apply: flaky });
  expect(landed.results.map((r) => r.status)).toEqual(["applied", "applied", "refused", "refused"]);
  expect(landed.recorded).toEqual([true, true, false, false]);

  const lost = await applyOpsAndPersist(alwaysConflicting(), [envie("rec-old"), envie("rec-conflict"), envie("rec-conflict")], NOW);
  expect(lost.state).toBeNull();
  expect(lost.results).toEqual([{ status: "applied", reason: null }, CONFLICT, CONFLICT]);
  expect(lost.recorded).toEqual([true, false, false]);
  expect((await loadState(env.DB, ["rec-conflict"])).appliedOps["rec-conflict"]).toBeUndefined();
});

const seedRecord = (opId: string, appliedAt: string, type = "shopping.buy") =>
  env.DB.prepare("INSERT INTO applied_ops (op_id, type, applied_at, status, reason, changes, undone_by, seq) VALUES (?, ?, ?, 'applied', NULL, '[]', NULL, (SELECT COALESCE(MAX(seq), 0) + 1 FROM applied_ops))")
    .bind(opId, type, appliedAt).run();

// only the undo window's buy and cook records are loaded, so the load does not grow with the whole history
it("loads the buy and cook records applied inside the undo window and none older", async () => {
  await seedRecord("win-inside", "2026-10-01T10:00:00.000Z");
  await seedRecord("win-cook", "2026-10-01T11:00:00.000Z", "meal.cook");
  await seedRecord("win-older", "2026-09-20T10:00:00.000Z");
  const state = await loadState(env.DB, [], undoWindowStart(NOW));
  expect(Object.hasOwn(state.appliedOps, "win-inside")).toBe(true);
  expect(Object.hasOwn(state.appliedOps, "win-cook")).toBe(true);
  expect(Object.hasOwn(state.appliedOps, "win-older")).toBe(false);
});

// Regression: 7c1d842 — the window's records sat in the state the apply loop clones once per op, so a flush's CPU grew with two weeks of buys
it("keeps the window's records out of the state each op is applied to, and hands them to the answer's state", async () => {
  await seedRecord("loop-recent", "2026-10-11T10:00:00.000Z");
  const seen: string[][] = [];
  const spy: typeof applyOp = (state, raw, now) => {
    seen.push(Object.keys(state.appliedOps));
    return applyOp(state, raw, now);
  };
  const envie = (opId: string) => ({ opId, type: "envie.add", at: NOW, payload: { text: opId, url: null } });
  const { results, state } = await applyOpsAndPersist(env.DB, [envie("loop-1"), envie("loop-2")], NOW, { apply: spy, recentSince: undoWindowStart(NOW) });
  expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
  expect(seen).toHaveLength(2);
  for (const keys of seen) expect(keys).not.toContain("loop-recent");
  expect(Object.hasOwn(state!.appliedOps, "loop-recent")).toBe(true);
  expect(Object.hasOwn(state!.appliedOps, "loop-2")).toBe(true);
});

// Regression: ac71541 — an undone row freed its id across requests: the next row took it, and an op queued for the undone one landed on it
it("keeps an undone row's id out of use across loads", async () => {
  const add = (opId: string, text: string) => applyAndPersist(env.DB, { opId, type: "envie.add", at: NOW, payload: { text, url: null } }, NOW);
  expect((await add("id-a", "pot-au-feu")).status).toBe("applied");
  const undoneId = (await loadState(env.DB, [])).envies.find((e) => e.text === "pot-au-feu")!.id;
  expect((await applyAndPersist(env.DB, { opId: "id-u", type: "undo", at: NOW, payload: { targetOpId: "id-a" } }, NOW)).status).toBe("applied");
  expect((await add("id-b", "blanquette")).status).toBe("applied");
  expect((await loadState(env.DB, [])).envies.find((e) => e.text === "blanquette")!.id).toBe(undoneId + 1);
});

/** A D1 on which another writer bumps the version before this request's first write only, and that lists every SQL text prepared. */
function conflictingOnce(): { db: D1Database; sql: string[] } {
  let calls = 0;
  const sql: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          sql.push(query);
          return target.prepare(query);
        };
      }
      if (prop === "batch") {
        return async (s: D1PreparedStatement[]) => {
          calls += 1;
          if (calls === 2) await target.prepare("UPDATE meta SET version = version + 1 WHERE id = 1").run(); // load, conflict, load, write
          return target.batch(s);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db, sql };
}

const isWindowQuery = (query: string) => query.includes("undone_by IS NULL AND applied_at >= ?");

// Regression: a5e3c27 — every attempt's load read the window's records with SELECT *, conflicts included, though only the answer reads them
it("reads the window's records only for the answer, in a write batch only once it landed, and only the columns the snapshot needs", async () => {
  await seedRecord("once-recent", "2026-10-11T12:00:00.000Z");
  const { db, sql } = conflictingOnce();
  const envie = { opId: "once-1", type: "envie.add", at: NOW, payload: { text: "once", url: null } };
  const { results, state } = await applyOpsAndPersist(db, [envie], NOW, { recentSince: undoWindowStart(NOW) });
  expect(results.map((r) => r.status)).toEqual(["applied"]);
  expect(state!.appliedOps["once-recent"]).toEqual({
    opId: "once-recent", type: "shopping.buy", appliedAt: "2026-10-11T12:00:00.000Z", status: "applied", reason: null, changes: [], undoneBy: null, seq: expect.any(Number),
  });
  // one per write batch (the conflicting one and the one that landed), each reading only once its own release landed
  const window = sql.filter(isWindowQuery);
  expect(window).toHaveLength(2);
  for (const query of window) {
    expect(query).toMatch(/^SELECT seq, op_id, type, applied_at, changes FROM applied_ops /);
    expect(query).toMatch(/AND \(SELECT version FROM meta WHERE id = 1\) = \?$/);
  }
});

it("hands the window's records to the answer of a request that writes nothing (a replay)", async () => {
  await seedRecord("replay-recent", "2026-10-11T13:00:00.000Z");
  const envie = { opId: "replay-1", type: "envie.add", at: NOW, payload: { text: "replay", url: null } };
  await applyOpsAndPersist(env.DB, [envie], NOW);
  const { results, state } = await applyOpsAndPersist(env.DB, [envie], NOW, { recentSince: undoWindowStart(NOW) });
  expect(results.map((r) => r.status)).toEqual(["applied"]);
  expect(Object.hasOwn(state!.appliedOps, "replay-recent")).toBe(true);
  const fresh = await loadState(env.DB, [], undoWindowStart(NOW));
  expect(Object.hasOwn(fresh.appliedOps, "replay-recent")).toBe(true);
});

// Regression: 5318329 — a request that wrote nothing read the undo window in a second call with no version guard: the answer mixed version v with the window at v + 1
it("answers a request that writes nothing from one version of the data when another writer lands between its two reads", async () => {
  await seedRecord("mix-buy", "2026-10-11T14:00:00.000Z");
  const envie = { opId: "mix-1", type: "envie.add", at: NOW, payload: { text: "mix", url: null } };
  await applyOpsAndPersist(env.DB, [envie], NOW);
  let calls = 0;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (s: D1PreparedStatement[]) => {
          calls += 1;
          const results = await target.batch(s);
          if (calls === 1) { // right after the load: another phone undoes the buy
            await target.prepare("UPDATE applied_ops SET undone_by = 'mix-undo' WHERE op_id = 'mix-buy'").run();
            await target.prepare("UPDATE meta SET version = version + 1 WHERE id = 1").run();
          }
          return results;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  const { results, state } = await applyOpsAndPersist(db, [envie], NOW, { recentSince: undoWindowStart(NOW) });
  expect(results.map((r) => r.status)).toEqual(["applied"]);
  const now = await loadState(env.DB, [], undoWindowStart(NOW));
  expect(state!.version).toBe(now.version);
  expect(Object.hasOwn(state!.appliedOps, "mix-buy")).toBe(false);
  expect(calls).toBe(3);
});

// Regression: 99b4539 — the store loaded only the records a request names, so an undo never saw the writes
// after its target: « un fond », « presque fini », « un fond » again, and the undo of the first erased the two after it
it("loads the later writes of an undo's rows, so it refuses one put back as its target left it, and takes them back in order", async () => {
  await applyAndPersist(env.DB, { opId: "aba-add", type: "stock.add", at: NOW, payload: { label: "aba", productId: null, qtyText: null, useBy: null } }, NOW);
  const itemId = (await loadState(env.DB, [])).stockItems.find((i) => i.label === "aba")!.id;
  const partial = (opId: string, qtyText: string) => ({ opId, type: "stock.partial", at: NOW, payload: { itemId, qtyText, low: false } });
  const undo = (opId: string, targetOpId: string) => ({ opId, type: "undo", at: NOW, payload: { targetOpId } });
  for (const op of [partial("aba-1", "un fond"), partial("aba-2", "presque fini"), partial("aba-3", "un fond")]) {
    expect((await applyAndPersist(env.DB, op, NOW)).status).toBe("applied");
  }
  expect(await applyAndPersist(env.DB, undo("aba-u1", "aba-1"), NOW)).toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
  const qtyText = async () => (await loadState(env.DB, [])).stockItems.find((i) => i.id === itemId)!.qtyText;
  expect(await qtyText()).toBe("un fond");
  for (const [opId, target, left] of [["aba-u3", "aba-3", "presque fini"], ["aba-u2", "aba-2", "un fond"], ["aba-u1b", "aba-1", null]] as const) {
    expect((await applyAndPersist(env.DB, undo(opId, target), NOW)).status).toBe("applied");
    expect(await qtyText()).toBe(left);
  }
});

// Regression: 78ef33d — the apply order was applied_ops' implicit rowid, which a VACUUM or a restore from a dump may
// renumber: once the later writes sat below their target, the undo of « un fond » erased the two after it
it("keeps the apply order in its own column, so an undo still sees the later writes once the rowids are renumbered", async () => {
  await applyAndPersist(env.DB, { opId: "seq-add", type: "stock.add", at: NOW, payload: { label: "seq", productId: null, qtyText: null, useBy: null } }, NOW);
  const itemId = (await loadState(env.DB, [])).stockItems.find((i) => i.label === "seq")!.id;
  const partial = (opId: string, qtyText: string) => ({ opId, type: "stock.partial", at: NOW, payload: { itemId, qtyText, low: false } });
  // two in one request: each takes the next place, in the order the request applied them
  const { results } = await applyOpsAndPersist(env.DB, [partial("seq-1", "un fond"), partial("seq-2", "presque fini")], NOW);
  expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
  expect((await applyAndPersist(env.DB, partial("seq-3", "un fond"), NOW)).status).toBe("applied");
  const seqs = async () => (await env.DB.prepare("SELECT op_id, seq FROM applied_ops WHERE op_id LIKE 'seq-%' ORDER BY seq").all<{ op_id: string }>()).results.map((r) => r.op_id);
  expect(await seqs()).toEqual(["seq-add", "seq-1", "seq-2", "seq-3"]);
  // a restore that renumbered the target alone above every row: its later writes now sit below it, while the earlier
  // seq-add stays below it too, so only an order read from the rowid would miss them
  await env.DB.prepare("UPDATE applied_ops SET rowid = (SELECT MAX(rowid) FROM applied_ops) + 1000 WHERE op_id = 'seq-1'").run();
  expect(await applyAndPersist(env.DB, { opId: "seq-u1", type: "undo", at: NOW, payload: { targetOpId: "seq-1" } }, NOW))
    .toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
  expect((await loadState(env.DB, [])).stockItems.find((i) => i.id === itemId)!.qtyText).toBe("un fond");
});

// Regression: 14cf23d — the later-writes query returned every column of every later record whose changes met a
// target's, read the targets' changes again for each of them, and scanned for targets an undo refuses anyway
it("loads an undo's later writes from the seq index, only the columns undo reads, and none for a target already undone", async () => {
  await applyAndPersist(env.DB, { opId: "scan-add", type: "stock.add", at: NOW, payload: { label: "scan", productId: null, qtyText: null, useBy: null } }, NOW);
  const itemId = (await loadState(env.DB, [])).stockItems.find((i) => i.label === "scan")!.id;
  const partial = (opId: string, qtyText: string) => ({ opId, type: "stock.partial", at: NOW, payload: { itemId, qtyText, low: false } });
  const undo = (opId: string, targetOpId: string) => ({ opId, type: "undo", at: NOW, payload: { targetOpId } });
  for (const op of [partial("scan-1", "un fond"), partial("scan-2", "presque fini"), undo("scan-u2", "scan-2"), partial("scan-3", "la moitié")]) {
    expect((await applyAndPersist(env.DB, op, NOW)).status).toBe("applied");
  }
  const sql: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => { sql.push(query); return target.prepare(query); };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  const held: string[][] = [];
  const spy: typeof applyOp = (state, raw, now) => { held.push(Object.keys(state.appliedOps)); return applyOp(state, raw, now); };

  // scan-3 wrote the row since scan-1: loaded, with the order and the fields undo reads
  expect((await applyOpsAndPersist(db, [undo("scan-u1", "scan-1")], NOW, { apply: spy })).results[0]).toEqual({ status: "refused", reason: "modifié depuis : impossible d'annuler" });
  expect(held.at(-1)!.sort()).toEqual(["scan-1", "scan-3"]);
  const query = sql.find((q) => q.includes("json_each"))!;
  expect(query).toMatch(/SELECT a\.seq, a\.op_id, a\.type, a\.applied_at, a\.changes FROM applied_ops a\s/);
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`).bind("scan-1", ...NOT_UNDOABLE).all<{ detail: string }>();
  expect(plan.results.map((r) => r.detail)).toContainEqual(expect.stringMatching(/^SEARCH a USING INDEX applied_ops_seq \(seq>\?\)$/));

  // scan-2 is undone already: the undo is refused before it would look, so nothing after it is loaded
  expect((await applyOpsAndPersist(db, [undo("scan-u2b", "scan-2")], NOW, { apply: spy })).results[0]).toEqual({ status: "refused", reason: "déjà annulée" });
  expect(held.at(-1)).toEqual(["scan-2"]);
});

it("refuses an applied_ops record written without its place in the apply order", async () => {
  // Regression: 9a07c19 — a NULL seq passes the UNIQUE index and is never « after » anything, so an undo could erase a later write
  await expect(env.DB.prepare("INSERT INTO applied_ops (op_id, type, applied_at, status, reason, changes, undone_by) VALUES ('no-seq', 'stock.add', ?, 'applied', NULL, '[]', NULL)").bind(NOW).run())
    .rejects.toThrow(/seq is required/);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE seq IS NULL").first<{ n: number }>())!.n).toBe(0);
});
