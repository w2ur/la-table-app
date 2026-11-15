-- The order ops were applied in, which « Annuler » reads to refuse an undo « modifié depuis » (src/worker/d1-store.ts).
-- An explicit column, because applied_ops' rowid is implicit (TEXT primary key): a VACUUM or a restore from a dump may
-- renumber it. Each record is written with MAX(seq) + 1 inside the store's version-guarded batch; the records already
-- there keep the order their rowid gave them. Unique, so two records never share a place in that order.
ALTER TABLE applied_ops ADD COLUMN seq INTEGER;
UPDATE applied_ops SET seq = rowid;
CREATE UNIQUE INDEX applied_ops_seq ON applied_ops (seq);
-- A UNIQUE index allows any number of NULLs, and « modifié depuis » (seq > after) is never true for one: a record
-- inserted without a seq would let an earlier op's undo erase a later write. Refuse it at the door.
CREATE TRIGGER applied_ops_seq_required BEFORE INSERT ON applied_ops WHEN NEW.seq IS NULL
BEGIN
  SELECT RAISE(ABORT, 'applied_ops.seq is required');
END;
