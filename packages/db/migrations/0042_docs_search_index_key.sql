ALTER TABLE "docs_search_indexes" ADD COLUMN "index_key" text;--> statement-breakpoint
ALTER TABLE "docs_sites" ADD COLUMN "search_index_key" text;--> statement-breakpoint
ALTER TABLE "docs_sites" ADD COLUMN "search_index_stale_since" timestamp with time zone;