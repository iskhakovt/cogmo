CREATE TABLE "model_catalogs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entries" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
