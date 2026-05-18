-- Add `venice` to image_provider_type. Split from the CHECK-constraint
-- extension (0037) because Postgres refuses `unsafe use of new value` when
-- the same transaction both adds an enum value and references it. The
-- per-file migrator (`src/db/migrate-per-file.ts`) commits this file's tx
-- before 0037 opens, so the value is visible by then.

ALTER TYPE "public"."image_provider_type" ADD VALUE 'venice';
