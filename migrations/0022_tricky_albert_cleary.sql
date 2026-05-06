ALTER TABLE "voice_config" ADD COLUMN "singleton" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_config" ADD CONSTRAINT "uq_voice_config_singleton" UNIQUE("singleton");--> statement-breakpoint
ALTER TABLE "voice_config" ADD CONSTRAINT "chk_voice_config_singleton" CHECK (singleton = true);