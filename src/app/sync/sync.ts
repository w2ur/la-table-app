import type { Snapshot } from "../../domain/snapshot";
import { fetchSnapshot, isSnapshot, postOps, type Fetcher, type Outcome } from "./api";
import { abandon, annuler, covered, departed, enqueue, markSent, nextBatch, retry, settle, waiting, type Fate } from "./outbox";
import { project, type View } from "./project";
import type { StoreWrite, SyncStore } from "./store";
import type { ConnStatus, Op, OutboxEntry, Refusal } from "./types";

/** Wait before resending ops the server answered without a record (a version conflict, « erreur interne »). */
export const RETRY_MS = 5000;

/**
 * Waits before resending after a request that got no answer (the network dropped it with the phone still online) or a
 * server failure (5xx): one after the other, then the last one again, for as long as ops wait and the app is visible.
 * An answer, an Access redirect or the app hidden ends the series.
 */
export const BACKOFF_MS = [2000, 5000, 15000, 30000] as const;

/**
 * An answer worth resending on a timer: none at all, a 5xx, or a 200 with a truncated or garbled body. A 4xx is a
 * deterministic refusal of the request itself (400 ops_expected, 413 too_many_ops, 415 json_expected): sending it again
 * changes nothing, so it waits for the next foreground or network event like any other answer.
 */
function resendable(answer: Outcome<unknown>): boolean {
  return answer.kind === "offline" || (answer.kind === "server" && (answer.status === 200 || answer.status >= 500));
}

/** A new base, a new outbox, and the answer's version of the ops it settled (`Settled.answered`) for their fates. */
interface Change {
  base?: Snapshot;
  outbox?: OutboxEntry[];
  answered?: OutboxEntry[];
}

export interface SyncDeps {
  store: SyncStore;
  persistent: boolean;
  fetch: Fetcher;
  now: () => string;
  uuid: () => string;
  isOnline: () => boolean;
  /** The app is on screen (`document.visibilityState`): a failed request is resent on a timer only then. */
  isVisible: () => boolean;
  /** Runs `run` once after `ms`; the function returned cancels it. */
  schedule: (run: () => void, ms: number) => () => void;
}

export interface SyncState {
  loaded: boolean;
  /** Null until a first snapshot ever reached this phone. */
  view: View | null;
  status: ConnStatus;
  /** Ops still to send (spec §8.3 « actions en attente »); those en échec are not counted. */
  waitingCount: number;
  failed: OutboxEntry[];
  refusals: Refusal[];
  /** Cuisiné sheets dropped because the other phone cooked the meal first (outbox.ts `sheetDropped`), by label. */
  droppedSheets: string[];
  persistent: boolean;
}

/**
 * The phone's side of spec §8.3. The last snapshot and the outbox live in the store, so a reload, an update or an app
 * killed by the OS loses nothing. One request at a time: a GET and a POST never overlap, so an older answer never
 * replaces a newer one, and a tap made during a request goes in the next one. Ops leave in tap order; after an answer
 * that left any of them unrecorded, the whole outbox waits RETRY_MS so a later op never overtakes an earlier one. A
 * request that got no answer or a 5xx is sent again after BACKOFF_MS while the app is visible; the state is still read
 * only on open, foreground and network events (spec §8.3).
 */
export class Sync {
  private readonly deps: SyncDeps;
  private base: Snapshot | null = null;
  private outbox: OutboxEntry[] = [];
  private status: ConnStatus = "online";
  private refusals: Refusal[] = [];
  private droppedSheets: string[] = [];
  /**
   * What became of each op that left the outbox since the app opened (outbox.ts `departed`): its final answer, abandoned,
   * cancelled, or taken back by an undo from here. « Annuler » from the bar reads it once its op has left the outbox.
   */
  private readonly fates = new Map<string, Fate>();
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private queuedFlush: Promise<void> | null = null;
  private queuedRefresh: Promise<void> | null = null;
  private holding = false;
  /** The resend waiting after a failed request (`BACKOFF_MS`), and how many came before it in the series. */
  private backoff: (() => void) | null = null;
  private backoffs = 0;
  /** An answer came with no snapshot (D1 could not be read back): the base may miss what the server holds now. */
  private stale = false;
  /** Set by an Access redirect, cleared only by a read that succeeds: going offline meanwhile does not end it (spec §8.3). */
  private needsLogin = false;
  /** Taps whose first write to the store has not landed: neither shown nor sent, so a tick on screen is a tick on disk. */
  private readonly saving = new Set<string>();
  /** Unsent ops cancelled whose delete from the store has not landed: still shown, never sent (a tap shows only once its write commits, mirrored). */
  private readonly cancelling = new Map<string, OutboxEntry>();
  private cached: SyncState | null = null;
  /** False from the start without IndexedDB, or once a write to it failed: offline taps then die with the app. */
  private persistent: boolean;
  /** Store writes started, in call order; the last one the store refused; the last full rewrite that landed (`apply`). */
  private writes = 0;
  private refusedAt = 0;
  private rewrittenAt = 0;

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.persistent = deps.persistent;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): SyncState {
    const shown = this.shown();
    this.cached ??= {
      loaded: this.loaded,
      view: this.base === null ? null : project(this.base, shown),
      status: this.status,
      waitingCount: waiting(shown).length,
      failed: shown.filter((e) => e.failed),
      refusals: this.refusals,
      droppedSheets: this.droppedSheets,
      persistent: this.persistent,
    };
    return this.cached;
  }

  async load(): Promise<void> {
    const [base, outbox] = await Promise.all([this.deps.store.readSnapshot(), this.deps.store.readOutbox()]);
    this.base = isSnapshot(base) ? base : null; // a snapshot stored by an older app may lack a section the screens read
    this.outbox = outbox;
    this.loaded = true;
    this.emit();
  }

  /** Spec §8.3: on open, on coming back to the foreground, on the network returning. Never on a timer. */
  refresh(): Promise<void> {
    if (this.queuedRefresh) return this.queuedRefresh;
    const run = this.exclusive(async () => {
      this.queuedRefresh = null;
      await this.read();
    }).then(() => this.flush());
    this.queuedRefresh = run;
    return run;
  }

  markOffline(): void {
    this.setStatus("offline");
  }

  /** The app left the screen: a resend waiting after a failed request is dropped; coming back refreshes (spec §8.3). */
  hidden(): void {
    this.endBackoff();
  }

  /**
   * One tap: the op joins the outbox, on disk before it is sent, and shows at once. Returns its id for « Annuler ». A tap
   * the store failed to keep is still shown and sent from memory, and the phone then says offline taps die with the app.
   */
  async tap(type: string, payload: unknown, label: string): Promise<string> {
    return (await this.tapMany([{ type, payload }], label))[0]!;
  }

  /**
   * One tap standing for several ops (a Courses row joining one product's lines): all join the outbox in order in one
   * write, so the phone never keeps half of a tap. Returns their ids for « Annuler ».
   */
  async tapMany(ops: readonly { type: string; payload: unknown }[], label: string): Promise<string[]> {
    let outbox = this.outbox;
    const ids: string[] = [];
    for (const o of ops) {
      const op = this.newOp(o.type, o.payload);
      outbox = enqueue(outbox, op, label);
      ids.push(op.opId);
    }
    await this.send(outbox);
    return ids;
  }

  /**
   * « Annuler » (spec §6.6), by the rules in outbox.ts (`annuler`): an op never sent, and named by no row, is dropped on
   * the phone, one that may be in effect gets an undo, sent once the op has its final answer, and one that changed
   * nothing, was cancelled or already taken back gets nothing. Once its op has left the outbox, what this phone knows of
   * it comes from `fates`, or from a row of the snapshot that names it (another phone's op, or this phone's before a
   * reload). A row naming an op still in the outbox says it landed, whatever send count the store kept.
   */
  async undo(targetOpId: string, label: string): Promise<void> {
    if (this.cancelling.has(targetOpId)) return;
    const fate = this.fates.get(targetOpId) ?? (this.namedByRow(targetOpId) ? "applied" : undefined);
    const plan = annuler(this.outbox, targetOpId, fate, () => this.newOp("undo", { targetOpId }), label);
    if (plan.kind === "drop") return this.cancel(targetOpId, plan.outbox);
    if (plan.kind === "send") await this.send(plan.outbox);
  }

  /** « Réessayer »: back in line, and sent even when the store refuses the write (`keep`). */
  async retry(opId: string): Promise<void> {
    try {
      await this.keep({ outbox: retry(this.outbox, opId) });
    } finally {
      void this.flush();
    }
  }

  /** « Abandonner » (outbox.ts `abandon`): an op that may have landed is sent an undo; an undo abandoned leaves its op as it is. */
  abandon(opId: string): Promise<void> {
    return this.send(abandon(this.outbox, opId, () => this.newOp("undo", { targetOpId: opId })));
  }

  dismissRefusals(): void {
    this.refusals = [];
    this.emit();
  }

  dismissDroppedSheets(): void {
    this.droppedSheets = [];
    this.emit();
  }

  flush(): Promise<void> {
    if (this.queuedFlush) return this.queuedFlush;
    const run = this.exclusive(async () => {
      this.queuedFlush = null;
      if (this.diverged()) await this.keep({}); // a full rewrite, tried again until it lands
      await this.drain();
      if (this.stale) await this.read();
    });
    this.queuedFlush = run;
    return run;
  }

  /** GET /api/state into the base; a read that succeeds is what ends a lapsed login (spec §8.3). */
  private async read(): Promise<void> {
    this.stale = false;
    if (!this.deps.isOnline()) return this.setStatus("offline");
    const answer = await fetchSnapshot(this.deps.fetch);
    if (answer.kind !== "ok") return this.setStatus(answer.kind);
    this.needsLogin = false;
    this.status = "online";
    this.backoffs = 0; // a read that lands ends the failure series: the next one starts from BACKOFF_MS[0]
    await this.keep({ base: answer.body, outbox: covered(this.outbox) });
  }

  /**
   * Sends the outbox in batches. The answered ops leave the outbox with the answer's snapshot (`covered`); an answer with
   * no snapshot keeps them, still shown, and the flush ends with a read (`stale`), so the base catches up with the server.
   */
  private async drain(): Promise<void> {
    for (;;) {
      if (this.needsLogin || this.holding) return; // spec §8.3: nothing is resent until a login works
      if (!this.deps.isOnline()) return this.setStatus("offline");
      const batch = nextBatch(this.saved());
      if (batch.length === 0) return this.endBackoff(); // nothing left to resend: the series is over
      const ids = batch.map((op) => op.opId);
      await this.keep({ outbox: markSent(this.outbox, new Set(ids)) });
      const answer = await postOps(this.deps.fetch, batch);
      if (answer.kind !== "ok") {
        if (resendable(answer)) this.backoffThenRetry();
        return this.setStatus(answer.kind);
      }
      this.endBackoff();
      const settled = settle(this.outbox, ids, answer.body);
      if (settled.refused.length > 0) this.refusals = [...this.refusals, ...settled.refused];
      if (settled.dropped.length > 0) this.droppedSheets = [...this.droppedSheets, ...settled.dropped];
      this.status = "online";
      const base = answer.body.snapshot;
      if (base === null) this.stale = true;
      const answered = settled.answered;
      await this.keep(base === null ? { outbox: settled.outbox, answered } : { base, outbox: covered(settled.outbox), answered });
      const resend = new Set(ids);
      if (!settled.progress || waiting(this.outbox).some((e) => resend.has(e.op.opId))) {
        if (waiting(this.outbox).length > 0) this.holdThenRetry();
        return;
      }
    }
  }

  /** After a request with no answer or a 5xx, while visible: the next resend of the series (`BACKOFF_MS`). */
  private backoffThenRetry(): void {
    if (this.backoff !== null || !this.deps.isVisible()) return;
    const ms = BACKOFF_MS[Math.min(this.backoffs, BACKOFF_MS.length - 1)]!;
    this.backoffs += 1;
    this.backoff = this.deps.schedule(() => {
      this.backoff = null;
      void this.flush();
    }, ms);
  }

  private endBackoff(): void {
    this.backoff?.();
    this.backoff = null;
    this.backoffs = 0;
  }

  private holdThenRetry(): void {
    if (this.holding) return;
    this.holding = true;
    this.deps.schedule(() => {
      this.holding = false;
      void this.flush();
    }, RETRY_MS);
  }

  /** The outbox with a new op, on disk before it is sent; a write the store refuses still shows and sends it (`keep`). */
  private async send(outbox: OutboxEntry[]): Promise<void> {
    await this.keep({ outbox });
    void this.flush();
  }

  /** Runs network work one task at a time; a failing task (a store write) never blocks the next. */
  private exclusive(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task).catch((error: unknown) => {
      console.error("la-table: synchronisation interrompue", error);
    });
    this.chain = run;
    return run;
  }

  private newOp(type: string, payload: unknown): Op {
    return { opId: this.deps.uuid(), type, at: this.deps.now(), payload };
  }

  /** A row of the snapshot names this op as the applied one that bought its line or cooked its meal. */
  private namedByRow(opId: string): boolean {
    const base = this.base;
    if (base === null) return false;
    return base.courses.lines.some((l) => l.buyOpId === opId) || base.menu.recentlyCooked.some((m) => m.cookOpId === opId);
  }

  /** The outbox but the taps still being written: what may leave. */
  private saved(): OutboxEntry[] {
    return this.saving.size === 0 ? this.outbox : this.outbox.filter((e) => !this.saving.has(e.op.opId));
  }

  /** What is shown: the saved taps, and the cancelled ones until they are off disk, in tap order. */
  private shown(): OutboxEntry[] {
    const saved = this.saved();
    return this.cancelling.size === 0 ? saved : [...saved, ...this.cancelling.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * Cancels an unsent op: it leaves the outbox at once, so it is never sent, but stays shown until its delete commits, so
   * a reload or the OS closing the app right after « Annuler » never brings back a cancel already seen. A failed delete
   * still hides it: this phone keeps the cancel in memory while it stays open, and says taps no longer persist (`keep`).
   */
  private async cancel(opId: string, outbox: OutboxEntry[]): Promise<void> {
    const entry = this.outbox.find((e) => e.op.opId === opId);
    if (entry) this.cancelling.set(opId, entry);
    try {
      await this.keep({ outbox });
    } finally {
      this.cancelling.delete(opId);
      this.emit();
    }
  }

  /** A write the store refused has not been made good by a full rewrite since: the disk may not hold what memory does. */
  private diverged(): boolean {
    return this.refusedAt > this.rewrittenAt;
  }

  /**
   * Writes only what changed (the snapshot, and the outbox entries added, changed or gone), in one store write so the
   * OS killing the app never keeps half of it (an undo on disk with its op en échec still there), and shows it. The server's
   * answer shows at once; a new tap shows, and may be sent, only once its entry is on disk, so a reload or the OS closing
   * the app right after a tick keeps it (spec §8.3). The fields change before the first await, so a
   * concurrent change diffs against this one.
   *
   * After a refused write, a difference would never carry what that write held (a cancel would come back on reload, an
   * op that landed would come back unsent), so every write rewrites the whole outbox, with the snapshot, until one of
   * them lands. The phone goes on saying offline taps die with the app: the store may refuse the next one.
   */
  private async apply(change: Change): Promise<void> {
    const previous = this.outbox;
    if (change.base) this.base = change.base;
    if (change.outbox) {
      this.outbox = change.outbox;
      for (const [id, fate] of departed(previous, change.outbox, change.answered)) this.fates.set(id, fate);
    }
    const write: StoreWrite = { snapshot: change.base, put: [], remove: [] };
    const added: string[] = [];
    if (change.outbox) {
      const known = new Set(previous.map((e) => e.op.opId));
      const kept = new Set(change.outbox.map((e) => e.op.opId));
      const put = change.outbox.filter((e) => !previous.includes(e));
      for (const e of put) if (!known.has(e.op.opId)) added.push(e.op.opId);
      write.put = put;
      write.remove = previous.filter((e) => !kept.has(e.op.opId)).map((e) => e.op.opId);
    }
    const rewrite = this.diverged();
    if (rewrite) Object.assign(write, { snapshot: this.base ?? undefined, put: this.outbox, remove: [], replace: true });
    const at = ++this.writes;
    for (const id of added) this.saving.add(id);
    this.emit();
    try {
      await this.deps.store.write(write);
      // only a rewrite started after every refusal so far holds all they missed
      if (rewrite && at > this.refusedAt) this.rewrittenAt = at;
    } catch (error: unknown) {
      this.refusedAt = Math.max(this.refusedAt, at);
      throw error;
    } finally {
      // a failed write still shows and sends the tap: this phone keeps it in memory while it stays open
      for (const id of added) this.saving.delete(id);
      this.emit();
    }
  }

  /**
   * `apply` for the changes memory must keep even when the store refuses them (a tap, a send count, an answer, a read's
   * snapshot, a cancel, « Réessayer », « Abandonner »): a failed write leaves the change in memory, so the op is still shown and sent, and
   * the phone then says offline taps die with the app; every later write rewrites the stored state whole until one
   * lands (`apply`). A store failing every write (quota, eviction) would otherwise stop every send at its first send count.
   */
  private async keep(change: Change): Promise<void> {
    try {
      await this.apply(change);
    } catch {
      this.persistent = false;
      this.emit();
    }
  }

  private setStatus(status: ConnStatus): void {
    if (status === "reauth") this.needsLogin = true;
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  /** Tells every screen; one that throws (a render error) never stops the others, nor reaches `keep` as a store failure. */
  private emit(): void {
    this.cached = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error: unknown) {
        console.error("la-table: un écran n'a pas pu s'afficher", error);
      }
    }
  }
}
