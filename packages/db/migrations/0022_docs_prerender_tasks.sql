CREATE TYPE "public"."docs_prerender_task_reason" AS ENUM('generation', 'promotion', 'editor_publication', 'starter_publication', 'hostname_activation', 'repair', 'reconciliation');--> statement-breakpoint
CREATE TYPE "public"."docs_prerender_task_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'obsolete');--> statement-breakpoint
CREATE TABLE "docs_prerender_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"published_version_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"trusted_request_origin" text NOT NULL,
	"artifact_prefix" text NOT NULL,
	"source_manifest_path" text NOT NULL,
	"source_artifact_version" text NOT NULL,
	"artifact_identity" text NOT NULL,
	"renderer_release_id" text NOT NULL,
	"render_context_id" text NOT NULL,
	"render_id" text NOT NULL,
	"reason" "docs_prerender_task_reason" NOT NULL,
	"status" "docs_prerender_task_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"lease_deadline" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"completed_routes" integer DEFAULT 0 NOT NULL,
	"total_routes" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docs_prerender_tasks" ADD CONSTRAINT "docs_prerender_tasks_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_prerender_tasks" ADD CONSTRAINT "docs_prerender_tasks_published_version_id_docs_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_prerender_tasks_logical_identity_idx" ON "docs_prerender_tasks" USING btree ("site_id","artifact_identity","renderer_release_id","render_context_id");--> statement-breakpoint
CREATE INDEX "docs_prerender_tasks_due_idx" ON "docs_prerender_tasks" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "docs_prerender_tasks_site_status_idx" ON "docs_prerender_tasks" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "docs_prerender_tasks_render_id_idx" ON "docs_prerender_tasks" USING btree ("render_id");--> statement-breakpoint
CREATE INDEX "docs_prerender_tasks_lease_deadline_idx" ON "docs_prerender_tasks" USING btree ("lease_deadline");