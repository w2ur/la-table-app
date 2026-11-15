import { expect, test } from "@playwright/test";
import { cheeseProposal, history, opsAnswer, plan, postOps, uniq, watchPageErrors } from "./helpers";
import { PHONE } from "./phone";

test.use(PHONE);

const removeButton = (page: import("@playwright/test").Page, label: string) => page.getByRole("button", { name: `Retirer ${label}`, exact: true });
/** Undoes a removal through the API, so the seed's own lines the row also held are back for the other specs. */
const takeBack = (request: Parameters<typeof history>[0], answer: { results: { opId: string }[] }) =>
  postOps(request, [...answer.results].reverse().map((r) => ({ type: "undo", payload: { targetOpId: r.opId } })));
/** A line still on Courses, by the meal it serves: a removal takes an open meal's share off it, so look it up before. */
const lineOf = async (request: Parameters<typeof history>[0], label: string, meal: number) =>
  (await history(request)).shoppingItems.find((l) => l.label === label && l.forMeals.some((m) => m.mealId === meal))!;
const lineById = async (request: Parameters<typeof history>[0], id: number) => (await history(request)).shoppingItems.find((l) => l.id === id)!;

test("« On n'en prend pas » takes a planned line off Courses and the meal it served says « manque » on its recipe", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const meals = await plan(request, cheeseProposal(uniq("pas")));
  const first = meals[0];
  const colin = await lineOf(request, "filets de colin surgelés", first!.id);
  await page.goto("/#/courses");
  await removeButton(page, "filets de colin surgelés").click();
  const sheet = page.getByRole("dialog", { name: "Retirer filets de colin surgelés" });
  await expect(sheet.getByText(/^pour /)).toContainText(first!.title);
  const removed = await opsAnswer(page, () => sheet.getByRole("button", { name: "On n'en prend pas" }).click());
  expect(removed.results.every((r) => r.status === "applied")).toBe(true);
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/#\/courses$/);
  await expect(page.getByRole("checkbox", { name: /^filets de colin surgelés /, checked: false })).toHaveCount(0);
  expect((await lineById(request, colin.id)).removedAt).not.toBeNull();

  const served = (await (await request.get("/api/state")).json()) as { menu: { pool: { id: number; shortfalls?: unknown }[] } };
  expect(served.menu.pool.find((m) => m.id === first!.id)?.shortfalls).toEqual([{ label: "filets de colin surgelés", qty: 300, unit: "g" }]);
  await page.goto(`/#/menu/repas/${first!.id}`);
  // the « manque » is not predicted on the phone: it comes with the server's next snapshot
  await expect(page.getByRole("article").getByText("manque : filets de colin surgelés 300 g")).toBeVisible({ timeout: 15000 });
  await takeBack(request, removed);
  await postOps(request, meals.map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});

test("« On en a déjà » takes a planned line off Courses and the item shows in Reste, reserved for the meal", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const meals = await plan(request, cheeseProposal(uniq("deja")));
  const second = meals[1];
  const spinach = await lineOf(request, "épinards surgelés", second!.id);
  await page.goto("/#/courses");
  await removeButton(page, "épinards surgelés").click();
  const sheet = page.getByRole("dialog", { name: "Retirer épinards surgelés" });
  const removed = await opsAnswer(page, () => sheet.getByRole("button", { name: "On en a déjà" }).click());
  expect(removed.results.every((r) => r.status === "applied")).toBe(true); // one op per line of the row
  await expect(page.getByRole("checkbox", { name: /^épinards surgelés /, checked: false })).toHaveCount(0);
  const line = await lineById(request, spinach.id);
  expect(line.removedAt).not.toBeNull();
  expect(line.tripId).toBeNull();
  // the item at home names no line (only a purchase does): found by the meal it is reserved for
  const h = await history(request);
  const atHome = h.stockItems.filter((i) => i.label === "épinards surgelés" && h.reservations.some((r) => r.stockItemId === i.id && r.mealId === second!.id && r.releasedAt === null));
  expect(atHome).toMatchObject([{ finishedAt: null, sourceShoppingItemId: null }]);

  await page.getByRole("link", { name: "Reste" }).click();
  await expect(page.getByRole("link", { name: `pour ${second!.title}` })).toContainText("épinards surgelés");
  await takeBack(request, removed);
  await postOps(request, meals.map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});

test("« Annuler » within 5 s after a removal brings the line back, both ways", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const meals = await plan(request, cheeseProposal(uniq("retour")));
  const first = meals[0];
  await page.goto("/#/courses");
  for (const [label, choice] of [["filets de colin surgelés", "On n'en prend pas"], ["haricots verts surgelés", "On en a déjà"]] as const) {
    await removeButton(page, label).click();
    await opsAnswer(page, () => page.getByRole("dialog", { name: `Retirer ${label}` }).getByRole("button", { name: choice }).click());
    await expect(page.getByRole("checkbox", { name: new RegExp(`^${label} `), checked: false })).toHaveCount(0);
    const undone = await opsAnswer(page, () => page.locator(".undo-bar").getByRole("button", { name: "Annuler" }).click());
    expect(undone.results.map((r) => [r.status, r.reason])).toEqual([["applied", null]]);
    await expect(page.getByRole("checkbox", { name: new RegExp(`^${label} `), checked: false })).toHaveCount(1);
    await expect.poll(async () => (await lineOf(request, label, first!.id)).removedAt).toBeNull();
  }
  // the undone « On en a déjà » left no item reserved for these meals
  const h = await history(request);
  const ids = new Set(meals.map((m) => m.id));
  expect(h.stockItems.filter((i) => i.label === "haricots verts surgelés" && i.finishedAt === null
    && h.reservations.some((r) => r.stockItemId === i.id && ids.has(r.mealId) && r.releasedAt === null))).toEqual([]);
  await postOps(request, meals.map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});

test("a line shared by two meals names both, and « Annuler » brings it back", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const meals = await plan(request, cheeseProposal(uniq("deux")));
  const open = async () => (await history(request)).shoppingItems.filter((l) => l.label === "comté" && l.boughtAt === null && l.removedAt === null);
  const before = (await open()).map((l) => l.id);
  expect(before.length).toBeGreaterThanOrEqual(1);
  await page.goto("/#/courses");
  await removeButton(page, "comté").click();
  const sheet = page.getByRole("dialog", { name: "Retirer comté" });
  await expect(sheet.getByText(/^pour /)).toContainText(meals[0]!.title);
  await expect(sheet.getByText(/^pour /)).toContainText(meals[1]!.title);
  await opsAnswer(page, () => sheet.getByRole("button", { name: "On n'en prend pas" }).click());
  await expect.poll(async () => (await open()).length).toBe(0);
  await opsAnswer(page, () => page.locator(".undo-bar").getByRole("button", { name: "Annuler" }).click());
  await expect.poll(async () => (await open()).map((l) => l.id)).toEqual(before);
  await postOps(request, meals.map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});

test("a jump from one row's « Retirer » sheet to another's removes the second row, not nothing", async ({ page, request }) => {
  // Regression: 8d9486a — the sheet kept the first row's line ids, so the second row's tap sent no op
  const errors = watchPageErrors(page);
  const meals = await plan(request, cheeseProposal(uniq("saut")));
  const first = meals[0];
  const colin = await lineOf(request, "filets de colin surgelés", first!.id);
  const beans = await lineOf(request, "haricots verts surgelés", first!.id);
  await page.goto("/#/courses");
  await removeButton(page, "filets de colin surgelés").click();
  await expect(page.getByRole("dialog", { name: "Retirer filets de colin surgelés" })).toBeVisible();
  await page.evaluate((id) => { location.hash = `#/courses/retirer/${id}`; }, beans.id);
  const sheet = page.getByRole("dialog", { name: "Retirer haricots verts surgelés" });
  const removed = await opsAnswer(page, () => sheet.getByRole("button", { name: "On n'en prend pas" }).click());
  expect(removed.results.every((r) => r.status === "applied")).toBe(true);
  expect((await lineById(request, beans.id)).removedAt).not.toBeNull();
  expect((await lineById(request, colin.id)).removedAt).toBeNull();
  await takeBack(request, removed);
  await postOps(request, meals.map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});
