import type { AppliedOp, Change, Row, State, TableName } from "./types";

/** A stored op by id, own keys only: an op id is client text, and "constructor" must not read Object.prototype. */
export function storedOp(ops: State["appliedOps"], opId: string): AppliedOp | undefined {
  return Object.hasOwn(ops, opId) ? ops[opId] : undefined;
}

/** Stores an op as an own key: a plain assignment under "__proto__" would replace the prototype and store nothing. */
export function storeOp(ops: State["appliedOps"], rec: AppliedOp): void {
  Object.defineProperty(ops, rec.opId, { value: rec, enumerable: true, writable: true, configurable: true });
}

/** Foreign-key order: every table comes after the tables it references (d1-store persists in this order). */
export const TABLES: readonly TableName[] = [
  "products",
  "recipes",
  "recipeIngredients",
  "plannings",
  "meals",
  "trips",
  "shoppingItems",
  "stockItems",
  "reservations",
  "envies",
];

export function emptyState(): State {
  return {
    version: 0,
    products: [],
    recipes: [],
    recipeIngredients: [],
    plannings: [],
    meals: [],
    shoppingItems: [],
    trips: [],
    stockItems: [],
    reservations: [],
    envies: [],
    lastIds: {},
    appliedOps: {},
  };
}

export function cloneState(state: State): State {
  return structuredClone(state);
}

/** The id for a new row of `table`: above every row it holds and every id it ever issued (`State.lastIds`). */
export function nextId(state: State, table: TableName): number {
  return tableRows(state, table).reduce((max, row) => Math.max(max, row.id), state.lastIds[table] ?? 0) + 1;
}

/** Raises `lastIds` to every row an applied op created (a change with no `before`); never lowers it. */
export function recordIssuedIds(state: State, changes: readonly Change[]): void {
  for (const c of changes) {
    if (c.before === null && c.id > (state.lastIds[c.table] ?? 0)) state.lastIds = { ...state.lastIds, [c.table]: c.id };
  }
}

export function findRow<T extends { id: number }>(rows: readonly T[], id: number): T | undefined {
  return rows.find((row) => row.id === id);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

export function tableRows(state: State, table: TableName): Row[] {
  return state[table] as unknown as Row[];
}

export function diffStates(a: State, b: State): Change[] {
  const changes: Change[] = [];
  for (const table of TABLES) {
    const before = new Map(tableRows(a, table).map((row) => [row.id, row]));
    const after = new Map(tableRows(b, table).map((row) => [row.id, row]));
    for (const [id, row] of after) {
      const prev = before.get(id) ?? null;
      if (prev === null || stableStringify(prev) !== stableStringify(row)) {
        changes.push({ table, id, before: prev === null ? null : structuredClone(prev), after: structuredClone(row) });
      }
    }
    for (const [id, row] of before) {
      if (!after.has(id)) changes.push({ table, id, before: structuredClone(row), after: null });
    }
  }
  return changes;
}
