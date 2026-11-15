import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { snapshot } from "../../domain/snapshot";
import { applyOp } from "../../domain/ops/apply";
import { NOW, fixtureProposal, fixtureState, op } from "../../domain/test-fixtures";
import { idbStore } from "./store";
import type { OutboxEntry } from "./types";

const entry = (opId: string, seq: number): OutboxEntry => ({
  op: { opId, type: "shopping.add", at: NOW, payload: { label: "sel", isFood: true } }, label: "Ajouté : sel", seq, sends: 0, unrecorded: 0, failed: false,
  lastReason: null,
});

/** A fresh IndexedDB, and every connection the store opens on it, in order. */
function factory(): { indexedDB: IDBFactory; opened: IDBDatabase[] } {
  const indexedDB = new IDBFactory();
  const opened: IDBDatabase[] = [];
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (name: string, version?: number) => {
    const request = open(name, version);
    request.addEventListener("success", () => opened.push(request.result));
    return request;
  };
  return { indexedDB, opened };
}

describe("idbStore", () => {
  it("keeps the snapshot and the outbox, one record per op", async () => {
    const { indexedDB } = factory();
    const store = await idbStore(indexedDB);
    await store.write({ snapshot: snapshot(fixtureState(), NOW), put: [entry("b", 2), entry("a", 1)], remove: [] });
    await store.write({ put: [], remove: ["b"] });
    expect((await store.readOutbox()).map((e) => e.op.opId)).toEqual(["a"]);
    expect((await store.readSnapshot())?.version).toBe(0);
  });

  // the snapshot an older build stored has no `nutrition` on its pool meals; the new build reads it back as is
  it("reads back a snapshot whose pool meals have no nutrition", async () => {
    const planned = snapshot(applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state, NOW);
    const older = { ...planned, menu: { ...planned.menu, pool: planned.menu.pool.map(({ nutrition: _, ...m }) => m) } };
    const store = await idbStore(factory().indexedDB);
    await store.write({ snapshot: older as typeof planned, put: [], remove: [] });
    const read = await store.readSnapshot();
    expect(read).toEqual(older);
    expect(read!.menu.pool.length).toBeGreaterThan(0);
    expect(read!.menu.pool.every((m) => !("nutrition" in m))).toBe(true);
  });

  // Regression: b9febef — a closed IndexedDB connection was never reopened: every later read and write threw until the app was restarted
  it("reopens a connection closed under it, retrying once the transaction refused InvalidStateError", async () => {
    const { indexedDB, opened } = factory();
    const store = await idbStore(indexedDB);
    await store.write({ put: [entry("a", 1)], remove: [] });
    opened[0]!.close(); // lost without a close event
    await store.write({ put: [entry("b", 2)], remove: [] });
    expect((await store.readOutbox()).map((e) => e.op.opId)).toEqual(["a", "b"]);
    expect(opened).toHaveLength(2);
  });

  /** Makes every transaction of this connection fail some time after it started, as WebKit does once it lost the server. */
  function failAsynchronously(db: IDBDatabase): void {
    const lost = new DOMException("Connection to Indexed Database server lost", "UnknownError");
    const request = (): IDBRequest => {
      const r = {} as IDBRequest;
      setTimeout(() => (r.onerror as (() => void) | null)?.(), 0);
      Object.defineProperty(r, "error", { value: lost });
      return r;
    };
    db.transaction = (() => {
      const tx = {} as IDBTransaction;
      Object.defineProperty(tx, "error", { value: lost });
      setTimeout(() => (tx.onerror as (() => void) | null)?.(), 0);
      tx.objectStore = (() => ({ put: request, delete: request, clear: request, get: request, getAll: request })) as never;
      return tx;
    }) as never;
  }

  // Regression: 223a185 — an UnknownError failing a request or transaction after it began left the dead connection cached, so every later read and write rejected until the app restarted
  it("opens a new connection when a write fails asynchronously with UnknownError, and writes again on it", async () => {
    const { indexedDB, opened } = factory();
    const store = await idbStore(indexedDB);
    failAsynchronously(opened[0]!);
    await store.write({ put: [entry("a", 1)], remove: [] });
    expect(opened).toHaveLength(2);
    expect((await store.readOutbox()).map((e) => e.op.opId)).toEqual(["a"]);
  });

  it("opens a new connection when a read fails asynchronously with UnknownError", async () => {
    const { indexedDB, opened } = factory();
    const store = await idbStore(indexedDB);
    await store.write({ put: [entry("a", 1)], remove: [] });
    failAsynchronously(opened[0]!);
    expect((await store.readOutbox()).map((e) => e.op.opId)).toEqual(["a"]);
    expect(opened).toHaveLength(2);
  });

  it("gives up after one retry, and still opens a new connection for the next call", async () => {
    const { indexedDB, opened } = factory();
    const store = await idbStore(indexedDB);
    failAsynchronously(opened[0]!);
    const real = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name: string, version?: number) => {
      const r = real(name, version);
      r.addEventListener("success", () => failAsynchronously(r.result));
      return r;
    };
    await expect(store.write({ put: [entry("a", 1)], remove: [] })).rejects.toMatchObject({ name: "UnknownError" });
    expect(opened).toHaveLength(2);
    indexedDB.open = real;
    await store.write({ put: [entry("b", 2)], remove: [] });
    expect(opened).toHaveLength(3);
  });

  it("opens a new connection on the next use once the browser closes this one (close event)", async () => {
    const { indexedDB, opened } = factory();
    const store = await idbStore(indexedDB);
    opened[0]!.onclose?.call(opened[0]!, new Event("close"));
    await store.write({ put: [entry("a", 1)], remove: [] });
    expect(opened).toHaveLength(2);
    expect((await store.readOutbox()).map((e) => e.op.opId)).toEqual(["a"]);
  });

  it("closes its connection when another page upgrades the database, so that upgrade is not blocked", async () => {
    const { indexedDB } = factory();
    await idbStore(indexedDB);
    const outcome = await new Promise<string>((resolve) => {
      const upgrade = indexedDB.open("la-table", 2);
      upgrade.onblocked = () => resolve("blocked");
      upgrade.onsuccess = () => {
        upgrade.result.close();
        resolve("upgraded");
      };
    });
    expect(outcome).toBe("upgraded");
  });
});
