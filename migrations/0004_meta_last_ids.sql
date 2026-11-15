-- The highest id each table has issued (State.lastIds), as JSON: an undo deletes the rows its op created, and without
-- this the next row would take a deleted row's id, so an op queued against the deleted row would land on its successor.
ALTER TABLE meta ADD COLUMN last_ids TEXT NOT NULL DEFAULT '{}';
