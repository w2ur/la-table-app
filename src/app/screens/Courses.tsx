import { useEffect, useRef, useState } from "preact/hooks";
import { groupCourseLines } from "../../domain/course-groups";
import type { RemoveReason } from "../../domain/types";
import { COURSE_GROUPS, GROUP_LABELS } from "../../domain/vocabulary";
import type { Act, ActMany, Undo } from "../act";
import { lineMeta, priceText, totalsLine } from "../format";
import { go, leave } from "../nav";
import { removeRoute, type Route } from "../route";
import { removalMeals, removalOps, removalRow, untick, type Row } from "../rows";
import { Sheet } from "../Sheet";
import type { View, ViewLine } from "../sync/project";
import { Checkout } from "./Checkout";

/**
 * Spec §10.2: ajouts at the top, lines by aisle with their price, « Dans le panier » below, the total against the budget.
 * One row per product, unit and kind (`groupCourseLines`): a tick buys the lines the row was drawn with, one op each.
 * « Retirer » is on every unbought row: an ajout goes at once, a planned line or a staple opens a sheet that asks why
 * (`RemoveSheet`).
 */
export function CoursesScreen({ route, view, act, actMany, undo, refresh }: { route: Route; view: View; act: Act; actMany: ActMany; undo: Undo; refresh: () => Promise<void> }) {
  const toBuy = view.courses.lines.filter((l) => l.boughtAt === null);
  const basket = view.courses.lines.filter((l) => l.boughtAt !== null);
  const buy = (row: Row) => actMany(row.ids.map((itemId) => ({ type: "shopping.buy", payload: { itemId } })), `Acheté : ${row.head.label}`);
  const remove = (line: ViewLine) => act("shopping.remove", { itemId: line.id }, `Retiré : ${line.label}`);
  const removing = removalRow(route, toBuy);
  return (
    <>
      <AddLine act={act} />
      {toBuy.length === 0 && <p class="empty">Rien à acheter. La prochaine liste vient de la planification dans Claude Code.</p>}
      {COURSE_GROUPS.map((group) => {
        const rows = groupCourseLines(toBuy.filter((l) => l.group === group));
        return rows.length === 0 ? null : (
          <section class="group" key={group} aria-labelledby={`courses-${group}`}>
            <h2 id={`courses-${group}`}>{GROUP_LABELS[group]}</h2>
            <ul class="rows">
              {rows.map((row) => (
                <LineRow key={row.ids.join()} row={row} onTap={() => buy(row)}
                  onRemove={row.lines.some((l) => l.pending) ? null : row.head.kind === "ajout" ? () => remove(row.head) : () => go(removeRoute(row.head.id))} />
              ))}
            </ul>
          </section>
        );
      })}
      {basket.length > 0 && (
        <section class="group" aria-labelledby="courses-panier">
          <h2 id="courses-panier">Dans le panier</h2>
          <ul class="rows">
            {groupCourseLines(basket).map((row) => (
              <LineRow key={row.ids.join()} row={row} onTap={untick(row, undo)} onRemove={null} />
            ))}
          </ul>
        </section>
      )}
      <Totals view={view} />
      {/* keyed by the route: a jump from one row's sheet to another's starts a new sheet, with the new row's lines */}
      {route.path[0] === "retirer" && <RemoveSheet key={route.path.join("/")} row={removing} actMany={actMany} />}
      <Checkout view={view} basket={basket} route={route} act={act} actMany={actMany} undo={undo} refresh={refresh} />
    </>
  );
}

/**
 * Why a planned line leaves the list (spec §10.2): « On en a déjà » puts it in Reste, « On n'en prend pas » only takes it
 * off. The row's lines go through one actMany, so « Annuler » takes them all back. A route (`#/courses/retirer/45`), so
 * the back button closes it. On a row Courses no longer shows (bought or removed on the other phone, a typed URL) it goes
 * back to Courses rather than wait; once sent, the projection empties the row before the route closes, which is not that.
 */
function RemoveSheet({ row, actMany }: { row: Row | null; actMany: ActMany }) {
  const sent = useRef(false);
  // the lines the row was drawn with when the sheet opened: the removal acts on those, not on a row that grew since
  const opened = useRef<readonly number[] | null>(null);
  if (opened.current === null && row !== null) opened.current = row.ids;
  useEffect(() => {
    if (row === null && !sent.current) leave("courses");
  }, [row === null]);
  if (row === null) return null;
  const meals = removalMeals(row, opened.current!);
  const send = (reason: RemoveReason, label: string) => {
    if (sent.current) return;
    sent.current = true;
    const ops = removalOps(opened.current!, row, reason);
    if (ops.length > 0) actMany(ops, `${label} : ${row.head.label}`);
    leave("courses");
  };
  return (
    <Sheet title={`Retirer ${row.head.label}`} onClose={() => leave("courses")}>
      {meals.length > 0 && <p class="meta sheet-meta">pour {meals.join(", ")}</p>}
      <div class="sheet-actions">
        <button type="button" class="button wide" onClick={() => send("a_la_maison", "Déjà à la maison")}>On en a déjà</button>
        <button type="button" class="button wide" onClick={() => send("pas_achete", "Retiré")}>On n'en prend pas</button>
        <button type="button" class="link" onClick={() => leave("courses")}>Annuler</button>
      </div>
    </Sheet>
  );
}

function LineRow({ row, onTap, onRemove }: { row: Row; onTap: (() => void) | null; onRemove: (() => void) | null }) {
  const line = row.head;
  const pending = row.lines.some((l) => l.pending);
  return (
    <li>
      <button
        type="button"
        class="row"
        role="checkbox"
        aria-checked={line.boughtAt !== null}
        disabled={pending || onTap === null}
        onClick={onTap ?? undefined}
      >
        <span class="box" aria-hidden="true" />
        <span class="name">
          {line.label}
          <span class="meta">{lineMeta({ ...line, qty: row.qty, pending })}</span>
        </span>
        <span class="price">{priceText(row.estPriceCents)}</span>
      </button>
      {onRemove && (
        <button type="button" class="side" aria-label={`Retirer ${line.label}`} onClick={onRemove}>Retirer</button>
      )}
    </li>
  );
}

/** One field for an ajout, food by default (spec §10.2). */
function AddLine({ act }: { act: Act }) {
  const [text, setText] = useState("");
  const [nonFood, setNonFood] = useState(false);
  const submit = (event: Event) => {
    event.preventDefault();
    const label = text.trim();
    if (label === "") return;
    act("shopping.add", { label, isFood: !nonFood }, `Ajouté : ${label}`);
    setText("");
    setNonFood(false);
  };
  return (
    <form class="add" onSubmit={submit}>
      <label class="visually-hidden" for="new-line">Nouvel article</label>
      <input id="new-line" type="text" autocomplete="off" placeholder="Ajouter un article" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <label class="check">
        <input type="checkbox" checked={nonFood} onChange={(e) => setNonFood(e.currentTarget.checked)} />
        Non alimentaire
      </label>
      <button type="submit" class="button" disabled={text.trim() === ""}>Ajouter</button>
    </form>
  );
}

function Totals({ view }: { view: View }) {
  if (!view.courses.lines.some((l) => l.kind === "planning")) return null;
  return <p class="totals">{totalsLine(view.courses.estimateCents, view.courses.budgetCents)}</p>;
}
