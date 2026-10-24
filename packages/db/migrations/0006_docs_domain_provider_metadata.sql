ALTER TABLE "docs_domains" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "provider_hostname_id" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "provider_ssl_status" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "ownership_verification_type" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "ownership_verification_name" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "ownership_verification_value" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "ownership_verification_http_url" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "ownership_verification_http_body" text;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "ssl_validation_records" jsonb;--> statement-breakpoint
ALTER TABLE "docs_domains" ADD COLUMN "verification_error" text;