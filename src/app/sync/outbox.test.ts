import { describe, expect, it } from "vitest";
import {
  ALREADY_COOKED, MAX_OPS_PER_REQUEST, MAX_UNRECORDED, abandon, annuler, covered, departed, enqueue, markSent, nextBatch, resolve, retry, settle,
  sheetDropped, undoTarget, waiting,
} from "./outbox";
import type { Op, OpsAnswer, OutboxEntry } from "./types";

let n = 0;
const op = (): Op => ({
  opId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, type: "shopping.buy", at: "2026-10-12T09:00:00.000Z", payload: { itemId: n },
});
const answer = (results: OpsAnswer["results"], unrecorded: string[] = []): OpsAnswer => ({ results, unrecorded, snapshot: null });
const sendAndAnswer = (box: OutboxEntry[], ids: string[], a: OpsAnswer) => settle(markSent(box, new Set(ids)), ids, a);
const undoOf = (target: Op): Op => ({ ...op(), type: "undo", payload: { targetOpId: target.opId } });
const finals = (box: readonly OutboxEntry[]) => box.flatMap((e) => (e.final === undefined ? [] : [[e.op.opId, e.final]]));

describe("outbox", () => {
  it("keeps taps in order with a growing seq, each unsent", () => {
    const a = op();
    const b = op();
    const box = enqueue(enqueue([], a, "A"), b, "B");
    expect(box.map((e) => [e.op.opId, e.label, e.seq, e.sends])).toEqual([[a.opId, "A", 1, 0], [b.opId, "B", 2, 0]]);
    expect(nextBatch(box)).toEqual([a, b]);
  });

  it("never hands out a seq already held, once an earlier op has left the outbox", () => {
    const [a, b, c, d] = [op(), op(), op(), op()];
    const box = enqueue(enqueue([], a, "A"), b, "B");
    const settled = covered(sendAndAnswer(box, [a.opId], answer([{ opId: a.opId, status: "applied", reason: null }])).outbox);
    expect(enqueue(settled, c, "C").map((e) => e.seq)).toEqual([2, 3]);
    const cancelled = annuler(enqueue(enqueue([], a, "A"), d, "D"), a.opId, undefined, op, "A");
    expect(cancelled.kind).toBe("drop");
    expect(enqueue(cancelled.kind === "drop" ? cancelled.outbox : [], c, "C").map((e) => e.seq)).toEqual([2, 3]);
  });

  // an answer leaves the outbox with the first snapshot stored after it, not before
  it("keeps an op's final answer until a snapshot covers it, and reports a refusal once with its label and reason", () => {
    const [a, b, c] = [op(), op(), op()];
    const box = enqueue(enqueue(enqueue([], a, "Acheté : comté"), b, "Acheté : poireau"), c, "Retiré : poireau");
    const s = sendAndAnswer(box, [a.opId, b.opId, c.opId], answer([
      { opId: a.opId, status: "applied", reason: null },
      { opId: b.opId, status: "noop", reason: "déjà acheté" },
      { opId: c.opId, status: "refused", reason: "mettez l'application à jour" },
    ]));
    expect(s.refused).toEqual([{ label: "Retiré : poireau", reason: "mettez l'application à jour" }]);
    expect(finals(s.outbox)).toEqual([[a.opId, "applied"], [b.opId, "noop"], [c.opId, "refused"]]);
    expect(waiting(s.outbox)).toEqual([]);
    expect(nextBatch(s.outbox)).toEqual([]);
    expect(covered(s.outbox)).toEqual([]);
    expect(s.progress).toBe(true);
  });

  it("keeps an op listed in unrecorded under its id, and marks it en échec at its sixth such answer", () => {
    const a = op();
    let box = enqueue([], a, "Acheté : comté");
    for (let i = 1; i <= MAX_UNRECORDED; i++) {
      expect(box[0]!.failed).toBe(false);
      const s = sendAndAnswer(box, [a.opId], answer([{ opId: a.opId, status: "refused", reason: "trop de modifications simultanées, réessayez" }], [a.opId]));
      expect(s.progress).toBe(false);
      expect(s.refused).toEqual([]);
      box = s.outbox;
    }
    expect(MAX_UNRECORDED).toBe(6);
    expect(box).toEqual([expect.objectContaining({ op: a, sends: 6, unrecorded: 6, failed: true, lastReason: "trop de modifications simultanées, réessayez" })]);
    expect(waiting(box)).toEqual([]);
    expect(nextBatch(box)).toEqual([]);
  });

  // Regression: 6e7ad9d — an op listed in unrecorded but missing from results was never counted, so it resent forever
  it("counts an op listed in unrecorded even when the answer has no result for it, up to en échec", () => {
    const a = op();
    let box = enqueue([], a, "Acheté : comté");
    for (let i = 1; i <= MAX_UNRECORDED; i++) {
      expect(box[0]!.failed).toBe(false);
      const s = sendAndAnswer(box, [a.opId], answer([], [a.opId]));
      expect(s.progress).toBe(false);
      expect(finals(s.outbox)).toEqual([]);
      box = s.outbox;
    }
    expect(box).toEqual([expect.objectContaining({ op: a, sends: 6, unrecorded: 6, failed: true, lastReason: "sans réponse" })]);
    expect(nextBatch(box)).toEqual([]);
  });

  // Regression: 295a5df — an op sent but given no result and not listed in unrecorded was never counted, so it resent forever
  it("counts an op the answer neither lists in unrecorded nor gives a result for, up to en échec", () => {
    const a = op();
    let box = enqueue([], a, "Acheté : comté");
    for (let i = 1; i <= MAX_UNRECORDED; i++) {
      expect(box[0]!.failed).toBe(false);
      const s = sendAndAnswer(box, [a.opId], answer([]));
      expect(s.progress).toBe(false);
      expect(finals(s.outbox)).toEqual([]);
      box = s.outbox;
    }
    expect(box).toEqual([expect.objectContaining({ op: a, sends: 6, unrecorded: 6, failed: true, lastReason: "sans réponse" })]);
    expect(nextBatch(box)).toEqual([]);
  });

  it("leaves untouched an op tapped during the request, and counts one the answer does not mention", () => {
    const [a, b, c] = [op(), op(), op()];
    const box = enqueue(enqueue(enqueue([], a, "A"), b, "B"), c, "C");
    // c was not in the request, so even an answer that names it must not settle it
    const s = sendAndAnswer(box.slice(0, 3), [a.opId, b.opId], answer(
      [{ opId: a.opId, status: "applied", reason: null }, { opId: c.opId, status: "refused", reason: "trop de modifications simultanées, réessayez" }],
      [c.opId],
    ));
    expect(covered(s.outbox).map((e) => [e.op.opId, e.sends, e.unrecorded, e.failed])).toEqual([[b.opId, 1, 1, false], [c.opId, 0, 0, false]]);
    expect(finals(s.outbox)).toEqual([[a.opId, "applied"]]);
    expect(s.refused).toEqual([]);
  });

  // an op that has left may have been applied, so « Annuler » must not just drop it
  it("drops on the phone only an op never sent; retries and abandons only an op en échec", () => {
    const [a, b] = [op(), op()];
    const box = markSent(enqueue(enqueue([], a, "A"), b, "B"), new Set([a.opId]));
    const sentA = annuler(box, a.opId, undefined, () => undoOf(a), "A");
    expect(sentA.kind === "send" && sentA.outbox.map((e) => [e.op.type, e.label])).toEqual([["shopping.buy", "A"], ["shopping.buy", "B"], ["undo", "Annuler « A »"]]);
    expect(annuler(box, b.opId, undefined, () => undoOf(b), "B")).toEqual({ kind: "drop", outbox: [box[0]] });
    expect(annuler(box, "inconnu", undefined, op, "?")).toEqual({ kind: "nothing" });
    expect(abandon(box, a.opId, op)).toEqual(box);
    const failed = box.map((e) => (e.op.opId === a.opId ? { ...e, failed: true, unrecorded: 6 } : e));
    expect(retry(failed, a.opId)[0]).toMatchObject({ op: a, failed: false, unrecorded: 0 });
    const counting = box.map((e) => (e.op.opId === a.opId ? { ...e, unrecorded: 2 } : e));
    expect(retry(counting, a.opId)).toEqual(counting);
    expect(abandon(failed, a.opId, () => undoOf(a)).map((e) => [e.op.opId === b.opId ? "B" : e.op.type, undoTarget(e.op)])).toEqual([["B", null], ["undo", a.opId]]);
  });

  // Regression: b506f3e — an undo queued behind its target kept going alone once the target went en échec
  it("abandons an op going en échec with its waiting undo, which may then leave", () => {
    const [a, b] = [op(), op()];
    const undoA = undoOf(a);
    let box = enqueue(enqueue(enqueue([], a, "A"), b, "B"), undoA, "Annuler « A »");
    box = box.map((e) => (e.op.opId === a.opId ? { ...e, unrecorded: MAX_UNRECORDED - 1 } : e));
    const s = sendAndAnswer(box, [a.opId], answer([]));
    expect(s.outbox.map((e) => [e.op.opId, e.failed])).toEqual([[b.opId, false], [undoA.opId, false]]);
    expect(departed(box, s.outbox, s.answered)).toEqual([[a.opId, "abandoned"]]);
    expect(nextBatch(s.outbox)).toEqual([b, undoA]);
    expect(undoTarget(undoA)).toBe(a.opId);
    expect(undoTarget(a)).toBeNull();
  });

  // Regression: e5b671c — an op and its undo going en échec in the same answer both stayed, so « Réessayer » on the op applied what was cancelled
  it("abandons an op going en échec together with its undo, which stays en échec", () => {
    const [a, b] = [op(), op()];
    const undoA = undoOf(a);
    let box = enqueue(enqueue(enqueue([], a, "A"), b, "B"), undoA, "Annuler « A »");
    box = box.map((e) => (e.op.opId === b.opId ? e : { ...e, unrecorded: MAX_UNRECORDED - 1 })); // « Réessayer » on A, then « Annuler »
    // a hand-built request: the rules never send an undo with its unanswered target (`nextBatch`)
    const s = sendAndAnswer(box, [a.opId, undoA.opId], answer([]));
    expect(s.outbox.map((e) => [e.op.opId, e.failed])).toEqual([[b.opId, false], [undoA.opId, true]]);
    expect(retry(s.outbox, a.opId)).toEqual(s.outbox); // the cancelled op cannot be retried
    expect(nextBatch(retry(s.outbox, undoA.opId))).toEqual([b, undoA]);
  });

  // Regression: d5d28ad — an undo left in the same request as a target still to be answered
  it("stops a request at an undo whose target still waits for its final answer, and sends it once the target has one", () => {
    const [a, b, c] = [op(), op(), op()];
    const undoA = undoOf(a);
    const box = enqueue(enqueue(enqueue(enqueue([], a, "A"), b, "B"), undoA, "Annuler « A »"), c, "C");
    expect(nextBatch(box)).toEqual([a, b]);
    const unrecorded = sendAndAnswer(box, [a.opId, b.opId], answer([{ opId: b.opId, status: "applied", reason: null }], [a.opId])).outbox;
    expect(nextBatch(unrecorded)).toEqual([a]);
    const failedA = unrecorded.map((e) => (e.op.opId === a.opId ? { ...e, failed: true } : e));
    expect(nextBatch(resolve(failedA))).toEqual([undoA]); // a target en échec is abandoned, so it no longer holds its undo back
    const answered = sendAndAnswer(unrecorded, [a.opId], answer([{ opId: a.opId, status: "applied", reason: null }])).outbox;
    expect(nextBatch(answered)).toEqual([undoA]);
  });

  // Regression: a1a965c — an undo shared a request with a later op, which the server judged with the target still in
  // effect when the undo alone was refused unrecorded (a re-tick of its line answered noop, then lost)
  it("ends a request at an undo whose target has its final answer: later ops go once it has its own", () => {
    const [a, b, c] = [op(), op(), op()];
    const undoA = undoOf(a);
    const answered = sendAndAnswer(enqueue([], a, "A"), [a.opId], answer([{ opId: a.opId, status: "applied", reason: null }])).outbox;
    const box = enqueue(enqueue(enqueue(answered, b, "B"), undoA, "Annuler « A »"), c, "C");
    expect(nextBatch(box)).toEqual([b, undoA]);
    const thrown = sendAndAnswer(box, [b.opId, undoA.opId], answer([{ opId: b.opId, status: "applied", reason: null }, { opId: undoA.opId, status: "refused", reason: "erreur interne" }], [undoA.opId])).outbox;
    expect(nextBatch(thrown)).toEqual([undoA]); // refused unrecorded: C still waits behind it
    const undone = sendAndAnswer(thrown, [undoA.opId], answer([{ opId: undoA.opId, status: "applied", reason: null }])).outbox;
    expect(nextBatch(undone)).toEqual([c]);
  });

  // Regression: d5d28ad — an undo of an op answered noop or refused was sent anyway, and its refusal reported
  it("drops an undo waiting behind an op answered noop or refused, and keeps one behind an op applied", () => {
    for (const status of ["noop", "refused"] as const) {
      const [a, c] = [op(), op()];
      const undoA = undoOf(a);
      const box = enqueue(enqueue(enqueue([], a, "A"), undoA, "Annuler « A »"), c, "C");
      const s = sendAndAnswer(box, [a.opId], answer([{ opId: a.opId, status, reason: "déjà acheté" }]));
      expect(covered(s.outbox).map((e) => e.op.opId)).toEqual([c.opId]);
      expect(departed(box, covered(s.outbox), s.answered)).toEqual([[a.opId, status], [undoA.opId, "cancelled"]]);
    }
    const [a, c] = [op(), op()];
    const undoA = undoOf(a);
    const box = enqueue(enqueue(enqueue([], a, "A"), undoA, "Annuler « A »"), c, "C");
    const s = sendAndAnswer(box, [a.opId], answer([{ opId: a.opId, status: "applied", reason: null }]));
    expect(covered(s.outbox).map((e) => e.op.opId)).toEqual([undoA.opId, c.opId]);
  });

  // Regression: ce748f9 — any final answer to an undo counted its op as undone, a refusal « modifié depuis » too
  it("names the ops an undo left undone: applied, « déjà annulée », « action introuvable » or « rien à annuler »", () => {
    const targets = [op(), op(), op(), op(), op(), op()];
    const undos = targets.map(undoOf);
    let box: OutboxEntry[] = [];
    undos.forEach((u, i) => { box = enqueue(box, u, `U${i}`); });
    const s = sendAndAnswer(box, undos.map((u) => u.opId), answer([
      { opId: undos[0]!.opId, status: "applied", reason: null },
      { opId: undos[1]!.opId, status: "refused", reason: "déjà annulée" },
      { opId: undos[2]!.opId, status: "refused", reason: "action introuvable" },
      { opId: undos[3]!.opId, status: "refused", reason: "rien à annuler" },
      { opId: undos[4]!.opId, status: "refused", reason: "modifié depuis : impossible d'annuler" },
      { opId: undos[5]!.opId, status: "refused", reason: "déjà passé en caisse" },
    ]));
    const undone = departed(box, covered(s.outbox), s.answered).flatMap(([id, fate]) => (fate === "undone" ? [id] : []));
    expect(undone).toEqual(targets.slice(0, 4).map((t) => t.opId));
    // until a snapshot covers them, the answered undos in the outbox say the same to « Annuler »
    for (const [i, t] of targets.entries()) expect(annuler(s.outbox, t.opId, "applied", op, "T").kind).toBe(i < 4 ? "nothing" : "send");
  });

  it("sends at most 100 ops per request, oldest first", () => {
    const ops = Array.from({ length: 150 }, () => op());
    let box: OutboxEntry[] = [];
    for (const o of ops) box = enqueue(box, o, "x");
    expect(MAX_OPS_PER_REQUEST).toBe(100);
    expect(nextBatch(box)).toEqual(ops.slice(0, 100));
  });

  // sent only after its target's final answer, an undo refused this way left the cancel holding
  it("reports an undo's refusal only when it leaves its op in effect, never one saying the op is not in effect", () => {
    const reasons = ["action introuvable", "rien à annuler", "déjà annulée", "déjà passé en caisse", "modifié depuis : impossible d'annuler"];
    const undos = reasons.map(() => undoOf(op()));
    let box: OutboxEntry[] = [];
    undos.forEach((u, i) => { box = enqueue(box, u, `Annuler « ${i} »`); });
    const s = sendAndAnswer(box, undos.map((u) => u.opId), answer(undos.map((u, i) => ({ opId: u.opId, status: "refused" as const, reason: reasons[i]! }))));
    expect(s.refused).toEqual([
      { label: "Annuler « 3 »", reason: "déjà passé en caisse" }, { label: "Annuler « 4 »", reason: "modifié depuis : impossible d'annuler" },
    ]);
    // a tap's refusal is always reported, whatever its words
    const a = op();
    expect(sendAndAnswer(enqueue([], a, "A"), [a.opId], answer([{ opId: a.opId, status: "refused", reason: "action introuvable" }])).refused).toEqual([
      { label: "A", reason: "action introuvable" },
    ]);
  });

  // the one noop that is told, since the server dropped what the user typed
  it("tells a Cuisiné sheet answered « déjà cuisiné » once, by its label, only when it said something", () => {
    const cook = (sheet: unknown): Op => ({ ...op(), type: "meal.cook", payload: { mealId: 1, sheet } });
    const said = [
      cook({ verdict: "a_refaire", note: null, items: [] }),
      cook({ verdict: null, note: "trop salé", items: [] }),
      cook({ verdict: null, note: null, items: [{ stockItemId: 2, outcome: "fini" }] }),
      cook({ verdict: null, note: null, items: [{ stockItemId: 2, outcome: "il_en_reste", qtyText: null, low: false }] }),
      cook({ verdict: null, note: null, items: [{ stockItemId: 2, outcome: "fini", ifEmpty: true }, { stockItemId: 3, outcome: "fini" }] }),
    ];
    // a « Fini » the sheet pre-made (ifEmpty) is not something the user said
    const quiet = [cook({ verdict: null, note: null, items: [] }), cook({}), cook(undefined), cook({ verdict: null, note: "  ", items: [] }),
      cook({ verdict: null, note: null, items: [{ stockItemId: 2, outcome: "fini", ifEmpty: true }] })];
    let box: OutboxEntry[] = [];
    [...said, ...quiet].forEach((o, i) => { box = enqueue(box, o, `Cuisiné : ${i}`); });
    const ids = [...said, ...quiet].map((o) => o.opId);
    const s = sendAndAnswer(box, ids, answer(ids.map((opId) => ({ opId, status: "noop" as const, reason: ALREADY_COOKED }))));
    expect(s.dropped).toEqual(["Cuisiné : 0", "Cuisiné : 1", "Cuisiné : 2", "Cuisiné : 3", "Cuisiné : 4"]);
    expect(s.refused).toEqual([]);
    // the same sheet applied, refused, or answered noop for another reason is not dropped by the other phone's cook
    const sheet = said[2]!;
    for (const result of [{ status: "applied", reason: null }, { status: "refused", reason: "repas retiré du menu" }, { status: "noop", reason: "déjà acheté" }] as const) {
      expect(sheetDropped(sheet, result)).toBe(false);
    }
    // a tick answered noop (3a's two phones on one line) stays quiet
    const tick = op();
    expect(sendAndAnswer(enqueue([], tick, "Acheté : comté"), [tick.opId], answer([{ opId: tick.opId, status: "noop", reason: "déjà acheté" }])).dropped).toEqual([]);
    // an answer the server did not record tells nothing yet: the resend's answer will
    const late = sendAndAnswer(enqueue([], sheet, "Cuisiné : 2"), [sheet.opId], answer([{ opId: sheet.opId, status: "noop", reason: ALREADY_COOKED }], [sheet.opId]));
    expect(late.dropped).toEqual([]);
  });

  it("« Annuler » by what the phone knows of the op: nothing for one that changed nothing, was cancelled or taken back", () => {
    const a = op();
    const undo = () => undoOf(a);
    for (const fate of ["noop", "refused", "cancelled", "undone", undefined] as const) expect(annuler([], a.opId, fate, undo, "A")).toEqual({ kind: "nothing" });
    for (const fate of ["applied", "abandoned"] as const) {
      const plan = annuler([], a.opId, fate, undo, "A");
      expect(plan.kind === "send" && plan.outbox.map((e) => [undoTarget(e.op), e.label])).toEqual([[a.opId, "Annuler « A »"]]);
    }
    // in the outbox, its entry is what counts: answered noop there, nothing, whatever the caller's fate says
    const noop = settle(markSent(enqueue([], a, "A"), new Set([a.opId])), [a.opId], answer([{ opId: a.opId, status: "noop", reason: "déjà acheté" }])).outbox;
    expect(annuler(noop, a.opId, "applied", undo, "A")).toEqual({ kind: "nothing" });
    // en échec: abandoned, with the undo that takes it back if it landed
    const failed = enqueue([], a, "A").map((e) => ({ ...e, sends: 6, unrecorded: 6, failed: true }));
    const plan = annuler(failed, a.opId, undefined, undo, "A");
    expect(plan.kind === "send" && plan.outbox.map((e) => [undoTarget(e.op), e.failed])).toEqual([[a.opId, false]]);
    // twice: the first undo is underway, so the second « Annuler » does nothing
    const once = annuler([], a.opId, "applied", undo, "A");
    expect(once.kind === "send" && annuler(once.outbox, a.opId, "applied", undo, "A")).toEqual({ kind: "nothing" });
  });

  // Regression: 13d9f3c — « Annuler » dropped as never sent an op a row named as bought, its send count lost by the store
  it("« Annuler » on an op a row names sends an undo, even when the outbox counts it as never sent", () => {
    const a = op();
    const box = enqueue([], a, "A");
    const plan = annuler(box, a.opId, "applied", () => undoOf(a), "A");
    expect(plan.kind === "send" && plan.outbox.map((e) => [e.op.opId === a.opId ? "A" : e.op.type, undoTarget(e.op)])).toEqual([["A", null], ["undo", a.opId]]);
    expect(annuler(box, a.opId, undefined, () => undoOf(a), "A")).toEqual({ kind: "drop", outbox: [] });
  });

  it("« Abandonner » on an undo leaves its op as the server holds it; on another op, an undo already waiting is kept", () => {
    const [a, b] = [op(), op()];
    const undoA = undoOf(a);
    const failedUndo = enqueue([], undoA, "Annuler « A »").map((e) => ({ ...e, sends: 6, unrecorded: 6, failed: true }));
    expect(abandon(failedUndo, undoA.opId, () => undoOf(undoA))).toEqual([]);
    expect(departed(failedUndo, [])).toEqual([[undoA.opId, "abandoned"]]);
    const withUndo = enqueue(enqueue([], b, "B"), undoOf(b), "Annuler « B »").map((e, i) => (i === 0 ? { ...e, sends: 6, unrecorded: 6, failed: true } : e));
    expect(abandon(withUndo, b.opId, () => undoOf(b))).toEqual([withUndo[1]]);
  });
});
