ALTER TABLE "core_memory_blocks" DROP CONSTRAINT "uq_core_memory_user_key";--> statement-breakpoint
ALTER TABLE "core_memory_blocks" ADD COLUMN "profile_class" text;--> statement-breakpoint
ALTER TABLE "core_memory_blocks" ADD CONSTRAINT "fk_core_memory_profile_class" FOREIGN KEY ("user_id","profile_class") REFERENCES "public"."profile_classes"("user_id","name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_memory_blocks" ADD CONSTRAINT "uq_core_memory_user_class_key" UNIQUE NULLS NOT DISTINCT("user_id","profile_class","key");