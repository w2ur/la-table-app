import { expect, test } from "@playwright/test";
import { CHEESE_NUTRITION, cheeseProposal, doubledProposal, history, opsAnswer, plan, postOps, setNutrition, uniq, watchPageErrors } from "./helpers";

test("the recipe view shows the meal with what Reste holds for it; « Cuisiné » sends the verdict, the note and what is left; « Cuisinés récemment » opens it read-only and takes it back", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  await setNutrition(request, CHEESE_NUTRITION);
  const [first, second] = await plan(request, cheeseProposal(uniq("menu")));
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]); // the other phone bought the comté

  await page.goto("/#/menu");
  await page.getByRole("link", { name: first!.title }).click();
  await expect(page).toHaveURL(new RegExp(`#/menu/repas/${first!.id}$`));
  const recipe = page.getByRole("article");
  await expect(recipe.getByRole("heading", { name: first!.title })).toBeVisible();
  await expect(recipe.getByRole("listitem").filter({ hasText: "comté" })).toContainText("100 g · réservé");
  await expect(recipe.getByRole("listitem").filter({ hasText: "haricots verts surgelés" })).toHaveText(/300 g$/);
  await expect(recipe.getByRole("listitem").filter({ hasText: "Cuire 20 minutes." })).toBeVisible();
  // per base portion: (300 g colin + 100 g comté) / 2; the haricots verts have no values
  const nutrition = recipe.getByText(/^Par portion : /);
  await expect(nutrition).toContainText("Par portion : 328 kcal · 40 g protéines");
  await expect(nutrition).toContainText("partiel : sans haricots verts surgelés");
  // Regression: e8dbfb6 — « Retirer du menu » sat inside its button padding, off the gutter « ‹ Menu » is on
  const textLeft = (name: string) =>
    page.getByRole("button", { name }).evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
  expect(await textLeft("Retirer du menu")).toBe(await textLeft("‹ Menu"));

  await page.getByRole("button", { name: "Cuisiné" }).click();
  await expect(page).toHaveURL(new RegExp(`#/menu/repas/${first!.id}/cuisine$`));
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  // Regression: 3f1fbd9 — showModal() focused « Fermer », the first focusable control, so a sheet opened on its close
  // button rather than its title (a browser that shows focus after a tap drew a ring on it)
  await expect(sheet.getByRole("heading", { name: "Cuisiné" })).toBeFocused();
  await sheet.getByRole("group", { name: "Verdict" }).getByRole("button", { name: "À refaire" }).click();
  await expect(sheet.getByRole("button", { name: "À refaire" })).toHaveAttribute("aria-pressed", "true");
  await sheet.getByLabel("Note (facultatif)").fill("un peu trop cuit");
  await sheet.getByRole("group", { name: "comté : fini ou il en reste" }).getByRole("button", { name: "Il en reste" }).click();
  await sheet.getByLabel("Ce qu'il en reste (facultatif)").fill("un bout");
  await sheet.getByLabel("Presque fini").check();
  const cooked = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page).toHaveURL(/#\/menu$/);
  let state = await history(request);
  expect(state.meals.find((m) => m.id === first!.id)).toMatchObject({ verdict: "a_refaire", note: "un peu trop cuit" });
  expect(state.recipes.find((r) => r.title === first!.title)?.status).toBe("favourite");
  // « un bout » is no quantity: unknown, never the 100 g the subtraction left (one other meal holds it, so unknown is allowed)
  expect(state.stockItems.find((i) => i.sourceShoppingItemId === line.id)).toMatchObject({ qty: null, qtyText: "un bout", isLow: true });

  await page.getByText("Cuisinés récemment").click();
  // the cooked meal opens read-only: its recipe and nutrition, when it was cooked, no action and no reservation left
  await page.getByRole("link", { name: first!.title }).click();
  await expect(page).toHaveURL(new RegExp(`#/menu/repas/${first!.id}$`));
  const cookedRecipe = page.getByRole("article");
  await expect(cookedRecipe.getByRole("heading", { name: first!.title })).toBeVisible();
  await expect(cookedRecipe.getByText(/^cuisiné /)).toBeVisible();
  await expect(cookedRecipe.getByText(/^Par portion : /)).toContainText("Par portion : 328 kcal · 40 g protéines");
  await expect(cookedRecipe.getByRole("listitem").filter({ hasText: "comté" })).toHaveText(/100 g$/);
  await expect(cookedRecipe.getByRole("listitem").filter({ hasText: "Cuire 20 minutes." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cuisiné" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retirer du menu" })).toHaveCount(0);
  await expect(page.getByText("Déjà cuisiné sur l'autre téléphone", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "‹ Menu" }).click();
  await expect(page).toHaveURL(/#\/menu$/);
  // back on the list it was opened from, still open; two targets on the row, each at least 44 px: the title opens, « Annuler » undoes
  for (const target of [page.getByRole("link", { name: first!.title }), page.getByRole("button", { name: `Annuler « Cuisiné : ${first!.title} »` })]) {
    expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const undone = await opsAnswer(page, () => page.getByRole("button", { name: `Annuler « Cuisiné : ${first!.title} »` }).click());
  expect(undone.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page.getByRole("link", { name: first!.title })).toBeVisible();
  state = await history(request);
  expect(state.meals.find((m) => m.id === first!.id)).toMatchObject({ cookedAt: null, verdict: null, note: null });

  // « Retirer du menu » on both: the pool holds the seed's meals again
  for (const meal of [first!, second!]) {
    await page.getByRole("link", { name: meal.title }).click();
    const dropped = await opsAnswer(page, () => page.getByRole("button", { name: "Retirer du menu" }).click());
    expect(dropped.results.map((r) => r.status)).toEqual(["applied"]);
    await expect(page).toHaveURL(/#\/menu$/);
    await expect(page.getByRole("link", { name: meal.title })).toHaveCount(0);
  }
  errors();
});

// Regression: 38c46e6 — « Il en reste · 125g » stayed text beside the quantity the cook left, so Reste and planning read the subtraction
test("« Il en reste » in the Cuisiné sheet: a bare number is read in the unit shown beside it, becomes the quantity, and Reste shows it", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first, second] = await plan(request, cheeseProposal(uniq("reste")));
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);

  await page.goto("/#/menu");
  await page.getByRole("link", { name: first!.title }).click();
  await page.getByRole("button", { name: "Cuisiné" }).click();
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  await sheet.getByRole("group", { name: "comté : fini ou il en reste" }).getByRole("button", { name: "Il en reste" }).click();
  const field = sheet.getByLabel("Ce qu'il en reste (facultatif)");
  // the comté holds a number, so the field opens empty, its unit after it
  await expect(field).toHaveValue("");
  await expect(field).toHaveAttribute("placeholder", "ex. 125");
  await expect(sheet.locator(".left-over-unit")).toHaveText("g");
  await field.fill("125");
  const cooked = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  const item = (await history(request)).stockItems.find((i) => i.sourceShoppingItemId === line.id);
  expect(item).toMatchObject({ qty: 125, unit: "g", qtyText: null });

  await page.goto("/#/reste");
  const row = page.getByRole("region", { name: "Réservé" }).getByRole("link", { name: `100 g pour ${second!.title}` });
  await expect(row).toContainText(/^comté125 g · /);
  await expect(row).toContainText("≈ 25 g libres");
  errors();
});

// a second round eats its first round's leftovers, so it is never cooked first (spec §6.3)
test("a second round waits for its first round: its « Cuisiné » is off and says why", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const meals = await plan(request, doubledProposal(uniq("tour")));
  const secondRound = meals.find((m) => m.isSecondRound)!;
  await page.goto("/#/menu");
  await page.getByRole("link", { name: /second tour/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/menu/repas/${secondRound.id}$`));
  await expect(page.getByRole("button", { name: "Cuisiné" })).toBeDisabled();
  await expect(page.getByText("Cuisinez d'abord le premier tour.")).toBeVisible();
  // a second round eats the plat cuisiné: nothing of the recipe to gather or buy
  await expect(page.getByRole("article").getByText("Le plat cuisiné du premier tour.")).toBeVisible();
  await expect(page.getByRole("article").getByRole("listitem").filter({ hasText: "œuf" })).toHaveCount(0);
  // the first round's drop takes its second round with it
  await postOps(request, meals.filter((m) => !m.isSecondRound).map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});

// the other phone cooked or dropped the meal while its recipe was open here
test("a meal the other phone cooked or dropped while its recipe is open says so when the app comes back to the foreground", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first, second] = await plan(request, cheeseProposal(uniq("ailleurs")));
  const comeBack = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // spec §8.3: refresh on coming back
  const lost = page.getByText("Déjà cuisiné sur l'autre téléphone : ce que vous aviez saisi n'a pas été envoyé.");
  await page.goto(`/#/menu/repas/${first!.id}`);
  await expect(page.getByRole("heading", { name: first!.title })).toBeVisible();
  // the Cuisiné sheet open, a note typed: the other phone's cook closes it, and says what was not sent
  await page.getByRole("button", { name: "Cuisiné" }).click();
  await page.getByRole("dialog", { name: "Cuisiné" }).getByLabel("Note (facultatif)").fill("trop salé");
  await postOps(request, [{ type: "meal.cook", payload: { mealId: first!.id, sheet: {} } }]);
  await comeBack();
  await expect(lost).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Cuisiné" })).toHaveCount(0);
  // cooked: the recipe stays, read-only, saying when
  await expect(page.getByRole("article").getByText(/^cuisiné /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cuisiné" })).toHaveCount(0);
  await page.getByRole("button", { name: "‹ Menu" }).click();
  await expect(page).toHaveURL(/#\/menu$/);
  // dropped, its sheet open: no longer on the menu, and nothing about a cook
  await page.getByRole("link", { name: second!.title }).click();
  await page.getByRole("button", { name: "Cuisiné" }).click();
  await postOps(request, [{ type: "meal.drop", payload: { mealId: second!.id } }]);
  await comeBack();
  await expect(page.getByText("Ce repas n'est plus au menu", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retirer du menu" })).toHaveCount(0);
  await expect(lost).toHaveCount(0);
  errors();
});

// Regression: 9e46f3e — on a recipe typed or reloaded (no entry the app opened behind it), « Valider » in its Cuisiné
// sheet went back onto the recipe that had sent, which then showed nothing until a tab was tapped
test("« Valider » on a recipe opened from a typed address lands on the Menu list", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first, second] = await plan(request, cheeseProposal(uniq("tape")));
  await page.goto(`/#/menu/repas/${first!.id}`);
  await page.getByRole("button", { name: "Cuisiné" }).click();
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  const cooked = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page).toHaveURL(/#\/menu$/);
  await expect(page.getByRole("link", { name: second!.title })).toBeVisible();
  await postOps(request, [{ type: "meal.drop", payload: { mealId: second!.id } }]);
  errors();
});

test("an envie typed with a web address keeps it as its link, for the next planning", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const text = `tarte aux poireaux ${uniq("envie")} https://example.org/tarte`;
  await page.goto("/#/menu");
  await page.getByLabel("Nouvelle envie").fill(text);
  const added = await opsAnswer(page, () => page.getByRole("button", { name: "Ajouter", exact: true }).click());
  expect(added.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page.getByRole("link", { name: `Ouvrir le lien de « ${text} »` })).toHaveAttribute("href", "https://example.org/tarte");
  expect((await history(request)).envies.find((e) => e.text === text)).toMatchObject({ url: "https://example.org/tarte" });
  errors();
});

// From the Menu: « Fini » in the Cuisiné sheet on an item another open meal holds asks first (spec
// §10.1, §10.4); « Annuler » there sends nothing, and the cook carries the resolution chosen
test("« Fini » in the Cuisiné sheet on the comté the other meal holds asks first, and the cook carries « Retirer le repas »", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first, second] = await plan(request, cheeseProposal(uniq("avertir")));
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/ops") && r.method() === "POST") posts += 1;
  });

  await page.goto("/#/menu");
  await page.getByRole("link", { name: first!.title }).click();
  await page.getByRole("button", { name: "Cuisiné" }).click();
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  const comte = sheet.getByRole("group", { name: "comté : fini ou il en reste" });
  await comte.getByRole("button", { name: "Fini" }).click();
  await expect(sheet.getByText(`Réservé pour ${second!.title}`)).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Valider" })).toBeDisabled();
  // the window is opened before the click: an op flushed after it, asynchronously, still lands in it
  const stray = page.waitForRequest((r) => r.url().endsWith("/api/ops") && r.method() === "POST", { timeout: 1_000 });
  await sheet.getByRole("button", { name: "Annuler" }).click();
  await expect(comte.getByRole("button", { name: "Fini" })).toHaveAttribute("aria-pressed", "false");
  await expect(stray).rejects.toThrow(/Timeout/);
  expect(posts).toBe(0);

  await comte.getByRole("button", { name: "Fini" }).click();
  await sheet.getByRole("button", { name: "Retirer le repas" }).click();
  await expect(comte.getByRole("button", { name: "Fini" })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByText(`Fini · ${second!.title} : retiré du menu`)).toBeVisible();
  const cooked = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  expect(posts).toBe(1);
  await expect(page).toHaveURL(/#\/menu$/);
  const state = await history(request);
  expect(state.meals.find((m) => m.id === first!.id)!.cookedAt).not.toBeNull();
  expect(state.meals.find((m) => m.id === second!.id)!.droppedAt).not.toBeNull();
  expect(state.stockItems.find((i) => i.sourceShoppingItemId === line.id)!.finishedAt).not.toBeNull();
  errors();
});

// a second round eats its first round's plat cuisiné, so its sheet says « Fini » on it until told otherwise
test("a second round's Cuisiné sheet has « Fini » on its plat cuisiné, a tap clears it, and the cook finishes the plat", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const meals = await plan(request, doubledProposal(uniq("plat")));
  const secondRound = meals.find((m) => m.isSecondRound)!;
  const firstRound = meals.find((m) => m.id === secondRound.firstRoundId)!;
  await postOps(request, [{ type: "meal.cook", payload: { mealId: firstRound.id, sheet: {} } }]); // the other phone cooked the first round
  await page.goto("/#/menu");
  await page.getByRole("link", { name: /second tour/ }).click();
  await page.getByRole("button", { name: "Cuisiné" }).click();
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  const fini = sheet.getByRole("group", { name: `${firstRound.title} : fini ou il en reste` }).getByRole("button", { name: "Fini" });
  await expect(fini).toHaveAttribute("aria-pressed", "true");
  await fini.click();
  await expect(fini).toHaveAttribute("aria-pressed", "false");
  await fini.click();
  await expect(fini).toHaveAttribute("aria-pressed", "true");
  const cooked = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  const state = await history(request);
  expect(state.meals.find((m) => m.id === secondRound.id)!.cookedAt).not.toBeNull();
  expect(state.stockItems.find((i) => i.label === firstRound.title)!.finishedAt).not.toBeNull();
  await postOps(request, meals.filter((m) => m.id !== firstRound.id && m.id !== secondRound.id).map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});

// Regression: 19f9aac — the warning stayed asked for an item a refresh had taken out of its reach, and « Valider »
// stayed off for good
test("a reservation warning the other phone settled while it was open lets « Valider » go: the comté finished with « Racheter »", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first, second] = await plan(request, cheeseProposal(uniq("rachete")));
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
  const item = (await history(request)).stockItems.find((i) => i.sourceShoppingItemId === line.id)!;

  await page.goto("/#/menu");
  await page.getByRole("link", { name: first!.title }).click();
  await page.getByRole("button", { name: "Cuisiné" }).click();
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  await sheet.getByRole("group", { name: "comté : fini ou il en reste" }).getByRole("button", { name: "Fini" }).click();
  await expect(sheet.getByText(`Réservé pour ${second!.title}`)).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Valider" })).toBeDisabled();

  // the other phone finished the comté with « Racheter »: it left Reste, and this meal holds it no more
  await postOps(request, [{ type: "stock.finish", payload: { itemId: item.id, resolution: "rebuy" } }]);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/state")),
    page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
  ]);
  await expect(sheet.getByText(`Réservé pour ${second!.title}`)).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Valider" })).toBeEnabled();
  const cooked = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page).toHaveURL(/#\/menu$/);
  await postOps(request, [{ type: "meal.drop", payload: { mealId: second!.id } }]);
  errors();
});

// Regression: 6ca8c91 — once a refresh showed no other meal holding the comté, the line under « Fini » read « Fini ·  :
// retiré du menu »
test("a « Fini » answered « Retirer le repas » reads as a plain « Fini » once the other phone dropped that meal", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first, second] = await plan(request, cheeseProposal(uniq("seul")));
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);

  await page.goto("/#/menu");
  await page.getByRole("link", { name: first!.title }).click();
  await page.getByRole("button", { name: "Cuisiné" }).click();
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  const fini = sheet.getByRole("group", { name: "comté : fini ou il en reste" }).getByRole("button", { name: "Fini" });
  await fini.click();
  await sheet.getByRole("button", { name: "Retirer le repas" }).click();
  await expect(sheet.getByText(`Fini · ${second!.title} : retiré du menu`)).toBeVisible();

  await postOps(request, [{ type: "meal.drop", payload: { mealId: second!.id } }]); // the other phone dropped it
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/state")),
    page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
  ]);
  await expect(sheet.getByText("retiré du menu", { exact: false })).toHaveCount(0);
  await expect(fini).toHaveAttribute("aria-pressed", "true");
  const cooked = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  expect((await history(request)).stockItems.find((i) => i.sourceShoppingItemId === line.id)!.finishedAt).not.toBeNull();
  errors();
});

// Regression: 5a8b2a9 — a « Fini » tapped while the item had no other holder was sent with no resolution after a refresh
// showed another open meal holding it, and the domain refused the whole meal.cook; this pins the sheet's call to
// `unresolvedFini`, which cook.test.ts pins on its own
test("« Valider » asks the warning for a « Fini » another meal took hold of since the tap, and sends nothing until answered", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  // the cheese pair and an egg meal on the comté too (a third protein: the second planning below stays within two per
  // protein); the pair dropped, the egg meal alone holds 100 g of the 300 g bought
  const cheese = cheeseProposal(uniq("depuis"));
  const omelette = {
    key: "x", title: `Omelette épinards et comté ${uniq("depuis")}`, source_url: null, base_portions: 2, active_min: 15, total_min: 15, main_protein: "protein:oeuf",
    steps: ["Battre les œufs.", "Cuire avec les épinards et le comté."], ingredients: [{ product: "œuf", qty: 4, unit: "piece" }, { product: "épinards surgelés", qty: 200, unit: "g" }, { product: "comté", qty: 100, unit: "g" }],
  };
  const meals = await plan(request, {
    ...cheese,
    new_recipes: [...(cheese.new_recipes as unknown[]), omelette],
    meals: [...(cheese.meals as unknown[]), { recipe: "x", portions: 2, doubled: false }],
    prices: [...(cheese.prices as unknown[]), { product: "œuf", unit: "piece", est_price_cents: 240 }],
  });
  const meal = meals.find((m) => m.title === omelette.title)!;
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 300 && l.boughtAt === null)!;
  await postOps(request, [
    { type: "shopping.buy", payload: { itemId: line.id } },
    ...meals.filter((m) => m.id !== meal.id).map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })),
  ]);

  await page.goto("/#/menu");
  await page.getByRole("link", { name: meal.title }).click();
  await page.getByRole("button", { name: "Cuisiné" }).click();
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  const fini = sheet.getByRole("group", { name: "comté : fini ou il en reste" }).getByRole("button", { name: "Fini" });
  await fini.click(); // this meal alone holds the comté: no warning
  await expect(fini).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByText("Réservé pour", { exact: false })).toHaveCount(0);

  // the other phone plans on the comté left over: a planning reserves libre stock (spec §6.1), here for both its meals
  const other = cheeseProposal(uniq("ensuite"));
  await postOps(request, [{ type: "planning.commit", payload: other }]);
  const titles = (other.new_recipes as { title: string }[]).map((r) => r.title);
  const holder = new RegExp(`^Réservé pour (${titles.join(", ")}|${[...titles].reverse().join(", ")})$`);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/state")),
    page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
  ]);

  // the window is opened before the click: an op flushed after it, asynchronously, still lands in it
  const stray = page.waitForRequest((r) => r.url().endsWith("/api/ops") && r.method() === "POST", { timeout: 1_000 });
  await sheet.getByRole("button", { name: "Valider" }).click();
  await expect(sheet.getByText(holder)).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Valider" })).toBeDisabled();
  await expect(stray).rejects.toThrow(/Timeout/);
  await expect(page).toHaveURL(new RegExp(`#/menu/repas/${meal.id}/cuisine$`));

  await sheet.getByRole("button", { name: "Retirer le repas" }).click();
  const cooked = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(cooked.results.map((r) => r.status)).toEqual(["applied"]);
  const state = await history(request);
  expect(state.meals.find((m) => m.id === meal.id)!.cookedAt).not.toBeNull();
  expect(state.stockItems.find((i) => i.sourceShoppingItemId === line.id)!.finishedAt).not.toBeNull();
  // « Retirer le repas » dropped both meals that held the comté
  const pool = (await (await request.get("/api/state")).json()) as { menu: { pool: { title: string }[] } };
  expect(pool.menu.pool.filter((m) => titles.includes(m.title))).toEqual([]);
  errors();
});

test.describe("a stored address that is not a web one", () => {
  // page.route does not see requests a service worker handles
  test.use({ serviceWorkers: "block" });

  // Regression: d6862d6 — an envie's address and a recipe's source were rendered as links whatever their scheme, so a
  // « javascript: » address would run on a tap; the server refuses one now, and the screens link only http(s) anyway
  test("is refused by the server, and never rendered as a link if one is stored", async ({ page, request }) => {
    const errors = watchPageErrors(page);
    const res = await request.post("/api/ops", {
      data: { ops: [{ opId: uniq("js-envie"), at: new Date().toISOString(), type: "envie.add", payload: { text: "piège", url: "javascript:alert(1)" } }] },
    });
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([expect.objectContaining({ status: "refused", reason: "données invalides" })]);

    const [meal] = await plan(request, cheeseProposal(uniq("lien")));
    const safe = uniq("tarte");
    const unsafe = uniq("piège");
    await page.route("**/api/state", async (route) => {
      const snapshot = await (await route.fetch()).json();
      snapshot.menu.envies.push(
        { id: 9001, text: safe, url: "https://example.org/tarte", createdAt: new Date().toISOString(), status: "ouverte", mealId: null },
        { id: 9002, text: unsafe, url: "javascript:alert(1)", createdAt: new Date().toISOString(), status: "ouverte", mealId: null },
      );
      for (const m of snapshot.menu.pool) if (m.id === meal!.id) m.sourceUrl = "javascript:alert(1)";
      await route.fulfill({ json: snapshot });
    });
    await page.goto("/#/menu");
    await expect(page.getByRole("link", { name: `Ouvrir le lien de « ${safe} »` })).toHaveAttribute("href", "https://example.org/tarte");
    await expect(page.getByText(unsafe)).toBeVisible();
    await expect(page.getByRole("link", { name: `Ouvrir le lien de « ${unsafe} »` })).toHaveCount(0);
    await page.getByRole("link", { name: meal!.title }).click();
    await expect(page.getByRole("article").getByRole("heading", { name: meal!.title })).toBeVisible();
    await expect(page.getByRole("link", { name: "Recette d'origine" })).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    await page.unrouteAll({ behavior: "ignoreErrors" }); // a refresh still in flight as the page closes
    errors();
  });
});

test.describe("« Cuisinés récemment » emptied while open", () => {
  // page.route does not see requests a service worker handles
  test.use({ serviceWorkers: "block" });

  test("comes back closed when a meal is cooked again", async ({ page, request }) => {
    const errors = watchPageErrors(page);
    const [meal, other] = await plan(request, cheeseProposal(uniq("vide")));
    await postOps(request, [{ type: "meal.cook", payload: { mealId: meal!.id, sheet: {} } }, { type: "meal.drop", payload: { mealId: other!.id } }]);
    let empty = false;
    await page.route("**/api/state", async (route) => {
      const snapshot = await (await route.fetch()).json();
      if (empty) snapshot.menu.recentlyCooked = [];
      await route.fulfill({ json: snapshot });
    });
    const comeBack = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // spec §8.3: refresh on coming back
    await page.goto("/#/menu");
    await page.getByText("Cuisinés récemment").click();
    await expect(page.getByRole("link", { name: meal!.title })).toBeVisible();
    empty = true;
    await comeBack();
    await expect(page.getByText("Cuisinés récemment")).toHaveCount(0);
    empty = false;
    await comeBack();
    await expect(page.getByText("Cuisinés récemment")).toBeVisible();
    await expect(page.getByRole("link", { name: meal!.title })).toBeHidden();
    await page.unrouteAll({ behavior: "ignoreErrors" }); // a refresh still in flight as the page closes
    errors();
  });
});

test.describe("a recent meal stored by an older app", () => {
  // page.route does not see requests a service worker handles
  test.use({ serviceWorkers: "block" });

  // the snapshot an older build stored or served has only the title and the cook on a recent meal: its row still opens,
  // on what it has, and leaves out the rest
  test("still lists its row and opens it on its title alone", async ({ page, request }) => {
    const errors = watchPageErrors(page);
    const [meal, other] = await plan(request, cheeseProposal(uniq("ancien")));
    await postOps(request, [{ type: "meal.cook", payload: { mealId: meal!.id, sheet: {} } }, { type: "meal.drop", payload: { mealId: other!.id } }]);
    await page.route("**/api/state", async (route) => {
      const snapshot = await (await route.fetch()).json();
      snapshot.menu.recentlyCooked = snapshot.menu.recentlyCooked.map(
        ({ mealId, title, cookedAt, cookOpId }: Record<string, unknown>) => ({ mealId, title, cookedAt, cookOpId }),
      );
      await route.fulfill({ json: snapshot });
    });
    await page.goto("/#/menu");
    await page.getByText("Cuisinés récemment").click();
    await expect(page.getByRole("button", { name: `Annuler « Cuisiné : ${meal!.title} »` })).toBeVisible();
    await page.getByRole("link", { name: meal!.title }).click();
    const recipe = page.getByRole("article");
    await expect(recipe.getByRole("heading", { name: meal!.title })).toBeVisible();
    await expect(recipe.getByText(/^cuisiné /)).toBeVisible();
    await expect(recipe.getByText(/Par portion|\d+ min|portion/)).toHaveCount(0);
    await expect(recipe.getByRole("heading", { name: "Ingrédients" })).toHaveCount(0);
    await expect(recipe.getByRole("heading", { name: "Étapes" })).toHaveCount(0);
    await expect(recipe.getByRole("listitem")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cuisiné" })).toHaveCount(0);
    await page.unrouteAll({ behavior: "ignoreErrors" }); // a refresh still in flight as the page closes
    errors();
  });
});

test("a meal a declared leftover left short says « manque » on its row, and « Ajouter aux courses » on its recipe puts the line on Courses", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first, second] = await plan(request, cheeseProposal(uniq("reliquat")));
  const line = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
  const comte = (await history(request)).stockItems.find((i) => i.sourceShoppingItemId === line.id)!;
  // the owners say 50 g are left of the 200 g: the two 100 g holds no longer fit, the second meal loses its whole hold
  await postOps(request, [{ type: "stock.partial", payload: { itemId: comte.id, qtyText: "50 g", low: false } }]);

  await page.goto("/#/menu");
  const row = (title: string) => page.getByRole("link", { name: title });
  await expect(row(first!.title)).toContainText("manque : comté 50 g");
  await expect(row(second!.title)).toContainText("manque : comté 100 g");
  await row(second!.title).click();
  const recipe = page.getByRole("article");
  await expect(recipe.getByText("manque : comté 100 g")).toBeVisible();
  const known = new Set((await history(request)).shoppingItems.map((l) => l.id));
  const added = await opsAnswer(page, () => recipe.getByRole("button", { name: "Ajouter aux courses" }).click());
  expect(added.results.map((r) => r.status)).toEqual(["applied"]);
  // the tap clears the line at once, and the server's answer keeps it cleared
  await expect(recipe.getByText(/^manque : /)).toHaveCount(0);
  await expect(recipe.getByRole("button", { name: "Ajouter aux courses" })).toHaveCount(0);
  // the new line: the one the cover added, found by id against the lines known before it
  const covered = (await history(request)).shoppingItems.filter((l) => l.label === "comté" && l.boughtAt === null && l.removedAt === null && !known.has(l.id));
  expect(covered).toHaveLength(1);
  expect(covered[0]!.qty).toBeGreaterThanOrEqual(100);

  await page.getByRole("button", { name: "‹ Menu" }).click();
  await expect(row(second!.title)).not.toContainText("manque");
  await expect(row(first!.title)).toContainText("manque : comté 50 g");
  await page.getByRole("link", { name: "Courses" }).click();
  await expect(page.getByRole("region", { name: "Crèmerie" }).getByRole("checkbox", { name: /^comté /u }).first()).toBeVisible(); // one row per product: the new line joins the others
  await postOps(request, [{ type: "meal.drop", payload: { mealId: first!.id } }, { type: "meal.drop", payload: { mealId: second!.id } }]);
  errors();
});

// decided 2026-10-25: an item the cook empties opens with « Fini »; cleared, the item stays at 0, and its Reste row then
// offers « Fini » beside it, undone by « Annuler »
test("the Cuisiné sheet has « Fini » on an item the cook empties; left at 0, its Reste row finishes it in one tap", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [first] = await plan(request, cheeseProposal(uniq("zero")));
  const lines = (await history(request)).shoppingItems.filter((l) => l.boughtAt === null && l.forMeals.some((f) => f.mealId === first!.id));
  const line = lines.find((l) => l.label === "haricots verts surgelés")!;
  const comte = lines.find((l) => l.label === "comté")!;
  await postOps(request, [line, comte].map((l) => ({ type: "shopping.buy", payload: { itemId: l.id } })));
  const itemOf = async () => (await history(request)).stockItems.find((i) => i.sourceShoppingItemId === line.id)!;

  await page.goto("/#/menu");
  await page.getByRole("link", { name: first!.title }).click();
  await page.getByRole("button", { name: "Cuisiné" }).click();
  const sheet = page.getByRole("dialog", { name: "Cuisiné" });
  const beans = sheet.getByRole("group", { name: "haricots verts surgelés : fini ou il en reste" });
  await expect(beans.getByRole("button", { name: "Fini" })).toHaveAttribute("aria-pressed", "true");
  // the comté the other meal holds too is not preselected
  await expect(sheet.getByRole("group", { name: "comté : fini ou il en reste" }).getByRole("button", { name: "Fini" })).toHaveAttribute("aria-pressed", "false");
  await beans.getByRole("button", { name: "Fini" }).click();
  await expect(beans.getByRole("button", { name: "Fini" })).toHaveAttribute("aria-pressed", "false");
  await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(await itemOf()).toMatchObject({ qty: 0, finishedAt: null });

  await page.goto("/#/reste");
  const { id } = await itemOf();
  const finish = page.getByRole("button", { name: "Fini : haricots verts surgelés" });
  await expect(finish).toHaveCount(1);
  const finished = await opsAnswer(page, () => finish.click());
  expect(finished.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(finish).toHaveCount(0);
  expect((await history(request)).stockItems.find((i) => i.id === id)!.finishedAt).not.toBeNull();
  await page.locator(".undo-bar").getByRole("button", { name: "Annuler" }).click();
  await expect(finish).toHaveCount(1);
  await expect.poll(async () => (await history(request)).stockItems.find((i) => i.id === id)?.finishedAt).toBeNull();
  errors();
});
