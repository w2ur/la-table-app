import { expect, test } from "@playwright/test";
import { addAjout, history, postOps, tick, uniq, watchPageErrors } from "./helpers";
import { PHONE } from "./phone";

test.use(PHONE);

const boughtAt = async (request: Parameters<typeof history>[0], label: string) =>
  (await history(request)).shoppingItems.find((l) => l.label === label)?.boughtAt;

test("« Annuler » within 5 s puts the line back unticked, here and on the server", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("riz");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await tick(page, label).click();
  await expect(tick(page, label)).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Annuler" }).click();
  await expect(tick(page, label)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Annuler" })).toHaveCount(0);
  await expect.poll(() => boughtAt(request, label)).toBeNull();
  errors();
});

test("tapping a line under « Dans le panier » unticks it on the server", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("oignon");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await tick(page, label).click();
  await expect.poll(() => boughtAt(request, label)).not.toBeNull();
  await expect(page.getByRole("button", { name: "Annuler" })).toHaveCount(0, { timeout: 8000 });
  await page.getByRole("region", { name: "Dans le panier" }).getByRole("checkbox", { name: label }).click();
  await expect(tick(page, label)).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => boughtAt(request, label)).toBeNull();
  errors();
});

// Regression: 3780f97 — unticking another line under « Dans le panier » took away the « Annuler » bar of the last tick
test("unticking another line keeps the « Annuler » bar of the last tick, which still undoes it", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const earlier = uniq("ail");
  const last = uniq("échalote");
  await addAjout(request, earlier);
  await addAjout(request, last);
  const line = (await history(request)).shoppingItems.find((l) => l.label === earlier)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: line.id } }]); // the other phone ticked it
  await page.goto("/#/courses");
  await tick(page, last).click();
  const bar = page.getByRole("status").filter({ hasText: `Acheté : ${last}` });
  await expect(bar).toBeVisible();
  await page.getByRole("region", { name: "Dans le panier" }).getByRole("checkbox", { name: earlier }).click();
  await expect(tick(page, earlier)).toHaveAttribute("aria-checked", "false");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Annuler" }).click();
  await expect(tick(page, last)).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => boughtAt(request, last)).toBeNull();
  await expect.poll(() => boughtAt(request, earlier)).toBeNull();
  errors();
});

// Regression: 0da4dc9 — the undo bar covered the last row and had a rounded corner
test("the undo bar never covers the last row, and is square", async ({ page, request }) => {
  const label = uniq("sel");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await tick(page, label).click();
  const bar = page.locator(".undo-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveCSS("border-radius", "0px");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const last = await page.locator("footer").boundingBox();
  const barBox = await bar.boundingBox();
  expect(last!.y + last!.height).toBeLessThanOrEqual(barBox!.y + 0.5);
});

// Regression: 0da4dc9 — theme-color stayed on the other scheme's colour after a scheme change
test("the browser bar colour follows a scheme change while the app is open", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/courses");
  const metas = () => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content")));
  await expect.poll(metas).toEqual(["#2f7d4f", "#2f7d4f"]);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(metas).toEqual(["#2b6e47", "#2b6e47"]);
});
