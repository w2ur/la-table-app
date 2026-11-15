import type { Snapshot } from "../../domain/snapshot";
import type { OutboxEntry } from "./types";

/**
 * Where the phone keeps the last snapshot and the outbox (spec §8.3), one record per op, keyed by its id.
 *
 * One app instance at a time: each `Sync` holds its own outbox in memory over this store, and
 * nothing coordinates two (no lock, no BroadcastChannel). A second live tab would still hold, and send, an op the first
 * cancelled, and its write would put the op back on disk.
 */
export interface SyncStore {
  readSnapshot(): Promise<Snapshot | null>;
  readOutbox(): Promise<OutboxEntry[]>;
  /** Writes one change whole or not at all, so an app killed during it never leaves half an outbox rule applied. */
  write(change: StoreWrite): Promise<void>;
}

/**
 * One change of the stored state: a new snapshot, outbox entries added or changed, and outbox entries gone (by op id).
 * With `replace`, the stored outbox becomes exactly `put` (`remove` is ignored): what `Sync` writes after a refused write,
 * whose change would otherwise never reach the disk.
 */
export interface StoreWrite {
  snapshot?: Snapshot;
  put: readonly OutboxEntry[];
  remove: readonly string[];
  replace?: boolean;
}

const bySeq = (a: OutboxEntry, b: OutboxEntry): number => a.seq - b.seq || a.op.opId.localeCompare(b.op.opId);

/** Tests, and the fallback when IndexedDB is unavailable (the app then says offline taps are lost on close). */
export function memoryStore(): SyncStore {
  let snapshot: Snapshot | null = null;
  const outbox = new Map<string, OutboxEntry>();
  return {
    readSnapshot: async () => (snapshot === null ? null : structuredClone(snapshot)),
    readOutbox: async () => [...outbox.values()].map((e) => structuredClone(e)).sort(bySeq),
    write: async (change) => {
      if (change.snapshot) snapshot = structuredClone(change.snapshot);
      if (change.replace) outbox.clear();
      for (const e of change.put) outbox.set(e.op.opId, structuredClone(e));
      for (const opId of change.remove) outbox.delete(opId);
    },
  };
}

/** The IndexedDB database the phone keeps its snapshot and outbox in (the demo opens one per generation instead). */
export const DB_NAME = "la-table";
const DB_VERSION = 1;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const open = factory.open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("snapshot")) db.createObjectStore("snapshot");
    if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox");
  };
  return request(open);
}

/**
 * The store over IndexedDB. Its connection can close under the app: WebKit drops it once the installed app has been in
 * the background a while (« Connection to Indexed Database server lost », the `close` event), and a page upgrading the
 * database asks this one to close (`versionchange`). The next read or write then opens a new one, and a transaction
 * refused or failed by a connection lost without notice (InvalidStateError, UnknownError) is tried once more on a new
 * one. Opening fails as before when IndexedDB is unavailable, so `openSyncStore` falls back to memory.
 */
export async function idbStore(factory: IDBFactory = indexedDB, name: string = DB_NAME): Promise<SyncStore> {
  let db: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  const connect = (): Promise<IDBDatabase> => {
    if (db !== null) return Promise.resolve(db);
    opening ??= openDb(factory, name)
      .then((opened) => {
        const drop = () => {
          if (db === opened) db = null;
        };
        opened.onclose = drop;
        opened.onversionchange = () => {
          opened.close();
          drop();
        };
        db = opened;
        return opened;
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  };
  const isLost = (error: unknown): boolean =>
    error instanceof DOMException && (error.name === "InvalidStateError" || error.name === "UnknownError");
  // one transaction run to its end, and tried once more on a new connection when this one was lost, whether it refused
  // the transaction at once or failed it later (WebKit reports « Connection to Indexed Database server lost » both ways)
  const run = async <T>(names: string | string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const used = await connect();
      try {
        return await work(used.transaction(names, mode));
      } catch (error: unknown) {
        if (!isLost(error)) throw error;
        if (db === used) db = null;
        if (attempt > 0) throw error;
      }
    }
  };
  await connect();
  return {
    readSnapshot: async () => ((await run("snapshot", "readonly", (tx) => request(tx.objectStore("snapshot").get("current")))) as Snapshot | undefined) ?? null,
    readOutbox: async () => ((await run("outbox", "readonly", (tx) => request(tx.objectStore("outbox").getAll()))) as OutboxEntry[]).sort(bySeq),
    // one transaction over the stores it touches, resolved once it commits: an op is on disk before it is sent
    write: async (change) => {
      const outboxChanges = change.replace === true || change.put.length + change.remove.length > 0;
      const names = [...(change.snapshot ? ["snapshot"] : []), ...(outboxChanges ? ["outbox"] : [])];
      if (names.length === 0) return;
      await run(names, "readwrite", (tx) => {
        if (change.snapshot) tx.objectStore("snapshot").put(change.snapshot, "current");
        if (outboxChanges) {
          const outbox = tx.objectStore("outbox");
          if (change.replace) outbox.clear();
          for (const e of change.put) outbox.put(e, e.op.opId);
          for (const opId of change.remove) outbox.delete(opId);
        }
        return done(tx);
      });
    },
  };
}

export async function openSyncStore(name: string = DB_NAME): Promise<{ store: SyncStore; persistent: boolean }> {
  try {
    return { store: await idbStore(indexedDB, name), persistent: true };
  } catch {
    return { store: memoryStore(), persistent: false };
  }
}
