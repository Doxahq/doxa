CREATE TYPE "public"."agent_activity_outcome" AS ENUM('succeeded', 'failed', 'approval_required', 'denied', 'rate_limited');--> statement-breakpoint
CREATE TABLE "agent_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"grant_ref" text NOT NULL,
	"project_id" uuid,
	"tool" text NOT NULL,
	"action_kind" text,
	"approval_request_id" uuid,
	"outcome" "agent_activity_outcome" NOT NULL,
	"error_code" text,
	"policy_source" text,
	"duration_ms" integer NOT NULL,
	"input_sha256" text
);
--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_activity_project_occurred_idx" ON "agent_activity" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_activity_user_occurred_idx" ON "agent_activity" USING btree ("user_id","occurred_at");