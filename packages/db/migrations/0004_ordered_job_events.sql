ALTER TABLE "job_events" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "job_events" ADD COLUMN "source" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
WITH ordered_events AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "job_id"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS "event_sequence"
  FROM "job_events"
)
UPDATE "job_events"
SET "sequence" = ordered_events."event_sequence"
FROM ordered_events
WHERE "job_events"."id" = ordered_events."id";--> statement-breakpoint
ALTER TABLE "job_events" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "job_events_job_sequence_idx" ON "job_events" USING btree ("job_id","sequence");
