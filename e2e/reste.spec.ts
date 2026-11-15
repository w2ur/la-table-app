import { expect, test } from "@playwright/test";
import { dateLabel, qtyText } from "../src/app/format";
import { addDays, parisDate } from "../src/domain/dates";
import { cheeseProposal, doubledProposal, history, opsAnswer, plan, postOps, serviceWorkerReady, uniq, watchPageErrors } from "./helpers";

test("an item added to Reste is used in steps: what is left, a new date, then finished, and « Annuler » brings it back", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("olives");
  await page.goto("/#/reste");
  await page.getByLabel("Nouvel article au Reste").fill(label);
  const added = await opsAnswer(page, () => page.getByRole("button", { name: "Ajouter", exact: true }).click());
  expect(added.results.map((r) => r.status)).toEqual(["applied"]);
  const row = page.getByRole("link", { name: label });
  const sheet = page.getByRole("dialog", { name: label });

  await row.click();
  await sheet.getByRole("button", { name: "Il en reste" }).click();
  await expect(page).toHaveURL(/#\/reste\/article\/\d+\/reste$/);
  await sheet.getByLabel("Ce qu'il en reste (facultatif)").fill("un fond");
  await sheet.getByLabel("Presque fini").check();
  const partial = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(partial.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page).toHaveURL(/#\/reste$/);
  await expect(row).toContainText("un fond · presque fini");

  const today = parisDate(new Date().toISOString());
  const later = addDays(today, 10);
  await row.click();
  await sheet.getByRole("button", { name: "Changer la date" }).click();
  await sheet.getByLabel("À utiliser avant le").fill(later);
  const redated = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(redated.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(row).toContainText(`jusqu'au ${dateLabel(later, today)}`);

  await row.click();
  const finished = await opsAnswer(page, () => sheet.getByRole("button", { name: "Fini" }).click());
  expect(finished.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(row).toHaveCount(0);
  expect((await history(request)).stockItems.find((i) => i.label === label)).toMatchObject({ qtyText: "un fond", isLow: true, useBy: later });
  await page.locator(".undo-bar").getByRole("button", { name: "Annuler" }).click();
  await expect(row).toBeVisible();
  await expect.poll(async () => (await history(request)).stockItems.find((i) => i.label === label)?.finishedAt).toBeNull();
  errors();
});

// B8: emptying the prefilled « Il en reste » field sends qtyText null, which clears what the item said
test("emptying what is left under « Il en reste » clears it", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("cornichons");
  await page.goto("/#/reste");
  await page.getByLabel("Nouvel article au Reste").fill(label);
  await opsAnswer(page, () => page.getByRole("button", { name: "Ajouter", exact: true }).click());
  const row = page.getByRole("link", { name: label });
  const sheet = page.getByRole("dialog", { name: label });

  await row.click();
  await sheet.getByRole("button", { name: "Il en reste" }).click();
  await sheet.getByLabel("Ce qu'il en reste (facultatif)").fill("un bocal");
  await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  await expect(row).toContainText("un bocal");

  await row.click();
  await sheet.getByRole("button", { name: "Il en reste" }).click();
  const field = sheet.getByLabel("Ce qu'il en reste (facultatif)");
  await expect(field).toHaveValue("un bocal");
  await field.fill("   ");
  const cleared = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cleared.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(row).not.toContainText("un bocal");
  expect((await history(request)).stockItems.find((i) => i.label === label)).toMatchObject({ qtyText: null, isLow: false });
  errors();
});

// a row created offline has no server id, so it opens nothing until the server answers
test("an item added offline shows « en attente » and opens nothing until the server has it", async ({ page, context }) => {
  const errors = watchPageErrors(page);
  await page.goto("/#/reste");
  await serviceWorkerReady(page);
  await context.setOffline(true);
  const label = uniq("câpres");
  await page.getByLabel("Nouvel article au Reste").fill(label);
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: label })).toContainText("en attente");
  await expect(page.getByRole("link", { name: label })).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByRole("link", { name: label })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: label })).not.toContainText("en attente");
  errors();
});

test("« Racheter » finishes a held item and puts what each meal needed back on Courses, priced from its line", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first, second] = await plan(request, cheeseProposal(uniq("rachat")));
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
  await page.goto("/#/reste");
  const row = page.getByRole("link", { name: `100 g pour ${first!.title}` });
  await expect(row).toContainText(`100 g pour ${second!.title}`);
  await row.click();
  const sheet = page.getByRole("dialog", { name: "comté" });
  await sheet.getByRole("button", { name: "Fini" }).click();
  await expect(sheet.getByText(`Réservé pour ${first!.title}, ${second!.title}`)).toBeVisible();
  const lastLine = Math.max(...(await history(request)).shoppingItems.map((l) => l.id));
  const rebought = await opsAnswer(page, () => sheet.getByRole("button", { name: "Racheter" }).click());
  expect(rebought.results.map((r) => r.status)).toEqual(["applied"]);
  // one line per meal, 100 g each, priced pro rata of the 200 g line (6,40 €)
  const lines = (await history(request)).shoppingItems;
  expect(lines.filter((l) => l.id > lastLine).map((l) => [l.label, l.qty, l.estPriceCents, l.boughtAt])).toEqual([["comté", 100, 320, null], ["comté", 100, 320, null]]);
  await page.getByRole("link", { name: "Courses" }).click();
  // both rebuys, and any other comté still to buy, on the one comté row Courses shows (one row per product)
  const open = lines.filter((l) => l.label === "comté" && l.boughtAt === null && l.removedAt === null);
  const comteRow = page.getByRole("region", { name: "Crèmerie" }).getByRole("checkbox", { name: /^comté / });
  await expect(comteRow).toHaveCount(1);
  await expect(comteRow).toHaveAccessibleName(new RegExp(`^comté ${qtyText(open.reduce((n, l) => n + l.qty!, 0), "g")}`));
  await postOps(request, [first!, second!].map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});

// a plat cuisiné is not rebought (the server refuses it), so its warning offers no « Racheter »
test("« Fini » on a plat cuisiné a second round holds offers « Retirer le repas » and no « Racheter »", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const meals = await plan(request, doubledProposal(uniq("plat reste")));
  const secondRound = meals.find((m) => m.isSecondRound)!;
  const firstRound = meals.find((m) => m.id === secondRound.firstRoundId)!;
  await postOps(request, [{ type: "meal.cook", payload: { mealId: firstRound.id, sheet: {} } }]); // the plat cuisiné arrives on Reste
  await page.goto("/#/reste");
  await page.getByRole("link", { name: firstRound.title }).click();
  const sheet = page.getByRole("dialog", { name: firstRound.title });
  await sheet.getByRole("button", { name: "Fini" }).click();
  await expect(sheet.getByText(`Réservé pour ${secondRound.title}`)).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Retirer le repas" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Racheter" })).toHaveCount(0);
  const dropped = await opsAnswer(page, () => sheet.getByRole("button", { name: "Retirer le repas" }).click());
  expect(dropped.results.map((r) => r.status)).toEqual(["applied"]);
  const state = await history(request);
  expect(state.meals.find((m) => m.id === secondRound.id)!.droppedAt).not.toBeNull();
  await postOps(request, meals.filter((m) => m.id !== firstRound.id && m.id !== secondRound.id).map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});
