ALTER TABLE "steering_rules" ADD COLUMN "retracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "steering_rules" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "steering_rules" ADD COLUMN "quote" text;--> statement-breakpoint
ALTER TABLE "steering_rules" ADD CONSTRAINT "steering_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_steering_rules_instruction" ON "steering_rules" USING btree (lower(btrim(regexp_replace(rule, '[[:space:]]+', ' ', 'g'))),user_id,COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid),COALESCE(channel_type, '')) WHERE source = 'instruction' AND retracted_at IS NULL;--> statement-breakpoint
ALTER TABLE "steering_rules" ADD CONSTRAINT "chk_steering_rules_lifecycle" CHECK (NOT ("steering_rules"."active" AND "steering_rules"."retracted_at" IS NOT NULL)
        AND ("steering_rules"."source" <> 'instruction' OR "steering_rules"."active" OR "steering_rules"."retracted_at" IS NOT NULL)
        AND (("steering_rules"."source" = 'instruction') = ("steering_rules"."user_id" IS NOT NULL))
        AND (("steering_rules"."source" = 'instruction') = ("steering_rules"."quote" IS NOT NULL)));