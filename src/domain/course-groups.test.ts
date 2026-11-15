import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { groupCourseLines } from "./course-groups";
import type { CourseLine } from "./snapshot";

const line = (over: Partial<CourseLine>): CourseLine => ({
  id: 1, label: "citron", qty: 1, unit: "piece", estPriceCents: 50, kind: "planning", group: "fruits-legumes",
  isFood: true, boughtAt: null, buyOpId: null, mealRefs: [], ...over,
});

describe("groupCourseLines", () => {
  it("joins the lines of one product, unit and kind into one row, summing quantity and price", () => {
    // Regression: 2026-10-14 replacement planning — citron, gingembre, coriandre and crème fraîche showed twice in Courses
    const groups = groupCourseLines([line({ id: 7 }), line({ id: 3, label: "carotte", qty: 200, unit: "g" }), line({ id: 45, label: "Citron" })]);
    expect(groups.map((g) => [g.head.label, g.ids, g.qty, g.estPriceCents])).toEqual([["citron", [7, 45], 2, 100], ["carotte", [3], 200, 50]]);
  });

  it("keeps apart another unit, another kind, an ajout, and a bought line from an unbought one", () => {
    const groups = groupCourseLines([
      line({ id: 1 }), line({ id: 2, unit: "g", qty: 100 }), line({ id: 3, kind: "staple_hors_budget" }),
      line({ id: 4, kind: "ajout", qty: null, unit: null }), line({ id: 5, kind: "ajout", qty: null, unit: null }),
      line({ id: 6, boughtAt: "2026-10-14T09:00:00Z" }),
    ]);
    expect(groups.map((g) => g.ids)).toEqual([[1], [2], [3], [4], [5], [6]]);
  });

  it("sums the prices it knows, as the Courses total does, and is unknown only when no line has one", () => {
    // Regression: review of the grouping — one unpriced rebuy hid a known 0,50 € the total still counted
    expect(groupCourseLines([line({ id: 1 }), line({ id: 2, estPriceCents: null })])[0]!.estPriceCents).toBe(50);
    expect(groupCourseLines([line({ id: 1, estPriceCents: null }), line({ id: 2, estPriceCents: null })])[0]!.estPriceCents).toBeNull();
  });

  it("keeps apart two lines of one name in two aisles, as the screen draws them", () => {
    // Regression: review of the grouping — the header counted one row where Courses drew two
    expect(groupCourseLines([line({ id: 1 }), line({ id: 2, group: "surgeles" })]).map((g) => g.ids)).toEqual([[1], [2]]);
  });

  it("puts every line in exactly one row and keeps Σ quantity and Σ priced cents", () => {
    const arb = fc.uniqueArray(fc.record({
      id: fc.integer({ min: 1, max: 60 }), label: fc.constantFrom("citron", "Citron", "gingembre"), unit: fc.constantFrom("g", "piece") as fc.Arbitrary<CourseLine["unit"]>,
      kind: fc.constantFrom("planning", "staple_hors_budget", "ajout") as fc.Arbitrary<CourseLine["kind"]>, qty: fc.integer({ min: 1, max: 500 }),
      estPriceCents: fc.integer({ min: 0, max: 900 }), bought: fc.boolean(),
    }), { selector: (l) => l.id, maxLength: 20 });
    fc.assert(fc.property(arb, (raw) => {
      const lines = raw.map((r) => line({ ...r, boughtAt: r.bought ? "2026-10-14T09:00:00Z" : null }));
      const groups = groupCourseLines(lines);
      expect(groups.flatMap((g) => g.ids).sort((a, b) => a - b)).toEqual(lines.map((l) => l.id).sort((a, b) => a - b));
      expect(groups.reduce((n, g) => n + g.qty!, 0)).toBe(lines.reduce((n, l) => n + l.qty!, 0));
      expect(groups.reduce((n, g) => n + g.estPriceCents!, 0)).toBe(lines.reduce((n, l) => n + l.estPriceCents!, 0));
      for (const g of groups) expect(new Set(g.lines.map((l) => [l.unit, l.kind, l.boughtAt === null].join())).size).toBe(1);
    }));
  });
});
