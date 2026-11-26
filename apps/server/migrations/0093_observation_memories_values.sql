ALTER TYPE "public"."observation_phase" ADD VALUE 'memories';--> statement-breakpoint
ALTER TYPE "public"."observation_status" ADD VALUE 'held' BEFORE 'applied';--> statement-breakpoint
ALTER TYPE "public"."observation_status" ADD VALUE 'held_extracted' BEFORE 'applied';--> statement-breakpoint
ALTER TYPE "public"."observation_status" ADD VALUE 'extracted' BEFORE 'applied';