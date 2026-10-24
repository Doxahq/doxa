CREATE TYPE "public"."email_delivery_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."email_notification_category" AS ENUM('approvals', 'generations', 'domains');--> statement-breakpoint
CREATE TYPE "public"."email_suppression_reason" AS ENUM('bounce', 'complaint', 'provider', 'manual');--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"props" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_email" text NOT NULL,
	"recipient_user_id" text,
	"dedupe_key" text NOT NULL,
	"status" "email_delivery_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"provider" text,
	"provider_message_id" text,
	"last_failure_kind" text,
	"last_failure_message" text,
	"last_provider_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "email_deliveries_attempts_positive" CHECK ("email_deliveries"."attempts" >= 0),
	CONSTRAINT "email_deliveries_failure_message_length" CHECK ("email_deliveries"."last_failure_message" IS NULL OR char_length("email_deliveries"."last_failure_message") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "email_preferences" (
	"user_id" text NOT NULL,
	"category" "email_notification_category" NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_preferences_user_id_category_pk" PRIMARY KEY("user_id","category")
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" "email_suppression_reason" NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "invited_email" text;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_preferences" ADD CONSTRAINT "email_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_dedupe_key_idx" ON "email_deliveries" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_deliveries_due_idx" ON "email_deliveries" USING btree ("status","next_attempt_at") WHERE "email_deliveries"."status" in ('queued', 'sending');--> statement-breakpoint
CREATE INDEX "email_deliveries_created_idx" ON "email_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "team_invites_team_emailed_created_idx" ON "team_invites" USING btree ("team_id","created_at") WHERE "team_invites"."invited_email" IS NOT NULL;