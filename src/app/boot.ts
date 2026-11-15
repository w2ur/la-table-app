import { memoryStore, type SyncStore } from "./sync/store";
import { Sync, type SyncDeps } from "./sync/sync";

type Opened = { store: SyncStore; persistent: boolean };
type Deps = Omit<SyncDeps, "store" | "persistent">;

/** How long the local store gets to open and be read before the app starts without it. */
export const STORE_TIMEOUT_MS = 3000;

async function inMemory(deps: Deps): Promise<Sync> {
  const fallback = new Sync({ ...deps, store: memoryStore(), persistent: false });
  await fallback.load();
  return fallback;
}

/**
 * The `Sync` the app runs on, loaded. A store that opened but cannot be read (IndexedDB refusing the first read, as
 * WebKit does once its connection is lost) falls back to memory: the app still opens, says « Stockage local
 * indisponible », and works from the network, rather than stay a blank page.
 */
export async function loadSync(opened: Opened, deps: Deps): Promise<Sync> {
  const sync = new Sync({ ...deps, ...opened });
  try {
    await sync.load();
    return sync;
  } catch (error: unknown) {
    console.error("la-table: stockage local illisible", error);
    return inMemory(deps);
  }
}

/**
 * Opens the store and loads the `Sync` from it, in at most `timeoutMs`. WebKit's other IndexedDB failure is an open (or
 * a first read) that never settles: the app then starts on memory, with the same « Stockage local indisponible »
 * line, rather than stay a blank page. A store that answers late is dropped.
 */
export async function bootSync(open: () => Promise<Opened>, deps: Deps, timeoutMs: number = STORE_TIMEOUT_MS): Promise<Sync> {
  let cancel = (): void => undefined;
  const timeout = new Promise<null>((resolve) => {
    cancel = deps.schedule(() => resolve(null), timeoutMs);
  });
  try {
    const loaded = await Promise.race([open().then((opened) => loadSync(opened, deps)).catch(() => null), timeout]);
    if (loaded !== null) return loaded;
  } finally {
    cancel();
  }
  console.error("la-table: stockage local sans réponse");
  return inMemory(deps);
}
