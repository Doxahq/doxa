CREATE TYPE "public"."docs_domain_routing_status" AS ENUM('pending', 'healthy', 'failed');--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "routing_status" "docs_domain_routing_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "routing_http_status" integer;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "routing_error" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "routing_checked_at" timestamp with time zone;