import type { Snapshot } from "../../domain/snapshot";
import type { OpStatus } from "../../domain/types";

export type { OpStatus };

/** The envelope POST /api/ops takes (spec §8.1): a UUID made on the phone, the tap time as full ISO with Z. */
export interface Op {
  opId: string;
  type: string;
  at: string;
  payload: unknown;
}

/** One tap waiting for its final answer, or keeping it until a snapshot shows it, as stored in IndexedDB. */
export interface OutboxEntry {
  op: Op;
  /** What the tap did, in French, for « Annuler », « en échec » and refusals: « Acheté : comté ». */
  label: string;
  /** Tap order on this phone. */
  seq: number;
  /** Requests that carried it; once above 0 its answer may have been lost after the server applied it. */
  sends: number;
  /** Answers that listed it in `unrecorded` (spec §8.2). */
  unrecorded: number;
  /** « En échec »: no longer sent until « Réessayer » (spec §8.3). */
  failed: boolean;
  lastReason: string | null;
  /** Its final answer, kept until a snapshot taken after it is stored (outbox.ts `covered`); absent while unanswered. */
  final?: OpStatus;
}

/** Why waiting ops are not leaving: nothing, no network, an Access login to redo, or a server failure. */
export type ConnStatus = "online" | "offline" | "reauth" | "server";

export interface WireResult {
  opId: string | null;
  status: OpStatus;
  reason: string | null;
}

/** POST /api/ops answer (spec §8.1); `snapshot` is null when D1 could not be read back. */
export interface OpsAnswer {
  results: WireResult[];
  unrecorded: string[];
  snapshot: Snapshot | null;
}

export interface Refusal {
  label: string;
  reason: string;
}
