-- Rows reaped before `reaped_reason` existed carry no record of why; the
-- next migration's CHECK ties the column to `status = 'reaped'`, so they get
-- the one value no code path writes.
UPDATE "containers" SET "reaped_reason" = 'unknown' WHERE "status" = 'reaped' AND "reaped_reason" IS NULL;
