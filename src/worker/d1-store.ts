import { applyOp, parseEnvelope } from "../domain/ops/apply";
import type { OpResult } from "../domain/ops/types";
import { NOT_UNDOABLE } from "../domain/ops/undo";
import { UNDO_FROM_ROW_TYPES } from "../domain/snapshot";
import { diffStates, emptyState, storeOp, TABLES } from "../domain/state";
import type { AppliedOp, Change, State, TableName } from "../domain/types";
import { COLUMNS, SQL_TABLE, fromDbRow, toDbRow } from "./schema";

/** D1 binds at most 100 parameters per statement. */
const MAX_BOUND = 100;

type Row = Record<string, unknown>;

/** Each table's every column at null, built once: `recordedChanges` runs on every record a load reads. */
const NULL_ROWS = Object.fromEntries(
  TABLES.map((t) => [t, Object.freeze(Object.fromEntries(COLUMNS[t].map(({ key }) => [key, null])))]),
) as Record<TableName, Readonly<Row>>;

/**
 * An applied_ops record's changes, each row given every column the schema has now: a column a later migration added is
 * absent from a record written before it, while a loaded row carries it as null (`fromDbRow`), so undo's row compare
 * would refuse « modifié depuis » a row nothing changed, and its restore would put back a row without that key.
 */
export function recordedChanges(text: string): Change[] {
  const withColumns = (table: TableName, row: Row | null): Row | null => (row === null ? null : { ...NULL_ROWS[table], ...row });
  return (JSON.parse(text) as Change[]).map((c) => ({
    ...c,
    before: withColumns(c.table, c.before as Row | null) as Change["before"],
    after: withColumns(c.table, c.after as Row | null) as Change["after"],
  }));
}

const recordOf = (r: Row): AppliedOp => ({
  opId: r.op_id as string, type: r.type as string, appliedAt: r.applied_at as string, status: r.status as AppliedOp["status"],
  reason: (r.reason as string | null) ?? null, changes: recordedChanges(r.changes as string), undoneBy: (r.undone_by as string | null) ?? null,
  seq: Number(r.seq),
});

/**
 * The undo window's records (spec §6.6): the cook and buy ops applied since `since` and not undone, which the snapshot
 * needs to name the op that undoes a cooked meal or a bought line from its row. Only the columns it reads, and the order
 * every record carries (`seq`): the WHERE fixes the status, the reason and undone_by (`windowRecord`). With `released`,
 * the version a write batch releases, it reads only when that batch landed: a conflicting attempt reads nothing.
 */
function windowQuery(db: D1Database, since: string, released: number | null = null): D1PreparedStatement {
  const guard = released === null ? "" : " AND (SELECT version FROM meta WHERE id = 1) = ?";
  return db.prepare(
    `SELECT seq, op_id, type, applied_at, changes FROM applied_ops WHERE type IN (${UNDO_FROM_ROW_TYPES.map(() => "?").join(", ")}) AND status = 'applied' AND undone_by IS NULL AND applied_at >= ?${guard}`,
  ).bind(...UNDO_FROM_ROW_TYPES, since, ...(released === null ? [] : [released]));
}

const windowRecord = (r: Row): AppliedOp => ({
  opId: r.op_id as string, type: r.type as string, appliedAt: r.applied_at as string, status: "applied", reason: null,
  changes: recordedChanges(r.changes as string), undoneBy: null, seq: Number(r.seq),
});

/**
 * For the undos of a request, the ops applied after their targets (`seq`, the apply order every record is written
 * with), still in effect and not undos, whose changes name a row a target's changes name: what the undo must see to
 * refuse « modifié depuis » a write that left a row as the target had (`writtenSince` in undo.ts). Only a target the
 * undo could take back counts (applied, not undone, of an undoable type): for any other the undo is refused before
 * `writtenSince`, so the scan is skipped. The targets' rows are read once (`k`), the scan starts at the earliest target
 * on the `seq` index, and only the columns `windowRecord` reads come back (the WHERE fixes the status, the reason and
 * undone_by). One statement per chunk of targets, inside the load's batch, so a request still makes one D1 call to load.
 */
function writtenSinceQuery(db: D1Database, targets: string[]): D1PreparedStatement {
  const types = [...NOT_UNDOABLE];
  return db.prepare(
    `WITH t AS (SELECT seq, changes FROM applied_ops WHERE op_id IN (${targets.map(() => "?").join(",")})
       AND status = 'applied' AND undone_by IS NULL AND type NOT IN (${types.map(() => "?").join(",")})),
     k AS (SELECT DISTINCT t.seq AS after, json_extract(c.value, '$.table') AS tbl, json_extract(c.value, '$.id') AS id FROM t, json_each(t.changes) c)
     SELECT a.seq, a.op_id, a.type, a.applied_at, a.changes FROM applied_ops a
     WHERE a.seq > (SELECT MIN(seq) FROM t) AND a.status = 'applied' AND a.undone_by IS NULL AND a.type <> 'undo'
       AND EXISTS (SELECT 1 FROM json_each(a.changes) c JOIN k ON k.tbl = json_extract(c.value, '$.table') AND k.id = json_extract(c.value, '$.id')
         WHERE a.seq > k.after)`,
  ).bind(...targets, ...types);
}

/**
 * Loads every table, the op records named by `opIds`, and for the undos targeting `undoTargets` the later writes of their
 * rows (`writtenSinceQuery`) into the state, and, from `recentSince` on, the undo window's records, kept apart as raw
 * rows: the apply loop clones its state once per op, and two weeks of those records would multiply that cost. All in one
 * batch: one D1 call, whatever is asked.
 */
async function loadParts(db: D1Database, opIds: string[], recentSince: string | null, undoTargets: string[] = []): Promise<{ state: State; recent: Row[] }> {
  const state = emptyState();
  const statements = [
    db.prepare("SELECT version, last_ids FROM meta WHERE id = 1"),
    ...TABLES.map((t) => db.prepare(`SELECT * FROM ${SQL_TABLE[t]} ORDER BY id`)),
  ];
  const ids = [...new Set(opIds)];
  for (let i = 0; i < ids.length; i += MAX_BOUND) {
    const chunk = ids.slice(i, i + MAX_BOUND);
    statements.push(db.prepare(`SELECT * FROM applied_ops WHERE op_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk));
  }
  const named = statements.length;
  const targets = [...new Set(undoTargets)];
  const perChunk = MAX_BOUND - NOT_UNDOABLE.size;
  for (let i = 0; i < targets.length; i += perChunk) statements.push(writtenSinceQuery(db, targets.slice(i, i + perChunk)));
  const later = statements.length;
  if (recentSince !== null) statements.push(windowQuery(db, recentSince));
  const results = await db.batch<Row>(statements);
  const meta = results[0]!.results[0]!;
  state.version = Number(meta.version);
  state.lastIds = JSON.parse(meta.last_ids as string) as State["lastIds"];
  TABLES.forEach((table, i) => {
    (state[table] as unknown[]) = results[i + 1]!.results.map((r) => fromDbRow(table, r));
  });
  for (const chunk of results.slice(TABLES.length + 1, named)) for (const r of chunk.results) storeOp(state.appliedOps, recordOf(r));
  // a later write the request also names is already held, whole
  for (const chunk of results.slice(named, later)) {
    for (const r of chunk.results) if (!Object.hasOwn(state.appliedOps, r.op_id as string)) storeOp(state.appliedOps, windowRecord(r));
  }
  return { state, recent: recentSince === null ? [] : results[results.length - 1]!.results };
}

/**
 * Adds the window's records to a state for its snapshot, parsing only those it does not already hold: a record the
 * state holds is the same op, loaded by name or written by this request, and at least as recent.
 */
function withRecent(state: State, recent: readonly Row[]): State {
  const missing = recent.filter((r) => !Object.hasOwn(state.appliedOps, r.op_id as string));
  if (missing.length === 0) return state;
  const appliedOps = { ...state.appliedOps };
  for (const r of missing) storeOp(appliedOps, windowRecord(r));
  return { ...state, appliedOps };
}

/** Loads every table, the op records named by `opIds`, and from `recentSince` on the window's cook and buy records. */
export async function loadState(db: D1Database, opIds: string[], recentSince: string | null = null): Promise<State> {
  const { state, recent } = await loadParts(db, opIds, recentSince);
  return withRecent(state, recent);
}

/** TABLES is in foreign-key order: parents first for inserts and updates, children first for deletes. */
const ORDER: TableName[] = [...TABLES];

/**
 * The batch is one transaction. Its first statement claims meta.version by setting it to a sentinel no real version
 * takes (-(v + 1)), only if it is still the version we loaded. Each chunk of the request's new op ids then revokes the
 * claim (puts v back) if any of them is already recorded: another writer can record a noop or a refusal without
 * bumping, so an unchanged version does not mean those ids are still free. Every row change and op record is guarded by
 * "the version is the sentinel", and the last statement releases it to v + 1 when the batch changes rows or an existing
 * record (an undo marks its target), or back to v when it only records new ops whose outcome changed nothing (a noop, a
 * refusal): those write nothing another writer could conflict with, so they do not make it retry. The release landing is
 * the success signal. Without it nothing was written, so neither a refusal computed on a stale state nor a row change
 * whose record another writer already stored under the same op id is ever committed. The release also stores `lastIds`
 * when given (the state's high-water ids, which an undo never lowers).
 * Returns the version after the write, or null on a conflict (nothing was written).
 */
export async function persist(
  db: D1Database, expectedVersion: number, changes: Change[], records: AppliedOp[], storedOpIds: ReadonlySet<string> = new Set(),
  lastIds?: State["lastIds"],
): Promise<number | null> {
  return (await writeBatch(db, expectedVersion, changes, records, storedOpIds, lastIds, null)).version;
}

/** `persist`, and from `recentSince` on the undo window's records, read in the same batch once the write landed. */
async function writeBatch(
  db: D1Database, expectedVersion: number, changes: Change[], records: AppliedOp[], storedOpIds: ReadonlySet<string>,
  lastIds: State["lastIds"] | undefined, recentSince: string | null,
): Promise<{ version: number | null; recent: Row[] }> {
  const v = expectedVersion;
  const claimed = -(v + 1);
  const guard = "(SELECT version FROM meta WHERE id = 1) = ?";
  const updated = records.filter((r) => storedOpIds.has(r.opId));
  const inserted = records.filter((r) => !storedOpIds.has(r.opId));
  if (changes.length === 0 && records.length === 0) return { version: v, recent: [] };
  const statements: D1PreparedStatement[] = [db.prepare("UPDATE meta SET version = ? WHERE id = 1 AND version = ?").bind(claimed, v)];
  const newIds = inserted.map((r) => r.opId);
  for (let i = 0; i < newIds.length; i += MAX_BOUND - 2) {
    const chunk = newIds.slice(i, i + MAX_BOUND - 2);
    statements.push(
      db.prepare(`UPDATE meta SET version = ? WHERE id = 1 AND version = ? AND EXISTS (SELECT 1 FROM applied_ops WHERE op_id IN (${chunk.map(() => "?").join(",")}))`)
        .bind(v, claimed, ...chunk),
    );
  }
  const sorted = [...changes].sort((a, b) => {
    const da = a.after === null ? 1 : 0;
    const dbb = b.after === null ? 1 : 0;
    if (da !== dbb) return da - dbb;
    const ia = ORDER.indexOf(a.table);
    const ib = ORDER.indexOf(b.table);
    return da === 1 ? ib - ia : ia - ib;
  });
  for (const change of sorted) {
    const table = SQL_TABLE[change.table];
    const cols = COLUMNS[change.table];
    if (change.after === null) {
      statements.push(db.prepare(`DELETE FROM ${table} WHERE id = ? AND ${guard}`).bind(change.id, claimed));
    } else if (change.before === null) {
      const values = toDbRow(change.table, change.after);
      statements.push(
        db.prepare(`INSERT INTO ${table} (${cols.map((c) => c.col).join(", ")}) SELECT ${cols.map(() => "?").join(", ")} WHERE ${guard}`)
          .bind(...values, claimed),
      );
    } else {
      const values = toDbRow(change.table, change.after);
      statements.push(
        db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c.col} = ?`).join(", ")} WHERE id = ? AND ${guard}`)
          .bind(...values, change.id, claimed),
      );
    }
  }
  // each new record takes the next place in the apply order (`seq`), in the order this request applied them
  for (const r of inserted) {
    statements.push(
      db.prepare(
        `INSERT INTO applied_ops (op_id, type, applied_at, status, reason, changes, undone_by, seq) SELECT ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM applied_ops) WHERE ${guard}`,
      ).bind(r.opId, r.type, r.appliedAt, r.status, r.reason, JSON.stringify(r.changes), r.undoneBy, claimed),
    );
  }
  for (const r of updated) {
    statements.push(db.prepare(`UPDATE applied_ops SET undone_by = ? WHERE op_id = ? AND ${guard}`).bind(r.undoneBy, r.opId, claimed));
  }
  const next = changes.length > 0 || updated.length > 0 ? v + 1 : v;
  statements.push(
    lastIds === undefined
      ? db.prepare("UPDATE meta SET version = ? WHERE id = 1 AND version = ?").bind(next, claimed)
      : db.prepare("UPDATE meta SET version = ?, last_ids = ? WHERE id = 1 AND version = ?").bind(next, JSON.stringify(lastIds), claimed),
  );
  const release = statements.length - 1;
  if (recentSince !== null) statements.push(windowQuery(db, recentSince, next));
  const results = await db.batch<Row>(statements);
  if (results[release]!.meta.changes !== 1) return { version: null, recent: [] };
  return { version: next, recent: recentSince === null ? [] : results[release + 1]!.results };
}

/** The op an undo names, for `writtenSinceQuery`: none for any other op. */
function undoTargetOf(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const o = raw as { type?: unknown; payload?: { targetOpId?: unknown } };
  return o.type === "undo" && typeof o.payload?.targetOpId === "string" ? [o.payload.targetOpId] : [];
}

function opIdsOf(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const o = raw as { opId?: unknown; type?: unknown; payload?: { targetOpId?: unknown } };
  const ids = typeof o.opId === "string" ? [o.opId] : [];
  if (o.type === "undo" && typeof o.payload?.targetOpId === "string") ids.push(o.payload.targetOpId);
  return ids;
}

/**
 * The window's records for the answer of a request that writes nothing, read at the version the state was loaded at: one
 * batch of the current version and the guarded window query. If another writer moved the version between the two calls,
 * the state and the window would be two moments of the data (a bought line whose buy was just undone elsewhere, shown
 * bought with no buy to undo), so everything is loaded again once, in one batch, and the answer comes from that.
 */
async function readWindow(db: D1Database, ids: string[], version: number, since: string, state: State): Promise<{ state: State; recent: Row[] }> {
  const [current, window] = await db.batch<Row>([db.prepare("SELECT version FROM meta WHERE id = 1"), windowQuery(db, since, version)]);
  if (Number(current!.results[0]!.version) === version) return { state, recent: window!.results };
  return loadParts(db, ids, since);
}

export const CONFLICT: OpResult = { status: "refused", reason: "trop de modifications simultanées, réessayez" };

/**
 * Applies a request's ops in order on one loaded state and persists them in one version-guarded batch: two D1 calls
 * however many ops (a Worker invocation has a D1 query budget). On a version conflict the whole request is re-applied
 * on a fresh load; an op another writer recorded meanwhile then replays as what it got. An op that throws, inside its
 * handler or outside it, is refused alone and recorded nowhere, so a resend tries it again. `state` is the persisted
 * state, or null when every attempt conflicted. `recorded[i]` says whether D1 holds a record for op i once the call
 * returns, so that a resend replays it: false for an op that threw, a malformed op, and every op whose record an
 * exhausted conflict kept from landing (spec §8.2). Of those, only a malformed op has a final answer: the caller decides.
 */
export async function applyOpsAndPersist(
  db: D1Database, raws: readonly unknown[], now: string,
  options: { maxAttempts?: number; apply?: typeof applyOp; recentSince?: string | null } = {},
): Promise<{ results: OpResult[]; state: State | null; recorded: boolean[] }> {
  const { maxAttempts = 3, apply = applyOp, recentSince = null } = options;
  const ids = raws.flatMap(opIdsOf);
  const targets = raws.flatMap(undoTargetOf);
  // stored: D1 held the op's record before this request (a replay) · pending: recorded once this batch lands · none: never
  let fates: ("stored" | "pending" | "none")[] = [];
  let results: OpResult[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // the window's records stay out of the state the loop clones once per op, and out of every attempt's load: only the
    // answer reads them, in the batch that writes it, or on their own when the request writes nothing
    const { state: loaded } = await loadParts(db, ids, null, targets);
    let state = loaded;
    const records = new Map<string, AppliedOp>();
    results = [];
    fates = [];
    for (const raw of raws) {
      const opId = parseEnvelope(raw)?.opId ?? null;
      // a replay of an op recorded earlier in this same request is only as durable as this request's batch
      const replay = opId !== null && Object.hasOwn(state.appliedOps, opId);
      try {
        const applied = apply(state, raw, now);
        state = applied.state;
        for (const r of applied.records) records.set(r.opId, r); // an undo of an op from this request leaves the latest record
        results.push(applied.result);
        fates.push(replay ? (Object.hasOwn(loaded.appliedOps, opId) ? "stored" : "pending") : applied.records.length > 0 ? "pending" : "none");
      } catch (error) {
        results.push({ status: "refused", reason: `erreur interne : ${error instanceof Error ? error.message : String(error)}` });
        fates.push("none");
      }
    }
    if (records.size === 0) {
      const settled = recentSince === null ? { state, recent: [] } : await readWindow(db, ids, loaded.version, recentSince, state);
      return { results, state: withRecent(settled.state, settled.recent), recorded: fates.map((f) => f === "stored") };
    }
    const { version, recent } = await writeBatch(
      db, loaded.version, diffStates(loaded, state), [...records.values()], new Set(Object.keys(loaded.appliedOps)), state.lastIds, recentSince,
    );
    if (version !== null) return { results, state: withRecent({ ...state, version }, recent), recorded: fates.map((f) => f !== "none") };
  }
  return { results: results.map((r, i) => (fates[i] === "pending" ? CONFLICT : r)), state: null, recorded: fates.map((f) => f === "stored") };
}
