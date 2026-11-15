export interface WorkerLike extends EventTarget {
  readonly state: string;
  postMessage(message: unknown): void;
}

export interface RegistrationLike extends EventTarget {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
}

/**
 * Calls `onWaiting` when a new service worker is installed and waits behind the one serving this page — never on the
 * first install, which has nothing to replace. The new version waits for « Mettre à jour » (applyUpdate): a phone in a
 * shop aisle never reloads under a thumb.
 */
export function watchForUpdate(reg: RegistrationLike, hasController: () => boolean, onWaiting: () => void): void {
  const track = (worker: WorkerLike | null) => {
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && hasController()) onWaiting();
    });
  };
  if (reg.waiting && hasController()) onWaiting();
  track(reg.installing); // an update found before this page listened
  reg.addEventListener("updatefound", () => track(reg.installing));
}

/** Lets the waiting worker take over, then reloads once it controls the page; the outbox is in IndexedDB, so nothing is lost. */
export function applyUpdate(reg: RegistrationLike, container: EventTarget, reload: () => void): void {
  if (!reg.waiting) return reload(); // another tab already let it take over: this page only needs the new shell
  container.addEventListener("controllerchange", () => reload(), { once: true });
  reg.waiting.postMessage({ type: "SKIP_WAITING" });
}
