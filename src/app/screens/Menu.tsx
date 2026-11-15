import { useState } from "preact/hooks";
import { parisDate } from "../../domain/dates";
import { isWebUrl } from "../../domain/text";
import type { Act, Undo } from "../act";
import { ACTION_LABEL, cookedMeta, envieMeta, mealMeta, parseEnvie, shortfallMeta } from "../format";
import { mealRoute, routeTarget, type Route } from "../route";
import { RouteLink } from "../RouteLink";
import type { View } from "../sync/project";
import { RecipeScreen } from "./Recipe";

/**
 * Spec §10.1: the pool, cook-early meals first with their reason, each opening its recipe view; below it, « Cuisinés
 * récemment » (collapsed, each meal opening its recipe read-only and undone from its row's « Annuler » while its cook can
 * be), then the envies with their one-line add field.
 */
export function MenuScreen({ route, view, act, undo, refresh }: { route: Route; view: View; act: Act; undo: Undo; refresh: () => Promise<void> }) {
  const target = routeTarget(route, "repas");
  if (target !== null) return <RecipeScreen mealId={target.id} sheet={target.rest[0] ?? null} view={view} act={act} refresh={refresh} />;
  const pool = view.menu.pool;
  return (
    <>
      {pool.length === 0 ? (
        <p class="empty">Rien à cuisiner. Prochaine planification dans Claude Code.</p>
      ) : (
        <ul class="rows">
          {pool.map((meal) => (
            <li key={meal.id}>
              <RouteLink class="row open" route={mealRoute(meal.id)}>
                <span class="name">
                  {meal.title}
                  {meal.cookEarlyReason !== null && <span class="meta">{meal.cookEarlyReason}</span>}
                  <span class="meta">{mealMeta(meal)}</span>
                  {shortfallMeta(meal) !== "" && <span class="meta shortfall">{shortfallMeta(meal)}</span>}
                </span>
                <span class="go" aria-hidden="true">›</span>
              </RouteLink>
            </li>
          ))}
        </ul>
      )}
      <Recent view={view} undo={undo} />
      <Envies view={view} act={act} />
    </>
  );
}

// « Cuisinés récemment » stays as it was left while the app is open: « ‹ Menu » from a cooked meal's recipe comes back
// to the list it was opened from, not to a closed one. A module variable, not state: the Menu is drawn anew on every
// route, so a component's state would be lost on the way. An emptied list forgets it, so a later cook never reopens it.
let recentOpen = false;

function Recent({ view, undo }: { view: View; undo: Undo }) {
  const recent = view.menu.recentlyCooked;
  if (recent.length === 0) {
    recentOpen = false;
    return null;
  }
  // the phone's Paris day, not the snapshot's: offline the snapshot can be days old
  const today = parisDate(new Date().toISOString());
  return (
    <details class="group recent" open={recentOpen} onToggle={(e) => { recentOpen = e.currentTarget.open; }}>
      <summary>Cuisinés récemment <span class="count">{recent.length}</span></summary>
      <ul class="rows">
        {recent.map((meal) => (
          <li key={meal.mealId}>
            <RouteLink class="row open" route={mealRoute(meal.mealId)}>
              <span class="name">
                {meal.title}
                <span class="meta">{cookedMeta(meal.cookedAt, today, meal.undoing)}</span>
              </span>
              <span class="go" aria-hidden="true">›</span>
            </RouteLink>
            {meal.cookOpId !== null && !meal.undoing && (
              <button type="button" class="side" aria-label={`Annuler « ${ACTION_LABEL.cook(meal.title)} »`} onClick={() => undo(meal.cookOpId!, ACTION_LABEL.cook(meal.title))}>
                Annuler
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The envies for the next planning (spec §2): one line each, a dish, a link or an idea; the first web address is its link. */
function Envies({ view, act }: { view: View; act: Act }) {
  const [text, setText] = useState("");
  const submit = (event: Event) => {
    event.preventDefault();
    const envie = parseEnvie(text);
    if (envie === null) return;
    act("envie.add", envie, ACTION_LABEL.envie(envie.text));
    setText("");
  };
  const envies = view.menu.envies;
  return (
    <section class="group" aria-labelledby="menu-envies">
      <h2 id="menu-envies">Envies</h2>
      <form class="add" onSubmit={submit}>
        <label class="visually-hidden" for="new-envie">Nouvelle envie</label>
        <input id="new-envie" type="text" autocomplete="off" placeholder="Un plat, un lien, une idée" value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <button type="submit" class="button" disabled={text.trim() === ""}>Ajouter</button>
      </form>
      {envies.length === 0 ? (
        <p class="empty">Aucune envie. Ce qui est noté ici est proposé à la prochaine planification.</p>
      ) : (
        <ul class="rows">
          {envies.map((envie) => (
            <li key={envie.id}>
              <div class="row static">
                <span class="name">
                  {envie.text}
                  {envieMeta(envie) !== "" && <span class="meta">{envieMeta(envie)}</span>}
                </span>
              </div>
              {isWebUrl(envie.url) && (
                <a class="side" href={envie.url} target="_blank" rel="noopener noreferrer" aria-label={`Ouvrir le lien de « ${envie.text} »`}>Ouvrir</a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
