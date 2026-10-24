CREATE TYPE "public"."agent_action_policy_scope" AS ENUM('project', 'user');--> statement-breakpoint
CREATE TYPE "public"."agent_approval_mode" AS ENUM('allow', 'require_approval', 'deny');--> statement-breakpoint
CREATE TABLE "agent_action_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_kind" "agent_action_policy_scope" NOT NULL,
	"project_id" uuid,
	"user_id" text,
	"action_kind" text NOT NULL,
	"mode" "agent_approval_mode" NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_action_policies_scope_target" CHECK (("agent_action_policies"."scope_kind" = 'project' AND "agent_action_policies"."project_id" IS NOT NULL AND "agent_action_policies"."user_id" IS NULL) OR ("agent_action_policies"."scope_kind" = 'user' AND "agent_action_policies"."user_id" IS NOT NULL AND "agent_action_policies"."project_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_activity" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "erase_branch_after_publish" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_action_policies" ADD CONSTRAINT "agent_action_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_policies" ADD CONSTRAINT "agent_action_policies_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_policies" ADD CONSTRAINT "agent_action_policies_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_action_policies_project_action_idx" ON "agent_action_policies" USING btree ("project_id","action_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_action_policies_user_action_idx" ON "agent_action_policies" USING btree ("user_id","action_kind");