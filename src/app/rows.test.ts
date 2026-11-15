import { describe, expect, it } from "vitest";
import { groupCourseLines } from "../domain/course-groups";
import type { Route } from "./route";
import { liveUnticks, lineGone, removalMeals, removalOps, removalRow, untick, untickAll } from "./rows";
import type { ViewLine } from "./sync/project";

const line = (id: number, over: Partial<ViewLine> = {}): ViewLine => ({
  id, label: "comté", qty: 100, unit: "g", estPriceCents: 400, kind: "planning", group: "cremerie", isFood: true,
  boughtAt: null, buyOpId: null, mealRefs: [], pending: false, ...over,
});
const route = (...path: string[]): Route => ({ tab: "courses", path });

describe("removalRow", () => {
  const toBuy = [line(3), line(5)];

  it("names the row holding the line of the route", () => {
    expect(removalRow(route("retirer", "5"), toBuy)?.ids).toEqual([3, 5]);
  });

  it("names no row for a line Courses no longer shows, a missing id, or a line still waiting for its answer", () => {
    expect(removalRow(route("retirer", "9"), toBuy)).toBeNull();
    expect(removalRow(route("retirer"), toBuy)).toBeNull();
    expect(removalRow(route("retirer", "3"), [line(3, { pending: true })])).toBeNull();
  });

  it("names no row for an ajout, which « Retirer » takes off at once with no question", () => {
    // Regression: ba58f1e — a typed #/courses/retirer/<ajout id> opened the planned line's question on an ajout
    const ajout = line(7, { label: "sel", kind: "ajout", group: "ajouts", qty: null, unit: null, estPriceCents: null });
    expect(removalRow(route("retirer", "7"), [...toBuy, ajout])).toBeNull();
    expect(removalRow(route("retirer", "3"), [...toBuy, ajout])?.ids).toEqual([3, 5]);
  });

  it("leaves a route with segments after the id to Courses, as a missing target does", () => {
    // Regression: 26bb1a9 — #/courses/retirer/3/x showed no sheet and did not leave, a blank route
    expect(removalRow(route("retirer", "3", "x"), toBuy)).toBeNull();
  });
});

describe("removalMeals", () => {
  it("lists each meal once across the row's lines", () => {
    const gratin = { id: 1, recipeId: 10, title: "Gratin" };
    const salade = { id: 2, recipeId: 20, title: "Salade" };
    const row = groupCourseLines([line(3, { mealRefs: [gratin, salade] }), line(5, { mealRefs: [salade] })])[0]!;
    expect(removalMeals(row, [3, 5])).toEqual(["Gratin", "Salade"]);
  });

  it("counts two distinct meals of one recipe across two lines, « ×2 », and one meal on two lines once", () => {
    // Regression: 9a12476 — the row joined its lines' names, so a recipe planned twice on two lines was named once
    const two = groupCourseLines([line(3, { mealRefs: [{ id: 1, recipeId: 10, title: "Gratin" }] }), line(5, { mealRefs: [{ id: 9, recipeId: 10, title: "Gratin" }] })])[0]!;
    expect(removalMeals(two, [3, 5])).toEqual(["Gratin ×2"]);
    const same = groupCourseLines([line(3, { mealRefs: [{ id: 1, recipeId: 10, title: "Gratin" }] }), line(5, { mealRefs: [{ id: 1, recipeId: 10, title: "Gratin" }] })])[0]!;
    expect(removalMeals(same, [3, 5])).toEqual(["Gratin"]);
  });

  it("lists two recipes that share a title separately, not as « ×2 »", () => {
    // Regression: 02b8fc1 — meals were counted per title, so two different recipes both titled « Gratin » read as one recipe planned twice
    const row = groupCourseLines([line(3, { mealRefs: [{ id: 1, recipeId: 10, title: "Gratin" }, { id: 2, recipeId: 11, title: "Gratin" }] })])[0]!;
    expect(removalMeals(row, [3])).toEqual(["Gratin", "Gratin"]);
  });

  it("names only the meals of the lines pinned when the sheet opened", () => {
    // Regression: 18f3edb — the sheet named the meals of a line added to the row since it opened, which the tap does not remove
    const row = groupCourseLines([line(3, { mealRefs: [{ id: 1, recipeId: 10, title: "Gratin" }] }), line(5, { mealRefs: [{ id: 2, recipeId: 20, title: "Salade" }] })])[0]!;
    expect(removalMeals(row, [3])).toEqual(["Gratin"]);
    expect(removalMeals(row, [3, 99])).toEqual(["Gratin"]);
    expect(removalMeals(row, [])).toEqual([]);
  });

  it("reads a line without meals, as an older cached snapshot has it, as none", () => {
    // Regression: 26bb1a9 — a CourseLine cached by an older build has no `meals`
    const old = { ...line(3) } as Partial<ViewLine>;
    delete old.mealRefs;
    expect(removalMeals(groupCourseLines([old as ViewLine])[0]!, [3])).toEqual([]);
  });
});

describe("removalOps", () => {
  it("removes the ids the row was drawn with when the sheet opened, skipping those that left and not adding those that joined", () => {
    // Regression: 26bb1a9 — the sheet removed the live row, not the lines it was opened on
    const now = groupCourseLines([line(5), line(7)])[0]!;
    expect(removalOps([3, 5], now, "pas_achete")).toEqual([{ type: "shopping.remove", payload: { itemId: 5, reason: "pas_achete" } }]);
  });
});

describe("untick", () => {
  it("undoes each buy of a row, labelled with the row", () => {
    const sent: [string, string][] = [];
    const row = groupCourseLines([line(3, { boughtAt: "t", buyOpId: "a" }), line(5, { boughtAt: "t", buyOpId: "b" })])[0]!;
    untick(row, (opId, label) => sent.push([opId, label]))!();
    expect(sent).toEqual([["a", "Acheté : comté"], ["b", "Acheté : comté"]]);
  });

  it("takes a row back whole or not at all", () => {
    const row = groupCourseLines([line(3, { boughtAt: "t", buyOpId: "a" }), line(5, { boughtAt: "t", buyOpId: null })])[0]!;
    expect(untick(row, () => { throw new Error("no undo expected"); })).toBeNull();
  });
});

describe("untickAll", () => {
  // Regression: af2a7c7 — the checkout sheet's « Pas acheté » called each row's untick with a non-null assertion, so a row whose undo window closed while the sheet was open threw after part of the checkout was sent
  it("names the first row that can no longer be taken back, and sends nothing", () => {
    const sent: string[] = [];
    const lines = [line(3, { boughtAt: "t", buyOpId: "a" }), line(5, { label: "pain", group: "epicerie", boughtAt: "t", buyOpId: null })];
    const rows = groupCourseLines(lines);
    const all = untickAll(rows, liveUnticks(rows, lines, (opId) => sent.push(opId)));
    expect(all).toMatchObject({ ok: false, late: { head: { id: 5, label: "pain" } } });
    expect(sent).toEqual([]);
  });

  it("takes every row back only when called, each buy once", () => {
    const sent: string[] = [];
    const lines = [line(3, { boughtAt: "t", buyOpId: "a" }), line(5, { label: "pain", group: "epicerie", boughtAt: "t", buyOpId: "b" })];
    const rows = groupCourseLines(lines);
    const all = untickAll(rows, liveUnticks(rows, lines, (opId) => sent.push(opId)));
    expect(sent).toEqual([]);
    if (!all.ok) throw new Error("every row can be taken back");
    all.send();
    expect(sent.sort()).toEqual(["a", "b"]);
  });

  it("is ok with no row to take back", () => {
    expect(untickAll([], new Map())).toMatchObject({ ok: true });
  });

  // Regression: eb23066 — the checkout sheet read each row's buy from the basket it pinned on opening, so a buy whose undo window closed while the sheet was open was still undone, the « trop longtemps » guard never firing
  it("reads each pinned row's buy on the live basket, not the pinned one", () => {
    const sent: string[] = [];
    const pinned = groupCourseLines([line(3, { boughtAt: "t", buyOpId: "a" }), line(5, { label: "pain", group: "epicerie", boughtAt: "t", buyOpId: "b" })]);
    // a refresh landed while the sheet was open: the pain's undo window has closed
    const live = [line(3, { boughtAt: "t", buyOpId: "a" }), line(5, { label: "pain", group: "epicerie", boughtAt: "t", buyOpId: null })];
    const unticks = liveUnticks(pinned, live, (opId) => sent.push(opId));
    expect(untickAll(pinned, unticks)).toMatchObject({ ok: false, late: { head: { id: 5, label: "pain" } } });
    expect(unticks.get(5)).toBeNull();
    expect(unticks.get(3)).not.toBeNull();
    expect(sent).toEqual([]);
  });

  it("cannot take back a pinned row whose line the live basket no longer holds", () => {
    const pinned = groupCourseLines([line(3, { boughtAt: "t", buyOpId: "a" })]);
    expect(liveUnticks(pinned, [], () => { throw new Error("no undo expected"); }).get(3)).toBeNull();
  });
});

describe("lineGone", () => {
  // Regression: 69a399d — the checkout sheet told a row whose line had left the live basket that it was « acheté il y a trop longtemps pour être annulé », which is not why it cannot be taken back
  it("tells a pinned row a line of which left the live basket from one whose undo window closed", () => {
    const pinned = groupCourseLines([line(3, { boughtAt: "t", buyOpId: "a" }), line(5, { label: "pain", group: "epicerie", boughtAt: "t", buyOpId: "b" })]);
    const window = [line(3, { boughtAt: "t", buyOpId: "a" }), line(5, { label: "pain", group: "epicerie", boughtAt: "t", buyOpId: null })];
    expect(lineGone(pinned[1]!, window)).toBe(false);
    expect(lineGone(pinned[1]!, window.slice(0, 1))).toBe(true);
    expect(lineGone(pinned[0]!, window)).toBe(false);
  });
});
