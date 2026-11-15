import { daysBetween, parisDate } from "../../domain/dates";
import type { State } from "../../domain/types";
import type { Fetcher } from "../sync/api";
import { localServer, type StateStore } from "../sync/local-server";
import { DB_NAME } from "../sync/store";
import { demoState } from "./fixtures";

/** The demo's server state in `localStorage`: the day its fixtures were made, their generation, and the state. */
export const DEMO_STATE_KEY = "la-table-demo:server";
/** Set by « Réinitialiser », read and cleared at the next boot. */
export const DEMO_RESET_KEY = "la-table-demo:reset";
/** Fixtures older than this many days are made again at boot, so the week and its use-by dates stay current. */
export const FIXTURES_MAX_AGE_DAYS = 7;

export type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface Stored {
  generatedOn: string;
  /** Made anew with the fixtures: a tab booted on another generation is fenced off (demoStateStore, demoDbName). */
  generation: string;
  state: State;
}

/**
 * The IndexedDB database a tab of this generation keeps its snapshot and outbox in. One per generation, so a tab left
 * open across another tab's reset writes its outbox into a database no later boot reads, rather than into the one the
 * new generation opens.
 */
export const demoDbName = (generation: string): string => `${DB_NAME}-demo-${generation}`;
const DEMO_DB_PREFIX = demoDbName("");

/** Thrown by a stale tab's server: its ops never reach the state of another generation. */
export class StaleDemoTab extends Error {
  constructor() {
    super("démo : réinitialisée dans un autre onglet");
  }
}

/** A calendar day as parisDate writes it, and one that exists (`2026-02-30` does not). */
function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value}T12:00:00Z`); // NaN on a month 13: toISOString would throw on it
  return !Number.isNaN(at) && new Date(at).toISOString().startsWith(value);
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The stored fixtures, or null for anything else: unparsable text, a non-object, a state that is not an object, a
 * generatedOn that is not a real day, no generation. Null makes them again, as a missing entry does.
 */
function parse(text: string | null): Stored | null {
  let stored: unknown;
  try {
    stored = JSON.parse(text ?? "null");
  } catch {
    return null;
  }
  if (!isObject(stored)) return null;
  const { generatedOn, generation, state } = stored as Partial<Stored>;
  return isDay(generatedOn) && typeof generation === "string" && generation !== "" && isObject(state) ? (stored as Stored) : null;
}

const read = (storage: KeyValue): Stored | null => parse(storage.getItem(DEMO_STATE_KEY));

function fresh(storage: KeyValue, now: string, generation: string): Stored {
  const stored = { generatedOn: parisDate(now), generation, state: demoState(now) };
  storage.setItem(DEMO_STATE_KEY, JSON.stringify(stored));
  return stored;
}

/**
 * Resolves once IndexedDB has deleted the database, or refused to; an open queued after it waits for the deletion. No
 * IndexedDB, or one that throws (blocked site data): nothing to delete, the sync store falls back to memory as well.
 */
function deleteDatabase(factory: IDBFactory | null, name: string): Promise<void> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      if (factory === null) return resolve();
      request = factory.deleteDatabase(name);
    } catch {
      return resolve();
    }
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    // another tab still holds a connection: it closes on `versionchange` (store.ts), and the deletion then goes ahead
    request.onblocked = () => resolve();
  });
}

/**
 * The server's state over `storage` for a tab booted on `generation`, read and written on every request. Once another
 * tab has made the fixtures again (a reset, the weekly refresh) or the entry is gone, this tab's requests are refused
 * (StaleDemoTab, before anything is applied or written) and `onStale` reloads it: no op queued on the old fixtures lands
 * on the new ones, whose ids are the same.
 */
export function demoStateStore(storage: KeyValue, generation: string, onStale: () => void = () => undefined): StateStore {
  const current = (): Stored => {
    const stored = read(storage);
    if (stored === null || stored.generation !== generation) {
      onStale();
      throw new StaleDemoTab();
    }
    return stored;
  };
  return {
    load: () => current().state,
    save: (state) => {
      const { generatedOn } = current();
      storage.setItem(DEMO_STATE_KEY, JSON.stringify({ generatedOn, generation, state }));
    },
  };
}

/** Whether a `storage` event's new value for DEMO_STATE_KEY belongs to another generation than this tab's. */
export function isOtherGeneration(newValue: string | null, generation: string): boolean {
  return parse(newValue)?.generation !== generation;
}

/**
 * Deletes every demo database but the current generation's, and the real app's name, which demo builds before the
 * generations used. Without `databases()` (older engines), the previous generation's, when there was one.
 */
async function sweepDatabases(factory: IDBFactory | null, keep: string, previous: string | null): Promise<void> {
  let names: string[];
  try {
    names = factory?.databases ? (await factory.databases()).flatMap((d) => (d.name === undefined ? [] : [d.name])) : [DB_NAME, ...(previous === null ? [] : [demoDbName(previous)])];
  } catch {
    names = [];
  }
  for (const name of names) if (name !== keep && (name === DB_NAME || name.startsWith(DEMO_DB_PREFIX))) await deleteDatabase(factory, name);
}

export interface DemoDeps {
  storage: KeyValue;
  indexedDB: IDBFactory | null;
  now: () => string;
  /** A new generation's id; crypto.randomUUID in the page. */
  uuid?: () => string;
  /** Reloads this tab once its generation is no longer the stored one. */
  onStale?: () => void;
}

/** The demo as one tab runs it: its server, the database its sync store opens, and the generation both belong to. */
export interface DemoSession {
  store: StateStore;
  dbName: string;
  generation: string;
}

/**
 * Runs before the sync store opens. A reset marker, no valid fixtures, or fixtures made more than FIXTURES_MAX_AGE_DAYS
 * ago or more than a day ahead: the fixtures are made again under a new generation, whose database starts empty, so
 * the app starts on them with an empty outbox. Every tab still on an older generation is fenced off: its server
 * refuses its requests and it reloads (demoStateStore), and its outbox stays in a database of its own generation, which
 * the next boot deletes. The marker is cleared last, so a boot cut halfway resets again.
 */
export async function prepareDemo(deps: DemoDeps): Promise<DemoSession> {
  const now = deps.now();
  let stored = read(deps.storage);
  const age = stored === null ? null : daysBetween(stored.generatedOn, parisDate(now));
  // made more than a day ahead of today (a clock set back, a hand-edited entry) would never age out: stale as well
  const stale = age === null || age > FIXTURES_MAX_AGE_DAYS || age < -1;
  const previous = stored?.generation ?? null;
  if (deps.storage.getItem(DEMO_RESET_KEY) !== null || stale || stored === null) {
    stored = fresh(deps.storage, now, (deps.uuid ?? (() => crypto.randomUUID()))());
  }
  const dbName = demoDbName(stored.generation);
  await sweepDatabases(deps.indexedDB, dbName, previous === stored.generation ? null : previous);
  deps.storage.removeItem(DEMO_RESET_KEY);
  return { store: demoStateStore(deps.storage, stored.generation, deps.onStale), dbName, generation: stored.generation };
}

/** `localStorage` in memory: the demo's when the page may not use the real one. */
export function memoryKeyValue(): KeyValue {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * What main.tsx runs: prepareDemo over the page's `localStorage` and IndexedDB, each read through a getter, since a
 * browser with site data blocked throws on the first touch. Either missing or throwing, the demo still opens, on fresh
 * fixtures in memory, as the real app opens on memory with « Stockage local indisponible »; never a blank page.
 * Returns the storage the demo ended up on, for « Réinitialiser » and the `storage` event.
 */
export async function openDemo(
  deps: Omit<DemoDeps, "storage" | "indexedDB"> & { storage: () => KeyValue; indexedDB: () => IDBFactory | null | undefined },
): Promise<DemoSession & { storage: KeyValue }> {
  let factory: IDBFactory | null;
  try {
    factory = deps.indexedDB() ?? null;
  } catch {
    factory = null;
  }
  const rest = { now: deps.now, uuid: deps.uuid, onStale: deps.onStale };
  try {
    const storage = deps.storage();
    return { ...(await prepareDemo({ ...rest, storage, indexedDB: factory })), storage };
  } catch {
    const storage = memoryKeyValue();
    return { ...(await prepareDemo({ ...rest, storage, indexedDB: factory })), storage };
  }
}

/** « Réinitialiser »: the marker, then a reload, so the reset happens at boot before anything can write. */
export function requestReset(storage: KeyValue, reload: () => void): void {
  storage.setItem(DEMO_RESET_KEY, "1");
  reload();
}

/** The demo's only network: the local server. Anything else the page asks of `fetch` is refused. */
export function demoNetwork(store: StateStore, now: () => string): { fetch: Fetcher; refuse: typeof fetch } {
  return {
    fetch: localServer(store, now),
    refuse: (input) => Promise.reject(new TypeError(`démo : pas de réseau (${String(input)})`)),
  };
}
