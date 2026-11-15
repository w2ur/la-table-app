import { expect, test as setup } from "@playwright/test";
import { addDays, parisDate } from "../src/domain/dates";
import { postOps } from "./helpers";
import { SEED_PROPOSAL } from "./seed-data";

setup("seed one planning and a few Reste rows, once per database", async ({ request }) => {
  const state = (await (await request.get("/api/state")).json()) as { menu: { pool: unknown[] } };
  if (state.menu.pool.length > 0) return; // a reused server is already seeded
  await postOps(request, [{ type: "planning.commit", payload: SEED_PROPOSAL }]);
  const after = (await (await request.get("/api/state")).json()) as { courses: { lines: { id: number; label: string }[] } };
  const comte = after.courses.lines.find((l) => l.label === "comté");
  expect(comte, "the seed planning lists comté").toBeDefined();
  const today = parisDate(new Date().toISOString());
  await postOps(request, [
    { type: "shopping.buy", payload: { itemId: comte!.id } },
    { type: "stock.add", payload: { label: "yaourt nature", productId: null, qtyText: "4 pots", useBy: addDays(today, 1) } },
    { type: "stock.add", payload: { label: "reste de soupe", productId: null, qtyText: "un bol", useBy: null } },
    { type: "shopping.add", payload: { label: "sacs poubelle", isFood: false } },
    { type: "envie.add", payload: { text: "un curry de lentilles", url: null } },
  ]);
});
