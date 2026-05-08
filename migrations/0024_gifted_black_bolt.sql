CREATE TABLE "profile_classes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_profile_classes_user_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "profile_class" text;--> statement-breakpoint
ALTER TABLE "profile_classes" ADD CONSTRAINT "profile_classes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;