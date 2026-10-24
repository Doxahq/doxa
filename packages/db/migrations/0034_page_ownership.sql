CREATE TYPE "public"."docs_page_ownership_state" AS ENUM('owned', 'released');--> statement-breakpoint
CREATE TABLE "docs_page_ownership" (
	"site_id" uuid NOT NULL,
	"href" text NOT NULL,
	"state" "docs_page_ownership_state" NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_page_ownership_site_id_href_pk" PRIMARY KEY("site_id","href")
);
--> statement-breakpoint
ALTER TABLE "generation_reviews" ADD COLUMN "owned_page_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_page_ownership" ADD CONSTRAINT "docs_page_ownership_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_page_ownership" ADD CONSTRAINT "docs_page_ownership_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;