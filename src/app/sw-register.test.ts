import { describe, expect, it, vi } from "vitest";
import { Flag } from "./flag";
import { applyUpdate, watchForUpdate, type WorkerLike } from "./sw-register";

const worker = (state: string) => Object.assign(new EventTarget(), { state, postMessage: vi.fn() });
const registration = () => Object.assign(new EventTarget(), { waiting: null as WorkerLike | null, installing: null as WorkerLike | null });
const install = (reg: ReturnType<typeof registration>) => {
  const w = worker("installing");
  reg.installing = w;
  reg.dispatchEvent(new Event("updatefound"));
  w.state = "installed";
  w.dispatchEvent(new Event("statechange"));
  return w;
};

describe("updates", () => {
  // a new version waits for « Mettre à jour », never reloads under a thumb
  it("reports a waiting version only when a page is already controlled, and never activates it by itself", () => {
    const reg = registration();
    const seen = vi.fn();
    let controlled = false;
    watchForUpdate(reg, () => controlled, seen);
    install(reg); // the first install has nothing to replace
    expect(seen).not.toHaveBeenCalled();
    controlled = true;
    const next = install(reg);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(next.postMessage).not.toHaveBeenCalled();
  });

  it("reports a version already waiting when the page opens", () => {
    const reg = registration();
    reg.waiting = worker("installed");
    const seen = vi.fn();
    watchForUpdate(reg, () => true, seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  // main.tsx attaches after navigator.serviceWorker.ready: an update found by register() may already be installing
  it("reports a version still installing when the page opens, once it is installed", () => {
    const reg = registration();
    const w = worker("installing");
    reg.installing = w; // its updatefound fired before this page listened
    const seen = vi.fn();
    watchForUpdate(reg, () => true, seen);
    expect(seen).not.toHaveBeenCalled();
    w.state = "installed";
    w.dispatchEvent(new Event("statechange"));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("asks the waiting worker to take over, and reloads once, after it controls the page", () => {
    const reg = registration();
    const waiting = worker("installed");
    reg.waiting = waiting;
    const container = new EventTarget();
    const reload = vi.fn();
    applyUpdate(reg, container, reload);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event("controllerchange"));
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads at once when no worker waits any more (another tab already took the update)", () => {
    const reload = vi.fn();
    applyUpdate(registration(), new EventTarget(), reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps one boolean and tells its listeners when it changes", () => {
    const flag = new Flag();
    const seen = vi.fn();
    const stop = flag.subscribe(seen);
    flag.set(true);
    flag.set(true);
    expect(flag.get()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    flag.set(false);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
