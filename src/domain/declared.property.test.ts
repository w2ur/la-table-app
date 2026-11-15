import fc from "fast-check";
import { describe, it } from "vitest";
import { parseDeclaredQty } from "./declared";
import { formatAmount, type Unit } from "./units";

describe("parseDeclaredQty properties", () => {
  it("reads back what formatAmount prints, for any unit", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.constantFrom<Unit>("g", "ml", "piece"), (q, unit) => {
        return parseDeclaredQty(formatAmount(q, unit), unit) === q;
      }),
      { numRuns: 1000 },
    );
  });
});
