CREATE TYPE "public"."coding_task_failure_reason" AS ENUM('cli_exit_error', 'no_plan_produced', 'claude_auth_failed', 'push_failed', 'branch_conflict', 'auth_failed', 'verify_failed', 'verify_timed_out', 'pr_auth_failed', 'pr_validation_failed', 'pr_open_failed', 'credentials_unavailable', 'run_terminated', 'start_emit_failed', 'unexpected_error', 'user_cancelled', 'user_requested_revisions', 'unknown');--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD COLUMN "failure_detail" text;--> statement-breakpoint
-- A reason under a status that is not `failed` or `cancelled` is a Cancel's
-- text that an unconditional status write of an earlier build
-- (`set-status-pending-verify`, `set-status-pushed`, `set-status-pr-open`)
-- carried forward; the task went on, so the reason goes.
UPDATE "coding_tasks"
SET "failure_reason" = NULL
WHERE "failure_reason" IS NOT NULL AND "status" NOT IN ('failed', 'cancelled');--> statement-breakpoint
-- The stored text moves to `failure_detail` whole — except a Cancel's, whose
-- reason says everything — and `failure_reason` becomes the label of the
-- writer branch that produced it, matched on the text each branch wrote: a
-- CLI exit code, the push and PR-open prefixes (`draft PR open failed` before
-- PRs opened ready for review), the verify verdict (exit 124 is the timeout
-- cap; a suite that itself exits 124 reads as one too), the credential gates,
-- the reconciler's and the start emit's prefixes, and the two Cancel texts. Any other text on a `failed` row
-- is the free text of an orchestrator's catch, which has no prefix, and
-- becomes `unexpected_error`; on a `cancelled` row it becomes `unknown`. Either
-- way the detail is kept. A `failed` or `cancelled` row with no text at all,
-- or empty text, becomes `unknown` with a null detail.
UPDATE "coding_tasks"
SET "failure_detail" = CASE
      WHEN "failure_reason" IN ('user cancelled the plan', 'user requested revisions') THEN NULL
      ELSE NULLIF("failure_reason", '')
    END,
    "failure_reason" = CASE
      WHEN "failure_reason" ~ '^claude exit code ' THEN 'cli_exit_error'
      WHEN "failure_reason" = 'execute phase failed' THEN 'cli_exit_error'
      WHEN "failure_reason" = 'plan phase produced no plan' THEN 'no_plan_produced'
      WHEN "failure_reason" ~ '^execute push failed \(branch_conflict\)' THEN 'branch_conflict'
      WHEN "failure_reason" ~ '^execute push failed \(auth_failed\)' THEN 'auth_failed'
      WHEN "failure_reason" ~ '^execute push failed \(' THEN 'push_failed'
      WHEN "failure_reason" ~ '^push rejected — branch conflict' THEN 'branch_conflict'
      WHEN "failure_reason" ~ '^push rejected — GitHub authentication failed' THEN 'auth_failed'
      WHEN "failure_reason" ~ '^commit\+push failed' THEN 'push_failed'
      WHEN "failure_reason" ~ '^verify failed \(exit 124\)' THEN 'verify_timed_out'
      WHEN "failure_reason" ~ '^verify failed \(exit ' THEN 'verify_failed'
      WHEN "failure_reason" ~ '^(draft )?PR open failed \(auth\)' THEN 'pr_auth_failed'
      WHEN "failure_reason" ~ '^(draft )?PR open failed \(validation\)' THEN 'pr_validation_failed'
      WHEN "failure_reason" ~ '^(draft )?PR open failed' THEN 'pr_open_failed'
      WHEN "failure_reason" ~ '^cannot parse owner/repo from remote URL' THEN 'credentials_unavailable'
      WHEN "failure_reason" ~ '^GitHub identity ''[^'']*'' is (not configured|corrupt|malformed)' THEN 'credentials_unavailable'
      WHEN "failure_reason" ~ '^Claude Code subscription auth missing' THEN 'credentials_unavailable'
      WHEN "failure_reason" ~ '^inngest run terminated abnormally' THEN 'run_terminated'
      WHEN "failure_reason" ~ '^inngest\.send failed: ' THEN 'start_emit_failed'
      WHEN "failure_reason" = 'user cancelled the plan' THEN 'user_cancelled'
      WHEN "failure_reason" = 'user requested revisions' THEN 'user_requested_revisions'
      WHEN "failure_reason" = '' THEN 'unknown'
      WHEN "status" = 'failed' THEN 'unexpected_error'
      ELSE 'unknown'
    END
WHERE "failure_reason" IS NOT NULL;--> statement-breakpoint
UPDATE "coding_tasks"
SET "failure_reason" = 'unknown'
WHERE "failure_reason" IS NULL AND "status" IN ('failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "coding_tasks" ALTER COLUMN "failure_reason" SET DATA TYPE "public"."coding_task_failure_reason" USING "failure_reason"::"public"."coding_task_failure_reason";--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "chk_coding_tasks_reason_with_end" CHECK (("coding_tasks"."failure_reason" IS NOT NULL) = ("coding_tasks"."status" IN ('failed', 'cancelled')));--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "chk_coding_tasks_detail_with_reason" CHECK ("coding_tasks"."failure_detail" IS NULL OR "coding_tasks"."failure_reason" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "chk_coding_tasks_queued_bare" CHECK ("coding_tasks"."status" <> 'queued' OR ("coding_tasks"."worktree_assignment" IS NULL AND "coding_tasks"."session_id" IS NULL AND "coding_tasks"."container_id" IS NULL AND "coding_tasks"."plan" IS NULL AND "coding_tasks"."plan_approved_at" IS NULL AND "coding_tasks"."pr_metadata" IS NULL AND "coding_tasks"."resource_usage" IS NULL AND "coding_tasks"."claimed_by_run_id" IS NULL));--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "chk_coding_tasks_plan_at_gate" CHECK ("coding_tasks"."status" NOT IN ('awaiting_approval', 'executing', 'pending_verify', 'verifying', 'pushed', 'pr_open') OR "coding_tasks"."plan" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "chk_coding_tasks_approval_after_gate" CHECK (("coding_tasks"."plan_approved_at" IS NULL OR "coding_tasks"."status" <> 'planning') AND ("coding_tasks"."status" NOT IN ('executing', 'pending_verify', 'verifying', 'pushed', 'pr_open') OR "coding_tasks"."plan_approved_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "chk_coding_tasks_pr_metadata_after_push" CHECK (("coding_tasks"."pr_metadata" IS NULL OR "coding_tasks"."status" IN ('pushed', 'pr_open', 'failed', 'cancelled')) AND ("coding_tasks"."status" <> 'pr_open' OR "coding_tasks"."pr_metadata" IS NOT NULL));
