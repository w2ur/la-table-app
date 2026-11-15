import { useEffect, useRef, useState } from "preact/hooks";
import { parisDate } from "../../domain/dates";
import type { Act } from "../act";
import { ACTION_LABEL, finishFromRow, parseUseBy, resteMeta } from "../format";
import { LeftOver } from "../LeftOver";
import { leftOverPrefill, leftOverUnit, leftOverWords } from "../leftover-field";
import { back, go, leave } from "../nav";
import { ReservationWarning } from "../ReservationWarning";
import { itemRoute, routeTarget, type Route } from "../route";
import { RouteLink } from "../RouteLink";
import { Sheet } from "../Sheet";
import { viewItems, type View, type ViewItem } from "../sync/project";

const SECTIONS = [
  ["urgent", "À utiliser vite"],
  ["reserved", "Réservé"],
  ["libre", "Libre"],
  ["placard", "Placard"],
] as const;

/**
 * Reste by section (spec §10.3), an add field at the top, each item opening its sheet. An item added offline has no
 * server id yet: it shows « en attente » and opens nothing. An item at 0 that no meal holds has
 * « Fini » beside its row (`finishFromRow`), sent with the usual « Annuler » bar.
 */
export function ResteScreen({ route, view, act }: { route: Route; view: View; act: Act }) {
  // the phone's Paris day, not the snapshot's: offline the snapshot can be days old, and a passed date must say so
  const today = parisDate(new Date().toISOString());
  const target = routeTarget(route, "article");
  const empty = SECTIONS.every(([key]) => view.reste[key].length === 0);
  return (
    <>
      <AddItem act={act} />
      {empty && <p class="empty">Rien au frigo ni au placard. Ce qui est acheté arrive ici.</p>}
      {SECTIONS.map(([key, title]) => view.reste[key].length === 0 ? null : (
        <section class="group" key={key} aria-labelledby={`reste-${key}`}>
          <h2 id={`reste-${key}`}>{title}</h2>
          <ul class="rows">
            {view.reste[key].map((item) => (
              <li key={item.id}>
                {item.pending ? (
                  <div class="row static">
                    <span class="name">
                      {item.label}
                      <span class="meta">{resteMeta(item, today)}</span>
                    </span>
                  </div>
                ) : (
                  <RouteLink class="row open" route={itemRoute(item.id)}>
                    <span class="name">
                      {item.label}
                      <span class="meta">{resteMeta(item, today)}</span>
                    </span>
                    <span class="go" aria-hidden="true">›</span>
                  </RouteLink>
                )}
                {finishFromRow(item) && (
                  <button type="button" class="side" aria-label={`Fini : ${item.label}`} onClick={() => act("stock.finish", { itemId: item.id }, ACTION_LABEL.finish(item.label))}>
                    Fini
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {target !== null && <ItemSheet itemId={target.id} step={target.rest[0] ?? null} view={view} act={act} today={today} />}
    </>
  );
}

/** One field for something at home the lists do not know (spec §6.5 stock.add): no product, so no date until one is set. */
function AddItem({ act }: { act: Act }) {
  const [text, setText] = useState("");
  const submit = (event: Event) => {
    event.preventDefault();
    const label = text.trim();
    if (label === "") return;
    act("stock.add", { label, productId: null, qtyText: null, useBy: null }, ACTION_LABEL.stockAdd(label));
    setText("");
  };
  return (
    <form class="add" onSubmit={submit}>
      <label class="visually-hidden" for="new-item">Nouvel article au Reste</label>
      <input id="new-item" type="text" autocomplete="off" placeholder="Ajouter au frigo ou au placard" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <button type="submit" class="button" disabled={text.trim() === ""}>Ajouter</button>
    </form>
  );
}

/**
 * A Reste item's sheet (spec §10.3): « Fini », « Il en reste », « Changer la date », each step a route of its own
 * (`#/reste/article/12/reste`), so the back button steps back and « Fermer » closes the sheet. « Fini » on an item a
 * meal holds opens the reservation warning (§10.4, `…/fini`) and sends stock.finish only with the resolution chosen
 * there. Each step sends once per opening and goes back to Reste. On an item Reste does not show
 * (finished on the other phone, a typed URL), it goes back to Reste rather than wait.
 */
function ItemSheet({ itemId, step, view, act, today }: { itemId: number; step: string | null; view: View; act: Act; today: string }) {
  const item = viewItems(view).find((i) => i.id === itemId && !i.pending);
  const sent = useRef(false);
  useEffect(() => {
    if (!item && !sent.current) leave("reste");
  }, [item === undefined]);
  if (!item) return null;
  const send = (type: string, payload: unknown, label: string) => {
    if (sent.current) return;
    sent.current = true;
    act(type, payload, label);
    leave("reste");
  };
  const finish = () => {
    if (item.reservations.length > 0) return go(itemRoute(item.id, "fini"));
    send("stock.finish", { itemId: item.id }, ACTION_LABEL.finish(item.label));
  };
  return (
    <Sheet title={item.label} onClose={() => leave("reste")}>
      <p class="meta sheet-meta">{resteMeta(item, today) || " "}</p>
      {step === "fini" ? (
        item.reservations.length > 0 ? (
          <ReservationWarning
            holding={item.reservations}
            onChoose={(resolution) => send("stock.finish", { itemId: item.id, resolution }, ACTION_LABEL.finish(item.label))}
            onCancel={() => back(itemRoute(item.id))}
          />
        ) : (
          <div class="actions">
            <p class="meta">Plus aucun repas ne compte dessus.</p>
            <button type="button" class="button primary wide" onClick={finish}>Fini</button>
          </div>
        )
      ) : step === "reste" ? (
        <PartlyUsed item={item} onSend={(qtyText, low) => send("stock.partial", { itemId: item.id, qtyText, low }, ACTION_LABEL.partial(item.label))} />
      ) : step === "date" ? (
        <NewDate item={item} today={today} onSend={(useBy) => send("stock.set_use_by", { itemId: item.id, useBy }, ACTION_LABEL.useBy(item.label))} />
      ) : (
        <div class="sheet-actions">
          <button type="button" class="button primary wide" onClick={finish}>Fini</button>
          <button type="button" class="button wide" onClick={() => go(itemRoute(item.id, "reste"))}>Il en reste</button>
          <button type="button" class="button wide" onClick={() => go(itemRoute(item.id, "date"))}>Changer la date</button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * « Il en reste » (spec §6.5 stock.partial), prefilled by `leftOverPrefill`: always empty on an item that holds a number,
 * so sent unchanged it never puts back an amount a cook has taken off since; an unknown quantity's own words otherwise. A
 * bare number goes with the unit shown beside the field (`leftOverWords`).
 */
function PartlyUsed({ item, onSend }: { item: ViewItem; onSend: (qtyText: string | null, low: boolean) => void }) {
  const [text, setText] = useState(leftOverPrefill(item));
  const [low, setLow] = useState(item.isLow);
  const unit = leftOverUnit(item);
  const submit = (event: Event) => {
    event.preventDefault();
    onSend(leftOverWords(text, unit), low);
  };
  return (
    <form class="sheet-form" onSubmit={submit}>
      <LeftOver id="item-left" text={text} low={low} unit={unit} onText={setText} onLow={setLow} />
      <button type="submit" class="button primary wide">Valider</button>
    </form>
  );
}

/** « Changer la date » (spec §6.5 stock.set_use_by): any real day, a past one included; today when the item has none. */
function NewDate({ item, today, onSend }: { item: ViewItem; today: string; onSend: (useBy: string) => void }) {
  const [date, setDate] = useState(item.useBy ?? today);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: Event) => {
    event.preventDefault();
    const day = parseUseBy(date);
    if (!day.ok) return setError(day.message);
    onSend(day.date);
  };
  return (
    <form class="sheet-form" onSubmit={submit}>
      <label for="use-by">À utiliser avant le</label>
      <input id="use-by" type="date" value={date} onInput={(e) => { setDate(e.currentTarget.value); setError(null); }} />
      {error !== null && <p class="error" role="alert">{error}</p>}
      <button type="submit" class="button primary wide" disabled={date === item.useBy}>Valider</button>
    </form>
  );
}
