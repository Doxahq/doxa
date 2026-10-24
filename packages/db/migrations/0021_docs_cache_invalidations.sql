CREATE TABLE "docs_cache_invalidations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"hostname" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"lease_until" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "docs_cache_invalidations_pending_idx" ON "docs_cache_invalidations" USING btree ("next_attempt_at") WHERE "docs_cache_invalidations"."completed_at" is null;