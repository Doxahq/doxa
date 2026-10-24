CREATE TYPE "public"."generation_control_status" AS ENUM('enabled', 'paused');--> statement-breakpoint
ALTER TYPE "public"."generation_job_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "platform_generation_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "generation_control_status" DEFAULT 'enabled' NOT NULL,
	"reason" text,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_generation_controls" ADD CONSTRAINT "platform_generation_controls_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;