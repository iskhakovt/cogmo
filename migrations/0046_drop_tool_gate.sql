DROP TABLE "coding_tool_decisions" CASCADE;--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "coding_autoapprove_mode";--> statement-breakpoint
DROP TYPE "public"."decision_scope";--> statement-breakpoint
DROP TYPE "public"."tool_decision";--> statement-breakpoint
DROP TYPE "public"."coding_autoapprove_mode";