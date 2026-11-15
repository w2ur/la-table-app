import { expect, test } from "@playwright/test";
import { addAjout, cheeseProposal, history, opsAnswer, plan, postOps, tick, uniq, watchPageErrors } from "./helpers";
import { PHONE } from "./phone";

test("two phones tick the same line: one is applied, the other is a noop, and neither shows a refusal", async ({ browser, request }) => {
  const label = uniq("beurre");
  await addAjout(request, label);
  const contexts = [await browser.newContext(PHONE), await browser.newContext(PHONE)];
  const [phoneA, phoneB] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors = [phoneA!, phoneB!].map(watchPageErrors);
  for (const page of [phoneA!, phoneB!]) {
    await page.goto("/#/courses");
    await expect(tick(page, label)).toHaveAttribute("aria-checked", "false");
  }
  const first = await opsAnswer(phoneA!, () => tick(phoneA!, label).click());
  expect(first.results.map((r) => r.status)).toEqual(["applied"]);
  const second = await opsAnswer(phoneB!, () => tick(phoneB!, label).click()); // phone B's list is still the one it opened
  expect(second.results.map((r) => r.status)).toEqual(["noop"]);
  for (const page of [phoneA!, phoneB!]) {
    await expect(tick(page, label)).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText(/pas pu s'appliquer/)).toHaveCount(0);
  }
  expect((await history(request)).shoppingItems.filter((l) => l.label === label && l.boughtAt !== null)).toHaveLength(1);
  for (const check of errors) check();
  for (const c of contexts) await c.close();
});

// spec §8.2 « same intent twice »: the second cook is a noop and the server drops its sheet; the phone
// says so when the sheet said something, so « Fini » can be redone from Reste, and stays quiet when it said nothing
test("two phones cook the same meal: the second phone says its sheet was not recorded, and says nothing for an empty sheet", async ({ browser, request }) => {
  const [first, second] = await plan(request, cheeseProposal(uniq("deux")));
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
  const contexts = [await browser.newContext(PHONE), await browser.newContext(PHONE)];
  const [phoneA, phoneB] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors = [phoneA!, phoneB!].map(watchPageErrors);
  for (const page of [phoneA!, phoneB!]) {
    await page.goto("/#/menu");
    await page.getByRole("link", { name: first!.title }).click();
    await page.getByRole("button", { name: "Cuisiné" }).click();
    await expect(page.getByRole("dialog", { name: "Cuisiné" })).toBeVisible();
  }
  const cooked = await opsAnswer(phoneA!, () => phoneA!.getByRole("dialog", { name: "Cuisiné" }).getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);

  // phone B's sheet was open on the same meal: its verdict and what is left of the comté
  const sheet = phoneB!.getByRole("dialog", { name: "Cuisiné" });
  await sheet.getByRole("group", { name: "Verdict" }).getByRole("button", { name: "À refaire" }).click();
  await sheet.getByRole("group", { name: "comté : fini ou il en reste" }).getByRole("button", { name: "Il en reste" }).click();
  await sheet.getByLabel("Ce qu'il en reste (facultatif)").fill("un bout");
  const again = await opsAnswer(phoneB!, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(again.results.map((r) => [r.status, r.reason])).toEqual([["noop", "déjà cuisiné"]]);
  const told = phoneB!.getByText("Déjà cuisiné sur l'autre téléphone", { exact: false });
  await expect(told).toContainText(`Déjà cuisiné sur l'autre téléphone : votre avis et vos « Fini » n'ont pas été enregistrés (Cuisiné : ${first!.title}).`);
  await expect(phoneB!.getByText(/pas pu s'appliquer/)).toHaveCount(0);
  await expect(phoneA!.getByText("Déjà cuisiné sur l'autre téléphone", { exact: false })).toHaveCount(0);
  const state = await history(request);
  expect(state.meals.find((m) => m.id === first!.id)).toMatchObject({ verdict: null, note: null });
  expect(state.stockItems.find((i) => i.sourceShoppingItemId === line.id)!.qtyText).toBeNull();
  await phoneB!.getByRole("button", { name: "OK" }).click();
  await expect(told).toHaveCount(0);

  // the other meal: phone B's sheet open, the other phone cooks it, phone B sends its own with nothing answered
  await expect(phoneB!).toHaveURL(/#\/menu$/);
  await phoneB!.getByRole("link", { name: second!.title }).click();
  await phoneB!.getByRole("button", { name: "Cuisiné" }).click();
  await expect(sheet).toBeVisible();
  // the comté this meal now holds alone opens with a pre-made « Fini » (the cook empties it): not something phone B said,
  // so sent unchanged it stays quiet too
  const comte = sheet.getByRole("group", { name: "comté : fini ou il en reste" }).getByRole("button", { name: "Fini" });
  await expect(comte).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByText("fini s'il ne reste rien après ce repas")).toBeVisible();
  await postOps(request, [{ type: "meal.cook", payload: { mealId: second!.id, sheet: {} } }]);
  const empty = await opsAnswer(phoneB!, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(empty.results.map((r) => r.status)).toEqual(["noop"]);
  await expect(phoneB!).toHaveURL(/#\/menu$/);
  // a read queued behind that answer (one request at a time) brings the other phone's envie: the answer is handled by then
  const envie = uniq("envie lue");
  await postOps(request, [{ type: "envie.add", payload: { text: envie, url: null } }]);
  await phoneB!.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(phoneB!.getByText(envie)).toBeVisible();
  await expect(phoneB!.getByText("Déjà cuisiné sur l'autre téléphone", { exact: false })).toHaveCount(0);
  await expect(phoneB!.getByText(/pas pu s'appliquer/)).toHaveCount(0);
  for (const check of errors) check();
  for (const c of contexts) await c.close();
});
