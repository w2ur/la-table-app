import { clampToNow } from "../dates";
import { cloneState, diffStates, recordIssuedIds, storedOp, storeOp, tableRows } from "../state";
import type { AppliedOp, Change, State } from "../types";
import { setNutrition, setPack, upsertProduct } from "./catalogue";
import { MALFORMED, refused } from "./helpers";
import { cook, coverShortfalls, dropMealOp } from "./meals";
import { commitPlanning } from "./planning";
import { addAjout, addEnvie, buy, recordTrip, removeLine, setBoughtQty, setPrice, setTripTotal } from "./shopping";
import { addStock, finish, partial, setUseBy } from "./stock";
import { undo } from "./undo";
import type { Applied, Handler, OpEnvelope, OpResult } from "./types";

export const HANDLERS: Partial<Record<string, Handler>> = {
  "planning.commit": commitPlanning,
  "shopping.buy": buy,
  "shopping.add": addAjout,
  "shopping.remove": removeLine,
  "shopping.set_price": setPrice,
  "shopping.set_bought_qty": setBoughtQty,
  "trip.record": recordTrip,
  "trip.set_total": setTripTotal,
  "envie.add": addEnvie,
  "meal.cook": cook,
  "meal.drop": dropMealOp,
  "meal.cover_shortfalls": coverShortfalls,
  "stock.finish": finish,
  "stock.partial": partial,
  "stock.set_use_by": setUseBy,
  "stock.add": addStock,
  "product.upsert": upsertProduct,
  "product.nutrition": setNutrition,
  "product.pack": setPack,
  undo,
};

/** A full ISO-8601 date-time with seconds and an explicit offset (or Z): what a phone's `toISOString()` sends. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 9999;

/**
 * A time the date helpers can work with: a full date-time whose calendar fields exist as written (no hour 24, no
 * 31 February rolled into March) and whose instant falls in a four-digit year, so every ISO string built from it
 * keeps the YYYY-MM-DD shape that string comparison and date arithmetic rely on.
 */
function isOpTime(at: string): boolean {
  if (!ISO_DATE_TIME.test(at)) return false;
  const wall = at.slice(0, 19);
  const asWritten = new Date(`${wall}Z`);
  if (Number.isNaN(asWritten.getTime()) || asWritten.toISOString().slice(0, 19) !== wall) return false;
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) return false;
  const year = instant.getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

export function parseEnvelope(raw: unknown): OpEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.opId !== "string" || o.opId.length === 0 || o.opId.length > 100) return null;
  if (typeof o.type !== "string" || typeof o.at !== "string" || !isOpTime(o.at)) return null;
  return { opId: o.opId, type: o.type, at: o.at, payload: o.payload };
}

function record(state: State, op: OpEnvelope, now: string, result: OpResult, changes: AppliedOp["changes"]): AppliedOp {
  const seq = Object.values(state.appliedOps).reduce((max, r) => Math.max(max, r.seq), 0) + 1;
  return { opId: op.opId, type: op.type, appliedAt: now, status: result.status, reason: result.reason, changes, undoneBy: null, seq };
}

/** The rows an op wrote with the values they already had, as changes whose before is their after, after its real changes. */
function withTouched(changes: Change[], next: State, touched: OpResult["touched"] = []): Change[] {
  const named = new Set(changes.map((c) => `${c.table}:${c.id}`));
  const same: Change[] = [];
  for (const { table, id } of touched) {
    const row = tableRows(next, table).find((r) => r.id === id);
    if (!row || named.has(`${table}:${id}`)) continue;
    named.add(`${table}:${id}`);
    same.push({ table, id, before: structuredClone(row), after: structuredClone(row) });
  }
  return [...changes, ...same];
}

export function applyOp(state: State, raw: unknown, now: string): Applied {
  const op = parseEnvelope(raw);
  if (!op) return { state, result: MALFORMED, changes: [], records: [] };
  // a resend (an outbox retry) gets back what the op got the first time, so a refusal is still shown as one (§8.3)
  const stored = storedOp(state.appliedOps, op.opId);
  if (stored) return { state, result: { status: stored.status, reason: stored.reason }, changes: [], records: [] };

  const handler = Object.hasOwn(HANDLERS, op.type) ? HANDLERS[op.type] : undefined;
  // stored timestamps are compared as strings, so every one is ISO UTC whatever offset the phone sent
  const at = new Date(clampToNow(op.at, now)).toISOString();
  let result: OpResult;
  let touched: OpResult["touched"];
  let next = cloneState(state);
  try {
    ({ touched, ...result } = handler ? handler(next, op.payload, at, op.opId) : refused("opération inconnue"));
  } catch (error) {
    // a handler bug is not the op's answer: refuse it unrecorded, so a resend is applied once the bug is fixed
    return { state, result: refused(`erreur interne : ${error instanceof Error ? error.message : String(error)}`), changes: [], records: [] };
  }

  if (result.status !== "applied") next = { ...state, appliedOps: { ...state.appliedOps } };
  const changes = result.status === "applied" ? withTouched(diffStates(state, next), next, touched) : [];
  recordIssuedIds(next, changes);
  const rec = record(state, op, now, result, changes);
  storeOp(next.appliedOps, rec);
  const records = [rec];
  if (op.type === "undo" && result.status === "applied") {
    const targetId = (op.payload as { targetOpId: string }).targetOpId;
    const target = storedOp(next.appliedOps, targetId);
    if (target) records.push(target);
  }
  return { state: next, result, changes, records };
}
