import type { AppliedOp, Change, OpStatus, State, TableName } from "../types";

export interface OpEnvelope {
  opId: string;
  type: string;
  at: string;
  payload: unknown;
}

export interface OpResult {
  status: OpStatus;
  reason: string | null;
  /** Rows an applied op wrote with the values they already had: kept in its record (AppliedOp.changes), never answered. */
  touched?: { table: TableName; id: number }[];
}

export interface Applied {
  state: State;
  result: OpResult;
  changes: Change[];
  /** op records to upsert: the new one, plus the undone target for an undo */
  records: AppliedOp[];
}

/** Mutates `next` (a clone). Returning `refused` discards every mutation. `opId` is the op being applied (undo records it). */
export type Handler = (next: State, payload: unknown, at: string, opId?: string) => OpResult;
