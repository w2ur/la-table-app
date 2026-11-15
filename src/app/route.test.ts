import { describe, expect, it } from "vitest";
import { href, itemRoute, mealRoute, parseRoute, removeRoute, routeTarget, type Route } from "./route";

describe("routes", () => {
  it("reads a tab and its path from the hash, Menu by default", () => {
    expect(parseRoute("")).toEqual({ tab: "menu", path: [] });
    expect(parseRoute("#/courses")).toEqual({ tab: "courses", path: [] });
    expect(parseRoute("#courses/caisse")).toEqual({ tab: "courses", path: ["caisse"] });
    expect(parseRoute("#/reste/12/")).toEqual({ tab: "reste", path: ["12"] });
    expect(parseRoute("#/ailleurs")).toEqual({ tab: "menu", path: [] });
    expect(parseRoute("#/menu/%E0")).toEqual({ tab: "menu", path: [] });
  });

  it("writes a route back to the same hash", () => {
    expect(href({ tab: "courses", path: ["caisse"] })).toBe("#/courses/caisse");
    expect(href({ tab: "menu", path: [] })).toBe("#/menu");
    const route: Route = { tab: "reste", path: ["a b", "é"] };
    expect(parseRoute(href(route))).toEqual(route);
  });

  it("names a meal, a Reste item and what opens over them, and reads the id back", () => {
    expect(href(mealRoute(7))).toBe("#/menu/repas/7");
    expect(href(mealRoute(7, "cuisine"))).toBe("#/menu/repas/7/cuisine");
    expect(href(itemRoute(12))).toBe("#/reste/article/12");
    expect(href(itemRoute(12, "fini"))).toBe("#/reste/article/12/fini");
    expect(routeTarget(parseRoute("#/menu/repas/7/cuisine"), "repas")).toEqual({ id: 7, rest: ["cuisine"] });
    expect(routeTarget(parseRoute("#/reste/article/12"), "article")).toEqual({ id: 12, rest: [] });
    expect(routeTarget(parseRoute("#/courses/retirer/45"), "retirer")).toEqual({ id: 45, rest: [] });
    expect(routeTarget(removeRoute(45), "retirer")).toEqual({ id: 45, rest: [] });
    // a row created offline has a negative id and never gets a route; neither does anything that is not a positive id
    for (const hash of ["#/menu", "#/menu/repas", "#/menu/repas/-1", "#/menu/repas/0", "#/menu/repas/07", "#/menu/repas/1.5", "#/menu/repas/abc", "#/menu/article/3"]) {
      expect(routeTarget(parseRoute(hash), "repas"), hash).toBeNull();
    }
  });
});
