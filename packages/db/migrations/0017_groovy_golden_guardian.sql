ALTER TABLE "generation_jobs" ADD COLUMN "source_author_external_id" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "source_author_handle" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "source_author_avatar_url" text;--> statement-breakpoint
CREATE INDEX "account_provider_account_id_idx" ON "account" USING btree ("providerId","accountId");--> statement-breakpoint
CREATE INDEX "generation_jobs_source_author_idx" ON "generation_jobs" USING btree ("source_provider","source_author_external_id");