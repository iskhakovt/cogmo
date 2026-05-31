-- Backfill `type: "host-path"` on existing `coding_tasks.worktree_assignment`
-- rows. Phase 3b.2.A turns the JSONB blob into a discriminated union and
-- `WorktreeAssignmentSchema` (Zod, validated at the driver boundary by
-- `jsonbZod`) now requires a `type` discriminator on read. Pre-3b.2.A rows
-- were always host-path, so this is a lossless one-shot rewrite.
--
-- Idempotent: the predicate excludes already-tagged rows.
UPDATE coding_tasks
SET worktree_assignment = jsonb_set(worktree_assignment, '{type}', '"host-path"')
WHERE worktree_assignment IS NOT NULL
  AND NOT (worktree_assignment ? 'type');
