import type { Tab } from "./format";
import { href, parseRoute, type Route } from "./route";

/**
 * Screens and sheets over a list are hash routes opened as history entries, so the back button
 * closes them. Each entry the app opens records how many such entries lead to it from its list; closing goes back
 * through exactly those, so the back button then leaves the list at once. A route reached with no record (typed, or a
 * link from elsewhere: the entries behind it are not the app's) is replaced instead. The record survives a reload.
 */
const DEPTH = "la-table-depth";

/** How many entries the app opened up to this one: 0 for a list, and for a route it did not open. */
export function depthOf(state: unknown): number {
  const depth = (state as Record<string, unknown> | null)?.[DEPTH];
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * Opens a screen, a sheet or a sheet's step on top of the current route. A route already shown (a double tap) opens no
 * entry, as setting the same hash adds none: counting one would send a later close back past the list.
 */
export function go(route: Route): void {
  const target = href(route);
  if (location.hash === target) return;
  const depth = depthOf(history.state) + 1;
  location.hash = target;
  history.replaceState({ [DEPTH]: depth }, "");
}

/** One step back (a sheet closed, a step left for its sheet), or to `parent` on a route the app did not open. */
export function back(parent: Route): void {
  if (depthOf(history.state) > 0) history.back();
  else location.replace(href(parent));
}

/**
 * Back to the list itself, through every entry the app opened on it: what follows an op sent from a sheet. Those
 * entries may sit on a route the app did not open (a recipe typed or reloaded at depth 0, then its Cuisiné sheet): the
 * entry they lead back to is then replaced by the list, so the screen that sent never shows again.
 */
export function leave(tab: Tab): void {
  const list = href({ tab, path: [] });
  const depth = depthOf(history.state);
  if (depth === 0) {
    location.replace(list);
    return;
  }
  addEventListener("popstate", () => { if (!atList(tab)) location.replace(list); }, { once: true });
  history.go(-depth);
}

function atList(tab: Tab): boolean {
  const route = parseRoute(location.hash);
  return route.tab === tab && route.path.length === 0;
}
