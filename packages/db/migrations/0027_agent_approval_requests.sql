CREATE TYPE "public"."agent_approval_request_status" AS ENUM('pending', 'executing', 'completed', 'failed', 'rejected', 'cancelled', 'expired', 'stale');--> statement-breakpoint
CREATE TABLE "agent_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"action_kind" text NOT NULL,
	"target_key" text NOT NULL,
	"status" "agent_approval_request_status" NOT NULL,
	"payload_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"summary" text,
	"result" jsonb,
	"error" jsonb,
	"requested_by_user_id" text NOT NULL,
	"requested_by_client_id" text NOT NULL,
	"requested_by_client_name" text NOT NULL,
	"grant_ref" text NOT NULL,
	"decided_by_user_id" text,
	"decision_note" text,
	"policy_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_approval_requests_summary_length" CHECK (char_length("agent_approval_requests"."summary") <= 500),
	CONSTRAINT "agent_approval_requests_decision_note_length" CHECK (char_length("agent_approval_requests"."decision_note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "docs_publications" ADD COLUMN "agent_client_id" text;--> statement-breakpoint
ALTER TABLE "docs_publications" ADD COLUMN "agent_client_name" text;--> statement-breakpoint
ALTER TABLE "docs_publications" ADD COLUMN "approval_request_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_requests_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_approval_requests_project_status_created_idx" ON "agent_approval_requests" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_approval_requests_requester_created_idx" ON "agent_approval_requests" USING btree ("requested_by_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approval_requests_pending_target_idx" ON "agent_approval_requests" USING btree ("project_id","action_kind","target_key") WHERE "agent_approval_requests"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_approval_request_id_agent_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."agent_approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_publications" ADD CONSTRAINT "docs_publications_approval_request_id_agent_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."agent_approval_requests"("id") ON DELETE set null ON UPDATE no action;