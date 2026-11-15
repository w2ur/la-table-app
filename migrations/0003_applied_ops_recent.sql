-- Lets loadState read the recent cook and buy records (undo from a row, spec §6.6) without scanning every op record.
CREATE INDEX applied_ops_recent ON applied_ops (type, applied_at);
