import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seedSql } from "./gen-seed-sql";

describe("0002_seed_products.sql", () => {
  it("matches what products.seed.json generates (run `npm run seed:sql` after editing the seed)", () => {
    const committed = readFileSync(new URL("../migrations/0002_seed_products.sql", import.meta.url), "utf8");
    expect(committed).toBe(seedSql());
  });
});
