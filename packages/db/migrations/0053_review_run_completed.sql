ALTER TABLE "generation_jobs" ADD COLUMN "review_run_completed_at" timestamp with time zone;--> statement-breakpoint
-- Jobs that ended before this column existed count as closed: the cron that
-- closes open checks only looks at jobs that end from now on.
UPDATE "generation_jobs" SET "review_run_completed_at" = "updated_at" WHERE "external_review_run_id" is not null and "status" not in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "generation_jobs_open_review_run_idx" ON "generation_jobs" USING btree ("updated_at") WHERE "generation_jobs"."external_review_run_id" is not null and "generation_jobs"."review_run_completed_at" is null;
