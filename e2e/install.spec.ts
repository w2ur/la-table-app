import { expect, test } from "@playwright/test";
import { readPng } from "../scripts/icons";

test("the home-screen icons are served as PNGs of their declared size, linked from the page and the manifest", async ({ page, request }) => {
  await page.goto("/#/menu");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");
  // Regression: 22681c8 — Chrome fetched the manifest without the Access cookie, so behind Access it read the login page
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("crossorigin", "use-credentials");
  const manifest = (await (await request.get("/manifest.webmanifest")).json()) as { icons: { src: string; sizes: string }[] };
  const icons = [{ src: "/apple-touch-icon.png", sizes: "180x180" }, ...manifest.icons];
  expect(icons.map((i) => i.src)).toEqual(["/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-512.png"]);
  for (const icon of icons) {
    const res = await request.get(icon.src);
    expect(res.headers()["content-type"]).toContain("image/png");
    const png = readPng(await res.body());
    expect(`${png.width}x${png.height}`).toBe(icon.sizes);
  }
});
