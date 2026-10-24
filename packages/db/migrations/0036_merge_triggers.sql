CREATE TYPE "public"."doxabot_merge_trigger" AS ENUM('manual', 'batched', 'every_merge');--> statement-breakpoint
ALTER TYPE "public"."generation_job_trigger" ADD VALUE 'merge';--> statement-breakpoint
CREATE TABLE "generation_pending_merges" (
	"project_id" uuid NOT NULL,
	"change_external_id" text NOT NULL,
	"change_number" integer NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone,
	CONSTRAINT "generation_pending_merges_project_id_change_external_id_pk" PRIMARY KEY("project_id","change_external_id")
);
--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ADD COLUMN "merge_trigger" "doxabot_merge_trigger" DEFAULT 'batched' NOT NULL;--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ADD COLUMN "batch_quiet_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_pending_merges" ADD CONSTRAINT "generation_pending_merges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_pending_merges_due_idx" ON "generation_pending_merges" USING btree ("attempted_at","merged_at");--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ADD CONSTRAINT "doxabot_automation_settings_batch_quiet_minutes" CHECK ("doxabot_automation_settings"."batch_quiet_minutes" IN (15, 30, 60, 360));