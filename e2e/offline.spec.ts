import { expect, test } from "@playwright/test";
import { addAjout, history, serviceWorkerReady, tick, uniq, watchPageErrors } from "./helpers";

test("a tick made offline survives a reload and reaches the server once back online", async ({ page, context, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("lait");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await serviceWorkerReady(page);
  await expect(tick(page, label)).toHaveAttribute("aria-checked", "false");

  await context.setOffline(true);
  await tick(page, label).click();
  await expect(tick(page, label)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Hors ligne · 1 action en attente")).toBeVisible();

  await page.reload(); // served by the service worker; the tick comes back from IndexedDB
  await expect(tick(page, label)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Hors ligne · 1 action en attente")).toBeVisible();

  // a row created offline has no server id yet, so it cannot be ticked
  const offlineLabel = uniq("sel");
  await page.getByLabel("Nouvel article").fill(offlineLabel);
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(tick(page, offlineLabel)).toBeDisabled();
  await expect(page.getByText("Hors ligne · 2 actions en attente")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText(/en attente/)).toHaveCount(0);
  await expect(tick(page, offlineLabel)).toBeEnabled();
  const state = await history(request);
  expect(state.shoppingItems.find((l) => l.label === label)?.boughtAt).not.toBeNull();
  expect(state.shoppingItems.filter((l) => l.label === offlineLabel)).toHaveLength(1);
  errors();
});

// Regression: ed48e5f — an IndexedDB that opened but refused its first read left the page blank and the service worker unregistered
test("an IndexedDB that cannot be read still opens the app on memory and registers the service worker", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    IDBObjectStore.prototype.get = () => {
      throw new DOMException("Connection to Indexed Database server lost. Refresh the page to try again", "UnknownError");
    };
  });
  await page.goto("/#/courses");
  await expect(page.getByText("Stockage local indisponible : une action faite hors ligne est perdue si l'app se ferme.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ajouter", exact: true })).toBeVisible(); // the list came from the network
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration()) !== undefined);
  errors();
});
