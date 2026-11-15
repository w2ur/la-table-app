import { expect, test } from "@playwright/test";
import { qtyText } from "../src/app/format";
import { cheeseProposal, history, plan, postOps, serviceWorkerReady, uniq, watchPageErrors } from "./helpers";

const FIELD = {
  light: { menu: "rgb(232, 163, 23)", courses: "rgb(47, 125, 79)", reste: "rgb(194, 59, 34)" },
  dark: { menu: "rgb(200, 138, 10)", courses: "rgb(43, 110, 71)", reste: "rgb(178, 58, 36)" },
} as const;
const TITLES = [["menu", "Menu"], ["courses", "Courses"], ["reste", "Reste"]] as const;

test("each list fills the field with its own colour in both schemes, and shows its count and sections", async ({ page }) => {
  const errors = watchPageErrors(page);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [tab, title] of TITLES) {
      await page.goto(`/#/${tab}`);
      const field = page.locator("header.field");
      await expect(field.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(field).toHaveCSS("background-color", FIELD[scheme][tab]);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/menu");
  await expect(page.locator("header.field p")).toHaveText(/^\d+ repas à cuisiner$/);
  await expect(page.getByText("Curry de pois chiches aux épinards")).toBeVisible();

  await page.getByRole("link", { name: "Courses" }).click();
  await expect(page).toHaveURL(/#\/courses$/);
  await expect(page.locator("header.field p")).toHaveText(/^(\d+ à acheter|rien à acheter)$/);
  for (const group of ["Fruits et légumes", "Épicerie", "Surgelés", "Ajouts"]) await expect(page.getByRole("heading", { name: group })).toBeVisible();
  await expect(page.getByText(/^Total estimé \d/)).toBeVisible();

  await page.getByRole("link", { name: "Reste" }).click();
  for (const section of ["À utiliser vite", "Réservé", "Libre"]) await expect(page.getByRole("heading", { name: section })).toBeVisible();
  await expect(page.getByText("80 g pour Colin gratiné au comté et haricots verts")).toBeVisible();
  await expect(page.getByRole("link", { name: "William" })).toHaveAttribute("href", "https://william.revah.paris");
  errors();
});

// Regression: 2026-10-14 replacement planning — a product on two Courses lines showed on two rows
test("a product on two lines shows as one row; its tick buys both, « Annuler » takes both back, and an offline tick sends both", async ({ page, context, request }) => {
  const errors = watchPageErrors(page);
  // two comté lines for one product: the bought 200 g finished with « Racheter » puts back one line per meal holding it
  const meals = await plan(request, cheeseProposal(uniq("regroupé")));
  const bought = (await history(request)).shoppingItems.find((l) => l.label === "comté" && l.qty === 200 && l.boughtAt === null)!;
  await postOps(request, [{ type: "shopping.buy", payload: { itemId: bought.id } }]);
  const item = (await history(request)).stockItems.find((i) => i.sourceShoppingItemId === bought.id && i.finishedAt === null)!;
  await postOps(request, [{ type: "stock.finish", payload: { itemId: item.id, resolution: "rebuy" } }]);
  const open = async () => (await history(request)).shoppingItems.filter((l) => l.label === "comté" && l.boughtAt === null && l.removedAt === null);
  const lines = await open();
  expect(lines.length).toBeGreaterThanOrEqual(2);
  const total = lines.reduce((n, l) => n + l.qty!, 0);

  await page.goto("/#/courses");
  const toBuy = page.getByRole("region", { name: "Crèmerie" }).getByRole("checkbox", { name: /^comté / });
  await expect(toBuy).toHaveCount(1);
  await expect(toBuy).toHaveAccessibleName(new RegExp(`^comté ${qtyText(total, "g")}`));
  await toBuy.click();
  await expect(page.getByRole("region", { name: "Dans le panier" }).getByRole("checkbox", { name: /^comté / })).toHaveCount(1);
  await expect.poll(async () => (await open()).length).toBe(0);

  await page.getByRole("status").getByRole("button", { name: "Annuler" }).click();
  await expect(toBuy).toHaveCount(1);
  await expect.poll(async () => (await open()).map((l) => l.id).sort()).toEqual(lines.map((l) => l.id).sort());

  // offline: the one tap waits as its buys, and both reach the server once back online
  await serviceWorkerReady(page);
  await context.setOffline(true);
  await toBuy.click();
  await expect(page.getByText(`Hors ligne · ${lines.length} actions en attente`)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText(/en attente/)).toHaveCount(0);
  await expect.poll(async () => (await open()).length).toBe(0);
  await postOps(request, meals.map((m) => ({ type: "meal.drop", payload: { mealId: m.id } })));
  errors();
});
