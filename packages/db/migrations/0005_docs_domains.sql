CREATE TYPE "public"."docs_domain_kind" AS ENUM('doxa_subdomain', 'custom_domain');--> statement-breakpoint
CREATE TYPE "public"."docs_domain_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."docs_domain_verification_status" AS ENUM('pending', 'verified', 'failed');--> statement-breakpoint
CREATE TABLE "docs_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"kind" "docs_domain_kind" NOT NULL,
	"status" "docs_domain_status" DEFAULT 'active' NOT NULL,
	"verification_status" "docs_domain_verification_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docs_domains" ADD CONSTRAINT "docs_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD CONSTRAINT "docs_domains_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_domains_hostname_idx" ON "docs_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "docs_domains_project_id_idx" ON "docs_domains" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "docs_domains_site_id_idx" ON "docs_domains" USING btree ("site_id");