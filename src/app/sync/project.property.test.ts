import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyOp } from "../../domain/ops/apply";
import { snapshot, type Snapshot } from "../../domain/snapshot";
import { NOW, P, doubledFixtureProposal, fixtureState, op } from "../../domain/test-fixtures";
import type { State } from "../../domain/types";
import { project, type View } from "./project";
import type { OutboxEntry } from "./types";

const TAP_AT = "2026-10-12T09:00:00.000Z";

/**
 * Every line of the doubled fixture planning bought: comté held for the gratin and the salade, saumon for the first
 * round of the doubled pair. With `cooked`, that first round is cooked too, so the phone already shows the plat cuisiné
 * its second round holds, which only « Retirer le repas » can settle.
 */
function stocked(cooked: boolean): State {
  const start = fixtureState();
  // the comté is sold in 250 g packs, so « 1 boîte » on it is an amount and on the others no quantity
  start.products.find((p) => p.id === P.comte)!.pack = { qty: 250, unit: "g" };
  let s = applyOp(start, op("planning.commit", doubledFixtureProposal()), NOW).state;
  for (const line of [...s.shoppingItems]) s = applyOp(s, op("shopping.buy", { itemId: line.id }), NOW).state;
  if (cooked) s = applyOp(s, op("meal.cook", { mealId: 3, sheet: {} }), NOW).state;
  return s;
}

type Tap =
  | { kind: "cook"; pick: number; answers: { outcome: "none" | "fini" | "il_en_reste"; resolution: "drop_meal" | "rebuy" | null; low: boolean; words: string | null; ifEmpty: boolean }[]; verdict: boolean }
  | { kind: "drop" | "finish" | "partial" | "useBy"; pick: number; resolution: "drop_meal" | "rebuy" | null; low: boolean; days: number; words: string | null }
  | { kind: "add" | "envie"; n: number }
  | { kind: "undo" };

/** What an « Il en reste » says: nothing, words that are no quantity, an amount, a pack (the comté's only). */
const words = fc.constantFrom(null, "un fond", "50 g", "1 boîte");

const answer = fc.record({
  outcome: fc.constantFrom("none" as const, "fini" as const, "il_en_reste" as const),
  resolution: fc.constantFrom("drop_meal" as const, "rebuy" as const, null),
  low: fc.boolean(),
  words,
  ifEmpty: fc.boolean(),
});
const tapArb: fc.Arbitrary<Tap> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("cook" as const), pick: fc.nat(9), answers: fc.array(answer, { minLength: 3, maxLength: 3 }), verdict: fc.boolean() }), weight: 3 },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom("drop" as const, "finish" as const, "partial" as const, "useBy" as const), pick: fc.nat(9),
      resolution: fc.constantFrom("drop_meal" as const, "rebuy" as const, null), low: fc.boolean(), days: fc.integer({ min: -3, max: 12 }), words,
    }),
    weight: 4,
  },
  fc.record({ kind: fc.constantFrom("add" as const, "envie" as const), n: fc.nat(99) }),
  { arbitrary: fc.constant({ kind: "undo" as const }), weight: 2 },
);

/**
 * Each tap aimed at what the server holds when it is made, as a screen would aim it, then applied by the domain. Only
 * items the starting snapshot shows are named: a row the waiting ops create has no server id on the phone, so the
 * screens never name it (a plat cuisiné or an addition stays « en attente »). A second round is never dropped alone
 * while its first round is open: the trim of the first round is not predicted. An undo takes back only the op just sent,
 * and never another undo: an op and its own undo, both waiting, is what the header claims to predict, not an undo
 * across later writes.
 */
function play(s0: State, taps: readonly Tap[]): { state: State; ops: { opId: string; type: string; at: string; payload: unknown }[] } {
  let s = s0;
  const known = new Set(s0.stockItems.map((i) => i.id));
  const ops: { opId: string; type: string; at: string; payload: unknown }[] = [];
  taps.forEach((t, i) => {
    const snap = snapshot(s, NOW);
    const items = [...snap.reste.urgent, ...snap.reste.reserved, ...snap.reste.libre, ...snap.reste.placard].filter((i) => known.has(i.id));
    const meal = snap.menu.pool.length === 0 ? undefined : snap.menu.pool[(t as { pick: number }).pick % snap.menu.pool.length];
    const item = items.length === 0 ? undefined : items[(t as { pick: number }).pick % items.length];
    let payload: unknown;
    let type: string;
    switch (t.kind) {
      case "cook":
        if (!meal) return;
        type = "meal.cook";
        payload = {
          mealId: meal.id,
          sheet: {
            verdict: t.verdict ? "a_refaire" : null,
            items: meal.reservedItems.filter((r) => known.has(r.stockItemId)).flatMap((r, k) => {
              const a = t.answers[k % t.answers.length]!;
              if (a.outcome === "none") return [];
              return [a.outcome === "fini"
                ? { stockItemId: r.stockItemId, outcome: "fini", resolution: a.resolution, ...(a.ifEmpty ? { ifEmpty: true } : {}) }
                : { stockItemId: r.stockItemId, outcome: "il_en_reste", qtyText: a.words, low: a.low }];
            }),
          },
        };
        break;
      case "drop":
        if (!meal || meal.firstRoundId !== null) return;
        type = "meal.drop";
        payload = { mealId: meal.id };
        break;
      case "finish":
        if (!item) return;
        type = "stock.finish";
        payload = { itemId: item.id, resolution: t.resolution };
        break;
      case "partial":
        if (!item) return;
        type = "stock.partial";
        payload = { itemId: item.id, qtyText: t.words, low: t.low };
        break;
      case "useBy": {
        if (!item) return;
        type = "stock.set_use_by";
        const day = new Date(Date.parse("2026-10-12T12:00:00Z") + t.days * 86_400_000).toISOString().slice(0, 10);
        payload = { itemId: item.id, useBy: day };
        break;
      }
      case "add":
        type = "stock.add";
        payload = { label: `olives ${t.n}`, productId: null, qtyText: null, useBy: null };
        break;
      case "envie":
        type = "envie.add";
        payload = { text: `envie ${t.n}`, url: null };
        break;
      case "undo": {
        const last = ops.at(-1);
        if (!last || last.type === "undo") return;
        type = "undo";
        payload = { targetOpId: last.opId };
        break;
      }
    }
    const o = { opId: `tap-${i}`, type, at: TAP_AT, payload };
    ops.push(o);
    s = applyOp(s, o, NOW).state;
  });
  return { state: s, ops };
}

/** What the projection claims to predict (its header comment): no ids of rows it creates, no dates an opening shortens. */
function predicted(v: View | Snapshot) {
  const item = (i: View["reste"]["urgent"][number] | Snapshot["reste"]["urgent"][number]) =>
    [i.label, i.qty, i.qtyText, i.isLow, i.libreQty, i.reservations.map((r) => [r.mealId, r.qty, r.unit])];
  return {
    pool: v.menu.pool.map((m) => [m.id, m.firstRoundId, m.reservedItems.map((r) => [r.label, r.qty])]),
    cooked: v.menu.recentlyCooked.map((m) => m.mealId),
    envies: v.menu.envies.map((e) => [e.text, e.url, e.status]),
    reste: { urgent: v.reste.urgent.map(item), reserved: v.reste.reserved.map(item), libre: v.reste.libre.map(item), placard: v.reste.placard.map(item) },
  };
}

const entries = (ops: { opId: string; type: string; at: string; payload: unknown }[]): OutboxEntry[] =>
  ops.map((o, i) => ({ op: o, label: o.type, seq: i + 1, sends: 0, unrecorded: 0, failed: false, lastReason: null }));

describe("project (property)", () => {
  const starts = [false, true].map((cooked) => {
    const state = stocked(cooked);
    return { state, base: snapshot(state, NOW) };
  });

  it("predicts the Menu and Reste the server shows after the same taps, refusals included", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(tapArb, { minLength: 1, maxLength: 8 }), (cooked, taps) => {
        const { state: s0, base } = starts[Number(cooked)]!;
        const { state, ops } = play(s0, taps);
        expect(predicted(project(base, entries(ops)))).toEqual(predicted(snapshot(state, NOW)));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("project (property): « Ajouter aux courses »", () => {
  // a declared leftover of 50 g leaves the gratin (1) and the salade (2) short of the comté their holds were trimmed from
  const short = applyOp(stocked(false), op("stock.partial", { itemId: stocked(false).stockItems.find((i) => i.productId === P.comte)!.id, qtyText: "50 g", low: false }), NOW).state;
  const base = snapshot(short, NOW);
  const tap = fc.record({ kind: fc.constantFrom("cover" as const, "drop" as const), pick: fc.nat(9) });
  const shortfalls = (v: View | Snapshot) => v.menu.pool.map((m) => [m.id, m.shortfalls ?? []]);

  it("shows the « manque » of the pool as the server does after covers and drops, the shortfall an op creates elsewhere aside", () => {
    expect(shortfalls(base).some(([, s]) => (s as unknown[]).length > 0)).toBe(true);
    fc.assert(
      fc.property(fc.array(tap, { minLength: 1, maxLength: 6 }), (taps) => {
        let s = short;
        const ops: { opId: string; type: string; at: string; payload: unknown }[] = [];
        taps.forEach((t, i) => {
          const pool = snapshot(s, NOW).menu.pool.filter((m) => t.kind === "cover" || m.firstRoundId === null);
          if (pool.length === 0) return;
          const o = { opId: `tap-${i}`, type: t.kind === "cover" ? "meal.cover_shortfalls" : "meal.drop", at: TAP_AT, payload: { mealId: pool[t.pick % pool.length]!.id } };
          ops.push(o);
          s = applyOp(s, o, NOW).state;
        });
        expect(shortfalls(project(base, entries(ops)))).toEqual(shortfalls(snapshot(s, NOW)));
      }),
      { numRuns: 1000 },
    );
  });
});
