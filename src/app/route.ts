import { TABS, type Tab } from "./format";

/** A screen: its tab, then a path inside it (a sheet: `#/courses/caisse`). Hash routes, so the back button closes a sheet. */
export interface Route {
  tab: Tab;
  path: string[];
}

const HOME: Route = { tab: "menu", path: [] };

export function parseRoute(hash: string): Route {
  let parts: string[];
  try {
    parts = hash.replace(/^#\/?/, "").split("/").filter((p) => p !== "").map(decodeURIComponent);
  } catch {
    return HOME; // a malformed escape in a hand-typed URL
  }
  const [first, ...path] = parts;
  return (TABS as readonly string[]).includes(first ?? "") ? { tab: first as Tab, path } : HOME;
}

export function href(route: Route): string {
  return `#/${[route.tab, ...route.path.map(encodeURIComponent)].join("/")}`;
}

/** What opens over a meal: its Cuisiné sheet (spec §10.1). */
export type MealSheet = "cuisine";
/** The steps of a Reste item's sheet (spec §10.3, §10.4): Il en reste, Changer la date, the reservation warning. */
export type ItemStep = "reste" | "date" | "fini";

/** `#/menu/repas/7`, the recipe view, or its Cuisiné sheet `#/menu/repas/7/cuisine`. */
export function mealRoute(mealId: number, sheet?: MealSheet): Route {
  return { tab: "menu", path: ["repas", String(mealId), ...(sheet ? [sheet] : [])] };
}

/** `#/reste/article/12`, a Reste item's sheet, or one of its steps (`#/reste/article/12/date`). */
export function itemRoute(itemId: number, step?: ItemStep): Route {
  return { tab: "reste", path: ["article", String(itemId), ...(step ? [step] : [])] };
}

/** `#/courses/retirer/45`, the removal sheet of the Courses row whose first line is 45. */
export function removeRoute(lineId: number): Route {
  return { tab: "courses", path: ["retirer", String(lineId)] };
}

/** The row a route names after `kind` (`#/menu/repas/7` → 7) and what follows it; null when it names no positive id. */
export function routeTarget(route: Route, kind: "repas" | "article" | "retirer"): { id: number; rest: string[] } | null {
  const [first, id, ...rest] = route.path;
  if (first !== kind || id === undefined || !/^[1-9]\d{0,8}$/.test(id)) return null;
  return { id: Number(id), rest };
}
