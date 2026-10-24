DROP INDEX "job_events_job_sequence_idx";--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "event_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ranked_events AS (
	SELECT
		"id",
		(row_number() OVER (
			PARTITION BY "job_id"
			ORDER BY "sequence", "created_at", "id"
		))::integer AS "next_sequence"
	FROM "job_events"
)
UPDATE "job_events" AS events
SET "sequence" = ranked_events."next_sequence"
FROM ranked_events
WHERE events."id" = ranked_events."id";--> statement-breakpoint
UPDATE "generation_jobs" AS jobs
SET "event_sequence" = COALESCE((
	SELECT MAX(events."sequence")
	FROM "job_events" AS events
	WHERE events."job_id" = jobs."id"
), 0);--> statement-breakpoint
CREATE UNIQUE INDEX "job_events_job_sequence_idx" ON "job_events" USING btree ("job_id","sequence");
