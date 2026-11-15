import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Act, ActMany, Undo } from "./act";
import type { Flag } from "./flag";
import { countLine, counts, TAB_TITLE, TABS, type Tab } from "./format";
import { href, parseRoute, type Route } from "./route";
import { CoursesScreen } from "./screens/Courses";
import { MenuScreen } from "./screens/Menu";
import { ResteScreen } from "./screens/Reste";
import { StatusLines } from "./StatusLines";
import type { View } from "./sync/project";
import type { Sync, SyncState } from "./sync/sync";
import { UndoBar } from "./UndoBar";

/** A new service worker waiting (sw-register.ts), and the tap that lets it take over. */
export interface Update {
  ready: Flag;
  apply: () => void;
}

/*
 * Each hook reads its source once more right after subscribing: an effect runs after the first paint, and a change made
 * in between (the first answer from the server, the offline status set on open) would otherwise never show — Menu would
 * stay on « Pas encore de liste » (e2e `lists.spec.ts`, `offline.spec.ts`).
 */
function useSync(sync: Sync): SyncState {
  const [state, setState] = useState(() => sync.getState());
  useEffect(() => {
    const update = () => setState(sync.getState());
    const stop = sync.subscribe(update);
    update();
    return stop;
  }, [sync]);
  return state;
}

function useFlag(flag: Flag): boolean {
  const [value, setValue] = useState(() => flag.get());
  useEffect(() => {
    const update = () => setValue(flag.get());
    const stop = flag.subscribe(update);
    update();
    return stop;
  }, [flag]);
  return value;
}

function useRoute(): Route {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener("hashchange", onChange);
    onChange();
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return useMemo(() => parseRoute(hash), [hash]);
}

/** The browser bar takes the active field's colour in the current scheme (DESIGN.md signature). */
function useThemeColor(tab: Tab): void {
  useEffect(() => {
    const apply = () => {
      const colour = getComputedStyle(document.documentElement).getPropertyValue(`--field-${tab}`).trim();
      if (colour !== "") for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", colour);
    };
    apply();
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", apply);
    return () => scheme.removeEventListener("change", apply);
  }, [tab]);
}

/** `banner`: a line above the status lines on every screen (the demo's). */
export function App({ sync, update, banner }: { sync: Sync; update: Update; banner?: ComponentChildren }) {
  const state = useSync(sync);
  const route = useRoute();
  const updateReady = useFlag(update.ready);
  const [bar, setBar] = useState<{ opIds: string[]; label: string } | null>(null);
  useThemeColor(route.tab);

  const act: Act = (type, payload, label) => {
    void sync.tap(type, payload, label).then((opId) => setBar({ opIds: [opId], label }));
  };
  const actMany: ActMany = (ops, label) => {
    if (ops.length === 0) return;
    void sync.tapMany(ops, label).then((opIds) => setBar({ opIds, label }));
  };
  // the bar goes only with its own op: an untick under « Dans le panier » undoes another one
  const undo: Undo = (targetOpId, label) => {
    setBar((current) => (current?.opIds.includes(targetOpId) ? null : current));
    void sync.undo(targetOpId, label);
  };
  const view = state.view;

  return (
    <div class="shell" data-tab={route.tab} data-undo={bar !== null ? "" : undefined}>
      <header class="field">
        <h1>{TAB_TITLE[route.tab]}</h1>
        {view !== null && <p>{countLine(route.tab, counts(view)[route.tab])}</p>}
      </header>
      <StatusLines state={state} sync={sync} updateReady={updateReady} onUpdate={update.apply} banner={banner} />
      <main>
        {state.loaded && view === null && <p class="empty">Pas encore de liste sur ce téléphone : ouvrez l'app une première fois avec du réseau.</p>}
        {view !== null && <Screen route={route} view={view} act={act} actMany={actMany} undo={undo} refresh={() => sync.refresh()} />}
      </main>
      <footer>
        Made with care by <a href="https://william.revah.paris">William</a>
      </footer>
      {bar !== null && (
        <UndoBar
          key={bar.opIds.join()}
          label={bar.label}
          onUndo={() => { for (const opId of bar.opIds) undo(opId, bar.label); }}
          onExpire={() => setBar((current) => (current === bar ? null : current))}
        />
      )}
      <nav class="tabs" aria-label="Listes">
        {TABS.map((tab) => (
          <a key={tab} class="tab" href={href({ tab, path: [] })} aria-current={tab === route.tab ? "page" : undefined}>
            {TAB_TITLE[tab]}
          </a>
        ))}
      </nav>
    </div>
  );
}

function Screen({ route, view, act, actMany, undo, refresh }: { route: Route; view: View; act: Act; actMany: ActMany; undo: Undo; refresh: () => Promise<void> }) {
  if (route.tab === "courses") return <CoursesScreen route={route} view={view} act={act} actMany={actMany} undo={undo} refresh={refresh} />;
  if (route.tab === "reste") return <ResteScreen route={route} view={view} act={act} />;
  return <MenuScreen route={route} view={view} act={act} undo={undo} refresh={refresh} />;
}
