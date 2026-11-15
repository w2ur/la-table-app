/** A tap: one op to send, and the French words that name it in « Annuler », « en échec » and refusals. */
export type Act = (type: string, payload: unknown, label: string) => void;

/**
 * A tap that stands for several ops (a Courses row joining one product's lines): each joins the outbox in order, and
 * « Annuler » takes them all back.
 */
export type ActMany = (ops: readonly { type: string; payload: unknown }[], label: string) => void;

/** « Annuler » on an op, by its id; `label` names the op being undone. */
export type Undo = (targetOpId: string, label: string) => void;
