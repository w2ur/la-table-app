import { useEffect, useRef, useState } from "preact/hooks";
import { groupCourseLines } from "../../domain/course-groups";
import { parisDate } from "../../domain/dates";
import type { Place, Trip } from "../../domain/types";
import { formatEuros } from "../../domain/units";
import type { Act, ActMany, Undo } from "../act";
import { dateLabel, parseReceipt, parseTripDate } from "../format";
import { back, go } from "../nav";
import type { Route } from "../route";
import { lineGone, liveUnticks, untickAll, type Row } from "../rows";
import { Sheet } from "../Sheet";
import type { View, ViewLine } from "../sync/project";

const PLACES: readonly { value: Place; label: string }[] = [
  { value: "marche", label: "Marché" },
  { value: "supermarche", label: "Supermarché" },
  { value: "autre", label: "Autre" },
];

/** Why an unchecked row is not on the receipt: taken back, or bought and recorded on a trip of its own without a ticket. */
type Off = "pas" | "sans";

const placeLabel = (place: Place): string => PLACES.find((p) => p.value === place)!.label;

/** A checkout sheet opens as an entry of its own and closes back to Courses (nav.ts). */
const open = (sheet: string): void => go({ tab: "courses", path: [sheet] });
const close = (): void => back({ tab: "courses", path: [] });

/** How long a checkout sheet waits for the read it asks for when it opens, a dead zone being what it is. */
const REFRESH_WAIT_MS = 2000;

/**
 * Below the Courses list: « Passage en caisse », a past ticket still without its total, and their sheets (spec §10.2, §6.5).
 * `basket` is Courses' « Dans le panier », the bought lines not yet on a trip. `refresh` reads the server (spec §8.3).
 */
export function Checkout({ view, basket: lines, route, act, actMany, undo, refresh }: { view: View; basket: readonly ViewLine[]; route: Route; act: Act; actMany: ActMany; undo: Undo; refresh: () => Promise<void> }) {
  const basket = lines.map((l) => l.id);
  // the receipt's day: today in Paris, where it was printed, by the phone's clock (never the UTC date, nor the snapshot's)
  const today = parisDate(new Date().toISOString());
  const trip = view.lastTrip;
  const ticketDue = trip !== null && trip.id > 0 && trip.totalCents === null; // id ≤ 0: recorded offline, not answered yet
  return (
    <div class="checkout">
      <button type="button" class="button primary wide" disabled={basket.length === 0} onClick={() => open("caisse")}>Passage en caisse</button>
      {ticketDue && trip !== null && (
        <p class="status-line">
          Ticket du {dateLabel(trip.date, today)} · {placeLabel(trip.place)} sans total.
          <button type="button" class="link" onClick={() => open("ticket")}>Saisir le total</button>
        </p>
      )}
      {route.path[0] === "caisse" && <CheckoutSheet view={view} lines={lines} today={today} actMany={actMany} undo={undo} refresh={refresh} />}
      {route.path[0] === "ticket" && <TicketSheet due={ticketDue ? trip : null} today={today} act={act} />}
    </div>
  );
}

/**
 * The checkout for the basket as it was once the read the sheet asks for on opening had landed (or failed, or waited
 * `REFRESH_WAIT_MS`): a phone that stayed in the foreground has not read since its last tap, and the receipt typed at a
 * shared till covers the other phone's lines too. trip.record lists those lines (`itemIds`), named under the count, and
 * the server records it only while every one of them is still bought and on no trip (« panier modifié depuis »), so a
 * line the other phone ticks after that read stays in the basket. A refresh that changes the basket while the sheet is
 * open (another phone's checkout, a line ticked there) means the receipt typed here may not be this basket's: the sheet
 * then sends nothing. Opened with an empty basket (a reload, a forward navigation), it goes back to Courses rather than
 * wait on the route for a later tick to open it.
 *
 * Each row of the basket is on the receipt unless unchecked, and an unchecked row says why it is not: « Pas acheté »
 * takes the tick back (the untick of Courses, `undo` of the buy), « Acheté sans ticket » records it on a trip of its own
 * without a total (spec §6.5 `noReceipt`), dated as the receipt, or by the date field alone (kept visible, default today) when no row
 * is on it, place and total being hidden then (a total already typed stays, and « Valider » refuses it until it is cleared
 * or a row is checked: never dropped unseen). A row is taken back whole or not at all. Unchecking a row defaults to « Acheté sans
 * ticket », the non-destructive answer: the « Annuler » bar undoes a trip but never re-ticks an untick.
 *
 * Applied in parts: the undos and the trips are independent ops. Each trip.record is all-or-nothing on its own list
 * (it attaches exactly the lines its sheet showed, or refuses « panier modifié depuis »), but the checkout as a whole is not: a refused receipt trip leaves its lines in the basket with the
 * refusal banner, whatever the other trip and the undos did, and the owners check out again. « Pas acheté » is no op of
 * its own but the undo of each line's buy, so it holds only within that buy's undo window (spec §6.6, decided
 * 2026-10-11: a line bought too long ago cannot be un-bought, and the snapshot gives it no `buyOpId`): such a row offers
 * « Acheté sans ticket » alone, and an undo the server refuses leaves its line in the basket, whatever the trips did. A
 * row left on « Pas acheté » whose window closed while the sheet was open stops « Valider » with « acheté il y a trop
 * longtemps pour être annulé » beside the form, and nothing is sent (untickAll). Whether a row can still be taken back is
 * read once per render on the live basket (rows.ts liveUnticks), the rows staying the pinned ones: the pinned lines keep the buy of the
 * read that opened the sheet. A row a line of which left the live basket (lineGone) cannot be taken back either, but gets no such note: the
 * changed-basket banner is its explanation.
 */
function CheckoutSheet({ view, lines, today, actMany, undo, refresh }: { view: View; lines: readonly ViewLine[]; today: string; actMany: ActMany; undo: Undo; refresh: () => Promise<void> }) {
  const basket = lines.map((l) => l.id);
  const [place, setPlace] = useState<Place>(view.lastTrip?.place ?? "supermarche");
  const [total, setTotal] = useState("");
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  // what each unchecked row (by its first line) is: absent = on the receipt
  const [off, setOff] = useState<ReadonlyMap<number, Off>>(new Map());
  // one op per opening: a second tap before the sheet closes would record a second, empty trip
  const sent = useRef(false);
  const [read, setRead] = useState(false);
  // pinned while rendering, so the lines are those of the view the landed read produced
  const pinned = useRef<readonly ViewLine[] | null>(null);
  if (pinned.current === null && (read || lines.length === 0)) pinned.current = lines;
  useEffect(() => {
    if (lines.length === 0) return;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => { waiting = setTimeout(resolve, REFRESH_WAIT_MS); });
    void Promise.race([refresh().catch(() => undefined), wait]).then(() => setRead(true));
    return () => clearTimeout(waiting);
  }, []);
  useEffect(() => {
    if (pinned.current !== null && pinned.current.length === 0) close();
  }, [read]);
  const shown = pinned.current;
  if (shown === null) {
    return (
      <Sheet title="Passage en caisse" onClose={close}>
        <p class="meta">Lecture du panier…</p>
      </Sheet>
    );
  }
  if (shown.length === 0) return null;
  const opened = shown.map((l) => l.id);
  const rows = groupCourseLines(shown);
  // once sent, the projection empties the basket before the route closes: that is this sheet's own trip, not a change
  const stale = !sent.current && (basket.length !== opened.length || basket.some((id) => !opened.includes(id)));
  // a line bought too long ago has no op to undo: its row cannot be « Pas acheté » (rows.ts untick). Read on the live
  // basket, not the pinned one: an undo window that closed while the sheet was open shows here at the next render
  // computed once per render, the one source of the disabled radio and of what « Valider » sends: null when it cannot
  const unticks = liveUnticks(rows, lines, undo);
  const takeBack = (row: Row) => (unticks.get(row.head.id) ?? null) !== null;
  // a row whose undo window closed says so; one whose line left the basket is explained by the changed-basket banner alone
  const lateRow = (row: Row) => !takeBack(row) && !lineGone(row, lines);
  const kind = (row: Row): Off | null => off.get(row.head.id) ?? null;
  const onReceipt = rows.filter((r) => kind(r) === null);
  const without = rows.filter((r) => kind(r) === "sans");
  const notBought = rows.filter((r) => kind(r) === "pas");
  // a total typed, then every row unchecked: kept in sight and refused, never dropped unseen
  const strayTotal = onReceipt.length === 0 && total.trim() !== "";
  const setKind = (row: Row, value: Off | null) => {
    const next = new Map(off);
    if (value === null) next.delete(row.head.id);
    else next.set(row.head.id, value);
    setOff(next);
    setError(null);
  };
  const submit = (event: Event) => {
    event.preventDefault();
    // backstop: the disabled « Valider » is the guard
    if (sent.current || stale) return;
    if (strayTotal) return setError("Aucune ligne cochée pour ce ticket");
    const receipt = onReceipt.length === 0 ? null : parseReceipt(total);
    if (receipt !== null && !receipt.ok) return setError(receipt.message);
    // the date is asked whenever a trip is recorded: the receipt's, or the one of the rows bought without a ticket
    const day = onReceipt.length === 0 && without.length === 0 ? null : parseTripDate(date, today);
    if (day !== null && !day.ok) return setError(day.message);
    // a « Pas acheté » row whose undo window closed while the sheet was open: said where it is, and nothing is sent
    const takeBackAll = untickAll(notBought, unticks);
    if (!takeBackAll.ok) return setError(`${takeBackAll.late.head.label} : acheté il y a trop longtemps pour être annulé`);
    // once every check passed, before the first call: the untick empties the basket, which is not a change made elsewhere
    sent.current = true;
    takeBackAll.send();
    // no date asked, so no row on a trip: the unticks were the whole checkout
    if (day === null) return close();
    const tripDate = day.date;
    const trips: { type: string; payload: unknown }[] = [];
    const names: string[] = [];
    if (receipt !== null) {
      trips.push({ type: "trip.record", payload: { place, totalCents: receipt.cents, date: tripDate, itemIds: onReceipt.flatMap((r) => r.ids) } });
      names.push(`${placeLabel(place)}${receipt.cents === null ? "" : ` · ${formatEuros(receipt.cents)}`}`);
    }
    if (without.length > 0) {
      // the date field's day: the receipt's when rows are on it, else the one typed for these rows alone (default today)
      trips.push({ type: "trip.record", payload: { place: "autre", noReceipt: true, date: tripDate, itemIds: without.flatMap((r) => r.ids) } });
      names.push("sans ticket");
    }
    if (trips.length > 0) actMany(trips, `Passage en caisse : ${names.join(" + ")}`);
    close();
  };
  return (
    <Sheet title="Passage en caisse" onClose={close}>
      <form class="sheet-form" onSubmit={submit}>
        {/* rows, as « Dans le panier » shows them: one per product, unit and kind */}
        <p class="meta">{rows.length} article{rows.length > 1 ? "s" : ""} dans le panier.</p>
        <ul class="rows trip-rows">
          {rows.map((row) => {
            const why = kind(row);
            return (
              <li key={row.head.id}>
                <label class="choice">
                  <input type="checkbox" checked={why === null} onChange={(e) => setKind(row, e.currentTarget.checked ? null : "sans")} />
                  {row.head.label}
                </label>
                {why !== null && (
                  <div class="choices trip-why" role="radiogroup" aria-label={`${row.head.label} : pourquoi pas sur le ticket`}>
                    <label class="choice">
                      <input type="radio" name={`why-${row.head.id}`} checked={why === "pas"} disabled={!takeBack(row)} aria-describedby={lateRow(row) ? `why-${row.head.id}-late` : undefined} onChange={() => setKind(row, "pas")} />
                      Pas acheté
                    </label>
                    <label class="choice">
                      <input type="radio" name={`why-${row.head.id}`} checked={why === "sans"} onChange={() => setKind(row, "sans")} />
                      Acheté sans ticket
                    </label>
                    {lateRow(row) && <p class="meta" id={`why-${row.head.id}-late`}>Pas acheté : acheté il y a trop longtemps pour être annulé.</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {onReceipt.length > 0 && (
          <fieldset>
            <legend>Lieu</legend>
            <div class="choices">
              {PLACES.map((p) => (
                <label class="choice" key={p.value}>
                  <input type="radio" name="place" value={p.value} checked={place === p.value} onChange={() => setPlace(p.value)} />
                  {p.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {(onReceipt.length > 0 || strayTotal) && (
          <>
            <label for="receipt">Total du ticket (facultatif)</label>
            <div class="amount">
              <input id="receipt" type="text" inputMode="decimal" autocomplete="off" value={total}
                onInput={(e) => { setTotal(e.currentTarget.value); setError(null); }} />
              <span aria-hidden="true">€</span>
            </div>
          </>
        )}
        {(onReceipt.length > 0 || without.length > 0) && (
          <>
            <label for="trip-date">Date</label>
            <input id="trip-date" type="date" max={today} value={date} onInput={(e) => { setDate(e.currentTarget.value); setError(null); }} />
          </>
        )}
        {stale && <p class="error" role="alert">Le panier a changé depuis l'ouverture : rien n'a été envoyé.</p>}
        {!stale && error !== null && <p class="error" role="alert">{error}</p>}
        <button type="submit" class="button primary wide" disabled={stale}>Valider</button>
      </form>
    </Sheet>
  );
}

/**
 * The later total for one trip, pinned when the sheet opens: a refresh that brings a newer trip without a total, or
 * gives this one its total from another phone, never retargets what was typed for it (spec §6.5 `trip.set_total`).
 * Opened with no ticket due (a reload, a forward navigation), it goes back to Courses rather than wait on the route
 * for a later due trip to open it untapped.
 */
function TicketSheet({ due, today, act }: { due: Trip | null; today: string; act: Act }) {
  const [total, setTotal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);
  const pinned = useRef<Trip | null>(due);
  useEffect(() => {
    if (pinned.current === null) close();
  }, []);
  const trip = pinned.current;
  if (trip === null) return null;
  const stale = due === null || due.id !== trip.id;
  const day = dateLabel(trip.date, today);
  const where = placeLabel(trip.place);
  const submit = (event: Event) => {
    event.preventDefault();
    // backstop: the disabled « Valider » is the guard (a form whose only submit button is disabled never submits)
    if (sent.current || stale) return;
    const receipt = parseReceipt(total, true);
    if (!receipt.ok) return setError(receipt.message);
    sent.current = true;
    act("trip.set_total", { tripId: trip.id, totalCents: receipt.cents }, `Ticket du ${day} · ${where} : ${formatEuros(receipt.cents)}`);
    close();
  };
  return (
    <Sheet title={`Ticket du ${day} · ${where}`} onClose={close}>
      <form class="sheet-form" onSubmit={submit}>
        <label for="ticket-total">Total du ticket</label>
        <div class="amount">
          <input id="ticket-total" type="text" inputMode="decimal" autocomplete="off" value={total}
            onInput={(e) => { setTotal(e.currentTarget.value); setError(null); }} />
          <span aria-hidden="true">€</span>
        </div>
        {stale && <p class="error" role="alert">Ce ticket n'est plus le dernier sans total : rien n'a été envoyé.</p>}
        {!stale && error !== null && <p class="error" role="alert">{error}</p>}
        <button type="submit" class="button primary wide" disabled={stale}>Valider</button>
      </form>
    </Sheet>
  );
}
