import { afterEach, describe, expect, it, vi } from "vitest";
import { depthOf, go, leave } from "./nav";
import { mealRoute } from "./route";

describe("depthOf", () => {
  it("reads how many entries the app opened up to this one, and 0 for any state it did not write", () => {
    expect(depthOf({ "la-table-depth": 2 })).toBe(2);
    expect(depthOf({ "la-table-depth": 1, other: true })).toBe(1);
    for (const state of [null, undefined, "x", {}, { "la-table-depth": 0 }, { "la-table-depth": -1 }, { "la-table-depth": 1.5 }, { "la-table-depth": "2" }, { "la-table-sheet": true }]) {
      expect(depthOf(state), JSON.stringify(state)).toBe(0);
    }
  });
});

/** A session history of hash entries: `go` traverses and fires popstate later, as a browser does. */
function fakeBrowser(firstHash: string) {
  const window = new EventTarget();
  const entries: { hash: string; state: unknown }[] = [{ hash: firstHash, state: null }];
  let index = 0;
  const location = {
    get hash() { return entries[index]!.hash; },
    // as a browser: the hash already shown adds no entry
    set hash(hash: string) { if (hash !== entries[index]!.hash) { entries.splice(index + 1, Infinity, { hash, state: null }); index += 1; } },
    replace(url: string) { entries[index] = { hash: url, state: null }; },
  };
  const history = {
    get state() { return entries[index]!.state; },
    replaceState(state: unknown) { entries[index]!.state = state; },
    go(delta: number) { index += delta; setTimeout(() => window.dispatchEvent(new Event("popstate"))); },
  };
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", history);
  vi.stubGlobal("addEventListener", window.addEventListener.bind(window));
  return { entries: () => entries.map((e) => e.hash), index: () => index };
}

describe("leave", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("goes back through the entries the app opened, to the list it opened them from", async () => {
    const browser = fakeBrowser("#/menu");
    go(mealRoute(7));
    go(mealRoute(7, "cuisine"));
    leave("menu");
    await new Promise((resolve) => setTimeout(resolve));
    expect(browser.index()).toBe(0);
    expect(browser.entries()[0]).toBe("#/menu");
  });

  // Regression: 9e46f3e — a recipe typed or reloaded at depth 0, then its Cuisiné sheet: « Valider » went back one entry,
  // onto the recipe that had sent, which then showed nothing until a tab was tapped
  it("replaces with the list an entry it lands on that the app did not open", async () => {
    const browser = fakeBrowser("#/menu/repas/7");
    go(mealRoute(7, "cuisine"));
    leave("menu");
    await new Promise((resolve) => setTimeout(resolve));
    expect(browser.index()).toBe(0);
    expect(browser.entries()[0]).toBe("#/menu");
  });

  // Regression: 73189fd — a double tap opened the route once but counted two entries, so leaving went back past the list
  it("opens no entry for the route already shown, so a double tap still leaves onto the list", async () => {
    const browser = fakeBrowser("#/menu");
    go(mealRoute(7));
    go(mealRoute(7));
    expect(browser.entries()).toEqual(["#/menu", "#/menu/repas/7"]);
    go(mealRoute(7, "cuisine"));
    go(mealRoute(7, "cuisine"));
    leave("menu");
    await new Promise((resolve) => setTimeout(resolve));
    expect(browser.index()).toBe(0);
    expect(browser.entries()[0]).toBe("#/menu");
  });

  it("replaces a route the app did not open with the list, on the spot", () => {
    const browser = fakeBrowser("#/reste/article/3");
    leave("reste");
    expect(browser.entries()).toEqual(["#/reste"]);
  });
});
