import "./archivo.css";
import { render, type ComponentChildren } from "preact";
import { App, type Update } from "./App";
import { bootSync } from "./boot";
import { Flag } from "./flag";
import { applyUpdate, watchForUpdate } from "./sw-register";
import type { Fetcher } from "./sync/api";
import { openSyncStore } from "./sync/store";
import "./styles.css";

// « Se reconnecter » comes back through Access with this marker (sw-logic.ts lets it reach the network); drop it
if (!__LA_TABLE_DEMO__ && new URLSearchParams(location.search).has("reconnexion")) history.replaceState(null, "", `/${location.hash}`);

async function start(): Promise<void> {
  let registration: ServiceWorkerRegistration | null = null;
  const update: Update = {
    ready: new Flag(),
    apply: () => {
      if (registration) applyUpdate(registration, navigator.serviceWorker, () => location.reload());
    },
  };

  // first, and whatever the local store does: an app that cannot read IndexedDB still installs and updates its shell;
  // the demo registers none (vite.config.ts builds none for it)
  if (!__LA_TABLE_DEMO__ && "serviceWorker" in navigator) {
    // offline, registering fails while the worker already installed keeps serving: nothing to report
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    void navigator.serviceWorker.ready.then((reg) => {
      registration = reg;
      watchForUpdate(reg, () => navigator.serviceWorker.controller !== null, () => update.ready.set(true));
    });
  }

  const now = () => new Date().toISOString();
  let network: Fetcher;
  let openStore = () => openSyncStore();
  let banner: ComponentChildren = null;
  if (__LA_TABLE_DEMO__) {
    // imported here, never at the top: a static import keeps the domain modules the demo pulls in (catalogue rules,
    // season exceptions) in the real bundle, where the bundler cannot prove their top-level code pure
    const { demoNetwork, isOtherGeneration, openDemo, requestReset, DEMO_STATE_KEY } = await import("./demo/boot");
    const { DemoBanner } = await import("./demo/DemoBanner");
    // before the sync store opens: a reset or stale fixtures delete it here, so nothing of the last session writes after;
    // read through getters, so a blocked localStorage or IndexedDB opens the demo on memory rather than a blank page
    const reload = () => location.reload();
    const { store, storage, dbName, generation } = await openDemo({ storage: () => localStorage, indexedDB: () => indexedDB, now, onStale: reload });
    // another tab made the fixtures again (« Réinitialiser », the weekly refresh): this one reloads onto them; its server
    // already refuses its ops (demoStateStore), and its outbox stays in its own generation's database
    addEventListener("storage", (event) => {
      if (event.key === DEMO_STATE_KEY && isOtherGeneration(event.newValue, generation)) reload();
    });
    openStore = () => openSyncStore(dbName);
    const demo = demoNetwork(store, now);
    network = demo.fetch;
    globalThis.fetch = demo.refuse;
    banner = <DemoBanner onReset={() => requestReset(storage, () => location.reload())} />;
  } else {
    network = (input, init) => fetch(input, init);
  }

  const sync = await bootSync(openStore, {
    fetch: network,
    now,
    uuid: () => crypto.randomUUID(),
    // the demo's server is in the page: it is never offline
    isOnline: () => __LA_TABLE_DEMO__ || navigator.onLine,
    isVisible: () => document.visibilityState === "visible",
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
  const root = document.getElementById("app");
  if (root) render(<App sync={sync} update={update} banner={banner} />, root);

  // spec §8.3: refresh on open, on coming back to the foreground, on the network returning; never on a timer (only a
  // failed send is retried on one, while visible: sync.ts BACKOFF_MS)
  void sync.refresh();
  addEventListener("online", () => void sync.refresh());
  if (!__LA_TABLE_DEMO__) addEventListener("offline", () => sync.markOffline());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return sync.hidden();
    void sync.refresh();
    registration?.update().catch(() => undefined);
  });
  // an installed app's storage is kept; asking costs nothing elsewhere (spec §8.3: add to the home screen)
  navigator.storage?.persist?.().catch(() => false);
}

void start();
