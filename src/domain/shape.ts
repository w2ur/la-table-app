/** A plain object (no null, no array) as a record, for reading untrusted JSON. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
