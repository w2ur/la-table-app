import type { CourseLine } from "./snapshot";
import { normalizeName } from "./text";

/**
 * One Courses row: the lines of one product, unit and kind on the same side (to buy, or in the basket), as plannings
 * left them each on its own line. Data keeps one line per planning (a buy writes one row, a drop prices its own share);
 * only the display joins them. A tick buys the `ids` the row was drawn with, so a line added later stays on the list.
 */
export interface CourseGroup<L extends CourseLine = CourseLine> {
  /** the first line, lowest id: label, unit, kind, group and isFood of the row */
  head: L;
  lines: L[];
  ids: number[];
  qty: number | null;
  estPriceCents: number | null;
}

const key = (l: CourseLine): string | null =>
  l.kind === "ajout" ? null : JSON.stringify([normalizeName(l.label), l.unit, l.kind, l.group, l.boughtAt === null]);

/** Rows in the order of each group's first line; ajouts and any line without a key stay alone. */
export function groupCourseLines<L extends CourseLine>(lines: readonly L[]): CourseGroup<L>[] {
  const groups: CourseGroup<L>[] = [];
  const byKey = new Map<string, CourseGroup<L>>();
  for (const line of [...lines].sort((a, b) => a.id - b.id)) {
    const k = key(line);
    const held = k === null ? undefined : byKey.get(k);
    if (held) {
      held.lines.push(line);
      held.ids.push(line.id);
      held.qty = held.qty === null || line.qty === null ? null : held.qty + line.qty;
      // the known prices summed, as the Courses total sums them; unknown only when no line has one
      held.estPriceCents = held.estPriceCents === null && line.estPriceCents === null ? null : (held.estPriceCents ?? 0) + (line.estPriceCents ?? 0);
      continue;
    }
    const group: CourseGroup<L> = { head: line, lines: [line], ids: [line.id], qty: line.qty, estPriceCents: line.estPriceCents };
    groups.push(group);
    if (k !== null) byKey.set(k, group);
  }
  const order = new Map(lines.map((l, i) => [l.id, i]));
  return groups.sort((a, b) => order.get(a.head.id)! - order.get(b.head.id)!);
}
