import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyOp } from "../../domain/ops/apply";
import { ALREADY_UNDONE, NOTHING_TO_UNDO, TARGET_MISSING } from "../../domain/ops/undo";
import { snapshot } from "../../domain/snapshot";
import { storedOp } from "../../domain/state";
import { NOW } from "../../domain/test-fixtures";
import type { State } from "../../domain/types";
import type { Fetcher } from "./api";
import { MAX_UNRECORDED, undoTarget } from "./outbox";
import { canRebuy, project, viewItems, type ViewItem } from "./project";
import { memoryStore, type StoreWrite, type SyncStore } from "./store";
import { Sync } from "./sync";
import { fakeServer, plannedForPhones, type ServerMode } from "./test-server";
import type { Op, OpsAnswer, OutboxEntry, Refusal, WireResult } from "./types";

/**
 * Model-based property of the phone's sync (spec §8.2, §8.3, §6.6): random user actions on Courses, Menu and Reste (a
 * tick, a meal cooked with its sheet, dropped, an item finished with the resolution the reservation warning asks for,
 * partly used, redated or added, an envie), « Annuler » on any row (a bought line, a meal cooked lately) or pending op,
 * « Réessayer », « Abandonner », reloads and network changes, interleaved with every failure the fake server can play
 * (the real domain computes its answers). The run is then driven to quiescence (online, server ok, every timer run, a
 * refresh) and checked against what the user asked for, not against how the outbox did it.
 *
 * The store may refuse writes while the page keeps running (`disk`), anywhere in a run and then a reload. What the page
 * did from a refused write until a write lands again may die with it, as the phone says (`bury`); once one lands, the
 * disk must hold all of it (after a refused write, each write rewrites the stored state whole until one lands). The bounded retry is judged as each request leaves (`judge`): no resend
 * before RETRY_MS after an unrecorded answer, none after SPEC_MAX_UNRECORDED of them without « Réessayer », counted
 * per page.
 *
 * Focused chains reach what the weighted runs (`wide`, `refusals`, `failures`) seldom do: an op en échec abandoned, then
 * cancelled again (`reabandon`); « Réessayer » (`retrying`); « Annuler » on an op answered with no snapshot (`noSnap`);
 * the whole rewrite after a refused write (`unkept`, `lostWrite`); an answer kept until a snapshot covers it (`unread`); an answer read but never stored (`untold`); a second
 * « Annuler » on an undo answered with no snapshot (`retake`); an undo refused « modifié depuis » (`changedSince`);
 * « Annuler », not « Abandonner », on an op en échec (`cancelFailed`); and a line ticked again behind the undo of its
 * purchase, that undo refused unrecorded (`retick`). On Menu and Reste: runs dense in cooks and finishes (`menu`), the
 * cheese story through the outbox (`cheese`), the doubled pair and its plat cuisiné (`plat`), a Reste change taken
 * back from the bar (`reste`), « Il en reste » said again, by a tap or a cook's sheet, before the first is taken back
 * (`repeat`), and an item the other phone finished, finished or partly used from a screen that has not heard
 * (`staleFinish`); a staple bought, a meal dropped, then that purchase taken back (`staple`); a cook taken back
 * after a reload (`reloadUncook`); and a second round cooked offline behind its first, landing first (`firstRound`).
 * A chain that exists to take a cook back (`cheese`, `reloadUncook`) must send an undo of one (invariant (i)), so a
 * row that names no cook cannot turn it into a run that does nothing and passes.
 *
 * Out of its reach, so held by the unit tests or not at all; outbox.ts's « Annuler » rules cite this property for no more than that:
 * - a row outranking a send count of zero (outbox.ts): since the whole rewrite after a refused write, only a second app instance leaves that on
 *   disk (sync.test, 13d9f3c);
 * - unrecorded answers counted across a reload: a page that died before storing one rightly forgets it, so the cap is
 *   judged per page;
 * - a 5xx after the Worker applied the batch (the fake server has no such mode);
 * - a row's undo window expiring: every op is tapped at the same instant, inside it;
 * - two app instances over one store (one at a time is assumed, store.ts);
 * - a purchase answered unrecorded with no snapshot while every read fails, so it goes en échec with its line shown
 *   unbought, ticked again (answered noop), then given up on, its undo unbuying the line with nothing said: a case left
 *   to the owner. Invariant (a) flags it, and a test pins it, since no mode cuts the read alone;
 * - the store refusing reads at load: only writes are refused (`disk`);
 * - a batch over MAX_OPS_PER_REQUEST: a run stops at 30 actions;
 * - a dead page's request and the next page's resend meeting on the server: the fake server applies each request whole
 *   before the next starts;
 * - what the screen shows between steps: the view is judged at quiescence only, so a cancelled tick back on screen for
 *   a moment (a tap shows only once its write commits) would pass;
 * - the projection's rules (`project.ts`): at quiescence the outbox is empty, so a waiting op is never projected here.
 *   A cook leaving its meal in the pool or an undo not marking its cooked meal passes 2000 runs; they are pinned
 *   by project.property.test.ts and project.test.ts. A cooked meal's row dropping its cookOpId passed 2000 runs too,
 *   every « Annuler » on a cooked meal then doing nothing, until (i): it now fails within 50.
 */

/** Spec §8.3: the first send plus five resends. Not read from outbox.ts, so the property judges the code against the spec. */
const SPEC_MAX_UNRECORDED = 6;
const TAP_AT = "2026-10-12T09:00:00.000Z";
const MODES: ServerMode[] = ["ok", "offline", "reauth", "unrecorded", "lose-answer", "blind", "throw-first", "no-snapshot", "no-read", "no-result", "unavailable"];

type Action =
  | { kind: "tick" | "untick" | "remove" | "doomed" | "retry" | "abandon" | "reannuler"; pick: number }
  | { kind: "annuler"; back: number }
  | { kind: "crash"; then: "annuler" | "abandon"; pick: number; after: number }
  | { kind: "add"; food: boolean }
  | { kind: "buy"; label: string }
  | { kind: "cook"; pick: number; answers: number; verdict: boolean }
  // `plat`: « Il en reste » on the plat cuisiné, whatever its rank among the Reste items; `must`: a chain's key « Annuler »
  // on a cooked meal: the run must then send an undo of a cook (`mustUncook`)
  | { kind: "drop" | "finish" | "partial" | "useBy" | "uncook"; pick: number; choice: number; plat?: boolean; must?: boolean }
  | { kind: "stockAdd" | "envie" }
  | { kind: "elsewhereMenu"; pick: number; finish: boolean }
  | { kind: "elsewhere"; pick: number; undo: boolean; trip: boolean }
  | { kind: "server"; mode: ServerMode }
  | { kind: "disk"; full: boolean }
  | { kind: "checkout"; receipt: boolean; none?: boolean }
  | { kind: "reload" | "offline" | "online" | "turn" | "settle" | "timer" | "storm" };

const pick = fc.nat({ max: 20 });
type Kind = Action["kind"];
const ACTIONS: Record<Kind, fc.Arbitrary<Action>> = {
  tick: fc.record({ kind: fc.constant("tick" as const), pick }),
  untick: fc.record({ kind: fc.constant("untick" as const), pick }),
  add: fc.record({ kind: fc.constant("add" as const), food: fc.boolean() }),
  // an ajout, or a planned line with its reason (« On en a déjà » or « On n'en prend pas », by the parity of the pick)
  remove: fc.record({ kind: fc.constant("remove" as const), pick }),
  // a tap the server refuses (a remove of a bought line, or of a planned line with no reason: an old cached build), as a screen behind the server sends it
  doomed: fc.record({ kind: fc.constant("doomed" as const), pick }),
  // with the receipt total typed, or without: a trip with no total is what the ticket sheet then asks for; `none`: the
  // basket bought without a ticket, a trip that carries no total and never becomes the last trip
  checkout: fc.record({ kind: fc.constant("checkout" as const), receipt: fc.boolean(), none: fc.boolean() }),
  // « Annuler » names an op 0–4 back among the session's taps and the outbox: the 5-second bar, or a pending op
  annuler: fc.record({ kind: fc.constant("annuler" as const), back: fc.nat({ max: 4 }) }),
  // « Annuler » again on an op the user already cancelled or abandoned: once its undo was refused, or abandoned too
  reannuler: fc.record({ kind: fc.constant("reannuler" as const), pick }),
  retry: fc.record({ kind: fc.constant("retry" as const), pick }),
  abandon: fc.record({ kind: fc.constant("abandon" as const), pick }),
  reload: fc.constant({ kind: "reload" as const }),
  // the OS kills the app during an « Annuler » or an « Abandonner », once `after` store writes have landed
  crash: fc.record({ kind: fc.constant("crash" as const), then: fc.constantFrom("annuler" as const, "abandon" as const), pick, after: fc.nat({ max: 2 }) }),
  offline: fc.constant({ kind: "offline" as const }),
  online: fc.constant({ kind: "online" as const }),
  server: fc.record({ kind: fc.constant("server" as const), mode: fc.constantFrom(...MODES) }),
  turn: fc.constant({ kind: "turn" as const }),
  settle: fc.constant({ kind: "settle" as const }),
  timer: fc.constant({ kind: "timer" as const }),
  // the store refuses every write while the page keeps running (quota, eviction): the phone then says taps die with it
  disk: fc.record({ kind: fc.constant("disk" as const), full: fc.boolean() }),
  // the first send and five resends in a row: what it takes to put an op en échec
  storm: fc.constant({ kind: "storm" as const }),
  // a line ticked by name, for chains that need a given line bought (comté: the cheese story; saumon: the doubled pair;
  // lentilles: a staple, shared by the meals and never reserved)
  buy: fc.record({ kind: fc.constant("buy" as const), label: fc.constantFrom("comté", "pavé de saumon", "poireau", "lentilles vertes") }),
  // « Cuisiné » on a pool meal, its sheet answering each item it holds with nothing, « Fini » or « Il en reste », two bits each
  cook: fc.record({ kind: fc.constant("cook" as const), pick, answers: fc.nat({ max: 511 }), verdict: fc.boolean() }),
  // « Retirer du menu », « Fini », « Il en reste », « Changer la date » on a pool meal or a Reste item, and « Annuler » on
  // a meal of « Cuisinés récemment »; `choice` picks the resolution the reservation warning asks for, and the rest
  drop: fc.record({ kind: fc.constant("drop" as const), pick, choice: fc.nat({ max: 7 }) }),
  finish: fc.record({ kind: fc.constant("finish" as const), pick, choice: fc.nat({ max: 7 }) }),
  partial: fc.record({ kind: fc.constant("partial" as const), pick, choice: fc.nat({ max: 7 }) }),
  useBy: fc.record({ kind: fc.constant("useBy" as const), pick, choice: fc.nat({ max: 7 }) }),
  uncook: fc.record({ kind: fc.constant("uncook" as const), pick, choice: fc.constant(0) }),
  stockAdd: fc.constant({ kind: "stockAdd" as const }),
  envie: fc.constant({ kind: "envie" as const }),
  // the other phone cooks a meal, or finishes an item nothing holds: this phone's cook or finish then answers noop
  elsewhereMenu: fc.record({ kind: fc.constant("elsewhereMenu" as const), pick, finish: fc.boolean() }),
  // another phone buys a line, undoes a purchase, records a trip over the basket, or undoes the last trip: what makes
  // this phone's ops answer noop or refused (a checkout « panier modifié depuis », a ticket total for a trip gone)
  elsewhere: fc.record({ kind: fc.constant("elsewhere" as const), pick, undo: fc.boolean(), trip: fc.boolean() }),
};
const actions = (weights: Partial<Record<Kind, number>>, maxLength: number): fc.Arbitrary<Action[]> =>
  fc.array(fc.oneof(...Object.entries(weights).map(([kind, weight]) => ({ arbitrary: ACTIONS[kind as Kind], weight: weight! }))), {
    minLength: 1, maxLength, size: "max",
  });

/** Every action, in long runs: reloads, network changes and refusals mixed with everything else. */
const wide = actions({
  tick: 4, untick: 2, add: 1, remove: 1, doomed: 1, checkout: 1, annuler: 4, reannuler: 1, retry: 1, abandon: 2, reload: 1, crash: 1, offline: 1,
  online: 1, server: 4, turn: 2, settle: 1, timer: 1, storm: 1, elsewhere: 1, disk: 1, buy: 1, cook: 2, drop: 1, finish: 2, partial: 1, useBy: 1,
  uncook: 1, stockAdd: 1, envie: 1, elsewhereMenu: 1,
}, 30);
/**
 * Short runs dense in what the undo rules turn on: ops answered at once (each action is followed by a flush), refused
 * because the line moved on (an ajout removed, a checkout: « modifié depuis », « déjà passé en caisse ») and cancelled
 * again once it can pass. In the wide runs alone, a five-step chain like that showed up in about one seed in five.
 */
const refusals = actions({ tick: 3, untick: 1, add: 2, remove: 2, doomed: 2, checkout: 2, annuler: 4, reannuler: 3, server: 1, elsewhere: 2 }, 12)
  .map((run) => run.flatMap((a): Action[] => [a, { kind: "settle" }]));
/**
 * Short runs dense in en échec: ops and their undos sent into failures, abandoned, retried and cancelled again, the app
 * killed mid-cancel, and refusals that leave an op in effect (a checkout after it) or that it never had (`doomed`).
 */
const failures = actions({
  tick: 2, remove: 1, doomed: 2, checkout: 2, annuler: 3, reannuler: 3, retry: 1, abandon: 3, reload: 1, crash: 2, server: 4, settle: 2, storm: 3,
  elsewhere: 1, disk: 1,
}, 14);
/**
 * An op en échec abandoned, then cancelled again: what « Annuler » meets once the undo « Abandonner » queued went en
 * échec and was abandoned too, or was refused because a checkout took the op in (« déjà passé en caisse »). That
 * chain is eight steps long: the weighted runs above reached it in none of several 2000-run passes. A few random
 * actions follow.
 */
const reabandon = fc
  .record({
    first: fc.constantFrom<ServerMode>("blind", "unrecorded"),
    checkout: fc.boolean(),
    then: fc.constantFrom<ServerMode>("blind", "unrecorded", "ok"),
    last: fc.constantFrom(...MODES),
    tail: actions({ tick: 1, annuler: 1, reannuler: 2, retry: 1, abandon: 1, crash: 1, server: 2, settle: 2, storm: 1 }, 6),
  })
  .map(({ first, checkout, then, last, tail }): Action[] => [
    { kind: "server", mode: first }, { kind: "tick", pick: 0 }, { kind: "storm" },
    ...(checkout ? [{ kind: "server", mode: "ok" }, { kind: "checkout", receipt: true }, { kind: "settle" }] as Action[] : []),
    { kind: "server", mode: then }, { kind: "abandon", pick: 0 }, { kind: "storm" }, { kind: "abandon", pick: 0 },
    { kind: "server", mode: last }, { kind: "reannuler", pick: 0 }, ...tail,
  ]);

/**
 * « Réessayer » on an op en échec, then the server in any mode, maybe « Annuler » on it, more failures, and a tail
 * weighted to « Réessayer ». In the runs above, « Réessayer » fired about 8 times in 2000.
 */
const retrying = fc
  .record({
    first: fc.constantFrom<ServerMode>("blind", "unrecorded"),
    then: fc.constantFrom(...MODES),
    cancel: fc.constantFrom<"annuler" | "untick" | null>("annuler", "untick", null),
    tail: actions({ retry: 4, tick: 1, annuler: 1, abandon: 1, server: 3, storm: 2, settle: 1, reload: 1, crash: 1 }, 8),
  })
  .map(({ first, then, cancel, tail }): Action[] => [
    { kind: "server", mode: first }, { kind: "tick", pick: 0 }, { kind: "storm" }, { kind: "server", mode: then },
    { kind: "retry", pick: 0 },
    ...(cancel === "annuler" ? [{ kind: "annuler", back: 0 }] as Action[] : cancel === "untick" ? [{ kind: "untick", pick: 0 }] as Action[] : []),
    { kind: "storm" }, ...tail,
  ]);

/**
 * « Annuler » on an op answered with no snapshot and still in the outbox, before a read covers it: final noop (another
 * phone bought the line), refused (`doomed`) or applied, the read that follows the answer cut short by the network or a
 * lapsed login. The runs above reached the noop and refused cases in none of 2000 runs, the applied one once.
 */
const noSnap = fc
  .record({
    pick,
    first: fc.constantFrom<"tick" | "doomed" | "noop">("tick", "doomed", "noop"),
    turns: fc.nat({ max: 2 }),
    cut: fc.constantFrom<ServerMode>("offline", "reauth", "no-snapshot", "ok"),
    tail: actions({ tick: 1, annuler: 2, reannuler: 1, untick: 1, server: 2, settle: 2, reload: 1, online: 1 }, 6),
  })
  .map(({ pick: n, first, turns, cut, tail }): Action[] => [
    ...(first === "noop" ? [{ kind: "elsewhere", pick: n, undo: false, trip: false }] as Action[] : []),
    { kind: "server", mode: "no-snapshot" }, { kind: first === "doomed" ? "doomed" : "tick", pick: n },
    ...Array.from({ length: turns }, (): Action => ({ kind: "turn" })), { kind: "server", mode: cut }, { kind: "turn" },
    { kind: "annuler", back: 0 }, ...tail,
  ]);

/**
 * A tap kept offline, then the store refusing every write while it is sent and answered, then a read stored once it
 * works again: after a reload the disk holds the op as answered (gone with the read's snapshot), not as never sent, and
 * « Annuler » on its row sends the undo that takes it back (the whole rewrite after a refused write; before it, a row outranking the send
 * count of zero was the only guard).
 */
const unkept = fc
  .record({
    pick,
    late: fc.boolean(),
    tail: actions({ tick: 1, annuler: 1, untick: 1, server: 1, settle: 2, reload: 1, online: 1 }, 6),
  })
  .map(({ pick: n, late, tail }): Action[] => [
    { kind: "offline" }, { kind: "tick", pick: n }, { kind: "disk", full: true }, { kind: "online" }, { kind: "settle" },
    { kind: "disk", full: false }, { kind: "online" }, { kind: "settle" }, ...(late ? [{ kind: "settle" }] as Action[] : []),
    { kind: "reload" }, { kind: "untick", pick: 0 }, ...tail,
  ]);

/**
 * An answer stays in the outbox until a snapshot covers it. Here: a purchase taken back by an undo answered with no snapshot, the app killed after storing that answer and
 * before the read that follows, then « Annuler » on the row the old snapshot still shows bought. The phone must still
 * know the undo was applied, and send no second one. Without this chain, a phone dropping that answer passed 9 of 11
 * full property runs.
 */
const unread = fc
  .record({
    pick,
    after: fc.integer({ min: 2, max: 4 }),
    then: fc.constantFrom<Kind>("untick", "annuler", "reannuler"),
    tail: actions({ tick: 1, untick: 1, annuler: 1, reannuler: 1, server: 1, settle: 2, turn: 1, online: 1, offline: 1 }, 6),
  })
  .map(({ pick: n, after, then, tail }): Action[] => [
    { kind: "tick", pick: n }, { kind: "settle" }, { kind: "server", mode: "no-snapshot" },
    { kind: "crash", then: "annuler", pick: 0, after },
    then === "annuler" ? { kind: "annuler", back: 0 } : { kind: then as "untick" | "reannuler", pick: 0 }, ...tail,
  ]);

// Regression: cc7e4ca — an answer the app died before storing is not "told": a refused remove's answer read, the
// app killed before the write that drops its undo, then six unrecorded answers abandon it and its undo leaves, rightly
const untold = fc.constant<Action[]>([
  { kind: "doomed", pick: 0 }, { kind: "crash", then: "annuler", pick: 0, after: 1 }, { kind: "server", mode: "unrecorded" },
  { kind: "storm" }, { kind: "annuler", back: 0 },
]);

/** One action of `kind` naming the n-th line, op or « Annuler » target it can. */
const act = (kind: Kind, n: number): Action => {
  switch (kind) {
    case "tick": case "untick": case "remove": case "doomed": case "retry": case "abandon": case "reannuler":
      return { kind, pick: n };
    case "cook":
      return { kind, pick: n, answers: 0, verdict: false };
    case "drop": case "finish": case "partial": case "useBy": case "uncook":
      return { kind, pick: n, choice: 0 };
    case "annuler":
      return { kind, back: 0 };
    case "add":
      return { kind, food: true };
    case "checkout":
      return { kind, receipt: true };
    case "reload": case "offline": case "online": case "turn": case "settle": case "timer": case "storm":
      return { kind };
    default:
      throw new Error(`no default for ${kind}`);
  }
};

/**
 * The store refusing writes while the page keeps running (WebKit's « Connection to Indexed Database server lost »,
 * quota), something done meanwhile (a cancel, a tap, an answer), then the store working again and one more step before
 * the app is reopened. Whatever reaches the disk once it works again must hold all the page did: a cancelled tick must
 * not come back, nor an op that landed come back as never sent.
 */
const lostWrite = fc
  .record({
    pick,
    offline: fc.boolean(),
    first: fc.constantFrom<Kind>("tick", "add", "checkout"),
    then: fc.constantFrom<Kind>("annuler", "untick", "settle", "tick", "abandon"),
    heal: fc.constantFrom<Kind>("tick", "settle", "online", "turn", "reload"),
    tail: actions({ tick: 1, annuler: 2, reannuler: 1, untick: 1, server: 1, settle: 2, reload: 1, online: 1, disk: 1 }, 6),
  })
  .map(({ pick: n, offline, first, then, heal, tail }): Action[] => [
    ...(offline ? [{ kind: "offline" }] as Action[] : []), act(first, n), { kind: "disk", full: true }, act(then, 0),
    { kind: "disk", full: false }, act(heal, n), { kind: "reload" }, { kind: "annuler", back: 0 }, ...tail,
  ]);

/**
 * « Annuler » twice from the bar on one op: the first undo answered applied with no snapshot, and the read that follows
 * cut, so the undo stays in the outbox with its answer. The second must send nothing (outbox.ts `cancelling`).
 */
const retake = fc
  .record({ pick, first: fc.constantFrom<Kind>("tick", "add"), tail: actions({ annuler: 2, untick: 1, server: 1, settle: 2, reload: 1, online: 1 }, 6) })
  .map(({ pick: n, first, tail }): Action[] => [
    act(first, n), { kind: "settle" }, { kind: "server", mode: "no-read" }, { kind: "annuler", back: 0 }, { kind: "settle" },
    { kind: "annuler", back: 0 }, ...tail,
  ]);

/**
 * An undo's refusal is shown only when it leaves its op in effect. Its example: an ajout, then that ajout removed, then « Annuler » on the ajout. The server refuses the
 * undo « modifié depuis », which leaves the op in effect, so it is shown; « Annuler » again may follow. The weighted
 * runs never reached a refusal of that kind other than a checkout's.
 */
const changedSince = fc
  .record({ food: fc.boolean(), tail: actions({ reannuler: 3, annuler: 1, tick: 1, server: 1, settle: 2, reload: 1, storm: 1 }, 6) })
  .map(({ food, tail }): Action[] => [
    { kind: "add", food }, { kind: "settle" }, { kind: "remove", pick: 0 }, { kind: "settle" }, { kind: "annuler", back: 1 },
    { kind: "settle" }, ...tail,
  ]);

/**
 * « Annuler », not « Abandonner », on an op en échec: it abandons the op and queues its undo (outbox.ts), into any
 * server mode, then failures and « Réessayer » on whatever goes en échec next. The weighted runs reached it about 9
 * times in 2000.
 */
const cancelFailed = fc
  .record({
    pick,
    first: fc.constantFrom<ServerMode>("blind", "unrecorded"),
    then: fc.constantFrom(...MODES),
    tail: actions({ retry: 2, annuler: 1, reannuler: 2, abandon: 1, tick: 1, server: 2, storm: 2, settle: 2, reload: 1, crash: 1 }, 8),
  })
  .map(({ pick: n, first, then, tail }): Action[] => [
    { kind: "server", mode: first }, { kind: "tick", pick: n }, { kind: "storm" }, { kind: "server", mode: then },
    { kind: "annuler", back: 0 }, { kind: "settle" }, ...tail,
  ]);

/**
 * « Annuler » on a purchase, then the same line ticked again before that undo has its answer, then a server that refuses
 * the first op of a request unrecorded (an undo handler that throws): the purchase answered applied or en échec (it
 * landed), the undo kept back by the network, a reload or nothing. The re-tick must still be in effect at the end. The
 * weighted runs reached it about once in three 2000-run passes.
 */
const retick = fc
  .record({
    pick,
    failed: fc.boolean(),
    hold: fc.constantFrom<"offline" | "reload" | "timer">("offline", "reload", "timer"),
    tail: actions({ tick: 1, annuler: 1, untick: 1, server: 1, settle: 2, reload: 1, online: 1, timer: 1 }, 6),
  })
  .map(({ pick: n, failed, hold, tail }): Action[] => [
    ...(failed ? [{ kind: "server", mode: "blind" }, { kind: "tick", pick: n }, { kind: "storm" }] as Action[] : [{ kind: "tick", pick: n }, { kind: "settle" }] as Action[]),
    ...(hold === "offline" ? [{ kind: "offline" }] as Action[] : []), { kind: "server", mode: "throw-first" }, { kind: "annuler", back: 0 },
    // sent at once, the undo is refused unrecorded and the outbox waits RETRY_MS: the re-tick joins it in the resend
    ...(hold === "offline" ? [] : [{ kind: "settle" }] as Action[]), { kind: "tick", pick: n },
    act(hold === "offline" ? "online" : hold, n), { kind: "settle" }, ...tail,
  ]);

/**
 * A ticket total for a trip another phone then undid: the sheet was pinned to the trip the phone last read, so the total
 * is sent for a trip the server no longer holds and is refused « passage en caisse introuvable », which must be shown.
 * Then a checkout queued offline over a basket the other phone checked out meanwhile: refused « panier modifié depuis ».
 * Both chains are longer than the weighted runs reach.
 */
const otherPhoneTrip = fc
  .record({
    pick,
    gone: fc.boolean(),
    tail: actions({ tick: 1, untick: 1, checkout: 2, annuler: 1, elsewhere: 2, server: 1, settle: 2, reload: 1, online: 1, offline: 1 }, 6),
  })
  .map(({ pick: n, gone, tail }): Action[] => [
    { kind: "tick", pick: n }, { kind: "settle" },
    ...(gone
      ? [
          { kind: "checkout", receipt: false }, { kind: "settle" }, { kind: "elsewhere", pick: n, undo: true, trip: true },
          { kind: "checkout", receipt: true }, { kind: "settle" },
        ] as Action[]
      : [
          { kind: "offline" }, { kind: "checkout", receipt: true }, { kind: "elsewhere", pick: n, undo: false, trip: true },
          { kind: "online" }, { kind: "settle" },
        ] as Action[]),
    ...tail,
  ]);

/**
 * Runs dense in Menu and Reste: lines bought so the meals hold stock, meals cooked with their sheet and taken back from
 * « Cuisinés récemment », items finished with or without a resolution, the other phone cooking or finishing first, and
 * the network and server failing in between.
 */
const menu = actions({
  buy: 3, tick: 1, cook: 4, drop: 1, finish: 3, partial: 2, useBy: 2, uncook: 2, stockAdd: 1, envie: 1, annuler: 3, reannuler: 1, abandon: 1,
  server: 2, settle: 3, offline: 1, online: 1, reload: 1, storm: 1, elsewhereMenu: 1,
}, 16);
/**
 * The cheese story (spec §11) through the outbox: comté bought for the gratin and the salade, the gratin cooked (its
 * sheet answering the comté or not), then the comté finished with the resolution the warning asks for, maybe offline,
 * maybe answered with no snapshot, then « Annuler » on the last tap and on the cook.
 */
const cheese = fc
  .record({
    offline: fc.boolean(),
    mode: fc.constantFrom<ServerMode>("ok", "no-snapshot", "lose-answer", "blind"),
    answers: fc.nat({ max: 511 }),
    choice: fc.nat({ max: 7 }),
    tail: actions({ annuler: 2, uncook: 2, reannuler: 1, finish: 1, cook: 1, server: 1, settle: 2, reload: 1, online: 1, storm: 1 }, 6),
  })
  .map(({ offline, mode, answers, choice, tail }): Action[] => [
    { kind: "buy", label: "comté" }, { kind: "settle" }, ...(offline ? [{ kind: "offline" }] as Action[] : []), { kind: "server", mode },
    { kind: "cook", pick: 0, answers, verdict: true }, { kind: "finish", pick: 0, choice }, { kind: "online" }, { kind: "settle" },
    { kind: "annuler", back: 0 }, { kind: "settle" }, { kind: "uncook", pick: 0, choice: 0, must: true }, ...tail,
  ]);
/**
 * The doubled pair: the saumon bought, its first round cooked (a plat cuisiné for the second round), then the second
 * round cooked, the plat finished (only « Retirer le repas » settles it) or the first round's cook taken back.
 */
const plat = fc
  .record({
    then: fc.constantFrom<Kind>("cook", "finish", "uncook", "drop"),
    tail: actions({ cook: 2, finish: 1, uncook: 2, annuler: 1, drop: 1, server: 1, settle: 2, reload: 1, storm: 1 }, 6),
  })
  .map(({ then, tail }): Action[] => [
    { kind: "buy", label: "pavé de saumon" }, { kind: "settle" }, { kind: "cook", pick: 2, answers: 0, verdict: false }, { kind: "settle" },
    act(then, 0), { kind: "settle" }, ...tail,
  ]);

/**
 * A Reste change taken back from the bar: the comté bought, then partly used, redated or finished (with the resolution
 * the warning asks for), maybe offline, maybe answered with no snapshot or lost, then « Annuler » on it, and on it again.
 */
const reste = fc
  .record({
    kind: fc.constantFrom("partial" as const, "useBy" as const, "finish" as const),
    choice: fc.nat({ max: 7 }),
    offline: fc.boolean(),
    mode: fc.constantFrom<ServerMode>("ok", "no-snapshot", "lose-answer", "blind"),
    tail: actions({ annuler: 2, reannuler: 1, partial: 1, useBy: 1, finish: 1, server: 1, settle: 2, reload: 1, online: 1, storm: 1 }, 6),
  })
  .map(({ kind, choice, offline, mode, tail }): Action[] => [
    { kind: "buy", label: "comté" }, { kind: "settle" }, ...(offline ? [{ kind: "offline" }] as Action[] : []), { kind: "server", mode },
    { kind, pick: 0, choice }, { kind: "online" }, { kind: "settle" }, { kind: "annuler", back: 0 }, { kind: "settle" }, ...tail,
  ]);

/**
 * « Il en reste » on the comté two or three times, each answered before the next, in the same words or not, then
 * « Annuler » on the first from the bar: a repeat is answered noop « déjà noté » and the first is taken back; a write
 * since, even one that put the first's words back (« un fond », nothing, « un fond »), has the undo refused « modifié
 * depuis ». Or « Il en reste : un fond » (low) on the plat cuisiné, then its second round cooked with a sheet saying
 * the same of it, then « Annuler » on the first: the cook wrote the row without changing it, and the undo is refused
 * « modifié depuis » all the same. The weighted runs reached neither the noop nor the undo behind a repeat.
 */
const repeatPartial = fc
  .record({
    choices: fc.array(fc.constantFrom(0, 1), { minLength: 2, maxLength: 3 }),
    tail: actions({ annuler: 1, reannuler: 1, partial: 1, server: 1, settle: 2, reload: 1 }, 4),
  })
  .map(({ choices, tail }): Action[] => [
    { kind: "buy", label: "comté" }, { kind: "settle" },
    ...choices.flatMap((choice): Action[] => [{ kind: "partial", pick: 0, choice }, { kind: "settle" }]),
    { kind: "annuler", back: choices.length - 1 }, { kind: "settle" }, ...tail,
  ]);
// Regression: 99b4539 — a cook's « Il en reste » in the plat cuisiné's own words let the undo of an earlier one erase it
const repeatByCook = actions({ annuler: 1, reannuler: 1, partial: 1, server: 1, settle: 2, reload: 1 }, 4).map((tail): Action[] => [
  { kind: "buy", label: "pavé de saumon" }, { kind: "settle" }, { kind: "cook", pick: 2, answers: 0, verdict: false }, { kind: "settle" },
  { kind: "partial", pick: 0, choice: 4, plat: true }, { kind: "settle" }, { kind: "cook", pick: 2, answers: 2, verdict: false }, { kind: "settle" },
  { kind: "annuler", back: 1 }, { kind: "settle" }, ...tail,
]);
const repeat = fc.oneof(repeatPartial, repeatByCook);

/**
 * The other phone finishes an item this phone still shows (an ajout to Reste, the only item nothing holds), then this
 * phone, offline since before it heard, finishes it too (noop « déjà fini ») or says « Il en reste » on it (refused
 * « déjà fini »). The weighted runs reached neither answer.
 */
const staleFinish = fc
  .record({
    then: fc.constantFrom("finish" as const, "partial" as const),
    tail: actions({ annuler: 1, reannuler: 1, finish: 1, server: 1, settle: 2, reload: 1 }, 4),
  })
  .map(({ then, tail }): Action[] => [
    { kind: "stockAdd" }, { kind: "settle" }, { kind: "offline" }, { kind: "elsewhereMenu", pick: 0, finish: true },
    { kind: then, pick: 0, choice: 0 }, { kind: "online" }, { kind: "settle" }, ...tail,
  ]);

// Regression: ebcb1f8 — an undo of a staple purchase put back a doubled share once its second round was dropped alone
/**
 * The lentilles bought, a meal dropped (a second round alone, or another), then « Annuler » on the purchase: the undo
 * that would put back a share no open meal needs any more is refused « repas doublé retiré depuis » (B14). The
 * weighted runs reached that refusal in none of 2000 runs, and the staple bound then passed with its check removed.
 */
const staple = fc
  .record({ drop: pick, tail: actions({ annuler: 1, reannuler: 2, settle: 2 }, 4) })
  .map(({ drop, tail }): Action[] => [
    { kind: "buy", label: "lentilles vertes" }, { kind: "settle" }, { kind: "drop", pick: drop, choice: 0 }, { kind: "settle" },
    { kind: "annuler", back: 1 }, { kind: "settle" }, ...tail,
  ]);

/**
 * A meal cooked, the page reloaded, then « Annuler » on it from « Cuisinés récemment »: the new page has lost the cook's
 * fate, so only the row naming its op says it landed, and the undo must still be sent. The weighted runs reached that
 * « Annuler » in some runs only: the row's half of the check then passed 2 of 10 times with that half removed.
 */
const reloadUncook = fc
  .record({ answers: fc.nat({ max: 511 }), tail: actions({ annuler: 1, reannuler: 1, uncook: 1, server: 1, settle: 2, reload: 1 }, 4) })
  .map(({ answers, tail }): Action[] => [
    { kind: "buy", label: "comté" }, { kind: "settle" }, { kind: "cook", pick: 0, answers, verdict: false }, { kind: "settle" },
    { kind: "reload" }, { kind: "uncook", pick: 0, choice: 0, must: true }, { kind: "settle" }, ...tail,
  ]);

/**
 * The saumon bought, then, offline, its first round cooked and its second round cooked from the pool that shows it
 * free: both leave in one request whose first op the server throws, so the second round lands before the first and is
 * refused « cuisinez d'abord le premier tour », then the first is sent again. The weighted runs reached that refusal in
 * none of 2000 runs.
 */
const firstRound = fc
  .record({ answers: fc.nat({ max: 511 }), tail: actions({ annuler: 1, reannuler: 1, uncook: 1, cook: 1, server: 1, settle: 2, reload: 1 }, 4) })
  .map(({ answers, tail }): Action[] => [
    { kind: "buy", label: "pavé de saumon" }, { kind: "settle" }, { kind: "offline" }, { kind: "server", mode: "throw-first" },
    { kind: "cook", pick: 2, answers: 0, verdict: false }, { kind: "cook", pick: 2, answers, verdict: false }, { kind: "online" }, { kind: "settle" },
    { kind: "server", mode: "ok" }, { kind: "settle" }, ...tail,
  ]);

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Session {
  sync: Sync;
  timers: (() => void)[];
  /** False once the page is gone: its store writes and requests never happen, as when the OS kills the app. */
  alive: { on: boolean };
  /** Store writes still to land before the OS kills the app (`crash`); null: no kill coming. */
  budget: { left: number | null };
  /** Taps made since this page opened, oldest first: what the « Annuler » bar can name. */
  taps: string[];
  /** Refusals of this page already read into `World.refusals`. */
  read: number;
  /** Final answers this page read and has not stored yet: what it knows only while it stays open (`World.told`). */
  heard: Map<string, WireResult>;
  /**
   * The step of the first store write refused since a write last landed once the page knew of a refusal: what the page
   * did from then on may die with it (the phone says so); null while the disk holds all of it. `sent`: the ops it sent
   * meanwhile, whose send count the disk may not hold.
   */
  loss: { from: number | null; sent: string[] };
  /** Unrecorded answers this page read for each op since its tap, its load or its last « Réessayer ». */
  unrecorded: Map<string, number>;
  /** Ops this page read an unrecorded answer for since a RETRY_MS timer last ran: none may leave before the next one. */
  held: Set<string>;
}

interface World {
  initial: State;
  server: ReturnType<typeof fakeServer>;
  disk: SyncStore;
  online: boolean;
  ids: number;
  labels: number;
  session: Session;
  /** Every tap's label by op id (« Annuler » passes it too, so a refusal names its target). */
  tapLabels: Map<string, string>;
  /** The step each tap was made at. */
  tapAt: Map<string, number>;
  /**
   * Ops a page tapped, cancelled or abandoned while its store refused writes, and that died with it before a write
   * landed again: the phone said such actions may be lost on close, so either fate is the user's.
   */
  lost: Set<string>;
  /**
   * Every « Annuler », by the op it named, with the step it was tapped at; `held`: an undo of that op already waited, or
   * sat en échec, in the outbox when it was tapped, so it asked for nothing new.
   */
  annulers: { target: string; at: number; held: boolean }[];
  /** Every « Abandonner », by the op it named, with the step it was tapped at. */
  abandoned: Map<string, { op: Op; at: number }>;
  /** The step of the last « Réessayer » on each op. */
  retried: Map<string, number>;
  /**
   * The final answers (a result not listed unrecorded) a store write has kept, by op id: what the phone knows of an op
   * once the page that read them is gone. An answer read by a page killed before it stored it is forgotten, rightly.
   */
  told: Map<string, WireResult>;
  /** How many final answers of each op reached a live page: a page killed before storing one gets it again on resend. */
  answers: Map<string, number>;
  /** The op each undo sent names. */
  undoOf: Map<string, string>;
  /**
   * Faults seen as each request left (`judge`): a pointless undo, a target sent again after its undo, a resend the
   * bounded retry forbids.
   */
  pointless: string[];
  /**
   * A focused chain asked to take a cook back (`must`): the run must then post an undo of a meal.cook this phone tapped,
   * or the chain did nothing and the property would pass without the case it exists for.
   */
  mustUncook: boolean;
  /** Another phone's ops, by id (`x-…`), and the server's request count when the last one landed. */
  elsewhere: Map<string, Op>;
  elsewhereAt: number;
  /** Every refusal the phone showed, with the step it showed at. */
  refusals: (Refusal & { at: number })[];
  /** Ops answered unrecorded at least once: the server may have applied later ops of their request (§8.2). */
  unrecorded: Set<string>;
  /**
   * Ops the user gave up on while en échec, with « Abandonner » or « Annuler »: they may have landed, and their undo
   * then takes back whatever they did, a purchase the user ticked again meanwhile included.
   */
  gaveUp: Set<string>;
  /**
   * Unrecorded answers a live page read for each op since its tap, or since a « Réessayer » of it that the store kept:
   * at least as many as the phone counted, since a page killed before storing one forgets it. Fewer than SPEC_MAX_UNRECORDED
   * and the op cannot rightly be en échec.
   */
  unrecordedSince: Map<string, number>;
  /** The store refuses every write (`disk`), while the page keeps running. */
  full: boolean;
  at: number;
}

function open(w: World): Session {
  const alive = { on: true };
  const live = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A): Promise<R> => (alive.on ? f(...a) : never<R>());
  const budget: { left: number | null } = { left: null };
  const heard = new Map<string, WireResult>();
  const unrecorded = new Map<string, number>();
  const held = new Set<string>();
  const loss: Session["loss"] = { from: null, sent: [] };
  let refusal: { known: boolean } | null = null;
  // each write lands whole, in call order, until the budget runs out: the app dies there, as between two transactions
  const lands = live(async (change: StoreWrite): Promise<void> => {
    if (budget.left !== null && budget.left-- <= 0) {
      if (w.session.alive === alive) harvest(w); // what the page showed up to its death
      alive.on = false;
      return never();
    }
    if (w.full) {
      // a refused write opens a loss; the page knows of it once its rejection has run, as IndexedDB's error event
      loss.from ??= w.at;
      const mark = { known: false };
      setTimeout(() => {
        mark.known = true;
      }, 0);
      refusal = mark;
      throw new DOMException("quota dépassé", "QuotaExceededError");
    }
    await w.disk.write(change);
    // a write that lands once the page knew of the last refusal must leave the disk holding all the page did
    if (refusal?.known) {
      loss.from = null;
      loss.sent = [];
      refusal = null;
    }
    // Regression: 0ace0e3 — an answer dropped with no snapshot was not "told", so the decision-17 revert passed
    // an answer is kept once a write that landed holds it: its op stored with it, or gone from the stored outbox (on
    // correct code only with a snapshot taken after it; one dropped without that snapshot is forgotten, and that phone
    // is judged as told, since an answer stays in the outbox until a snapshot covers it); a rewrite (`replace`) removes every op it does not put
    for (const [id, r] of heard) {
      const entry = change.put.find((e) => e.op.opId === id);
      if (entry?.final !== undefined || (change.replace ? entry === undefined : change.remove.includes(id))) {
        w.told.set(id, r);
        heard.delete(id);
      }
    }
  });
  const store: SyncStore = {
    readSnapshot: live(w.disk.readSnapshot),
    readOutbox: live(w.disk.readOutbox),
    write: lands,
  };
  const fetch: Fetcher = live(async (url: string, init?: RequestInit) => {
    if (url === "/api/ops") judge(w, (JSON.parse(String(init?.body)) as { ops: Op[] }).ops);
    const res = await w.server.fetch(url, init);
    if (url === "/api/ops" && res.ok) {
      const answer = (await res.clone().json()) as OpsAnswer;
      for (const id of answer.unrecorded) w.unrecorded.add(id);
      if (!alive.on) return never<Response>(); // a page killed meanwhile never reads the answer
      const answered = new Set(answer.results.flatMap((r) => (r.opId === null ? [] : [r.opId])));
      for (const o of (JSON.parse(String(init?.body)) as { ops: Op[] }).ops) {
        if (!answer.unrecorded.includes(o.opId) && answered.has(o.opId)) continue;
        w.unrecordedSince.set(o.opId, (w.unrecordedSince.get(o.opId) ?? 0) + 1);
        unrecorded.set(o.opId, (unrecorded.get(o.opId) ?? 0) + 1);
        held.add(o.opId);
      }
      for (const r of answer.results) {
        if (r.opId === null || answer.unrecorded.includes(r.opId)) continue;
        heard.set(r.opId, r);
        w.answers.set(r.opId, (w.answers.get(r.opId) ?? 0) + 1);
      }
    }
    if (!alive.on) return never<Response>();
    return res;
  });
  const timers: (() => void)[] = [];
  const sync = new Sync({
    store, persistent: true, fetch, now: () => TAP_AT, uuid: () => `p-${++w.ids}`, isOnline: () => w.online, isVisible: () => true,
    schedule: (run) => {
      const timer = () => {
        if (!alive.on) return;
        held.clear();
        run();
      };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at !== -1) timers.splice(at, 1);
      };
    },
  });
  return { sync, timers, alive, budget, taps: [], read: 0, heard, loss, unrecorded, held };
}

async function world(): Promise<World> {
  const initial = plannedForPhones();
  const w: World = {
    initial, server: fakeServer(initial), disk: memoryStore(), online: true, ids: 0, labels: 0,
    session: null as unknown as Session, tapLabels: new Map(), tapAt: new Map(), lost: new Set(), annulers: [], abandoned: new Map(), retried: new Map(), told: new Map(), answers: new Map(), undoOf: new Map(), pointless: [], mustUncook: false, elsewhere: new Map(), elsewhereAt: -1, refusals: [], unrecorded: new Set(), gaveUp: new Set(), unrecordedSince: new Map(), full: false, at: 0,
  };
  w.session = open(w);
  await w.session.sync.load();
  await w.session.sync.refresh();
  return w;
}

async function tap(w: World, type: string, payload: unknown, what: string): Promise<void> {
  const label = `${what} #${++w.labels}`;
  const id = await w.session.sync.tap(type, payload, label);
  w.tapLabels.set(id, label);
  w.tapAt.set(id, w.at);
  w.session.taps.push(id);
}

const labelOf = (w: World, opId: string) => w.tapLabels.get(opId) ?? `ligne ${opId}`;

/** An undo of `target` waiting or en échec in this page's outbox: the pending list shows it, so « Annuler » adds none. */
const undoPending = (s: Session, target: string): boolean =>
  (s.sync as unknown as { outbox: readonly OutboxEntry[] }).outbox.some((e) => undoTarget(e.op) === target && e.final === undefined);

async function annuler(w: World, target: string): Promise<void> {
  if (w.session.sync.getState().failed.some((e) => e.op.opId === target)) w.gaveUp.add(target);
  w.annulers.push({ target, at: w.at, held: undoPending(w.session, target) });
  await w.session.sync.undo(target, labelOf(w, target));
}

/** The resolution the reservation warning sends (spec §10.4): « Racheter » when asked and offered, else « Retirer le repas ». */
const resolutionFor = (holding: ViewItem["reservations"], rebuy: boolean): "drop_meal" | "rebuy" => (rebuy && canRebuy(holding) ? "rebuy" : "drop_meal");

async function step(w: World, a: Action): Promise<void> {
  const s = w.session;
  const state = s.sync.getState();
  const lines = state.view?.courses.lines ?? [];
  const nth = <T>(xs: T[], n: number): T | undefined => (xs.length === 0 ? undefined : xs[n % xs.length]);
  // what the screens offer: a pool meal whose first round is cooked (`!= null`: an older snapshot may lack the field),
  // a Reste item with a server id
  const pool = (state.view?.menu.pool ?? []).filter((m) => m.firstRoundId == null);
  const items = state.view === null ? [] : viewItems(state.view).filter((i) => !i.pending);
  switch (a.kind) {
    case "buy": {
      const line = lines.find((l) => l.label === a.label && l.boughtAt === null && !l.pending);
      if (line) await tap(w, "shopping.buy", { itemId: line.id }, `Acheté : ${line.label}`);
      return;
    }
    case "cook": {
      const meal = nth(pool, a.pick);
      if (!meal) return;
      // the Cuisiné sheet: each held item once, a pending one (a plat cuisiné not synced) left unanswered
      const held = [...new Map(meal.reservedItems.filter((r) => r.stockItemId > 0).map((r) => [r.stockItemId, r])).values()];
      const answers = held.flatMap((r, k): Record<string, unknown>[] => {
        const bits = (a.answers >> (2 * k)) & 3;
        if (bits === 0) return [];
        if (bits === 2) return [{ stockItemId: r.stockItemId, outcome: "il_en_reste", qtyText: k % 2 === 0 ? "un fond" : null, low: k % 2 === 0 }];
        const others = items.find((i) => i.id === r.stockItemId)?.reservations.filter((x) => x.mealId !== meal.id) ?? [];
        return [{ stockItemId: r.stockItemId, outcome: "fini", ...(others.length > 0 ? { resolution: resolutionFor(others, bits === 3) } : {}) }];
      });
      await tap(w, "meal.cook", { mealId: meal.id, sheet: { verdict: a.verdict ? "a_refaire" : null, note: null, items: answers } }, `Cuisiné : ${meal.title}`);
      return;
    }
    case "drop": {
      const meal = nth(state.view?.menu.pool ?? [], a.pick);
      if (meal) await tap(w, "meal.drop", { mealId: meal.id }, `Retiré du menu : ${meal.title}`);
      return;
    }
    case "finish": {
      const item = nth(items, a.pick);
      if (!item) return;
      const resolution = item.reservations.length > 0 ? { resolution: resolutionFor(item.reservations, a.choice % 2 === 1) } : {};
      await tap(w, "stock.finish", { itemId: item.id, ...resolution }, `Fini : ${item.label}`);
      return;
    }
    case "partial": {
      // the plat cuisiné bears the title of the second round that eats it
      const plat = (i: ViewItem) => (state.view?.menu.pool ?? []).some((m) => m.isSecondRound && m.title === i.label);
      const item = a.plat ? items.find(plat) : nth(items, a.pick);
      if (item) await tap(w, "stock.partial", { itemId: item.id, qtyText: a.choice % 2 === 0 ? "un fond" : null, low: a.choice >= 4 }, `Il en reste : ${item.label}`);
      return;
    }
    case "useBy": {
      const item = nth(items, a.pick);
      if (item) await tap(w, "stock.set_use_by", { itemId: item.id, useBy: `2026-10-${String(10 + a.choice).padStart(2, "0")}` }, `Nouvelle date : ${item.label}`);
      return;
    }
    case "stockAdd":
      return tap(w, "stock.add", { label: `olives ${w.labels + 1}`, productId: null, qtyText: null, useBy: null }, "Ajouté au Reste");
    case "envie":
      return tap(w, "envie.add", { text: `envie ${w.labels + 1}`, url: null }, "Envie");
    case "uncook": {
      const meal = nth((state.view?.menu.recentlyCooked ?? []).filter((m) => m.cookOpId !== null && !m.undoing), a.pick);
      if (a.must) w.mustUncook = true;
      if (meal) await annuler(w, meal.cookOpId!);
      return;
    }
    case "elsewhereMenu": {
      const S = w.server.state;
      const open = (id: number) => S.meals.some((m) => m.id === id && m.cookedAt === null && m.droppedAt === null);
      const held = (id: number) => S.reservations.some((r) => r.stockItemId === id && r.releasedAt === null);
      const meal = nth(S.meals.filter((m) => open(m.id) && !(m.doubledFrom !== null && open(m.doubledFrom))), a.pick);
      const item = nth(S.stockItems.filter((i) => i.finishedAt === null && !held(i.id)), a.pick);
      const o: Op | undefined = a.finish
        ? item && { opId: `x-${++w.ids}`, type: "stock.finish", at: TAP_AT, payload: { itemId: item.id } }
        : meal && { opId: `x-${++w.ids}`, type: "meal.cook", at: TAP_AT, payload: { mealId: meal.id, sheet: {} } };
      if (!o) return;
      w.elsewhere.set(o.opId, o);
      w.server.elsewhere(o);
      w.elsewhereAt = w.server.requests;
      return;
    }
    case "tick": {
      const line = nth(lines.filter((l) => l.boughtAt === null && !l.pending), a.pick);
      if (line) await tap(w, "shopping.buy", { itemId: line.id }, `Acheté : ${line.label}`);
      return;
    }
    case "untick": {
      const line = nth(lines.filter((l) => l.boughtAt !== null && l.buyOpId !== null), a.pick);
      if (line) await annuler(w, line.buyOpId!);
      return;
    }
    case "add":
      return tap(w, "shopping.add", { label: `ajout ${w.labels + 1}`, isFood: a.food }, "Ajouté");
    case "remove": {
      const line = nth(lines.filter((l) => l.boughtAt === null && !l.pending), a.pick);
      const reason = a.pick % 2 === 0 ? "a_la_maison" : "pas_achete";
      if (line) await tap(w, "shopping.remove", line.kind === "ajout" ? { itemId: line.id } : { itemId: line.id, reason }, `Retiré : ${line.label}`);
      return;
    }
    case "checkout": {
      if (a.none) {
        const bought = lines.filter((l) => l.boughtAt !== null).map((l) => l.id);
        if (bought.length > 0) await tap(w, "trip.record", { place: "autre", date: "2026-10-12", itemIds: bought, noReceipt: true }, "Passage sans ticket");
        return;
      }
      // the ticket sheet opens on the last trip the phone has an answer for, while it has no total, and stays on that trip
      const due = state.view?.lastTrip ?? null;
      if (due !== null && due.id >= 0 && due.totalCents === null) {
        await tap(w, "trip.set_total", { tripId: due.id, totalCents: 1380 }, "Ticket");
        return;
      }
      // the sheet lists the basket it shows, and opens only on a basket with something in it; the receipt total is optional
      const basket = lines.filter((l) => l.boughtAt !== null).map((l) => l.id);
      const total = a.receipt ? { totalCents: 1250 } : {};
      if (basket.length > 0) await tap(w, "trip.record", { place: "marche", ...total, date: "2026-10-12", itemIds: basket }, "Passage en caisse");
      return;
    }
    case "elsewhere": {
      const S = w.server.state;
      if (a.trip) {
        const basket = S.shoppingItems.filter((l) => l.removedAt === null && l.boughtAt !== null && l.tripId === null).map((l) => l.id);
        const last = [...w.server.landed].reverse().find((id) => {
          const r = storedOp(S.appliedOps, id);
          return r?.type === "trip.record" && r.status === "applied" && r.undoneBy === null;
        });
        const o: Op | undefined = a.undo
          ? last === undefined ? undefined : { opId: `x-${++w.ids}`, type: "undo", at: TAP_AT, payload: { targetOpId: last } }
          : basket.length === 0 ? undefined : { opId: `x-${++w.ids}`, type: "trip.record", at: TAP_AT, payload: { place: "supermarche", totalCents: 990, date: "2026-10-12", itemIds: basket } };
        if (!o) return;
        w.elsewhere.set(o.opId, o);
        w.server.elsewhere(o);
        w.elsewhereAt = w.server.requests;
        return;
      }
      const bought = Object.values(S.appliedOps).filter((r) => r.type === "shopping.buy" && r.status === "applied" && r.undoneBy === null);
      const target = a.undo ? nth(bought, a.pick) : undefined;
      const line = a.undo ? undefined : nth(S.shoppingItems.filter((l) => l.removedAt === null && l.boughtAt === null), a.pick);
      if (!target && !line) return;
      const o: Op = target
        ? { opId: `x-${++w.ids}`, type: "undo", at: TAP_AT, payload: { targetOpId: target.opId } }
        : { opId: `x-${++w.ids}`, type: "shopping.buy", at: TAP_AT, payload: { itemId: line!.id } };
      w.elsewhere.set(o.opId, o);
      w.server.elsewhere(o);
      w.elsewhereAt = w.server.requests;
      return;
    }
    case "doomed": {
      const line = nth(lines.filter((l) => !l.pending && (l.kind !== "ajout" || l.boughtAt !== null)), a.pick);
      if (line) await tap(w, "shopping.remove", { itemId: line.id }, `Retiré : ${line.label}`);
      return;
    }
    case "annuler": {
      const target = await barOrPending(w, a.back);
      if (target) await annuler(w, target);
      return;
    }
    case "crash":
      return crash(w, a);
    case "reannuler": {
      const undone = [...w.abandoned.values()].map(({ op }) => undoTarget(op) ?? op.opId);
      // only an op the screen still names: a tap of this page (the bar), a pending op, or a row
      const outbox = (await w.disk.readOutbox()).map((e) => e.op.opId);
      const cooked = (state.view?.menu.recentlyCooked ?? []).flatMap((m) => (m.cookOpId === null ? [] : [m.cookOpId]));
      const named = new Set([...s.taps, ...outbox, ...lines.flatMap((l) => (l.buyOpId === null ? [] : [l.buyOpId])), ...cooked]);
      const target = nth([...new Set([...w.annulers.map((x) => x.target), ...undone])].filter((t) => w.tapLabels.has(t) && named.has(t)), a.pick);
      if (target) await annuler(w, target);
      return;
    }
    case "retry": {
      const entry = nth(state.failed, a.pick);
      if (!entry) return;
      s.unrecorded.delete(entry.op.opId);
      s.held.delete(entry.op.opId);
      w.retried.set(entry.op.opId, w.at);
      await s.sync.retry(entry.op.opId);
      // the user asked for a fresh count; one the store refused dies with the page, so the model keeps counting then
      if (state.persistent && s.sync.getState().persistent) w.unrecordedSince.set(entry.op.opId, 0);
      return;
    }
    case "abandon": {
      const entry = nth(state.failed, a.pick);
      if (!entry) return;
      w.abandoned.set(entry.op.opId, { op: entry.op, at: w.at });
      w.gaveUp.add(entry.op.opId);
      await s.sync.abandon(entry.op.opId);
      return;
    }
    case "reload":
      return reload(w);
    case "offline":
      w.online = false;
      s.sync.markOffline();
      return;
    case "online":
      w.online = true;
      void s.sync.refresh();
      return;
    case "server":
      w.server.mode = a.mode;
      return;
    case "disk":
      w.full = a.full;
      return;
    case "turn":
      await turn();
      return;
    case "settle":
      await s.sync.flush();
      return;
    case "timer":
      s.timers.shift()?.();
      return;
    case "storm":
      for (let i = 0; i < 6; i++) {
        s.timers.shift()?.();
        await s.sync.flush();
      }
      return;
  }
}

/** An op 0–4 back among this page's taps (the 5-second bar), then the pending ops (« Annuler » on a waiting row). */
async function barOrPending(w: World, back: number): Promise<string | undefined> {
  const pending = (await w.disk.readOutbox()).filter((e) => e.op.type !== "undo").map((e) => e.op.opId).reverse();
  const named = [...new Set([...[...w.session.taps].reverse(), ...pending])];
  return named.length === 0 ? undefined : named[back % named.length];
}

/** The app closed and opened again: the old page's writes and requests never happen. */
async function reload(w: World): Promise<void> {
  if (w.session.alive.on) harvest(w);
  w.session.alive.on = false;
  bury(w);
  w.session = open(w);
  await w.session.sync.load();
  void w.session.sync.refresh();
}

/**
 * A page that dies while its store refuses writes, with no write landed since it knew of the refusal, loses what it did
 * from the first refusal on: its taps, « Annuler » and « Abandonner » may or may not survive the reload (the phone said
 * so), and so may the send count of every op it sent meanwhile. Once a write lands again, the disk must hold all of
 * it, so nothing is forgiven.
 */
function bury(w: World): void {
  const from = w.session.loss.from;
  if (from === null) return;
  for (const x of w.annulers) if (x.at >= from) w.lost.add(x.target);
  for (const [id, { op, at }] of w.abandoned) {
    if (at < from) continue;
    w.lost.add(id);
    w.lost.add(undoTarget(op) ?? id);
  }
  for (const id of w.session.taps) if ((w.tapAt.get(id) ?? -1) >= from) w.lost.add(id);
  // sent while the store refused its send count: the next page may load it as never sent, and « Annuler » there,
  // before a read names it on a row, drops it on the phone only (left to the owner)
  for (const id of w.session.loss.sent) w.lost.add(id);
}

/**
 * The OS kills the app during an « Annuler » or an « Abandonner », once `after` store writes have landed, then the app
 * opens again. Only what reached the disk was done: the screen shows a new undo, or an op gone, only once its write
 * commits, so the user's tap counts when its undo is on disk or its op is off it.
 */
async function crash(w: World, a: Extract<Action, { kind: "crash" }>): Promise<void> {
  const s = w.session;
  const failed = s.sync.getState().failed;
  const entry = a.then === "abandon" && failed.length > 0 ? failed[a.pick % failed.length] : undefined;
  const target = a.then === "annuler" ? await barOrPending(w, a.pick) : entry?.op.opId;
  if (!target) return;
  const undosOf = (outbox: OutboxEntry[]) => outbox.filter((e) => undoTarget(e.op) === target).map((e) => e.op.opId);
  const before = await w.disk.readOutbox();
  const held = undoPending(s, target);
  let finished = false;
  s.budget.left = a.after;
  void (a.then === "annuler" ? s.sync.undo(target, labelOf(w, target)) : s.sync.abandon(target)).then(() => {
    finished = true;
  });
  for (let i = 0; i < 3; i++) await turn();
  const after = await w.disk.readOutbox();
  const took = finished
    || undosOf(after).some((u) => !undosOf(before).includes(u))
    || (before.some((e) => e.op.opId === target) && !after.some((e) => e.op.opId === target));
  if (took && a.then === "annuler") w.annulers.push({ target, at: w.at, held });
  if (took && entry) w.abandoned.set(target, { op: entry.op, at: w.at });
  if (took && (entry || failed.some((e) => e.op.opId === target))) w.gaveUp.add(target);
  await reload(w);
}

const NOT_IN_EFFECT: (string | null)[] = [TARGET_MISSING, NOTHING_TO_UNDO, ALREADY_UNDONE];

/** What the sending page knows of an op's final answer: stored by any page, or read by this one. */
const known = (w: World, opId: string): WireResult | undefined => w.told.get(opId) ?? w.session.heard.get(opId);

/**
 * (b), judged as each request leaves, against what the answers so far told the phone (`known`): no undo of an op that never
 * reached the server (dropped on the phone, or cancelled), no undo of an op it was told changed nothing (noop, refused),
 * and no second undo of an op an undo from here was told it took back (applied, or
 * refused saying the op is not in effect). An op it was never told about (answered unrecorded, its answers lost, or
 * abandoned en échec) may have landed, so an undo of it is due, as is a new one after an undo abandoned en échec.
 */
function judge(w: World, ops: Op[]): void {
  const s = w.session;
  for (const o of ops) {
    if (s.loss.from !== null && undoTarget(o) === null) s.loss.sent.push(o.opId);
    // (c), bounded retry: no resend before RETRY_MS after an unrecorded answer, none past SPEC_MAX_UNRECORDED of them
    if (s.held.has(o.opId)) w.pointless.push(`(c) ${labelOf(w, o.opId)} resent before RETRY_MS after an unrecorded answer`);
    const n = s.unrecorded.get(o.opId) ?? 0;
    if (n >= SPEC_MAX_UNRECORDED) w.pointless.push(`(c) ${labelOf(w, o.opId)} resent after ${n} unrecorded answers with no « Réessayer »`);
    // (f): a target sent again after its undo by a page that knew its final answer; a page that never kept that answer
    // (gone before a write held it) rightly resends it under its id, and the server replays it
    if ([...w.undoOf.values()].includes(o.opId) && known(w, o.opId) !== undefined) w.pointless.push(`(f) ${labelOf(w, o.opId)} went again after its undo`);
    const t = undoTarget(o);
    if (t === null) continue;
    w.undoOf.set(o.opId, t);
    // an undo leaves only once its target has a final answer or was abandoned after SPEC_MAX_UNRECORDED sends, so its
    // target was posted before; one never posted was cancelled or dropped on the phone, and the undo is pointless
    if (!w.elsewhere.has(t) && !w.server.posts.some((ops) => ops.some((x) => x.opId === t))) {
      w.pointless.push(`(b) an undo sent for ${labelOf(w, t)}, which never reached the server`);
    }
    const target = known(w, t);
    if (target && target.status !== "applied") w.pointless.push(`(b) an undo sent for ${labelOf(w, t)}, which the phone was told was ${target.status}`);
    const back = [...w.undoOf].some(([u, of]) => {
      const r = known(w, u);
      return u !== o.opId && of === t && r !== undefined && (r.status === "applied" || (r.status === "refused" && NOT_IN_EFFECT.includes(r.reason)));
    });
    if (back) w.pointless.push(`(b) a second undo of ${labelOf(w, t)} once the phone was told one took it back`);
  }
}

/** Reads the refusals the page showed since the last read. */
function harvest(w: World): void {
  const { refusals: shown } = w.session.sync.getState();
  for (const r of shown.slice(w.session.read)) w.refusals.push({ ...r, at: w.at });
  w.session.read = shown.length;
}

/**
 * Online, the server answering, every timer run, until nothing moves. The app reads the state only when the spec says
 * it does (the network coming back, the app brought to the foreground, « Se reconnecter »): never as a last step, so a
 * view left stale by an answer shows. Another phone's change since this one's last request is seen by bringing the app
 * back to the foreground.
 */
async function quiesce(w: World): Promise<void> {
  w.server.mode = "ok";
  w.full = false;
  const s = w.session;
  for (let i = 0; i < 20; i++) {
    while (s.timers.length > 0) s.timers.shift()!();
    await s.sync.flush();
    const state = s.sync.getState();
    if (s.timers.length > 0) continue;
    if (state.waitingCount === 0 && state.status === "online" && w.online && w.server.requests > w.elsewhereAt) break;
    w.online = true;
    await s.sync.refresh();
  }
  w.at += 1;
  harvest(w);
}

/**
 * The k-th row of its kind in `into` for the k-th in `from`: an op the fold leaves out (undone) takes no id there, so the
 * later rows get lower ids than on the server. Rows of a kind are created in the same order on both sides (ids only
 * grow). A row the server no longer holds was created by an op the fold leaves out, so it names no row there either
 * (0: no table issues it): a cook sheet can still name the item of a purchase whose undo was waiting when it was shown.
 */
function sameRow<R extends { id: number }>(from: readonly R[], into: readonly R[], kind: (r: R) => string, id: number): number {
  const row = from.find((r) => r.id === id);
  if (!row) return 0;
  const k = kind(row);
  const nth = from.filter((r) => kind(r) === k && r.id < id).length;
  return into.filter((r) => kind(r) === k).sort((a, b) => a.id - b.id)[nth]?.id ?? id;
}

/** The op with the ids it names (lines, Reste items, trips) read in `into`; meal ids come from the planning, the same on both. */
function sameRows(o: Op, from: State, into: State): Op {
  const p = o.payload as { itemId?: unknown; itemIds?: unknown; tripId?: unknown; sheet?: { items?: { stockItemId: number }[] } };
  const line = (id: number) => sameRow(from.shoppingItems, into.shoppingItems, (l) => `${l.label}|${l.kind}`, id);
  const item = (id: number) => sameRow(from.stockItems, into.stockItems, (i) => `${i.origin}|${i.label}`, id);
  // a trip has the place among the live trips that `from` gives it, which `into` holds up to the trips recorded before it
  const trips = (st: State) => [...st.trips].sort((a, b) => a.id - b.id);
  if (typeof p.tripId === "number") return { ...o, payload: { ...p, tripId: trips(into)[trips(from).findIndex((t) => t.id === p.tripId)]?.id ?? p.tripId } };
  if (o.type.startsWith("stock.") && typeof p.itemId === "number") return { ...o, payload: { ...p, itemId: item(p.itemId) } };
  if (o.type === "meal.cook" && Array.isArray(p.sheet?.items)) {
    return { ...o, payload: { ...p, sheet: { ...p.sheet, items: p.sheet.items.map((x) => ({ ...x, stockItemId: item(x.stockItemId) })) } } };
  }
  if (typeof p.itemId === "number") return { ...o, payload: { ...p, itemId: line(p.itemId) } };
  if (Array.isArray(p.itemIds)) return { ...o, payload: { ...p, itemIds: p.itemIds.map((id) => (typeof id === "number" ? line(id) : id)) } };
  return o;
}

const ID_KEYS = new Set(["id", "stockItemId", "version"]);
/** What the user can see of a state, with row ids left out: an op applied then undone may leave a gap in an id sequence. */
function normal(state: State): unknown {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (typeof v !== "object" || v === null) return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !ID_KEYS.has(k)).map(([k, x]) => [k, strip(x)]));
  };
  const trips = [...state.trips].sort((a, b) => a.id - b.id);
  const lines = state.shoppingItems
    .map((l) => ({
      label: l.label, kind: l.kind, bought: l.boughtAt !== null, removed: l.removedAt !== null,
      trip: l.tripId === null ? null : trips.findIndex((t) => t.id === l.tripId), qty: l.qty, price: l.estPriceCents, meals: l.forMeals,
    }))
    .sort((a, b) => `${a.label}|${a.kind}`.localeCompare(`${b.label}|${b.kind}`));
  // Reste, meals and envies whole, finished and released rows included: the snapshot shows only what is open
  const label = (stockItemId: number) => state.stockItems.find((i) => i.id === stockItemId)?.label ?? null;
  const rows = <T>(xs: readonly T[], f: (x: T) => unknown[]) => xs.map((x) => JSON.stringify(f(x))).sort();
  return {
    snapshot: strip(snapshot(state, NOW)), lines, trips: trips.map((t) => [t.date, t.place, t.totalCents]),
    stock: rows(state.stockItems, (i) => [i.origin, i.label, i.qty, i.unit, i.qtyText, i.isLow, i.useBy, i.openedAt !== null, i.finishedAt !== null]),
    reservations: rows(state.reservations, (r) => [label(r.stockItemId), r.mealId, r.qty, r.unit, r.releasedAt !== null]),
    meals: state.meals.map((m) => [m.id, m.cookedAt !== null, m.droppedAt !== null, m.verdict, m.note]),
    recipes: state.recipes.map((r) => [r.id, r.status]),
    envies: rows(state.envies, (e) => [e.text, e.url, e.status]),
  };
}

/** The invariants (a)–(f) of the task, plus the truth of every refusal shown; returns the broken ones, in words. */
async function broken(w: World): Promise<string[]> {
  const out: string[] = [];
  const S = w.server.state;
  const rec = (id: string) => storedOp(S.appliedOps, id);
  const live = (id: string) => rec(id)?.status === "applied" && rec(id)!.undoneBy === null;
  const posted = new Map<string, Op>();
  for (const o of w.server.posts.flat()) if (!posted.has(o.opId)) posted.set(o.opId, o);
  const outbox: OutboxEntry[] = await w.disk.readOutbox();
  const state = w.session.sync.getState();
  const left = new Set(state.failed.map((e) => e.op.opId));

  // every undo this phone made, by target: sent, or still in the outbox
  const undos = new Map<string, Op[]>();
  for (const o of [...posted.values(), ...outbox.map((e) => e.op)]) {
    const t = undoTarget(o);
    if (t === null) continue;
    const list = undos.get(t) ?? [];
    if (!list.some((u) => u.opId === o.opId)) list.push(o);
    undos.set(t, list);
  }
  // a cancel whose undo the user left en échec, or abandoned with no « Annuler » since, may or may not have landed:
  // either fate is the user's
  const lastAnnuler = (t: string) => Math.max(0, ...w.annulers.filter((x) => x.target === t).map((x) => x.at));
  const unsure = (t: string) => (undos.get(t) ?? []).some((u) => left.has(u.opId) || (w.abandoned.get(u.opId)?.at ?? -1) > lastAnnuler(t));
  const cancelled = (t: string) => w.annulers.some((x) => x.target === t) || w.abandoned.has(t);
  const reported = (label: string, reasons: (string | null)[], since = 0) =>
    w.refusals.some((r) => r.label === label && reasons.includes(r.reason) && r.at >= since);
  const itemOf = (o: Op | undefined) => (o?.type === "shopping.buy" ? (o.payload as { itemId: number }).itemId : undefined);
  const order = new Map(w.server.landed.map((id, i) => [id, i]));
  /** The last step the user asked for `g` to be taken back: « Annuler », « Abandonner », or « Réessayer » on an undo of it. */
  const lastAsk = (g: string) =>
    Math.max(-1, w.abandoned.get(g)?.at ?? -1, ...w.annulers.filter((x) => x.target === g).map((x) => x.at), ...(undos.get(g) ?? []).map((u) => w.retried.get(u.opId) ?? -1));
  /**
   * For a purchase answered noop whose line ends unbought: the op of that line whose undo from here landed after the
   * noop, when that op was given up on en échec or the user's last ask to take it back came before the tap.
   */
  const noopUndoneBy = (t: string): string | undefined => {
    const item = itemOf(posted.get(t));
    const line = S.shoppingItems.find((l) => l.id === item);
    if (item === undefined || rec(t)?.status !== "noop" || !line || line.boughtAt !== null || line.removedAt !== null) return undefined;
    return [...posted.keys()].find((g) => {
      const by = rec(g)?.undoneBy ?? null;
      if (itemOf(posted.get(g)) !== item || rec(g)?.status !== "applied" || by === null || by.startsWith("x-") || w.lost.has(g)) return false;
      return (order.get(by) ?? -1) > (order.get(t) ?? -1) && (w.gaveUp.has(g) || lastAsk(g) < (w.tapAt.get(t) ?? -1));
    });
  };

  for (const [t, label] of w.tapLabels) {
    if (left.has(t) || w.lost.has(t)) continue; // en échec and left so, or lost with a page: either fate
    if (cancelled(t)) {
      // (a), (e): a cancel the UI accepted takes the op back, or says why it could not
      if (!live(t) || unsure(t)) continue;
      const reasons = (undos.get(t) ?? []).flatMap((u) => (rec(u.opId)?.status === "refused" ? [rec(u.opId)!.reason] : []));
      // the refusal must come after the last « Annuler »: one tapped again once the op could be undone must not be dropped
      if (!reported(`Annuler « ${label} »`, reasons, lastAnnuler(t))) out.push(`(e) ${label} cancelled, still applied, and no refusal said why`);
    } else {
      // (a): an op neither cancelled nor abandoned reaches the server and stays
      if (rec(t) === undefined) out.push(`(a) ${label} never reached the server`);
      else if (rec(t)!.undoneBy !== null && !rec(t)!.undoneBy!.startsWith("x-")) out.push(`(a) ${label} undone without « Annuler »`);
      // a refusal the server recorded is shown
      if (rec(t)?.status === "refused" && !reported(label, [rec(t)!.reason])) out.push(`(a) ${label} refused « ${rec(t)!.reason} » unreported`);
      // a purchase answered noop because an earlier op still bought the line, which an undo from here then unbought: the
      // user's last tick is gone and nothing says so. Reached when the undo shared a request with the tick and was refused
      // unrecorded (fixed), or when the op was given up on en échec while every read failed (left to the owner)
      const silenced = noopUndoneBy(t);
      if (silenced !== undefined && !w.refusals.some((r) => r.label === label)) out.push(`(a) ${label} answered noop, then an undo of « ${labelOf(w, silenced)} » unbought its line, unsaid`);
    }
  }
  // (a): the server's state is the fold of the ops that are still in effect, in the order the server applied them
  const effective = [...posted.values(), ...w.elsewhere.values()].filter((o) => o.type !== "undo" && live(o.opId)).sort((a, b) => order.get(a.opId)! - order.get(b.opId)!);
  const fold = effective.reduce((s, o) => applyOp(s, sameRows(o, S, s), NOW).state, w.initial);
  if (JSON.stringify(normal(fold)) !== JSON.stringify(normal(S))) out.push("(a) the server's state is not the fold of the ops in effect");
  // (a), in order: ops in effect were applied in tap order, but those the server once left unrecorded: it applied the
  // rest of their request without them, and « Réessayer » may send them after later ones
  const inOrder = effective.filter((o) => posted.has(o.opId) && !w.unrecorded.has(o.opId) && !w.lost.has(o.opId)).map((o) => o.opId);
  const tapOrder = [...w.tapLabels.keys()].filter((id) => inOrder.includes(id));
  if (JSON.stringify(inOrder) !== JSON.stringify(tapOrder)) out.push("(a) ops applied out of tap order");

  // (b): one op id per action, and no undo the phone knew was pointless when it left (`judge`)
  for (const [t, list] of undos) {
    if (w.lost.has(t)) continue;
    // an « Annuler » tapped while an undo of the op already waited or sat en échec asks for nothing new
    const asks = w.annulers.filter((x) => x.target === t && !x.held).length + (w.abandoned.has(t) ? 1 : 0);
    if (list.length > asks) out.push(`(b) ${list.length} undos of ${labelOf(w, t)} for ${asks} cancels`);
  }
  out.push(...w.pointless);
  // (i): a chain that exists to take a cook back sent an undo of one (from the bar, or from « Cuisinés récemment »)
  const cooks = [...undos].filter(([t, list]) => posted.get(t)?.type === "meal.cook" && w.tapLabels.has(t) && list.some((u) => posted.has(u.opId)));
  if (w.mustUncook && cooks.length === 0) out.push("(i) the chain's « Annuler » on a cooked meal sent no undo of a cook");
  for (const id of posted.keys()) {
    if (!w.tapLabels.has(id) && undoTarget(posted.get(id)!) === null) out.push(`(b) ${id} was sent but never tapped`);
  }

  // (c): an op is en échec only after SPEC_MAX_UNRECORDED unrecorded answers since its tap or its last « Réessayer »: one
  // retried, then left en échec with fewer, was never resent, or resent with the count it had
  for (const id of left) {
    const n = w.unrecordedSince.get(id) ?? 0;
    if (n < SPEC_MAX_UNRECORDED) out.push(`(c) ${labelOf(w, id)} en échec after ${n} unrecorded answers since its tap or « Réessayer »`);
  }
  // (c): nothing waits but what the user left en échec, and the disk says the same
  if (state.waitingCount !== 0) out.push(`(c) ${state.waitingCount} ops still waiting`);
  if (outbox.some((e) => !e.failed)) out.push("(c) the stored outbox holds an op not en échec");
  if (JSON.stringify(outbox.map((e) => e.op.opId).sort()) !== JSON.stringify([...left].sort())) out.push("(c) the stored outbox differs from the phone's");

  // (d): what the phone shows is the server's state
  if (JSON.stringify(state.view) !== JSON.stringify(project(snapshot(S, NOW), []))) out.push("(d) the view differs from the server's snapshot");

  // (f): an undo leaves only once its target has its final answer (a resend of the target after it: `judge`)
  w.server.posts.forEach((ops) => {
    ops.forEach((o, j) => {
      const t = undoTarget(o);
      if (t === null || w.lost.has(t)) return;
      if (ops.slice(0, j).some((x) => x.opId === t)) out.push(`(f) the undo of ${labelOf(w, t)} went with it`);
    });
  });

  // every refusal shown is one the server recorded, shown once per answer a live page read (a resend after a page
  // killed before storing its answer reads it again)
  const labels = new Map<string, Op[]>();
  for (const o of posted.values()) {
    const t = undoTarget(o);
    const label = t === null ? w.tapLabels.get(o.opId) : `Annuler « ${labelOf(w, t)} »`;
    if (label !== undefined) labels.set(label, [...(labels.get(label) ?? []), o]);
  }
  for (const r of w.refusals) {
    const truthful = (labels.get(r.label) ?? [])
      .filter((o) => rec(o.opId)?.status === "refused" && rec(o.opId)!.reason === r.reason)
      .reduce((n, o) => n + (w.answers.get(o.opId) ?? 0), 0);
    const shown = w.refusals.filter((x) => x.label === r.label && x.reason === r.reason).length;
    if (truthful < shown) out.push(`(g) « ${r.label} : ${r.reason} » shown ${shown}× for ${truthful} such answers`);
  }
  // (h): a refusal shown for an « Annuler » says why its op is still in effect; one that says it is not is noise
  for (const r of w.refusals) {
    if (r.label.startsWith("Annuler « ") && NOT_IN_EFFECT.includes(r.reason)) {
      out.push(`(h) « ${r.label} : ${r.reason} » shown, though its op is not in effect`);
    }
  }
  return [...new Set(out)];
}

const runs = 2000;

describe("Sync (property)", () => {
  it("puts an op en échec at the spec's count of unrecorded answers", () => {
    expect(MAX_UNRECORDED).toBe(SPEC_MAX_UNRECORDED);
  });

  // Pins a case left to the owner, out of the random runs' reach: a purchase lands, every answer to it is
  // unrecorded with no snapshot while every read fails, so it goes en échec and its line shows unbought; the user ticks
  // the line again (answered noop, « déjà acheté »), then abandons the first purchase, whose undo unbuys the line. The
  // second tick is gone and nothing says so. This test fails once the owner's decision closes the case.
  it("flags a tick answered noop whose line an op given up on en échec then unbought (open, left to the owner)", async () => {
    const w = await world();
    const fetch = w.server.fetch;
    let cut = true;
    w.server.fetch = (url, init) => (cut && url === "/api/state" ? Promise.reject(new TypeError("Failed to fetch")) : fetch(url, init));
    const line = w.session.sync.getState().view!.courses.lines.find((l) => l.boughtAt === null)!;
    for (const a of [{ kind: "server", mode: "blind" }, { kind: "tick", pick: 0 }, { kind: "storm" }, { kind: "server", mode: "ok" }] as Action[]) {
      w.at += 1;
      await step(w, a);
    }
    expect(w.session.sync.getState().view!.courses.lines.find((l) => l.id === line.id)!.boughtAt).toBeNull();
    await tap(w, "shopping.buy", { itemId: line.id }, `Acheté : ${line.label}`);
    await w.session.sync.flush();
    await step(w, { kind: "abandon", pick: 0 });
    cut = false;
    await quiesce(w);
    expect(await broken(w)).toEqual([
      `(a) Acheté : ${line.label} #2 answered noop, then an undo of « Acheté : ${line.label} #1 » unbought its line, unsaid`,
    ]);
  });

  // Regression: be5d537 — a staple line removed « On en a déjà » while its meal was cooked kept that meal's share, and the
  // cook's undo left it on the removed line: not the fold of the ops in effect (seed -2126087680, path 1275:3:1:3:3:3:9:8:9:8:9)
  it("a cook, a staple line removed behind it, then the cook taken back: the server holds the fold of the ops in effect", async () => {
    const w = await world();
    const run: Action[] = [
      { kind: "cook", pick: 0, answers: 0, verdict: false }, { kind: "buy", label: "comté" }, { kind: "annuler", back: 0 },
      { kind: "remove", pick: 2 }, { kind: "annuler", back: 2 },
    ];
    for (const a of run) {
      w.at += 1;
      await step(w, a);
      harvest(w);
    }
    await quiesce(w);
    const riz = w.server.state.shoppingItems.find((l) => l.label === "riz complet")!;
    expect(riz).toMatchObject({ kind: "staple_hors_budget", forMeals: [] });
    expect(riz.removedAt).not.toBeNull();
    expect(w.server.state.meals.find((m) => m.id === 1)!.cookedAt).toBeNull();
    expect(await broken(w)).toEqual([]);
  });

  it("whatever the user and the server do, quiescence leaves the server holding what the user asked for", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(wide, refusals, failures, reabandon, unread, retrying, noSnap, unkept, untold, lostWrite, retake, changedSince, cancelFailed, retick, otherPhoneTrip, menu, cheese, plat, reste, repeat, staleFinish, staple, reloadUncook, firstRound), async (run) => {
        const w = await world();
        for (const a of run) {
          w.at += 1;
          await step(w, a);
          harvest(w);
        }
        await quiesce(w);
        expect(await broken(w)).toEqual([]);
      }),
      { numRuns: runs },
    );
  }, 120_000);
});
