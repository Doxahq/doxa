CREATE TYPE "public"."change_proposal_state" AS ENUM('open', 'closed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."docs_version_channel" AS ENUM('production', 'preview');--> statement-breakpoint
CREATE TYPE "public"."generation_job_trigger" AS ENUM('manual', 'doxabot');--> statement-breakpoint
CREATE TYPE "public"."generation_publication_mode" AS ENUM('production', 'preview');--> statement-breakpoint
CREATE TYPE "public"."preview_channel_lifecycle_state" AS ENUM('active', 'closed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."source_control_provider" AS ENUM('github');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('claimed', 'processed', 'ignored', 'enqueue_failed', 'failed');--> statement-breakpoint
CREATE TABLE "docs_preview_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"provider" "source_control_provider" NOT NULL,
	"change_external_id" text NOT NULL,
	"hostname" text NOT NULL,
	"current_version_id" uuid,
	"lifecycle_state" "preview_channel_lifecycle_state" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doxabot_automation_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scm_change_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "source_control_provider" NOT NULL,
	"repository_external_id" text NOT NULL,
	"external_id" text NOT NULL,
	"display_number" integer NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"state" "change_proposal_state" DEFAULT 'open' NOT NULL,
	"default_branch" text NOT NULL,
	"base_ref" text NOT NULL,
	"base_revision" text NOT NULL,
	"head_revision" text NOT NULL,
	"last_source_tree_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scm_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "source_control_provider" NOT NULL,
	"delivery_id" text NOT NULL,
	"event_name" text NOT NULL,
	"action" text,
	"repository_external_id" text,
	"payload_hash" text NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'claimed' NOT NULL,
	"ignore_reason" text,
	"error_code" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_requested_by_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "generation_jobs_active_project_idx";--> statement-breakpoint
ALTER TABLE "generation_jobs" ALTER COLUMN "requested_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_versions" ADD COLUMN "channel" "docs_version_channel" DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_versions" ADD COLUMN "source_revision" text;--> statement-breakpoint
ALTER TABLE "docs_versions" ADD COLUMN "source_tree_hash" text;--> statement-breakpoint
ALTER TABLE "docs_versions" ADD COLUMN "baseline_version_id" uuid;--> statement-breakpoint
ALTER TABLE "docs_versions" ADD COLUMN "generator_fingerprint" text;--> statement-breakpoint
ALTER TABLE "docs_versions" ADD COLUMN "generation_state_prefix" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "trigger" "generation_job_trigger" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "publication_mode" "generation_publication_mode" DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "source_provider" "source_control_provider";--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "change_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "change_external_id" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "baseline_revision" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "target_revision" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "source_tree_hash" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "baseline_version_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "generator_fingerprint" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "concurrency_key" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "external_review_run_id" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "superseded_by_job_id" uuid;--> statement-breakpoint
UPDATE "docs_versions"
SET "generation_state_prefix" = "artifact_prefix" || '/generation-state';--> statement-breakpoint
ALTER TABLE "docs_versions" ALTER COLUMN "generation_state_prefix" SET NOT NULL;--> statement-breakpoint
UPDATE "generation_jobs"
SET
	"idempotency_key" = 'legacy:' || "id"::text,
	"concurrency_key" = 'publish:' || "project_id"::text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ALTER COLUMN "concurrency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ADD CONSTRAINT "docs_preview_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ADD CONSTRAINT "docs_preview_channels_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ADD CONSTRAINT "docs_preview_channels_current_version_id_docs_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ADD CONSTRAINT "doxabot_automation_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ADD CONSTRAINT "doxabot_automation_settings_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_change_proposals" ADD CONSTRAINT "scm_change_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_preview_channels_project_site_change_idx" ON "docs_preview_channels" USING btree ("project_id","site_id","provider","change_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_preview_channels_hostname_idx" ON "docs_preview_channels" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "docs_preview_channels_project_id_idx" ON "docs_preview_channels" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "doxabot_automation_settings_updated_by_user_id_idx" ON "doxabot_automation_settings" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scm_change_proposals_project_provider_external_idx" ON "scm_change_proposals" USING btree ("project_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "scm_change_proposals_repository_external_id_idx" ON "scm_change_proposals" USING btree ("repository_external_id");--> statement-breakpoint
CREATE INDEX "scm_change_proposals_project_id_idx" ON "scm_change_proposals" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scm_webhook_deliveries_provider_delivery_idx" ON "scm_webhook_deliveries" USING btree ("provider","delivery_id");--> statement-breakpoint
CREATE INDEX "scm_webhook_deliveries_repository_external_id_idx" ON "scm_webhook_deliveries" USING btree ("repository_external_id");--> statement-breakpoint
CREATE INDEX "scm_webhook_deliveries_status_idx" ON "scm_webhook_deliveries" USING btree ("status");--> statement-breakpoint
ALTER TABLE "docs_versions" ADD CONSTRAINT "docs_versions_baseline_version_id_docs_versions_id_fk" FOREIGN KEY ("baseline_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_change_proposal_id_scm_change_proposals_id_fk" FOREIGN KEY ("change_proposal_id") REFERENCES "public"."scm_change_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_baseline_version_id_docs_versions_id_fk" FOREIGN KEY ("baseline_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_superseded_by_job_id_generation_jobs_id_fk" FOREIGN KEY ("superseded_by_job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_idempotency_key_idx" ON "generation_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_active_concurrency_idx" ON "generation_jobs" USING btree ("concurrency_key") WHERE "generation_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "generation_jobs_change_proposal_id_idx" ON "generation_jobs" USING btree ("change_proposal_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_baseline_version_id_idx" ON "generation_jobs" USING btree ("baseline_version_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_superseded_by_job_id_idx" ON "generation_jobs" USING btree ("superseded_by_job_id");
