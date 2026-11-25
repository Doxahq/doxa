CREATE TABLE "github_installation_installers" (
	"installation_id" text PRIMARY KEY NOT NULL,
	"installer_github_user_id" text NOT NULL,
	"installer_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ALTER COLUMN "merge_trigger" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ADD COLUMN "allowed_bot_logins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "doxabot_automation_settings" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD COLUMN "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD COLUMN "disconnected_reason" text;--> statement-breakpoint
CREATE INDEX "scm_webhook_deliveries_status_created_at_idx" ON "scm_webhook_deliveries" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_status" CHECK ("github_installations"."status" IN ('active', 'suspended', 'deleted'));--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_disconnected_reason" CHECK (("github_repositories"."disconnected_at" IS NULL AND "github_repositories"."disconnected_reason" IS NULL) OR ("github_repositories"."disconnected_at" IS NOT NULL AND "github_repositories"."disconnected_reason" IN ('removed', 'deleted')));