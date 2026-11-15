import { expect, test } from "@playwright/test";

test("the e2e server answers on a fresh, seeded database and serves the shell and the service worker", async ({ request }) => {
  expect((await request.get("/api/health")).status()).toBe(200);
  const state = (await (await request.get("/api/state")).json()) as { menu: { pool: { title: string }[] } };
  expect(state.menu.pool.map((m) => m.title)).toEqual(
    expect.arrayContaining(["Curry de pois chiches aux épinards", "Colin gratiné au comté et haricots verts"]),
  );
  const shell = await request.get("/");
  expect(shell.headers()["content-type"]).toContain("text/html");
  const worker = await request.get("/sw.js");
  expect(worker.status()).toBe(200);
  expect(await worker.text()).toContain("/assets/");
});

// Regression: 9a83154 — the Archivo import brought its latin-ext and vietnamese faces into the build and the precache, though French needs neither
test("the service worker precaches the Latin Archivo face and no other subset, and the page draws with it", async ({ page, request }) => {
  const worker = await (await request.get("/sw.js")).text();
  const fonts = [...worker.matchAll(/\/assets\/[^"'\s]+\.woff2/g)].map((m) => m[0]);
  expect(fonts).toEqual([expect.stringMatching(/^\/assets\/archivo-latin-wdth-normal-[\w-]+\.woff2$/)]);
  await page.goto("/#/courses");
  await expect(page.getByRole("heading", { name: "Courses" })).toBeVisible();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
  });
  expect(loaded).toContain("Archivo Variable");
});
