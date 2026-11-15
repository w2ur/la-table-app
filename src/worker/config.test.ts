import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wrangler.jsonc", () => {
  it("never ships the Access bypass", () => {
    const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    expect(text).not.toMatch(/DEV_SKIP_ACCESS/);
  });
});
