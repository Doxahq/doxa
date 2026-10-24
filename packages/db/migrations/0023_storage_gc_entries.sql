CREATE TYPE "public"."storage_gc_status" AS ENUM('pending', 'running', 'collected', 'retained', 'failed');--> statement-breakpoint
CREATE TABLE "storage_gc_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text NOT NULL,
	"resource_key" text NOT NULL,
	"resource" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" "storage_gc_status" DEFAULT 'pending' NOT NULL,
	"eligible_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"lease_deadline" timestamp with time zone,
	"deleted_objects" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"retained_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storage_gc_entries_resource_idx" ON "storage_gc_entries" USING btree ("target","resource_key");--> statement-breakpoint
CREATE INDEX "storage_gc_entries_due_idx" ON "storage_gc_entries" USING btree ("status","eligible_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "storage_gc_entries_lease_deadline_idx" ON "storage_gc_entries" USING btree ("lease_deadline");