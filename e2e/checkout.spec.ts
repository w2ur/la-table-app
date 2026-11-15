import { expect, test } from "@playwright/test";
import { dateLabel } from "../src/app/format";
import { addDays, parisDate } from "../src/domain/dates";
import { addAjout, checkoutElsewhere, history, opsAnswer, postOps, tick, uniq, watchPageErrors } from "./helpers";

test("Passage en caisse records the place, the receipt in cents and the Paris date; a zero receipt is refused before sending", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("pain");
  await addAjout(request, label);
  await page.goto("/#/courses");
  const bought = await opsAnswer(page, () => tick(page, label).click());
  expect(bought.results.map((r) => r.status)).toEqual(["applied"]);

  let posts = 0;
  page.on("request", (r) => { if (r.url().endsWith("/api/ops") && r.method() === "POST") posts += 1; });
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await sheet.getByLabel("Marché", { exact: true }).check(); // exact: « Supermarché » contains it
  await sheet.getByLabel("Total du ticket").fill("0");
  await sheet.getByRole("button", { name: "Valider" }).click();
  await expect(sheet.getByText("Un total de 0 € n'est pas un ticket.")).toBeVisible();
  expect(posts).toBe(0);

  await sheet.getByLabel("Total du ticket").fill("12,5");
  const recorded = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(recorded.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(sheet).toHaveCount(0);
  await expect(tick(page, label)).toHaveCount(0); // the trip took it off Courses

  const state = await history(request);
  const line = state.shoppingItems.find((l) => l.label === label)!;
  expect(state.trips.find((t) => t.id === line.tripId)).toMatchObject({ place: "marche", totalCents: 1250, date: parisDate(new Date().toISOString()) });
  errors();
});

test("a ticket recorded without its total can be completed later from Courses", async ({ page, request }) => {
  const label = uniq("savon");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, label).click());
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const checkout = page.getByRole("dialog", { name: "Passage en caisse" });
  await opsAnswer(page, () => checkout.getByRole("button", { name: "Valider" }).click()); // no total yet
  await page.getByRole("button", { name: "Saisir le total" }).click();
  const ticket = page.getByRole("dialog", { name: /^Ticket du / });
  // Regression: 77fdb05 — a sample « 42,50 » in the empty ticket-total field read as a typed total
  await expect(ticket.getByLabel("Total du ticket")).not.toHaveAttribute("placeholder");
  await ticket.getByLabel("Total du ticket").fill("18,90");
  const answer = await opsAnswer(page, () => ticket.getByRole("button", { name: "Valider" }).click());
  expect(answer.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page.getByRole("button", { name: "Saisir le total" })).toHaveCount(0);
  const state = await history(request);
  const line = state.shoppingItems.find((l) => l.label === label)!;
  expect(state.trips.find((t) => t.id === line.tripId)?.totalCents).toBe(1890);
});

// a second tap before the sheet closes would record a second, empty trip that becomes the last one
test("a double tap on « Valider » records one trip", async ({ page, context, request }) => {
  const label = uniq("beurre");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, label).click());
  await context.setOffline(true); // the ops wait in the outbox, where they can be counted
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await sheet.getByLabel("Total du ticket").fill("7,20");
  await sheet.getByRole("button", { name: "Valider" }).dblclick();
  await expect(page.getByText("Hors ligne · 1 action en attente")).toBeVisible();
  // the status line goes as soon as the phone is online, before the outbox has flushed: wait for the server's answer
  const flushed = await opsAnswer(page, () => context.setOffline(false));
  expect(flushed.results.map((r) => r.status)).toEqual(["applied"]);
  const state = await history(request);
  const line = state.shoppingItems.find((l) => l.label === label)!;
  expect(state.trips.filter((t) => t.id >= line.tripId!)).toHaveLength(1);
});

// Regression: b36d886 — the ticket sheet sent its total to whichever trip was last at submit, and named no place
test("a newer trip arriving while the ticket sheet is open does not receive its total", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("poireau");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, label).click());
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const checkout = page.getByRole("dialog", { name: "Passage en caisse" });
  await checkout.getByLabel("Marché", { exact: true }).check();
  await opsAnswer(page, () => checkout.getByRole("button", { name: "Valider" }).click()); // no total yet
  await expect(page.getByText(/· Marché sans total/)).toBeVisible();
  await page.getByRole("button", { name: "Saisir le total" }).click();
  const ticket = page.getByRole("dialog", { name: /^Ticket du .* · Marché$/ });
  await ticket.getByLabel("Total du ticket").fill("23,40");

  // the other phone records the supermarché trip, without its total either; a refresh brings it here
  await checkoutElsewhere(request, { place: "supermarche", totalCents: null, date: parisDate(new Date().toISOString()) });
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/state")),
    page.evaluate(() => dispatchEvent(new Event("online"))),
  ]);
  await expect(ticket.getByText("Ce ticket n'est plus le dernier sans total : rien n'a été envoyé.")).toBeVisible();
  await expect(ticket.getByRole("button", { name: "Valider" })).toBeDisabled();

  let posts = 0;
  page.on("request", (r) => { if (r.url().endsWith("/api/ops") && r.method() === "POST") posts += 1; });
  await ticket.getByLabel("Total du ticket").press("Enter");
  await ticket.getByRole("button", { name: "Fermer" }).click();
  await expect(page.getByText(/· Supermarché sans total/)).toBeVisible();
  expect(posts).toBe(0);
  const state = await history(request);
  const marche = state.trips.find((t) => t.id === state.shoppingItems.find((l) => l.label === label)!.tripId)!;
  expect(marche).toMatchObject({ place: "marche", totalCents: null });
  expect(state.trips.filter((t) => t.id > marche.id)).toEqual([expect.objectContaining({ place: "supermarche", totalCents: null })]);
  errors();
});

// Regression: ac71541 — an undone trip freed its id, so the trip recorded next took it and the ticket sheet pinned to the undone trip sent its total there
test("a trip undone and recorded again by another phone while the ticket sheet is open does not receive its total", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("céleri");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, label).click());
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const checkout = page.getByRole("dialog", { name: "Passage en caisse" });
  await checkout.getByLabel("Marché", { exact: true }).check();
  const recorded = await opsAnswer(page, () => checkout.getByRole("button", { name: "Valider" }).click()); // no total yet
  const tripOp = recorded.results[0]!.opId;
  await page.getByRole("button", { name: "Saisir le total" }).click();
  const ticket = page.getByRole("dialog", { name: /^Ticket du .* · Marché$/ });
  await ticket.getByLabel("Total du ticket").fill("14,30");

  // the other phone takes the trip back and records the same basket again, same place, same day; a refresh brings it here
  const before = await history(request);
  const undone = before.trips.find((t) => t.id === before.shoppingItems.find((l) => l.label === label)!.tripId)!;
  await postOps(request, [{ type: "undo", payload: { targetOpId: tripOp } }]);
  await checkoutElsewhere(request, { place: "marche", totalCents: null, date: undone.date });
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/state")),
    page.evaluate(() => dispatchEvent(new Event("online"))),
  ]);
  await expect(ticket.getByText("Ce ticket n'est plus le dernier sans total : rien n'a été envoyé.")).toBeVisible();
  await expect(ticket.getByRole("button", { name: "Valider" })).toBeDisabled();
  await ticket.getByRole("button", { name: "Fermer" }).click();
  const state = await history(request);
  const again = state.trips.find((t) => t.id === state.shoppingItems.find((l) => l.label === label)!.tripId)!;
  expect(again).toMatchObject({ place: "marche", totalCents: null });
  expect(again.id).toBeGreaterThan(undone.id);
  errors();
});

// the later ticket sheet also sends its op once per opening
test("a double tap on the ticket sheet's « Valider » sends one total", async ({ page, context, request }) => {
  const label = uniq("endive");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, label).click());
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const checkout = page.getByRole("dialog", { name: "Passage en caisse" });
  await opsAnswer(page, () => checkout.getByRole("button", { name: "Valider" }).click()); // no total yet
  await context.setOffline(true); // the op waits in the outbox, where it can be counted
  await page.getByRole("button", { name: "Saisir le total" }).click();
  const ticket = page.getByRole("dialog", { name: /^Ticket du / });
  await ticket.getByLabel("Total du ticket").fill("9,60");
  await ticket.getByRole("button", { name: "Valider" }).dblclick();
  await expect(page.getByText("Hors ligne · 1 action en attente")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText(/en attente/)).toHaveCount(0);
  const state = await history(request);
  const line = state.shoppingItems.find((l) => l.label === label)!;
  expect(state.trips.find((t) => t.id === line.tripId)?.totalCents).toBe(960);
});

// Regression: daf563f — #/courses/ticket opened with no ticket due stayed on that route, and a refresh that later brought one opened the sheet untapped
test("the ticket route with no ticket due goes back to Courses, and a later due ticket does not open the sheet", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const date = parisDate(new Date().toISOString());
  await checkoutElsewhere(request, { place: "marche", totalCents: 500, date }); // the last trip has its total
  await page.goto("/#/courses/ticket");
  await expect(page.getByRole("button", { name: "Passage en caisse" })).toBeVisible();
  await expect(page).toHaveURL(/#\/courses$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // the other phone records a trip without its total; a refresh brings it here
  await checkoutElsewhere(request, { place: "autre", totalCents: null, date });
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/state")),
    page.evaluate(() => dispatchEvent(new Event("online"))),
  ]);
  await expect(page.getByText(/· Autre sans total/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  errors();
});

test("« Annuler » after a Passage en caisse puts the line back in the basket, and the server keeps no trip for it", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("lentilles");
  await addAjout(request, label);
  const lastBefore = Math.max(0, ...(await history(request)).trips.map((t) => t.id));
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, label).click());
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await sheet.getByLabel("Total du ticket").fill("3,10");
  const recorded = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(recorded.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(tick(page, label)).toHaveCount(0);

  const undone = await opsAnswer(page, () => page.getByRole("button", { name: "Annuler" }).click());
  expect(undone.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page.getByRole("region", { name: "Dans le panier" }).getByRole("checkbox", { name: label })).toHaveAttribute("aria-checked", "true");
  const state = await history(request);
  expect(state.shoppingItems.find((l) => l.label === label)).toMatchObject({ tripId: null, boughtAt: expect.any(String) });
  expect(state.trips.filter((t) => t.id > lastBefore)).toEqual([]);
  errors();
});

// Regression: b4cd6b8 — the last trip was the latest by date, so a forgotten marché recorded with a past date after a later-dated trip never offered its ticket
test("a trip recorded with a past date after a later-dated one offers « Saisir le total » for it", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const today = parisDate(new Date().toISOString());
  const yesterday = addDays(today, -1);
  await checkoutElsewhere(request, { place: "supermarche", totalCents: 3150, date: today }); // the later-dated trip, with its total
  const label = uniq("radis");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, label).click());
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const checkout = page.getByRole("dialog", { name: "Passage en caisse" });
  await checkout.getByLabel("Marché", { exact: true }).check();
  await checkout.getByLabel("Date", { exact: true }).fill(yesterday);
  const recorded = await opsAnswer(page, () => checkout.getByRole("button", { name: "Valider" }).click()); // no total yet
  expect(recorded.results.map((r) => r.status)).toEqual(["applied"]);

  const day = dateLabel(yesterday, today);
  await expect(page.getByText(`Ticket du ${day} · Marché sans total.`)).toBeVisible();
  await page.getByRole("button", { name: "Saisir le total" }).click();
  const ticket = page.getByRole("dialog", { name: `Ticket du ${day} · Marché` });
  await ticket.getByLabel("Total du ticket").fill("6,40");
  const answer = await opsAnswer(page, () => ticket.getByRole("button", { name: "Valider" }).click());
  expect(answer.results.map((r) => r.status)).toEqual(["applied"]);
  const state = await history(request);
  const line = state.shoppingItems.find((l) => l.label === label)!;
  expect(state.trips.find((t) => t.id === line.tripId)).toMatchObject({ place: "marche", date: yesterday, totalCents: 640 });
  errors();
});

// Regression: b81a819 — #/courses/caisse opened with an empty basket stayed on that route, and a refresh that later brought a bought line showed the form untapped
test("the checkout route with an empty basket goes back to Courses, and a later bought line does not open the sheet", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const date = parisDate(new Date().toISOString());
  await checkoutElsewhere(request, { place: "marche", totalCents: 500, date }); // empties the basket
  await page.goto("/#/courses/caisse");
  await expect(page.getByRole("button", { name: "Passage en caisse" })).toBeVisible();
  await expect(page).toHaveURL(/#\/courses$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // the other phone buys a line; a refresh brings it here
  const label = uniq("persil");
  await addAjout(request, label);
  const line = (await history(request)).shoppingItems.find((l) => l.label === label)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/state")),
    page.evaluate(() => dispatchEvent(new Event("online"))),
  ]);
  await expect(tick(page, label)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  errors();
});

// Regression: b81a819 — a refresh that changed the basket while the checkout sheet was open put the receipt typed for this basket on a trip holding other lines
test("a basket changed by another phone while the checkout sheet is open sends nothing", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const mine = uniq("navet");
  const theirs = uniq("cidre");
  await checkoutElsewhere(request, { place: "marche", totalCents: 500, date: parisDate(new Date().toISOString()) }); // empties the basket
  await addAjout(request, mine);
  await addAjout(request, theirs);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, mine).click());
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await expect(sheet.getByText("1 article dans le panier.")).toBeVisible();
  await sheet.getByLabel("Total du ticket").fill("8,70");

  // the other phone records its checkout (this basket's line goes with it), then ticks another line: the basket keeps
  // its size but holds other lines; a refresh brings that here
  const line = (await history(request)).shoppingItems.find((l) => l.label === theirs)!;
  await checkoutElsewhere(request, { place: "autre", totalCents: null, date: parisDate(new Date().toISOString()) });
  await postOps(request, [
    { type: "shopping.buy", payload: { itemId: line.id } },
  ]);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/state")),
    page.evaluate(() => dispatchEvent(new Event("online"))),
  ]);
  await expect(sheet.getByText("Le panier a changé depuis l'ouverture : rien n'a été envoyé.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Valider" })).toBeDisabled();

  let posts = 0;
  page.on("request", (r) => { if (r.url().endsWith("/api/ops") && r.method() === "POST") posts += 1; });
  await sheet.getByLabel("Total du ticket").press("Enter");
  await sheet.getByRole("button", { name: "Fermer" }).click();
  await expect(sheet).toHaveCount(0);
  expect(posts).toBe(0);
  const state = await history(request);
  const other = state.trips.find((t) => t.id === state.shoppingItems.find((l) => l.label === mine)!.tripId)!;
  expect(other).toMatchObject({ place: "autre", totalCents: null });
  expect(state.shoppingItems.find((l) => l.label === theirs)).toMatchObject({ tripId: null, boughtAt: expect.any(String) });
  expect(state.trips.filter((t) => t.id > other.id)).toEqual([]);
  errors();
});

// Regression: 6913337 — trip.record attached every bought line the server held, so a line the other phone ticked after this phone's last refresh went on this receipt
test("a line the other phone ticks unseen while the checkout sheet is open stays in the basket", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const mine = uniq("rutabaga");
  const theirs = uniq("bière");
  await checkoutElsewhere(request, { place: "marche", totalCents: 500, date: parisDate(new Date().toISOString()) }); // empties the basket
  await addAjout(request, mine);
  await addAjout(request, theirs);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, mine).click());
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await expect(sheet.getByText("1 article dans le panier.")).toBeVisible();
  await sheet.getByLabel("Total du ticket").fill("4,80");

  // the other phone ticks its line; no refresh reaches this one before « Valider »
  const line = (await history(request)).shoppingItems.find((l) => l.label === theirs)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
  const recorded = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(recorded.results.map((r) => r.status)).toEqual(["applied"]);
  const state = await history(request);
  const trip = state.trips.find((t) => t.id === state.shoppingItems.find((l) => l.label === mine)!.tripId)!;
  expect(trip).toMatchObject({ totalCents: 480 });
  expect(state.shoppingItems.find((l) => l.label === theirs)).toMatchObject({ tripId: null, boughtAt: expect.any(String) });
  await expect(page.getByRole("region", { name: "Dans le panier" }).getByRole("checkbox", { name: theirs })).toHaveAttribute("aria-checked", "true");

  // leave the basket as it was for the specs after this one
  await checkoutElsewhere(request, { place: "autre", totalCents: 100, date: parisDate(new Date().toISOString()) });
  errors();
});

// Regression: 53acb7f — a phone that stayed in the foreground listed only its own ticks, so a receipt typed at a shared till priced the other phone's lines too, and those needed a second checkout
test("the checkout sheet reads first, so a line the other phone ticked before it opened goes on the same receipt", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const mine = uniq("panais");
  const theirs = uniq("cidre");
  await checkoutElsewhere(request, { place: "marche", totalCents: 500, date: parisDate(new Date().toISOString()) }); // empties the basket
  await addAjout(request, mine);
  await addAjout(request, theirs);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, mine).click());
  // the other phone ticks its line; nothing has refreshed this one since its own tick
  const line = (await history(request)).shoppingItems.find((l) => l.label === theirs)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]);
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await expect(sheet.getByText("2 articles dans le panier.")).toBeVisible();
  await expect(sheet.getByText(mine)).toBeVisible();
  await expect(sheet.getByText(theirs)).toBeVisible();
  await sheet.getByLabel("Total du ticket").fill("9,60");
  const recorded = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  expect(recorded.results.map((r) => r.status)).toEqual(["applied"]);
  const state = await history(request);
  const tripIds = [mine, theirs].map((label) => state.shoppingItems.find((l) => l.label === label)!.tripId);
  expect(tripIds[0]).not.toBeNull();
  expect(tripIds[1]).toBe(tripIds[0]);
  errors();
});

// Regression: 77fdb05 — the browser's own checkbox and radios turned grey-filled in the dark scheme, and a sample « 42,50 » in the empty receipt field read as a typed total
test("in the dark scheme the form controls draw on the page ground, and the receipt field starts empty", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  await page.emulateMedia({ colorScheme: "dark" });
  const ground = "rgb(20, 23, 26)";
  const label = uniq("thé");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await expect(page.getByLabel("Non alimentaire", { exact: true })).toHaveCSS("background-color", ground);
  await opsAnswer(page, () => tick(page, label).click());

  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await expect(sheet.locator('input[type="radio"]:not(:checked)').first()).toHaveCSS("background-color", ground);
  await expect(sheet.getByLabel("Total du ticket")).not.toHaveAttribute("placeholder");
  await sheet.getByRole("button", { name: "Fermer" }).click();
  await expect(sheet).toHaveCount(0);

  // leave the basket as it was for the specs after this one
  await page.getByRole("region", { name: "Dans le panier" }).getByRole("checkbox", { name: label }).click();
  await expect.poll(async () => (await history(request)).shoppingItems.find((l) => l.label === label)?.boughtAt).toBeNull();
  errors();
});

// Regression: ed07859 — a closed sheet left a second #/courses entry, so back first went nowhere
test("closing a sheet with « Fermer », Échap or « Valider » pops its entry: back then leaves Courses", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("sel");
  await addAjout(request, label);
  await page.goto("/#/menu");
  await page.getByRole("link", { name: "Courses" }).click();
  await expect(page).toHaveURL(/#\/courses$/);
  await opsAnswer(page, () => tick(page, label).click());
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });

  await page.getByRole("button", { name: "Passage en caisse" }).click();
  await sheet.getByRole("button", { name: "Fermer" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/#\/courses$/);

  await page.getByRole("button", { name: "Passage en caisse" }).click();
  await expect(sheet).toBeVisible(); // Escape before the dialog opens goes to the page
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/#\/courses$/);

  await page.getByRole("button", { name: "Passage en caisse" }).click();
  await sheet.getByLabel("Total du ticket").fill("2,10"); // a total, so no ticket is left due for the next specs
  await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/#\/courses$/);

  await page.goBack();
  await expect(page).toHaveURL(/#\/menu$/);
  errors();
});
