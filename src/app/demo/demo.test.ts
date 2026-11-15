import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { addDays, parisDate } from "../../domain/dates";
import { invariantViolations, mealShortfalls } from "../../domain/invariants";
import { snapshot } from "../../domain/snapshot";
import { bootSync } from "../boot";
import { idbStore } from "../sync/store";
import { DEMO_RESET_KEY, DEMO_STATE_KEY, FIXTURES_MAX_AGE_DAYS, demoNetwork, isOtherGeneration, openDemo, prepareDemo, requestReset, type KeyValue } from "./boot";
import { demoRecipes, demoState } from "./fixtures";

const NOW = "2026-11-15T18:00:00.000Z";

/** `localStorage` as the demo uses it, in memory. */
function memoryStorage(): KeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

let uuids = 0;

/** One boot of the demo app, as main.tsx runs it: prepareDemo, then the sync store over the same IndexedDB. */
async function boot(storage: KeyValue, indexedDB: IDBFactory, net: { online: boolean }, now = NOW, onStale?: () => void) {
  const { store, dbName, generation } = await prepareDemo({ storage, indexedDB, now: () => now, onStale });
  const sync = await bootSync(async () => ({ store: await idbStore(indexedDB, dbName), persistent: true }), {
    fetch: demoNetwork(store, () => now).fetch,
    now: () => now,
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`,
    isOnline: () => net.online,
    isVisible: () => true,
    schedule: () => () => undefined,
  });
  await sync.refresh();
  return { sync, store, dbName, generation };
}

describe("demo fixtures", () => {
  // the planning rules depend on the month (season), so the fixtures are made on a day of every month
  it.each(Array.from({ length: 12 }, (_, m) => `2026-${String(m + 1).padStart(2, "0")}-15T10:00:00.000Z`))(
    "pass every planning rule and keep the domain invariants, made on %s",
    (now) => {
      const state = demoState(now); // throws if the domain refuses any fixture op
      expect(invariantViolations(state)).toEqual([]);
      expect(mealShortfalls(state)).toEqual([]);
      const snap = snapshot(state, now);
      expect(state.meals).toHaveLength(demoRecipes().length);
      expect(snap.menu.pool).toHaveLength(demoRecipes().length - 1); // one is cooked
      expect(snap.menu.recentlyCooked).toHaveLength(1);
      expect(snap.courses.lines.some((l) => l.boughtAt === null)).toBe(true);
      expect(snap.courses.lines.some((l) => l.boughtAt !== null)).toBe(true);
    },
  );

  it("control: the invariant check does report a broken fixture", () => {
    const state = demoState(NOW);
    const held = state.reservations[0]!.stockItemId;
    state.stockItems = state.stockItems.filter((s) => s.id !== held); // a reservation on an item that is gone
    expect(invariantViolations(state)).not.toEqual([]);
  });

  it("dates Reste from the day they are made", () => {
    for (const now of [NOW, "2027-03-02T08:00:00.000Z"]) {
      const today = parisDate(now);
      const reste = snapshot(demoState(now), now).reste;
      expect(reste.urgent.find((i) => i.label === "crème fraîche")).toMatchObject({ useBy: addDays(today, 1), daysLeft: 1 });
      expect([...reste.libre, ...reste.reserved].find((i) => i.label === "soupe de potiron")).toMatchObject({ useBy: addDays(today, 3) });
    }
  });
});

describe("demo boot", () => {
  it("starts on the fixtures the first time", async () => {
    const storage = memoryStorage();
    const { sync } = await boot(storage, new IDBFactory(), { online: true });
    expect(sync.getState()).toMatchObject({ loaded: true, waitingCount: 0, status: "online" });
    expect(sync.getState().view!.menu.pool.map((m) => m.title)).toContain(demoRecipes()[1]!.title);
    expect(JSON.parse(storage.map.get(DEMO_STATE_KEY)!).generatedOn).toBe(parisDate(NOW));
  });

  it("answers taps from the in-page server, kept in storage across boots", async () => {
    const storage = memoryStorage();
    const indexedDB = new IDBFactory();
    const first = await boot(storage, indexedDB, { online: true });
    const line = first.sync.getState().view!.courses.lines.find((l) => l.boughtAt === null)!;
    await first.sync.tap("shopping.buy", { itemId: line.id }, `Acheté : ${line.label}`);
    await first.sync.flush();
    expect(first.sync.getState().waitingCount).toBe(0);
    const again = await boot(storage, indexedDB, { online: true });
    expect(again.sync.getState().view!.courses.lines.find((l) => l.id === line.id)!.boughtAt).not.toBeNull();
  });

  it("Réinitialiser, then the boot: the fixtures again, with an empty outbox", async () => {
    const storage = memoryStorage();
    const indexedDB = new IDBFactory();
    const net = { online: true };
    const first = await boot(storage, indexedDB, net);
    const [sent, held] = first.sync.getState().view!.courses.lines.filter((l) => l.boughtAt === null);
    await first.sync.tap("shopping.buy", { itemId: sent!.id }, "Acheté");
    await first.sync.flush();
    net.online = false;
    await first.sync.tap("shopping.buy", { itemId: held!.id }, "Acheté"); // waits in the outbox, in IndexedDB
    expect(first.sync.getState().waitingCount).toBe(1);

    let reloads = 0;
    requestReset(storage, () => (reloads += 1));
    expect(reloads).toBe(1);
    net.online = true;
    const after = await boot(storage, indexedDB, net);
    expect(after.sync.getState().waitingCount).toBe(0);
    expect(await (await idbStore(indexedDB, after.dbName)).readOutbox()).toEqual([]);
    const lines = after.sync.getState().view!.courses.lines;
    expect(lines.find((l) => l.id === sent!.id)!.boughtAt).toBeNull();
    expect(lines.find((l) => l.id === held!.id)!.boughtAt).toBeNull();
    expect(after.store.load()).toEqual(demoState(NOW));
    expect(storage.map.has(DEMO_RESET_KEY)).toBe(false);
  });

  // Regression: 6b5f9f0 — a reset isolated only the tab that reloaded: another open tab kept its outbox in memory,
  // reopened the new IndexedDB after versionchange and sent its ops onto the new fixtures, whose ids are the same. Each
  // generation of fixtures now has its own id and database; a tab of another generation is refused and reloads.
  it.each([
    ["Réinitialiser", (storage: KeyValue) => requestReset(storage, () => undefined), NOW],
    ["the weekly refresh", () => undefined, `${addDays(parisDate(NOW), FIXTURES_MAX_AGE_DAYS + 1)}T18:00:00.000Z`],
  ] as const)("after %s in tab A, tab B's queued op never lands on the new fixtures", async (_, reset, later) => {
    const storage = memoryStorage();
    const indexedDB = new IDBFactory();
    const netB = { online: true };
    let staleB = 0;
    const b = await boot(storage, indexedDB, netB, NOW, () => (staleB += 1));
    const [early, late] = b.sync.getState().view!.courses.lines.filter((l) => l.boughtAt === null);
    netB.online = false;
    await b.sync.tap("shopping.buy", { itemId: early!.id }, "Acheté"); // queued before the reset
    expect(b.sync.getState().waitingCount).toBe(1);

    reset(storage);
    const a = await boot(storage, indexedDB, { online: true }, later); // tab A's boot makes the fixtures again
    expect(a.generation).not.toBe(b.generation);

    await b.sync.tap("shopping.buy", { itemId: late!.id }, "Acheté"); // queued after it, before B reloads
    netB.online = true;
    await b.sync.flush();
    const fresh = demoState(later);
    expect(a.store.load()).toEqual(fresh);
    expect(staleB).toBeGreaterThan(0); // B's server refused, and asked for the reload

    const reloaded = await boot(storage, indexedDB, { online: true }, later, () => (staleB += 1));
    expect(reloaded.generation).toBe(a.generation);
    expect(reloaded.sync.getState().waitingCount).toBe(0);
    await reloaded.sync.flush();
    expect(a.store.load()).toEqual(fresh);
    expect(reloaded.sync.getState().view!.courses.lines.find((l) => l.id === early!.id)!.boughtAt).toBeNull();
    expect(reloaded.sync.getState().view!.courses.lines.find((l) => l.id === late!.id)!.boughtAt).toBeNull();
  });

  it("control: without a reset, tab B's queued op does land, and B is never asked to reload", async () => {
    const storage = memoryStorage();
    const indexedDB = new IDBFactory();
    const netB = { online: true };
    let staleB = 0;
    const b = await boot(storage, indexedDB, netB, NOW, () => (staleB += 1));
    const line = b.sync.getState().view!.courses.lines.find((l) => l.boughtAt === null)!;
    netB.online = false;
    await b.sync.tap("shopping.buy", { itemId: line.id }, "Acheté");
    const a = await boot(storage, indexedDB, { online: true });
    expect(a.generation).toBe(b.generation);
    netB.online = true;
    await b.sync.flush();
    expect(b.sync.getState().waitingCount).toBe(0);
    expect(a.store.load().shoppingItems.find((l) => l.id === line.id)!.boughtAt).not.toBeNull();
    expect(staleB).toBe(0);
  });

  it("tells a storage event of another generation from one of this tab's", async () => {
    const storage = memoryStorage();
    const { generation } = await prepareDemo({ storage, indexedDB: null, now: () => NOW });
    const own = storage.getItem(DEMO_STATE_KEY);
    expect(isOtherGeneration(own, generation)).toBe(false); // another tab of this generation wrote: no reload
    requestReset(storage, () => undefined);
    await prepareDemo({ storage, indexedDB: null, now: () => NOW });
    expect(isOtherGeneration(storage.getItem(DEMO_STATE_KEY), generation)).toBe(true);
    expect(isOtherGeneration(null, generation)).toBe(true); // the entry removed (site data cleared)
  });

  it("control: the same boot without the marker keeps the outbox and the server's state", async () => {
    const storage = memoryStorage();
    const indexedDB = new IDBFactory();
    const net = { online: true };
    const first = await boot(storage, indexedDB, net);
    const [sent, held] = first.sync.getState().view!.courses.lines.filter((l) => l.boughtAt === null);
    await first.sync.tap("shopping.buy", { itemId: sent!.id }, "Acheté");
    await first.sync.flush();
    net.online = false;
    await first.sync.tap("shopping.buy", { itemId: held!.id }, "Acheté");
    const after = await boot(storage, indexedDB, net);
    expect(after.sync.getState().waitingCount).toBe(1);
    expect(after.store.load().shoppingItems.find((l) => l.id === sent!.id)!.boughtAt).not.toBeNull();
  });

  it(`makes the fixtures again when they are more than ${FIXTURES_MAX_AGE_DAYS} days old, and keeps them until then`, async () => {
    const made = "2026-11-01T10:00:00.000Z";
    for (const [days, regenerated] of [[FIXTURES_MAX_AGE_DAYS, false], [FIXTURES_MAX_AGE_DAYS + 1, true]] as const) {
      const storage = memoryStorage();
      await prepareDemo({ storage, indexedDB: new IDBFactory(), now: () => made }); // the fixtures made on `made`
      const now = `${addDays(parisDate(made), days)}T10:00:00.000Z`;
      const { store } = await prepareDemo({ storage, indexedDB: new IDBFactory(), now: () => now });
      expect(JSON.parse(storage.map.get(DEMO_STATE_KEY)!).generatedOn, `${days} days`).toBe(regenerated ? parisDate(now) : parisDate(made));
      expect(store.load(), `${days} days`).toEqual(demoState(regenerated ? now : made));
    }
  });

  // Regression: 346a138 — read() took any string for generatedOn and any object, null included, for state: a corrupt
  // date made daysBetween NaN (NaN > 7 is false) and a date in the future a negative age, so neither was ever made
  // again, and a null state reached the server.
  it.each<[string, unknown]>([
    ["a generatedOn that is no date", { generation: "g", generatedOn: "garbage", state: demoState("2026-11-14T10:00:00.000Z") }],
    ["a day that does not exist", { generation: "g", generatedOn: "2026-02-30", state: demoState("2026-11-14T10:00:00.000Z") }],
    ["a month that does not exist", { generation: "g", generatedOn: "2026-13-45", state: demoState("2026-11-14T10:00:00.000Z") }],
    ["a generatedOn two days ahead", { generation: "g", generatedOn: "2026-11-17", state: demoState("2026-11-14T10:00:00.000Z") }],
    ["a null state", { generation: "g", generatedOn: "2026-11-14", state: null }],
    ["a state that is an array", { generation: "g", generatedOn: "2026-11-14", state: [] }],
    ["a stored array", []],
    ["a stored null", null],
  ])("makes the fixtures again over %s", async (_, stored) => {
    const storage = memoryStorage();
    storage.setItem(DEMO_STATE_KEY, JSON.stringify(stored));
    const { store } = await prepareDemo({ storage, indexedDB: new IDBFactory(), now: () => NOW });
    expect(JSON.parse(storage.map.get(DEMO_STATE_KEY)!).generatedOn).toBe(parisDate(NOW));
    expect(store.load()).toEqual(demoState(NOW));
  });

  it("control: fixtures made yesterday, or dated tomorrow by a clock a few hours off, are kept", async () => {
    for (const day of [addDays(parisDate(NOW), -1), addDays(parisDate(NOW), 1)]) {
      const storage = memoryStorage();
      const made = demoState("2026-11-14T10:00:00.000Z");
      storage.setItem(DEMO_STATE_KEY, JSON.stringify({ generatedOn: day, generation: "g", state: made }));
      const { store } = await prepareDemo({ storage, indexedDB: new IDBFactory(), now: () => NOW });
      expect(store.load(), day).toEqual(made);
    }
  });

  it("refuses every request but the in-page server's", async () => {
    const { store } = await prepareDemo({ storage: memoryStorage(), indexedDB: null, now: () => NOW });
    const network = demoNetwork(store, () => NOW);
    await expect(network.refuse("https://example.com/")).rejects.toThrow(TypeError);
    expect((await network.fetch("/api/history", { method: "GET" })).status).toBe(404);
  });
});

// Regression: a page that may not touch localStorage (Chrome with site data blocked throws SecurityError on the first
// access) or has no IndexedDB made prepareDemo reject before render, so the demo stayed a blank page where the real app
// opens on memory. openDemo falls back to memory and opens on the fixtures.
describe("demo boot without the browser's storage", () => {
  function denied(): never {
    throw new DOMException("denied", "SecurityError");
  }
  const blocked: KeyValue = { getItem: denied, setItem: denied, removeItem: denied };

  it.each<[string, () => KeyValue, () => IDBFactory | null | undefined]>([
    ["localStorage throws, no IndexedDB", () => blocked, () => null],
    ["localStorage throws on access, IndexedDB too", denied, denied],
    ["localStorage works, no IndexedDB", () => memoryStorage(), () => undefined],
    ["localStorage works, IndexedDB throws", () => memoryStorage(), denied],
  ])("opens on the fixtures: %s", async (_, storage, indexedDB) => {
    const { store, storage: used } = await openDemo({ storage, indexedDB, now: () => NOW });
    expect(store.load()).toEqual(demoState(NOW));
    const response = await demoNetwork(store, () => NOW).fetch("/api/state", { method: "GET" });
    expect(response.status).toBe(200);
    // « Réinitialiser » goes to the storage the demo ended up on, and so does not throw either
    let reloads = 0;
    requestReset(used, () => (reloads += 1));
    expect(reloads).toBe(1);
  });

  it("control: prepareDemo alone rejects on the same blocked storage", async () => {
    await expect(prepareDemo({ storage: blocked, indexedDB: null, now: () => NOW })).rejects.toThrow("denied");
  });

  it("control: with working storage, openDemo keeps the browser's, not a copy in memory", async () => {
    const storage = memoryStorage();
    const { storage: used } = await openDemo({ storage: () => storage, indexedDB: () => new IDBFactory(), now: () => NOW });
    expect(used).toBe(storage);
    expect(storage.map.has(DEMO_STATE_KEY)).toBe(true);
  });
});
