CREATE TABLE "project_instruction_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"screening" jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_instruction_versions_version_positive" CHECK ("project_instruction_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "project_instruction_versions" ADD CONSTRAINT "project_instruction_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_instruction_versions" ADD CONSTRAINT "project_instruction_versions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_instruction_versions_project_version_idx" ON "project_instruction_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "project_instruction_versions_created_by_user_id_idx" ON "project_instruction_versions" USING btree ("created_by_user_id");