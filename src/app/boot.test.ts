import { describe, expect, it, vi } from "vitest";
import { snapshot } from "../domain/snapshot";
import { NOW, fixtureState } from "../domain/test-fixtures";
import { bootSync, loadSync } from "./boot";
import { memoryStore, type SyncStore } from "./sync/store";

const deps = {
  fetch: async () => new Response(null, { status: 503 }),
  now: () => NOW,
  uuid: () => "00000000-0000-4000-8000-000000000001",
  isOnline: () => true,
  isVisible: () => true,
  schedule: () => () => undefined,
};

describe("loadSync", () => {
  it("loads the store it is given", async () => {
    const store = memoryStore();
    await store.write({ snapshot: snapshot(fixtureState(), NOW), put: [], remove: [] });
    const sync = await loadSync({ store, persistent: true }, deps);
    expect(sync.getState()).toMatchObject({ loaded: true, persistent: true });
    expect(sync.getState().view).not.toBeNull();
  });

  // Regression: ed48e5f — an IndexedDB that opened but refused its first read left the page blank and the service worker unregistered
  it("falls back to memory, and says taps no longer persist, when the store cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: SyncStore = {
      readSnapshot: async () => { throw new DOMException("Connection to Indexed Database server lost", "UnknownError"); },
      readOutbox: async () => [],
      write: async () => undefined,
    };
    const sync = await loadSync({ store: broken, persistent: true }, deps);
    expect(sync.getState()).toMatchObject({ loaded: true, persistent: false, view: null });
    await sync.tap("shopping.add", { label: "sel", isFood: true }, "Ajouté : sel");
    expect(sync.getState().waitingCount).toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("bootSync", () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const expired = () => {
    let fire = (): void => undefined;
    return { fire: () => fire(), schedule: (run: () => void) => { fire = run; return () => undefined; } };
  };

  it("starts on the store it opens", async () => {
    const sync = await bootSync(async () => ({ store: memoryStore(), persistent: true }), deps);
    expect(sync.getState()).toMatchObject({ loaded: true, persistent: true });
  });

  // Regression: 811c52c — an IndexedDB open that never settled left the page blank, past the fallback for a read that throws
  it("falls back to memory, and says taps no longer persist, when the store never opens", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const clock = expired();
    const booting = bootSync(() => never(), { ...deps, schedule: clock.schedule });
    clock.fire();
    const sync = await booting;
    expect(sync.getState()).toMatchObject({ loaded: true, persistent: false });
    await sync.tap("shopping.add", { label: "sel", isFood: true }, "Ajouté : sel");
    expect(sync.getState().waitingCount).toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // Regression: 811c52c — a store that opened but whose first read never settled left the page blank
  it("falls back to memory when the first read never settles", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hung: SyncStore = { readSnapshot: () => never(), readOutbox: async () => [], write: async () => undefined };
    const clock = expired();
    const booting = bootSync(async () => ({ store: hung, persistent: true }), { ...deps, schedule: clock.schedule });
    clock.fire();
    expect((await booting).getState()).toMatchObject({ loaded: true, persistent: false });
    error.mockRestore();
  });

  it("falls back to memory when opening throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sync = await bootSync(async () => { throw new Error("denied"); }, { ...deps, schedule: expired().schedule });
    expect(sync.getState()).toMatchObject({ loaded: true, persistent: false });
    error.mockRestore();
  });
});
