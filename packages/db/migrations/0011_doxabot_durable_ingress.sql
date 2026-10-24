ALTER TABLE "generation_jobs" ADD COLUMN "source_installation_external_id" text;--> statement-breakpoint
ALTER TABLE "scm_change_proposals" ADD COLUMN "installation_external_id" text;--> statement-breakpoint
UPDATE "scm_change_proposals" AS "proposal"
SET "installation_external_id" = COALESCE(
  (
    SELECT "installation"."installation_id"
    FROM "github_repositories" AS "repository"
    INNER JOIN "github_installations" AS "installation"
      ON "repository"."installation_id" = "installation"."id"
    WHERE "repository"."github_repo_id" = "proposal"."repository_external_id"
    LIMIT 1
  ),
  'legacy-unresolved'
)
WHERE "installation_external_id" IS NULL;--> statement-breakpoint
ALTER TABLE "scm_change_proposals" ALTER COLUMN "installation_external_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_webhook_deliveries" ADD COLUMN "normalized_event" jsonb;--> statement-breakpoint
ALTER TABLE "scm_webhook_deliveries" ADD COLUMN "queue_published_at" timestamp with time zone;--> statement-breakpoint
UPDATE "scm_webhook_deliveries"
SET "normalized_event" = '{"outcome":"irrelevant","reason":"unsupported_event"}'::jsonb
WHERE "normalized_event" IS NULL;--> statement-breakpoint
ALTER TABLE "scm_webhook_deliveries" ALTER COLUMN "normalized_event" SET NOT NULL;
