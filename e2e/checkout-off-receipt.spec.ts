import { expect, test } from "@playwright/test";
import { addDays, parisDate } from "../src/domain/dates";
import { addAjout, checkoutElsewhere, history, opsAnswer, tick, uniq, watchPageErrors } from "./helpers";
import { PHONE } from "./phone";

test.use(PHONE);

const today = () => parisDate(new Date().toISOString());

/** Three bought lines on no trip, the basket empty before them (every spec shares one database). */
async function basketOfThree(page: import("@playwright/test").Page, request: Parameters<typeof history>[0], stem: string) {
  await checkoutElsewhere(request, { place: "marche", totalCents: 100, date: today() });
  const labels: [string, string, string] = [uniq(`${stem}a`), uniq(`${stem}b`), uniq(`${stem}c`)];
  for (const label of labels) await addAjout(request, label);
  await page.goto("/#/courses");
  for (const label of labels) {
    await opsAnswer(page, () => tick(page, label).click());
    await expect(page.getByRole("region", { name: "Dans le panier" }).getByRole("checkbox", { name: label })).toBeVisible();
  }
  return labels;
}

const lineOf = async (request: Parameters<typeof history>[0], label: string) => (await history(request)).shoppingItems.find((l) => l.label === label)!;
const tripOf = async (request: Parameters<typeof history>[0], label: string) => {
  const state = await history(request);
  return state.trips.find((t) => t.id === state.shoppingItems.find((l) => l.label === label)!.tripId);
};
const rowOf = (sheet: import("@playwright/test").Locator, label: string) => sheet.getByRole("listitem").filter({ has: sheet.page().getByRole("checkbox", { name: label }) });

test("an unchecked row is « Pas acheté » (back on Courses) or « Acheté sans ticket » (a trip of its own, no total asked), and « Annuler » takes both trips back", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [pas, sans, ticket] = await basketOfThree(page, request, "caisse");
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await expect(sheet.getByText("3 articles dans le panier.")).toBeVisible();
  await sheet.getByRole("checkbox", { name: pas }).uncheck();
  // an unchecked row defaults to « Acheté sans ticket »: the non-destructive answer
  await expect(rowOf(sheet, pas).getByLabel("Acheté sans ticket")).toBeChecked();
  await rowOf(sheet, pas).getByLabel("Pas acheté").check();
  await sheet.getByRole("checkbox", { name: sans }).uncheck();
  await expect(rowOf(sheet, sans).getByLabel("Acheté sans ticket")).toBeChecked();
  // the total is left blank: the receipt trip alone asks for it
  const answer = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click(), "trip.record");
  expect(answer.results.every((r) => r.status === "applied")).toBe(true);
  await expect(sheet).toHaveCount(0);

  await expect.poll(async () => (await lineOf(request, pas)).boughtAt).toBeNull();
  expect((await lineOf(request, pas)).tripId).toBeNull();
  await expect(tick(page, pas)).toHaveAttribute("aria-checked", "false");
  expect(await tripOf(request, sans)).toMatchObject({ place: "autre", totalCents: null, noReceipt: true, date: today() });
  expect(await tripOf(request, ticket)).toMatchObject({ totalCents: null, noReceipt: null });
  expect((await lineOf(request, sans)).tripId).not.toBe((await lineOf(request, ticket)).tripId);
  // one « Saisir le total », for the receipt trip: the trip without a receipt hides nothing and asks nothing
  await expect(page.getByText(/sans total\./)).toHaveCount(1);
  await expect(page.getByText(/· Supermarché sans total|· Marché sans total/)).toBeVisible();
  await expect(page.getByText(/· Autre sans total/)).toHaveCount(0);

  await page.locator(".undo-bar").getByRole("button", { name: "Annuler" }).click();
  await expect.poll(async () => (await lineOf(request, sans)).tripId).toBeNull();
  await expect.poll(async () => (await lineOf(request, ticket)).tripId).toBeNull();
  expect((await lineOf(request, sans)).boughtAt).not.toBeNull();
  expect((await lineOf(request, pas)).boughtAt).toBeNull(); // « Annuler » does not re-tick it

  await checkoutElsewhere(request, { place: "autre", totalCents: 100, date: today() });
  errors();
});

test("a receipt total is kept on the checked rows, and the sheet sends the trip with it", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const [pas, sans, ticket] = await basketOfThree(page, request, "total");
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await sheet.getByRole("checkbox", { name: sans }).uncheck();
  await sheet.getByRole("checkbox", { name: pas }).uncheck();
  await rowOf(sheet, pas).getByLabel("Pas acheté").check();
  await sheet.getByLabel("Total du ticket").fill("7,30");
  await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click(), "trip.record");
  await expect.poll(async () => (await tripOf(request, ticket))?.totalCents).toBe(730);
  expect(await tripOf(request, sans)).toMatchObject({ totalCents: null, noReceipt: true });
  await expect(page.getByRole("button", { name: "Saisir le total" })).toHaveCount(0);
  await checkoutElsewhere(request, { place: "autre", totalCents: 100, date: today() });
  errors();
});

test("every row « Pas acheté »: no trip is recorded and the receipt fields are gone", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const labels = await basketOfThree(page, request, "rien");
  const trips = (await history(request)).trips.length;
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await expect(sheet.getByLabel("Total du ticket")).toBeVisible();
  for (const label of labels) {
    await sheet.getByRole("checkbox", { name: label }).uncheck();
    await rowOf(sheet, label).getByLabel("Pas acheté").check();
  }
  await expect(sheet.getByLabel("Total du ticket")).toHaveCount(0);
  await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click());
  await expect(sheet).toHaveCount(0);
  for (const label of labels) await expect.poll(async () => (await lineOf(request, label)).boughtAt).toBeNull();
  expect((await history(request)).trips).toHaveLength(trips);
  for (const label of labels) await expect(tick(page, label)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Passage en caisse" })).toBeDisabled();
  errors();
});

test("a row bought too long ago to be undone cannot be « Pas acheté », and the sheet says why", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  await checkoutElsewhere(request, { place: "marche", totalCents: 100, date: today() });
  const old = uniq("vieux");
  await addAjout(request, old);
  await page.goto("/#/courses");
  await opsAnswer(page, () => tick(page, old).click());
  // the snapshot the phone reads has lost the op that bought it
  await page.route("**/api/state", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { courses: { lines: { label: string; buyOpId: string | null }[] } };
    for (const l of body.courses.lines) if (l.label === old) l.buyOpId = null;
    await route.fulfill({ response: res, json: body });
  });
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await sheet.getByRole("checkbox", { name: old }).uncheck();
  await expect(rowOf(sheet, old).getByLabel("Pas acheté")).toBeDisabled();
  await expect(rowOf(sheet, old).getByLabel("Pas acheté")).toHaveAccessibleDescription(/acheté il y a trop longtemps pour être annulé/);
  await expect(rowOf(sheet, old).getByLabel("Acheté sans ticket")).toBeChecked();
  await expect(sheet.getByText("acheté il y a trop longtemps pour être annulé")).toBeVisible();
  await expect(sheet.getByLabel("Date")).toHaveValue(today());
  await expect(sheet.getByLabel("Total du ticket")).toHaveCount(0);
  await page.unroute("**/api/state");
  // confirmed as it stands: a trip without a receipt for that row, and no undo sent
  const sent: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/ops") && r.method() === "POST") sent.push(r.postData() ?? ""); });
  const answer = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click(), "trip.record");
  expect(answer.results.every((r) => r.status === "applied")).toBe(true);
  await expect(sheet).toHaveCount(0);
  expect(sent.some((body) => body.includes('"type":"undo"'))).toBe(false);
  // no row on the receipt: place and total are hidden, the date (today by default) is what the trip takes
  expect(await tripOf(request, old)).toMatchObject({ place: "autre", totalCents: null, noReceipt: true, date: today() });
  await checkoutElsewhere(request, { place: "autre", totalCents: 100, date: today() });
  errors();
});

test("rows bought without a ticket alone take the date typed, place and total staying hidden", async ({ page, request }) => {
  // Regression: 8cf8a1f — the date field was hidden once no row was on the receipt, so a trip without a ticket was always dated today
  const errors = watchPageErrors(page);
  const rows = await basketOfThree(page, request, "seul");
  const yesterday = addDays(today(), -1);
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  for (const label of rows) await sheet.getByRole("checkbox", { name: label }).uncheck();
  await expect(sheet.getByLabel("Total du ticket")).toHaveCount(0);
  await sheet.getByLabel("Date").fill(yesterday);
  const answer = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click(), "trip.record");
  expect(answer.results.every((r) => r.status === "applied")).toBe(true);
  await expect.poll(async () => (await tripOf(request, rows[0]))?.date).toBe(yesterday);
  expect(await tripOf(request, rows[0])).toMatchObject({ noReceipt: true, totalCents: null });
  await checkoutElsewhere(request, { place: "autre", totalCents: 100, date: today() });
  errors();
});

test("a row bought without a ticket takes the date typed for the receipt", async ({ page, request }) => {
  // Regression: 2b8220d — the trip without a ticket was dated today whatever date the receipt was typed with
  const errors = watchPageErrors(page);
  const [, sans, ticket] = await basketOfThree(page, request, "veille");
  const yesterday = addDays(today(), -1);
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await sheet.getByRole("checkbox", { name: sans }).uncheck();
  await sheet.getByLabel("Date").fill(yesterday);
  const answer = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click(), "trip.record");
  expect(answer.results.every((r) => r.status === "applied")).toBe(true);
  await expect.poll(async () => (await tripOf(request, sans))?.date).toBe(yesterday);
  expect(await tripOf(request, sans)).toMatchObject({ noReceipt: true });
  expect(await tripOf(request, ticket)).toMatchObject({ date: yesterday, noReceipt: null });
  await checkoutElsewhere(request, { place: "autre", totalCents: 100, date: today() });
  errors();
});

test("a total typed, then every row unchecked, stays in sight and is refused until cleared or a row is checked", async ({ page, request }) => {
  // Regression: b42da16 — the total field hid once no row was on the receipt, and « Valider » dropped what it held unseen
  const errors = watchPageErrors(page);
  const rows = await basketOfThree(page, request, "orphelin");
  const trips = (await history(request)).trips.length;
  await page.getByRole("button", { name: "Passage en caisse" }).click();
  const sheet = page.getByRole("dialog", { name: "Passage en caisse" });
  await sheet.getByLabel("Total du ticket").fill("12,50");
  for (const label of rows) await sheet.getByRole("checkbox", { name: label }).uncheck();
  await expect(sheet.getByLabel("Total du ticket")).toHaveValue("12,50");
  await expect(sheet.getByRole("group", { name: "Lieu" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Valider" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Aucune ligne cochée pour ce ticket");
  await expect(sheet).toBeVisible();
  expect((await history(request)).trips).toHaveLength(trips);
  // a row checked again takes the message away; unchecked, the refusal comes back
  await sheet.getByRole("checkbox", { name: rows[0] }).check();
  await expect(sheet.getByRole("alert")).toHaveCount(0);
  await sheet.getByRole("checkbox", { name: rows[0] }).uncheck();
  await sheet.getByRole("button", { name: "Valider" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Aucune ligne cochée pour ce ticket");
  // cleared, the field goes and the rows leave on a trip without a ticket
  await sheet.getByLabel("Total du ticket").fill("");
  await expect(sheet.getByLabel("Total du ticket")).toHaveCount(0);
  const answer = await opsAnswer(page, () => sheet.getByRole("button", { name: "Valider" }).click(), "trip.record");
  expect(answer.results.every((r) => r.status === "applied")).toBe(true);
  expect(await tripOf(request, rows[0])).toMatchObject({ noReceipt: true, totalCents: null });
  await checkoutElsewhere(request, { place: "autre", totalCents: 100, date: today() });
  errors();
});
