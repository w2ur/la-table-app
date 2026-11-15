import { groupCourseLines, type CourseGroup } from "../domain/course-groups";
import { mealLabels } from "../domain/snapshot";
import type { RemoveReason } from "../domain/types";
import type { Undo } from "./act";
import { routeTarget, type Route } from "./route";
import type { ViewLine } from "./sync/project";

/** One Courses row as the screen draws it: a product's lines on the same side. */
export type Row = CourseGroup<ViewLine>;

/**
 * An untick is the undo of each buy (spec §6.6). A line bought too long ago has no op to undo, and a row is taken back
 * whole or not at all, so it never splits under the tap that showed it as one: null then. Shared by the Courses tick and
 * the checkout sheet's « Pas acheté ».
 */
export function untick(row: Row, undo: Undo): (() => void) | null {
  const opIds = row.lines.flatMap((l) => (l.buyOpId ? [l.buyOpId] : []));
  return opIds.length < row.lines.length ? null : () => { for (const opId of opIds) undo(opId, `Acheté : ${row.head.label}`); };
}

/**
 * A row the checkout sheet pinned when it opened, as the live basket now shows its lines: a buy's undo window may have
 * closed since (the snapshot then gives the line no `buyOpId`), and a line the basket no longer holds has no buy to undo.
 * The row's grouping, label and ids stay the pinned ones.
 */
export function liveRow(row: Row, live: readonly ViewLine[]): Row {
  return { ...row, lines: row.lines.map((l) => live.find((x) => x.id === l.id) ?? { ...l, buyOpId: null }) };
}

/** Whether a line of a pinned row has left the live basket (bought back by an untick, the undo of the buy, or checked out elsewhere): the sheet's « panier a changé » banner says so, which its note on a closed undo window must not. */
export function lineGone(row: Row, live: readonly ViewLine[]): boolean {
  return row.lines.some((l) => !live.some((x) => x.id === l.id));
}

/** Each pinned row's untick (by its head's id) on the live lines (liveRow): null when it can no longer be taken back. */
export type Unticks = ReadonlyMap<number, (() => void) | null>;

/** The unticks of the checkout sheet's pinned rows, read once per render on the live basket: what the sheet shows and sends. */
export function liveUnticks(rows: readonly Row[], live: readonly ViewLine[], undo: Undo): Unticks {
  return new Map(rows.map((row) => [row.head.id, untick(liveRow(row, live), undo)]));
}

/**
 * The checkout sheet's « Pas acheté » rows taken back together, from the unticks the sheet drew them with (liveUnticks):
 * `send` undoes every buy, or, when a row can no longer be taken back (its undo window closed while the sheet was open),
 * `late` names the first such row and nothing is sent.
 */
export function untickAll(rows: readonly Row[], unticks: Unticks): { ok: true; send: () => void } | { ok: false; late: Row } {
  const calls: (() => void)[] = [];
  for (const row of rows) {
    const call = unticks.get(row.head.id) ?? null;
    if (call === null) return { ok: false, late: row };
    calls.push(call);
  }
  return { ok: true, send: () => { for (const call of calls) call(); } };
}

/**
 * The row a removal route (`#/courses/retirer/45`) names among the rows still to buy, null when it names none: a row
 * Courses no longer shows, a route with segments after the id, a line whose creation waits for its answer, an ajout
 * (« Retirer » takes it off at once, so a typed route to one has no question to ask).
 */
export function removalRow(route: Route, toBuy: readonly ViewLine[]): Row | null {
  const target = routeTarget(route, "retirer");
  if (target === null || target.rest.length > 0) return null;
  const row = groupCourseLines(toBuy).find((r) => r.ids.includes(target.id) && !r.lines.some((l) => l.pending));
  return row === undefined || row.head.kind === "ajout" ? null : row;
}

/**
 * The meals the removal will take a share of: those of the row's lines among `opened` (the lines the sheet was drawn with,
 * the ones removalOps removes), from their live data; one name per recipe, « Titre ×2 » for two distinct meals of it, even
 * when they sit on two lines; a snapshot an older build stored has no `mealRefs`, read as none.
 */
export function removalMeals(row: Row, opened: readonly number[]): string[] {
  return mealLabels(row.lines.filter((l) => opened.includes(l.id)).flatMap((l) => l.mealRefs ?? []));
}

/**
 * The removals of the lines a row was drawn with when its sheet opened (`opened`), like a tick buys « the ids the row was
 * drawn with »: a line added to the row since is not removed under a tap that named the row as it was, and one that left
 * it (bought or removed elsewhere) is skipped.
 */
export function removalOps(opened: readonly number[], row: Row, reason: RemoveReason): { type: string; payload: unknown }[] {
  return opened.filter((itemId) => row.ids.includes(itemId)).map((itemId) => ({ type: "shopping.remove", payload: { itemId, reason } }));
}
