-- Usage rows are kept until billing decides their retention. Clearing the
-- expiry also stops an older agent-worker cron from deleting them.
DROP INDEX "generation_usage_records_expires_at_idx";--> statement-breakpoint
ALTER TABLE "generation_usage_records" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
UPDATE "generation_usage_records" SET "expires_at" = NULL;
