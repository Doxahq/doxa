ALTER TABLE "scm_change_proposals" ADD COLUMN "source_updated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "scm_change_proposals" SET "source_updated_at" = "updated_at" WHERE "source_updated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "scm_change_proposals" ALTER COLUMN "source_updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_webhook_deliveries" ADD COLUMN "generation_job_id" uuid;--> statement-breakpoint
ALTER TABLE "scm_webhook_deliveries" ADD CONSTRAINT "scm_webhook_deliveries_generation_job_id_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scm_webhook_deliveries_generation_job_id_idx" ON "scm_webhook_deliveries" USING btree ("generation_job_id");
