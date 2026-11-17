-- A short, speakable booking reference (e.g. BK-7K4Q2M) for chat and voice.
-- Added in three steps so the migration also works on a table that has rows.
ALTER TABLE "bookings" ADD COLUMN "reference" TEXT;

UPDATE "bookings" SET "reference" = 'BK-' || upper(substr(md5("id"), 1, 6)) WHERE "reference" IS NULL;

ALTER TABLE "bookings" ALTER COLUMN "reference" SET NOT NULL;

CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings"("reference");
