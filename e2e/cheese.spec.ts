import { expect, test } from "@playwright/test";
import { cheeseProposal, history, opsAnswer, plan, uniq, watchPageErrors } from "./helpers";
import { PHONE } from "./phone";

// Spec §11, the acceptance scenario: plan two recipes × 100 g comté → buy 200 g → cook the first → the other phone shows
// « 100 g pour … » under Réservé → Fini → the reservation warning, which sends nothing until a resolution is chosen
test("the cheese story: one phone cooks the first meal, the other sees the comté left held for the second and is warned before finishing it", async ({ browser, request }) => {
  const [first, second] = await plan(request, cheeseProposal(uniq("fromage")));
  const contexts = [await browser.newContext(PHONE), await browser.newContext(PHONE)];
  const [phoneA, phoneB] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors = [phoneA!, phoneB!].map(watchPageErrors);

  // phone A buys the 200 g of comté both meals share
  await phoneA!.goto("/#/courses");
  const comteLine = phoneA!.getByRole("region", { name: "Crèmerie" }).getByRole("checkbox", { name: /^comté 200 g/ });
  const bought = await opsAnswer(phoneA!, () => comteLine.click());
  expect(bought.results.map((r) => r.status)).toEqual(["applied"]);

  // phone A cooks the first meal and leaves the comté unanswered: the meal ate its 100 g
  await phoneA!.goto("/#/menu");
  await phoneA!.getByRole("link", { name: first!.title }).click();
  const recipe = phoneA!.getByRole("article");
  await expect(recipe.getByRole("heading", { name: first!.title })).toBeVisible();
  await expect(recipe.getByRole("listitem").filter({ hasText: "comté" })).toContainText("100 g · réservé");
  await phoneA!.getByRole("button", { name: "Cuisiné" }).click();
  const cookSheet = phoneA!.getByRole("dialog", { name: "Cuisiné" });
  await expect(cookSheet.getByRole("group", { name: "comté : fini ou il en reste" })).toBeVisible();
  const cooked = await opsAnswer(phoneA!, () => cookSheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(phoneA!).toHaveURL(/#\/menu$/);
  await expect(phoneA!.getByRole("link", { name: first!.title })).toHaveCount(0);

  // phone B opens Reste: what is left of the comté, 100 g, is held for the second meal, and none of it is libre
  await phoneB!.goto("/#/reste");
  const row = phoneB!.getByRole("region", { name: "Réservé" }).getByRole("link", { name: `100 g pour ${second!.title}` });
  await expect(row).toContainText("comté");
  await expect(row).toContainText(/^comté100 g · jusqu'au .* · 100 g pour /);
  await expect(row).not.toContainText("libre");

  // « Fini » opens the warning; « Annuler » there sends nothing
  let posts = 0;
  phoneB!.on("request", (r) => {
    if (r.url().endsWith("/api/ops") && r.method() === "POST") posts += 1;
  });
  await row.click();
  const sheet = phoneB!.getByRole("dialog", { name: "comté" });
  await sheet.getByRole("button", { name: "Fini" }).click();
  await expect(phoneB!).toHaveURL(/#\/reste\/article\/\d+\/fini$/);
  const itemId = Number(/article\/(\d+)\/fini$/.exec(phoneB!.url())![1]);
  await expect(sheet.getByText(`Réservé pour ${second!.title}`)).toBeVisible();
  // Regression: e8dbfb6 — the line under the item sheet's title left no padding before the reservation warning
  const metaBox = (await sheet.locator(".sheet-meta").boundingBox())!;
  const titleBox = (await sheet.locator(".warning-title").boundingBox())!;
  expect(titleBox.y - (metaBox.y + metaBox.height)).toBeGreaterThanOrEqual(12);
  await expect(sheet.getByRole("button", { name: "Racheter" })).toBeVisible();
  await sheet.getByRole("button", { name: "Annuler" }).click();
  await expect(phoneB!).toHaveURL(new RegExp(`#/reste/article/${itemId}$`));
  expect(posts).toBe(0);

  // « Retirer le repas »: the comté is finished, and the second meal leaves the pool with it, as phone B chose
  await sheet.getByRole("button", { name: "Fini" }).click();
  const finished = await opsAnswer(phoneB!, () => sheet.getByRole("button", { name: "Retirer le repas" }).click());
  expect(finished.results.map((r) => r.status)).toEqual(["applied"]);
  expect(posts).toBe(1);
  await expect(phoneB!).toHaveURL(/#\/reste$/);
  await expect(phoneB!.getByRole("link", { name: `100 g pour ${second!.title}` })).toHaveCount(0);
  const state = await history(request);
  expect(state.meals.find((m) => m.id === first!.id)!.cookedAt).not.toBeNull();
  expect(state.meals.find((m) => m.id === second!.id)!.droppedAt).not.toBeNull();
  expect(state.stockItems.find((i) => i.id === itemId)).toMatchObject({ label: "comté", qty: 100 });
  expect(state.stockItems.find((i) => i.id === itemId)!.finishedAt).not.toBeNull();
  for (const check of errors) check();
  for (const c of contexts) await c.close();
});
