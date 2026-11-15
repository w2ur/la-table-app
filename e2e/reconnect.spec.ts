import { expect, test } from "@playwright/test";
import { addAjout, history, opsAnswer, tick, uniq, watchPageErrors } from "./helpers";

// page.route does not see requests a service worker handles; this flow needs no worker
test.use({ serviceWorkers: "block" });

test("an Access redirect shows « Reconnexion nécessaire », keeps the tick, and sends it after « Se reconnecter »", async ({ page, request }) => {
  const errors = watchPageErrors(page);
  const label = uniq("farine");
  await addAjout(request, label);
  await page.goto("/#/courses");
  await expect(tick(page, label)).toBeVisible();

  await page.route("**/api/ops", (route) => route.fulfill({ status: 302, headers: { location: "https://example.cloudflareaccess.com/cdn-cgi/access/login/table" } }));
  await tick(page, label).click();
  await expect(page.getByText("Reconnexion nécessaire · 1 action en attente")).toBeVisible();
  expect((await history(request)).shoppingItems.find((l) => l.label === label)?.boughtAt).toBeNull();

  await page.unroute("**/api/ops");
  // wait for the resend itself: « en attente » is also absent while the reloaded page starts, and whenever it is online
  const resent = await opsAnswer(page, () => page.getByRole("button", { name: "Se reconnecter" }).click());
  expect(resent.results.map((r) => r.status)).toEqual(["applied"]);
  await expect(page).toHaveURL(/\/#\/courses$/); // the marker is gone from the address bar
  await expect(tick(page, label)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/en attente/)).toHaveCount(0);
  expect((await history(request)).shoppingItems.find((l) => l.label === label)?.boughtAt).not.toBeNull();
  errors();
});
