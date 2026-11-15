import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { SEED_PROPOSAL } from "./seed-data";

export interface HistoryLine { id: number; label: string; qty: number | null; estPriceCents: number | null; boughtAt: string | null; tripId: number | null; removedAt: string | null; forMeals: { mealId: number; qty: number }[] }
export interface HistoryTrip { id: number; date: string; place: string; totalCents: number | null; noReceipt: boolean | null }
export interface HistoryMeal { id: number; cookedAt: string | null; droppedAt: string | null; verdict: string | null; note: string | null }
export interface HistoryItem { id: number; label: string; qty: number | null; qtyText: string | null; isLow: boolean; useBy: string | null; finishedAt: string | null; sourceShoppingItemId: number | null }
export interface HistoryReservation { stockItemId: number; mealId: number; releasedAt: string | null }
export interface HistoryRecipe { id: number; title: string; status: string }
export interface HistoryEnvie { id: number; text: string; url: string | null }
export interface History {
  shoppingItems: HistoryLine[];
  trips: HistoryTrip[];
  meals: HistoryMeal[];
  stockItems: HistoryItem[];
  reservations: HistoryReservation[];
  recipes: HistoryRecipe[];
  envies: HistoryEnvie[];
}
type OpsBody = { results: { opId: string; status: string; reason: string | null }[] };

/** Sends ops straight to the Worker (the e2e server bypasses Access) and fails the test unless each one is applied. */
export async function postOps(request: APIRequestContext, ops: { type: string; payload: unknown }[]): Promise<void> {
  const res = await request.post("/api/ops", { data: { ops: ops.map((o) => ({ opId: randomUUID(), at: new Date().toISOString(), ...o })) } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as OpsBody;
  expect(body.results, JSON.stringify(body.results)).toEqual(ops.map(() => expect.objectContaining({ status: "applied" })));
}

/** A label no other spec uses: every spec shares one database. */
export const uniq = (stem: string): string => `${stem} ${randomUUID().slice(0, 8)}`;

export const addAjout = (request: APIRequestContext, label: string): Promise<void> =>
  postOps(request, [{ type: "shopping.add", payload: { label, isFood: true } }]);

/** The full state (/api/history): a line stays in it after a checkout takes it off Courses, a meal once cooked. */
export async function history(request: APIRequestContext): Promise<History> {
  return (await (await request.get("/api/history")).json()) as History;
}

/** A pool meal as /api/state lists it. */
export interface PlannedMeal { id: number; title: string; isSecondRound: boolean; firstRoundId: number | null }

const SEED_TITLES = new Set(SEED_PROPOSAL.new_recipes.map((r) => r.title));

/**
 * Drops every open meal the seed did not plan, so a planning stays within two meals per main protein (spec §5.2) even
 * after a spec that failed before closing its own: every planning adds a fish meal, and the seed holds one.
 */
export async function clearPool(request: APIRequestContext): Promise<void> {
  const state = (await (await request.get("/api/state")).json()) as { menu: { pool: PlannedMeal[] } };
  // a first round drops its second round with it, and a second round dropped alone is refused nothing: drop firsts first
  const extra = state.menu.pool.filter((m) => !SEED_TITLES.has(m.title)).sort((a, b) => Number(a.isSecondRound) - Number(b.isSecondRound));
  for (const meal of extra) {
    const res = await request.post("/api/ops", { data: { ops: [{ opId: randomUUID(), at: new Date().toISOString(), type: "meal.drop", payload: { mealId: meal.id } }] } });
    expect(res.status()).toBe(200);
  }
}

const recipe = (key: string, title: string, protein: string, ingredients: { product: string; qty: number; unit: string }[]) => ({
  key, title, source_url: null, base_portions: 2, active_min: 20, total_min: 35, main_protein: protein,
  steps: ["Préparer les légumes.", "Cuire 20 minutes."], ingredients,
});
const PLAN = { params: { portions: 2, red_meat_requested: false, constraints: "" }, new_products: [], envies: { placed: [], kept: [] } };

/**
 * Spec §11, the cheese story: two meals needing 100 g of comté each, so one 200 g line serves both. A fish meal and a
 * legume meal from seeded, never fresh products: it passes every rule in any month next to the seed's two meals.
 */
export function cheeseProposal(stem: string): Record<string, unknown> {
  return {
    ...PLAN,
    new_recipes: [
      recipe("a", `Colin au comté ${stem}`, "protein:poisson", [
        { product: "filets de colin surgelés", qty: 300, unit: "g" }, { product: "haricots verts surgelés", qty: 300, unit: "g" }, { product: "comté", qty: 100, unit: "g" },
      ]),
      recipe("b", `Lentilles au comté ${stem}`, "protein:legumineuse", [
        { product: "lentilles vertes", qty: 150, unit: "g" }, { product: "épinards surgelés", qty: 300, unit: "g" }, { product: "comté", qty: 100, unit: "g" },
      ]),
    ],
    meals: [{ recipe: "a", portions: 2, doubled: false }, { recipe: "b", portions: 2, doubled: false }],
    prices: [
      { product: "filets de colin surgelés", unit: "g", est_price_cents: 690 }, { product: "haricots verts surgelés", unit: "g", est_price_cents: 230 },
      { product: "comté", unit: "g", est_price_cents: 640 }, { product: "lentilles vertes", unit: "g", est_price_cents: 150 },
      { product: "épinards surgelés", unit: "g", est_price_cents: 250 },
    ],
  };
}

/** A doubled omelette (a first round and its second round) and a fish meal with lentils: three meals, every rule passed. */
export function doubledProposal(stem: string): Record<string, unknown> {
  return {
    ...PLAN,
    new_recipes: [
      recipe("o", `Omelette aux épinards ${stem}`, "protein:oeuf", [{ product: "œuf", qty: 4, unit: "piece" }, { product: "épinards surgelés", qty: 200, unit: "g" }]),
      recipe("f", `Sardines aux lentilles ${stem}`, "protein:poisson", [
        { product: "sardines en boîte", qty: 200, unit: "g" }, { product: "lentilles corail", qty: 150, unit: "g" }, { product: "haricots verts surgelés", qty: 200, unit: "g" },
      ]),
    ],
    meals: [{ recipe: "o", portions: 2, doubled: true }, { recipe: "f", portions: 2, doubled: false }],
    prices: [
      { product: "œuf", unit: "piece", est_price_cents: 240 }, { product: "épinards surgelés", unit: "g", est_price_cents: 250 },
      { product: "sardines en boîte", unit: "g", est_price_cents: 320 }, { product: "lentilles corail", unit: "g", est_price_cents: 180 },
      { product: "haricots verts surgelés", unit: "g", est_price_cents: 230 },
    ],
  };
}

/**
 * Commits a planning and returns its meals, in pool order. First `clearPool`, then every Reste item of the planning's
 * products that no meal holds is finished: a planning reserves libre stock before it lists a line (spec §6.1), and
 * every spec shares one database, so what an earlier spec left would otherwise replace the line this one buys.
 */
export async function plan(request: APIRequestContext, proposal: Record<string, unknown>): Promise<PlannedMeal[]> {
  await clearPool(request);
  const products = new Set((proposal.new_recipes as { ingredients: { product: string }[] }[]).flatMap((r) => r.ingredients.map((i) => i.product)));
  const before = (await (await request.get("/api/history")).json()) as History & { reservations: { stockItemId: number; releasedAt: string | null }[] };
  const held = new Set(before.reservations.filter((r) => r.releasedAt === null).map((r) => r.stockItemId));
  const libre = before.stockItems.filter((i) => i.finishedAt === null && products.has(i.label) && !held.has(i.id));
  if (libre.length > 0) await postOps(request, libre.map((i) => ({ type: "stock.finish", payload: { itemId: i.id } })));
  await postOps(request, [{ type: "planning.commit", payload: proposal }]);
  const titles = new Set((proposal.new_recipes as { title: string }[]).map((r) => r.title));
  const state = (await (await request.get("/api/state")).json()) as { menu: { pool: PlannedMeal[] } };
  return state.menu.pool.filter((m) => titles.has(m.title));
}

/**
 * Another phone's « Passage en caisse » on its whole basket: its trip.record lists every bought line on no trip. A
 * checkout lists at least one line, so on an empty basket a fresh ajout is bought for it first.
 */
export async function checkoutElsewhere(request: APIRequestContext, payload: { place: string; totalCents: number | null; date: string }): Promise<void> {
  let basket = (await history(request)).shoppingItems.filter((l) => l.boughtAt !== null && l.tripId === null && l.removedAt === null);
  if (basket.length === 0) {
    const label = uniq("sel");
    await addAjout(request, label);
    const line = (await history(request)).shoppingItems.find((l) => l.label === label)!;
    await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
    basket = [line];
  }
  await postOps(request, [{ type: "trip.record", payload: { ...payload, itemIds: basket.map((l) => l.id) } }]);
}

/** A Courses row: the whole row is one checkbox named by its line. */
export const tick = (page: Page, label: string) => page.getByRole("checkbox", { name: label });

/** Waits until the service worker controls the page, so a reload works offline. */
export async function serviceWorkerReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/** Uncaught exceptions and unhandled rejections in the page; call the returned check at the end of the test. */
export function watchPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return () => expect(errors).toEqual([]);
}

/**
 * The answer to the ops request an action makes; with `carrying`, the first one whose body holds an op of that type (an
 * action that sends undos and then trips makes several requests, and the first answer is not the trips').
 */
export async function opsAnswer(page: Page, action: () => Promise<void>, carrying?: string): Promise<OpsBody> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/ops") && r.request().method() === "POST"
      && (carrying === undefined || (r.request().postData() ?? "").includes(`"type":"${carrying}"`))),
    action(),
  ]);
  return (await response.json()) as OpsBody;
}

const per100g = (kcal: number, protein: number, carbs: number, fat: number, fibre: number, salt: number) => ({
  kcal, protein_g: protein, carbs_g: carbs, fat_g: fat, fibre_g: fibre, salt_g: salt,
});

/**
 * Ciqual values for two of the cheese story's products, as `plan -- nutrition` sends them: the local D1 comes from the
 * migrations, where no product has any. « haricots verts surgelés » stays without, so the colin's line is partial.
 */
export const CHEESE_NUTRITION = [
  { name: "filets de colin surgelés", nutrition: { ciqual_code: "26038", per_100g: per100g(80, 17.6, 0, 1, 0, 0.2), grams_per_piece: null, grams_per_ml: null, edible_pct: 100 } },
  { name: "comté", nutrition: { ciqual_code: "12726", per_100g: per100g(415, 28, 0.5, 34, 0, 0.9), grams_per_piece: null, grams_per_ml: null, edible_pct: 100 } },
];

/** Sends `product.nutrition` for each product; one already holding these values answers noop, which is fine here. */
export async function setNutrition(request: APIRequestContext, entries: { name: string; nutrition: unknown }[]): Promise<void> {
  const res = await request.post("/api/ops", {
    data: { ops: entries.map((payload) => ({ opId: randomUUID(), at: new Date().toISOString(), type: "product.nutrition", payload })) },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as OpsBody;
  for (const r of body.results) expect(["applied", "noop"], JSON.stringify(r)).toContain(r.status);
}
