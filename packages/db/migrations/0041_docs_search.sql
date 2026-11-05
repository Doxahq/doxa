CREATE TABLE "docs_search_indexes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text,
	"document_count" integer,
	"indexed_bytes" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_search_usage_daily" (
	"day" date NOT NULL,
	"site_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"outcome" text NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"response_bytes" bigint DEFAULT 0 NOT NULL,
	"elapsed_ms_total" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_search_usage_daily_day_site_id_provider_outcome_pk" PRIMARY KEY("day","site_id","provider","outcome")
);
--> statement-breakpoint
ALTER TABLE "docs_sites" ADD COLUMN "search_provider" text DEFAULT 'minisearch' NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_search_indexes" ADD CONSTRAINT "docs_search_indexes_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_search_indexes_site_version_idx" ON "docs_search_indexes" USING btree ("site_id","version_id");--> statement-breakpoint
CREATE INDEX "docs_search_indexes_due_idx" ON "docs_search_indexes" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "docs_search_usage_daily_site_idx" ON "docs_search_usage_daily" USING btree ("site_id","day");