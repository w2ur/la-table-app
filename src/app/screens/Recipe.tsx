import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { parisDate } from "../../domain/dates";
import type { PoolMeal, RecentMeal } from "../../domain/snapshot";
import { isWebUrl } from "../../domain/text";
import type { Verdict } from "../../domain/types";
import type { Act } from "../act";
import { answerFor, cookPayload, finiMeta, heldOnce, liveAsking, openingAnswers, othersHolding, pendingItem, unresolvedFini, type CookAnswer, type CookAnswers } from "../cook";
import { ACTION_LABEL, cookedMeta, ingredientMeta, mealNutritionMeta, qtyText, recipeMeta, shortfallMeta, VERDICTS } from "../format";
import { LeftOver } from "../LeftOver";
import { leftOverUnit } from "../leftover-field";
import { back, go, leave } from "../nav";
import { ReservationWarning } from "../ReservationWarning";
import { mealRoute } from "../route";
import { Sheet } from "../Sheet";
import { Toggles } from "../Toggles";
import { viewItems, type View, type ViewRecent } from "../sync/project";

/**
 * A pool meal (spec §10.1): its ingredients scaled to its portions, each marked « réservé » while Reste holds it, its
 * numbered steps and source, « Cuisiné » at the bottom, which opens its sheet, and « Retirer du menu » (spec §6.5
 * meal.drop). A second round waits for its first round (spec §6.3). Opening it reads the server, as the checkout sheet
 * does (an event): the Cuisiné sheet lists what Reste holds for the meal, which the other phone may
 * have finished. A meal of « Cuisinés récemment » opens the same recipe read-only: when it was cooked, no action, no
 * reservation. Any other meal (dropped elsewhere, cooked over a week ago, or a typed URL) says it is no longer on the
 * menu and sends nothing.
 */
export function RecipeScreen({ mealId, sheet, view, act, refresh }: { mealId: number; sheet: string | null; view: View; act: Act; refresh: () => Promise<void> }) {
  // what this screen sent takes its meal off the pool before the route goes back to Menu: neither « plus au menu » nor
  // the cooked meal's read-only view meanwhile
  const sent = useRef(false);
  useEffect(() => {
    void refresh();
  }, [mealId]);
  const meal = view.menu.pool.find((m) => m.id === mealId);
  const short = meal ? shortfallMeta(meal) : "";
  // one tap, one op: the button stays until the next render takes it off, and comes back only if the shortfall does
  const covering = useRef(false);
  useEffect(() => {
    covering.current = false;
  }, [short]);
  if (!meal) {
    if (sent.current) return null;
    const cooked = view.menu.recentlyCooked.find((m) => m.mealId === mealId);
    // its Cuisiné sheet was open here: what was typed in it is gone with it, and says so, in the words of the dropped-sheet line
    if (cooked) return <CookedRecipe meal={cooked} notice={sheet === "cuisine" ? COOKED_ELSEWHERE : null} />;
    return (
      <>
        <button type="button" class="link back" onClick={() => leave("menu")}>‹ Menu</button>
        <p class="empty">Ce repas n'est plus au menu : il a été cuisiné ou retiré, peut-être sur l'autre téléphone.</p>
      </>
    );
  }
  const waitsForFirst = meal.firstRoundId != null; // `!= null`: a snapshot stored by an older app has no firstRoundId
  const cover = () => {
    if (covering.current) return;
    covering.current = true;
    act("meal.cover_shortfalls", { mealId: meal.id }, ACTION_LABEL.cover(meal.title));
  };
  const drop = () => {
    sent.current = true;
    act("meal.drop", { mealId: meal.id }, ACTION_LABEL.drop(meal.title));
    leave("menu");
  };
  return (
    <RecipeView meal={meal} lead={meal.cookEarlyReason} afterIngredients={short !== "" && (
      <div class="recipe-shortfall">
        <p class="meta shortfall">{short}</p>
        <button type="button" class="button" onClick={cover}>Ajouter aux courses</button>
      </div>
    )}>
      <div class="recipe-actions">
        <button type="button" class="button primary wide" disabled={waitsForFirst} onClick={() => go(mealRoute(meal.id, "cuisine"))}>Cuisiné</button>
        {waitsForFirst && <p class="meta">Cuisinez d'abord le premier tour.</p>}
        <button type="button" class="link" onClick={drop}>Retirer du menu</button>
      </div>
      {sheet === "cuisine" && !waitsForFirst && <CookSheet meal={meal} view={view} act={act} onSent={() => { sent.current = true; }} />}
    </RecipeView>
  );
}

/** A meal cooked in the last seven days, read-only: undone from its Menu row, never from here. */
const COOKED_ELSEWHERE = "Déjà cuisiné sur l'autre téléphone : ce que vous aviez saisi n'a pas été envoyé.";

function CookedRecipe({ meal, notice }: { meal: ViewRecent; notice: string | null }) {
  // the phone's Paris day, not the snapshot's, as the Menu row says it: offline the snapshot can be days old
  const today = parisDate(new Date().toISOString());
  return <RecipeView meal={meal} lead={cookedMeta(meal.cookedAt, today, meal.undoing)} notice={notice} />;
}

/**
 * The recipe as both views show it: title, a lead line (why cook it early, or when it was cooked), the meta, the
 * nutrition per portion, ingredients, steps and source. A recent meal an older app stored has only its title: each part
 * it lacks is left out, never drawn empty.
 */
function RecipeView({ meal, lead, notice = null, afterIngredients = null, children }: {
  meal: Pick<RecentMeal, "title" | "portions" | "activeMin" | "totalMin" | "isSecondRound" | "steps" | "sourceUrl" | "nutrition"> & {
    ingredients?: (NonNullable<RecentMeal["ingredients"]>[number] & { reserved?: boolean })[];
  };
  lead: string | null;
  /** One line above the title, when something the screen showed is gone. */
  notice?: string | null;
  /** What closes the ingredients, after the last row: a pool meal's shortfall and its action. */
  afterIngredients?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const meta = recipeMeta(meal);
  const nutrition = mealNutritionMeta(meal);
  return (
    <article class="recipe" aria-labelledby="recipe-title">
      <button type="button" class="link back" onClick={() => leave("menu")}>‹ Menu</button>
      {notice !== null && <p class="notice" role="status">{notice}</p>}
      <h2 id="recipe-title">{meal.title}</h2>
      {lead !== null && <p class="meta">{lead}</p>}
      {meta !== "" && <p class="meta">{meta}</p>}
      {nutrition !== null && <p class="meta">{nutrition}</p>}
      {(meal.isSecondRound === true || meal.ingredients !== undefined) && <h3>Ingrédients</h3>}
      {meal.isSecondRound === true ? (
        // the snapshot lists a second round's recipe at 1× (snapshot.ts), but it eats the plat cuisiné: nothing to gather
        <p class="meta">Le plat cuisiné du premier tour.</p>
      ) : meal.ingredients !== undefined && (
        <ul class="rows">
          {meal.ingredients.map((i) => (
            <li key={`${i.productId}|${i.unit}`}>
              <div class="row static">
                <span class="name">
                  {i.label}
                  <span class="meta">{ingredientMeta(i)}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {afterIngredients}
      {meal.steps !== undefined && (
        <>
          <h3>Étapes</h3>
          <ol class="steps">
            {meal.steps.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        </>
      )}
      {isWebUrl(meal.sourceUrl) && (
        <p>
          <a href={meal.sourceUrl} target="_blank" rel="noopener noreferrer">Recette d'origine</a>
        </p>
      )}
      {children}
    </article>
  );
}

const OUTCOMES = [
  { value: "fini", label: "Fini" },
  { value: "il_en_reste", label: "Il en reste" },
] as const;

/**
 * « Cuisiné » (spec §10.1): a verdict, a note, then each Reste item held for the meal, once, with « Fini » or « Il en
 * reste » (what is left in words, « Presque fini »; prefilled with what the item says now, so leaving them alone changes
 * nothing). Everything optional; « Fini » is pre-made, and a tap clears it, on a second round's plat cuisiné (decision
 * B17) and on each item the cook empties that no other meal holds (`openingAnswers`); the latter is sent as `ifEmpty`, so
 * the server finishes the item only if the cook still empties it when it lands. A « Fini » on an item another open meal holds opens the reservation warning (§10.4)
 * in its place first, and so does « Valider » for a « Fini » another meal took hold of since (`unresolvedFini`), even one
 * already answered there; the cook carries the resolution chosen there. A plat cuisiné not yet synced is « en attente »:
 * no op may name it. One « Valider » sends one meal.cook (`cookPayload`), once per opening, and goes back to Menu.
 */
function CookSheet({ meal, view, act, onSent }: { meal: PoolMeal; view: View; act: Act; onSent: () => void }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [note, setNote] = useState("");
  const items = viewItems(view);
  const [answers, setAnswers] = useState<CookAnswers>(() => openingAnswers(meal, items));
  const [asking, setAsking] = useState<number | null>(null);
  const sent = useRef(false);
  const held = heldOnce(meal);
  const itemOf = (id: number) => items.find((i) => i.id === id);
  const others = (id: number) => othersHolding(meal, items, id);
  // a refresh may have taken the asked item out of the warning's reach: judge it against the view now (`liveAsking`)
  const askingNow = liveAsking(meal, items, asking);
  const set = (id: number, answer: CookAnswer | undefined) => setAnswers((all) => ({ ...all, [id]: answer }));
  const choose = (id: number, outcome: CookAnswer["outcome"] | null) => {
    if (outcome === "fini" && others(id).length > 0) return setAsking(id);
    if (asking === id) setAsking(null);
    const item = itemOf(id);
    set(id, outcome === null ? undefined : answerFor(item, outcome));
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (sent.current) return;
    // another meal took hold of a « Fini » item since the tap: ask now, as a tap would, rather than send it unresolved
    const unresolved = unresolvedFini(meal, items, answers);
    if (unresolved !== null) {
      set(unresolved, undefined);
      return setAsking(unresolved);
    }
    sent.current = true;
    onSent();
    act("meal.cook", cookPayload(meal, items, verdict, note, answers), ACTION_LABEL.cook(meal.title));
    leave("menu");
  };
  return (
    <Sheet title="Cuisiné" onClose={() => back(mealRoute(meal.id))}>
      <form class="sheet-form" onSubmit={submit}>
        <p class="meta">{meal.title}</p>
        <p class="label">Verdict (facultatif)</p>
        <Toggles label="Verdict" options={VERDICTS} value={verdict} onChange={setVerdict} />
        <label for="cook-note">Note (facultatif)</label>
        <input id="cook-note" type="text" autocomplete="off" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        {held.length > 0 && <p class="label">Ce qui reste de ses ingrédients</p>}
        {held.map((r) => {
          const answer = answers[r.stockItemId];
          const pending = pendingItem(r.stockItemId, items);
          const meta = finiMeta(meal, items, r.stockItemId, answer);
          return (
            <fieldset class="held" key={r.stockItemId}>
              <legend>
                {r.label}
                <span class="meta">{pending ? "en attente" : qtyText(r.qty, r.unit) || "réservé"}</span>
              </legend>
              {pending ? null : askingNow === r.stockItemId ? (
                <ReservationWarning
                  holding={others(r.stockItemId)}
                  onChoose={(resolution) => {
                    set(r.stockItemId, { outcome: "fini", qtyText: "", low: false, resolution, heldBy: others(r.stockItemId).map((h) => h.mealId) });
                    setAsking(null);
                  }}
                  onCancel={() => setAsking(null)}
                />
              ) : (
                <>
                  <Toggles label={`${r.label} : fini ou il en reste`} options={OUTCOMES} value={answer?.outcome ?? null} onChange={(o) => choose(r.stockItemId, o)} />
                  {meta !== null && <p class="meta">{meta}</p>}
                  {answer?.outcome === "il_en_reste" && (
                    <LeftOver id={`left-${r.stockItemId}`} text={answer.qtyText} low={answer.low} unit={leftOverUnit(items.find((i) => i.id === r.stockItemId))}
                      onText={(qtyText) => set(r.stockItemId, { ...answer, qtyText })} onLow={(low) => set(r.stockItemId, { ...answer, low })} />
                  )}
                </>
              )}
            </fieldset>
          );
        })}
        <button type="submit" class="button primary wide" disabled={askingNow !== null}>Valider</button>
      </form>
    </Sheet>
  );
}
