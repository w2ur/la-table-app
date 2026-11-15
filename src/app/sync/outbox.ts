import { MAX_OPS } from "../../domain/ops/helpers";
import { ALREADY_UNDONE, NOTHING_TO_UNDO, TARGET_MISSING } from "../../domain/ops/undo";
import type { Op, OpsAnswer, OpStatus, OutboxEntry, Refusal, WireResult } from "./types";

/**
 * The outbox rules (spec §8.2, §8.3, §6.6), one state per op:
 *
 *   unsent ──send──▶ unanswered ──answer──▶ final (applied · noop · refused) ──a snapshot covers it──▶ gone
 *                        │  ▲
 *        6th unrecorded  ▼  │ « Réessayer »
 *                      en échec ──« Abandonner »──▶ gone, abandoned (it may have landed)
 *
 * « Annuler » on an op (`annuler`): unsent, it is dropped on the phone and nothing is sent; unanswered, final applied,
 * abandoned, or named by a row (even one the outbox counts as unsent: a send count the store failed to keep), an `undo`
 * joins the outbox; en échec, it is abandoned with an undo; final noop or refused, cancelled, or already taken back by an
 * undo from here, nothing happens. Then three rules hold the outbox in shape (`resolve`), and nothing else special-cases
 * an undo:
 *
 * 1. An undo leaves only once its target has a final answer, or is abandoned, and it ends its request (`nextBatch`).
 *    Sent earlier, it can be refused « action introuvable » for good while the target still lands on its next send. Sent
 *    with a later op, that op is judged with the target still in effect if the undo alone is refused unrecorded (a
 *    handler that throws): a re-tick of the line it unbuys is answered noop, then the undo lands on its resend and the
 *    re-tick is gone with nothing said. Ending the request at the undo keeps every later op behind it until it lands.
 * 2. An undo whose target was answered noop or refused is dropped: that target changed nothing.
 * 3. An op that is en échec with an undo of it in the outbox is abandoned: the user cancelled it, so « Réessayer » must
 *    not offer it. « Abandonner » on an op that is not an undo sends an undo too, since an op answered unrecorded may
 *    have landed (spec §8.2); abandoning an undo leaves its target as the server holds it. Open, left to the owner: an op en
 *    échec that landed is hidden from the view, so its line can be ticked again (answered noop); giving the first op
 *    up then takes the line back with that second tick, and nothing says so.
 *
 * Since an undo only ever leaves after its target's final answer, its refusal « action introuvable », « rien à annuler »
 * or « déjà annulée » says the target is not in effect, which is what the user asked for: it is not reported. Any other
 * refusal (« modifié depuis », « déjà passé en caisse ») leaves the target in effect and is reported. A noop is not a
 * refusal (the server already holds what the tap asked) and says nothing, but one: a Cuisiné sheet answered « déjà
 * cuisiné » whose verdict, note or item answers the server dropped is told on its own line (`sheetDropped`).
 *
 * An op keeps its final answer in the outbox until a snapshot taken after it is stored (`covered`), so the phone's
 * stored state, base and outbox together, never forgets an answer the base does not show yet.
 */

/** The first send plus five resends (spec §8.3): an op still unrecorded after that is « en échec » and waits for a person. */
export const MAX_UNRECORDED = 6;
/** The Worker answers 413 past MAX_OPS ops in one request (src/worker/app.ts). */
export const MAX_OPS_PER_REQUEST = MAX_OPS;

/** What this phone knows of an op that left its outbox: its final answer, or how it left without one. */
export type Fate = OpStatus | "abandoned" | "cancelled" | "undone";

/** The noop meal.cook gets for a meal already cooked (domain/ops/meals.ts `cook`): the first sheet stands, this one is dropped. */
export const ALREADY_COOKED = "déjà cuisiné";

/** Refusals of an undo saying its target is not in effect: the cancel holds, so they are not reported. */
const TARGET_NOT_IN_EFFECT: readonly (string | null)[] = [TARGET_MISSING, NOTHING_TO_UNDO, ALREADY_UNDONE];

export function enqueue(outbox: readonly OutboxEntry[], op: Op, label: string): OutboxEntry[] {
  const seq = outbox.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  return [...outbox, { op, label, seq, sends: 0, unrecorded: 0, failed: false, lastReason: null }];
}

/** Ops still to be sent: neither answered nor en échec. */
export function waiting(outbox: readonly OutboxEntry[]): OutboxEntry[] {
  return outbox.filter((e) => !e.failed && e.final === undefined);
}

/**
 * The next request: the oldest waiting ops, in tap order, up to an undo whose target has no final answer yet, or up to
 * and including an undo whose target has one (rule 1).
 */
export function nextBatch(outbox: readonly OutboxEntry[]): Op[] {
  const unanswered = new Set(outbox.filter((e) => e.final === undefined).map((e) => e.op.opId));
  const batch: Op[] = [];
  for (const e of waiting(outbox)) {
    const target = undoTarget(e.op);
    if (batch.length === MAX_OPS_PER_REQUEST || (target !== null && unanswered.has(target))) break;
    batch.push(e.op);
    if (target !== null) break;
  }
  return batch;
}

/** Counted before the request leaves: a request whose answer is lost may still have been applied. */
export function markSent(outbox: readonly OutboxEntry[], opIds: ReadonlySet<string>): OutboxEntry[] {
  return outbox.map((e) => (opIds.has(e.op.opId) ? { ...e, sends: e.sends + 1 } : e));
}

export interface Settled {
  outbox: OutboxEntry[];
  /** Every op of the outbox with what this answer told of it, before `resolve`: where `departed` reads the fates. */
  answered: OutboxEntry[];
  refused: Refusal[];
  /** The labels of the Cuisiné sheets the other phone's cook made the server drop (`sheetDropped`), once per answer. */
  dropped: string[];
  /** At least one op got its final answer; without it the request changed nothing and the next try waits. */
  progress: boolean;
}

/**
 * Applies an answer to the ops of the request that carried them (spec §8.2, §8.3). An op with a result and not listed
 * in `unrecorded` keeps its final answer (a refusal is reported once, with its label, but an undo's refusal saying its
 * target is not in effect); an op listed in `unrecorded`, or sent but given no result at all (« sans réponse »), stays
 * waiting under the same id and is counted, and is « en échec » at MAX_UNRECORDED, so a stale Worker or a mangled answer
 * cannot resend it forever; an op that was not in the request is left as it is.
 */
export function settle(outbox: readonly OutboxEntry[], sent: readonly string[], answer: OpsAnswer): Settled {
  const inRequest = new Set(sent);
  const unrecorded = new Set(answer.unrecorded);
  const results = new Map(answer.results.flatMap((r) => (r.opId === null ? [] : [[r.opId, r] as const])));
  const refused: Refusal[] = [];
  const dropped: string[] = [];
  let progress = false;
  const next = outbox.map((e): OutboxEntry => {
    const result = results.get(e.op.opId);
    if (!inRequest.has(e.op.opId)) return e;
    if (unrecorded.has(e.op.opId) || !result) {
      const count = e.unrecorded + 1;
      return { ...e, unrecorded: count, lastReason: result ? result.reason : "sans réponse", failed: count >= MAX_UNRECORDED };
    }
    progress = true;
    const quiet = undoTarget(e.op) !== null && TARGET_NOT_IN_EFFECT.includes(result.reason);
    if (result.status === "refused" && !quiet) refused.push({ label: e.label, reason: result.reason ?? "sans raison" });
    if (sheetDropped(e.op, result)) dropped.push(e.label);
    return { ...e, final: result.status, lastReason: result.reason };
  });
  return { outbox: resolve(next), answered: next, refused, dropped, progress };
}

/** Rules 2 and 3: drops an undo whose target changed nothing, and abandons an op en échec that an undo cancels. */
export function resolve(outbox: readonly OutboxEntry[]): OutboxEntry[] {
  const changedNothing = new Set(outbox.filter((e) => e.final === "noop" || e.final === "refused").map((e) => e.op.opId));
  return outbox.filter((e) => {
    const target = undoTarget(e.op);
    if (target !== null && e.final === undefined && changedNothing.has(target)) return false;
    return !(e.failed && target === null && cancelling(outbox, e.op.opId));
  });
}

/** An undo of this op waiting, en échec, or answered as taking it back: a cancel underway, or done. */
function cancelling(outbox: readonly OutboxEntry[], opId: string): boolean {
  return outbox.some((e) => undoTarget(e.op) === opId && (e.final === undefined || takesBack(e)));
}

/** Once a snapshot taken after their answers is stored, the answered ops leave: the base now shows what they did. */
export function covered(outbox: readonly OutboxEntry[]): OutboxEntry[] {
  return outbox.filter((e) => e.final === undefined);
}

/**
 * What the phone knows of the ops that left the outbox between `before` and `after`, in tap order, each read in its
 * `newest` version when it has one (an answer's, which `before` does not hold yet).
 */
export function departed(before: readonly OutboxEntry[], after: readonly OutboxEntry[], newest: readonly OutboxEntry[] = []): [string, Fate][] {
  const kept = new Set(after.map((e) => e.op.opId));
  const latest = new Map(newest.map((e) => [e.op.opId, e]));
  return before.filter((e) => !kept.has(e.op.opId)).map((e) => latest.get(e.op.opId) ?? e).flatMap((e): [string, Fate][] => {
    const fate: Fate = e.final ?? (e.sends === 0 ? "cancelled" : "abandoned");
    const target = undoTarget(e.op);
    return target !== null && takesBack(e) ? [[e.op.opId, fate], [target, "undone"]] : [[e.op.opId, fate]];
  });
}

/** An undo answered applied, or refused for a reason saying its target is not in effect. */
function takesBack(e: OutboxEntry): boolean {
  return e.final === "applied" || (e.final === "refused" && TARGET_NOT_IN_EFFECT.includes(e.lastReason));
}

/**
 * A meal.cook answered noop « déjà cuisiné » whose sheet said something: a verdict, a note, or « Fini » / « Il en reste »
 * on an item. The other phone cooked the meal first, so the server kept its sheet and dropped this one:
 * the user is told, to redo a « Fini » from Reste. A sheet that said nothing loses nothing and stays quiet, as every
 * other noop does. A « Fini » the sheet pre-made (`ifEmpty`) is not something the user said: alone, it stays quiet too.
 */
export function sheetDropped(op: Op, result: Pick<WireResult, "status" | "reason">): boolean {
  if (op.type !== "meal.cook" || result.status !== "noop" || result.reason !== ALREADY_COOKED) return false;
  const sheet = (op.payload as { sheet?: { verdict?: unknown; note?: unknown; items?: unknown } | null } | null)?.sheet;
  if (typeof sheet !== "object" || sheet === null) return false;
  return sheet.verdict != null || (typeof sheet.note === "string" && sheet.note.trim() !== "") || (Array.isArray(sheet.items) && sheet.items.some((i) => (i as { ifEmpty?: unknown } | null)?.ifEmpty !== true));
}

/** The op an `undo` names, or null for any other op. */
export function undoTarget(op: Op): string | null {
  if (op.type !== "undo") return null;
  const target = (op.payload as { targetOpId?: unknown } | null)?.targetOpId;
  return typeof target === "string" ? target : null;
}

/** The label of the undo that cancels an op labelled `label`. */
export const undoLabel = (label: string): string => `Annuler « ${label} »`;

/** What « Annuler » does: nothing, drop an op never sent, or put this outbox (an undo added) on disk and send it. */
export type Annulment = { kind: "nothing" } | { kind: "drop" | "send"; outbox: OutboxEntry[] };

/**
 * « Annuler » on `targetOpId` (spec §6.6), given what the phone knows of it once it left the outbox (`fate`: undefined
 * when this phone knows nothing of it, "applied" when a row of the snapshot names it). `newUndo` builds the undo op.
 * A row naming an op still in the outbox outranks its send count: the op landed, so it is never dropped as unsent.
 */
export function annuler(outbox: readonly OutboxEntry[], targetOpId: string, fate: Fate | undefined, newUndo: () => Op, label: string): Annulment {
  if (cancelling(outbox, targetOpId)) return { kind: "nothing" };
  const entry = outbox.find((e) => e.op.opId === targetOpId);
  const unsent = entry !== undefined && entry.sends === 0 && fate !== "applied";
  const state = entry ? (entry.final ?? (entry.failed ? "failed" : unsent ? "unsent" : "unanswered")) : fate;
  switch (state) {
    case "unsent":
      return { kind: "drop", outbox: outbox.filter((e) => e !== entry) };
    case "failed":
      return { kind: "send", outbox: abandon(outbox, targetOpId, newUndo) };
    case "unanswered":
    case "applied":
    case "abandoned":
      return { kind: "send", outbox: enqueue(outbox, newUndo(), undoLabel(label)) };
    default: // noop, refused, cancelled, undone, or an op this phone knows nothing of
      return { kind: "nothing" };
  }
}

/** « Réessayer »: the same op id goes back in line with a fresh count. */
export function retry(outbox: readonly OutboxEntry[], opId: string): OutboxEntry[] {
  return outbox.map((e) => (e.op.opId === opId && e.failed ? { ...e, failed: false, unrecorded: 0 } : e));
}

/**
 * « Abandonner »: only an op en échec leaves. One that is not an undo may have landed, so an undo of it is sent unless one
 * is already in the outbox (rule 3); an undo abandoned leaves its target as the server holds it.
 */
export function abandon(outbox: readonly OutboxEntry[], opId: string, newUndo: () => Op): OutboxEntry[] {
  const entry = outbox.find((e) => e.op.opId === opId && e.failed);
  if (!entry) return [...outbox];
  const rest = outbox.filter((e) => e !== entry);
  if (undoTarget(entry.op) !== null || cancelling(rest, opId)) return rest;
  return enqueue(rest, newUndo(), undoLabel(entry.label));
}
