CREATE TYPE "public"."docs_branch_purpose" AS ENUM('user', 'generation_review', 'generation_backup');--> statement-breakpoint
CREATE TYPE "public"."generation_review_page_change" AS ENUM('added', 'modified', 'removed');--> statement-breakpoint
CREATE TYPE "public"."generation_review_page_decision" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."generation_review_status" AS ENUM('open', 'published', 'discarded');--> statement-breakpoint
CREATE TABLE "generation_review_pages" (
	"review_id" uuid NOT NULL,
	"href" text NOT NULL,
	"title" text NOT NULL,
	"change" "generation_review_page_change" NOT NULL,
	"decision" "generation_review_page_decision" NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "generation_review_pages_review_id_href_pk" PRIMARY KEY("review_id","href")
);
--> statement-breakpoint
CREATE TABLE "generation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"branch_id" uuid,
	"job_id" uuid NOT NULL,
	"generated_version_id" uuid NOT NULL,
	"status" "generation_review_status" DEFAULT 'open' NOT NULL,
	"creates_backup" boolean DEFAULT false NOT NULL,
	"backup_branch_id" uuid,
	"published_version_id" uuid,
	"closed_by_user_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_reviews_closed_matches_status" CHECK (("generation_reviews"."status" = 'open') = ("generation_reviews"."closed_at" IS NULL)),
	CONSTRAINT "generation_reviews_published_has_version" CHECK (("generation_reviews"."status" = 'published') = ("generation_reviews"."published_version_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "docs_branches" ADD COLUMN "purpose" "docs_branch_purpose" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_review_pages" ADD CONSTRAINT "generation_review_pages_review_id_generation_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."generation_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_review_pages" ADD CONSTRAINT "generation_review_pages_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_reviews" ADD CONSTRAINT "generation_reviews_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_reviews" ADD CONSTRAINT "generation_reviews_branch_id_docs_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."docs_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_reviews" ADD CONSTRAINT "generation_reviews_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_reviews" ADD CONSTRAINT "generation_reviews_generated_version_id_docs_versions_id_fk" FOREIGN KEY ("generated_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_reviews" ADD CONSTRAINT "generation_reviews_backup_branch_id_docs_branches_id_fk" FOREIGN KEY ("backup_branch_id") REFERENCES "public"."docs_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_reviews" ADD CONSTRAINT "generation_reviews_published_version_id_docs_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_reviews" ADD CONSTRAINT "generation_reviews_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_reviews_site_open_idx" ON "generation_reviews" USING btree ("site_id") WHERE "generation_reviews"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "generation_reviews_job_idx" ON "generation_reviews" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "generation_reviews_site_created_idx" ON "generation_reviews" USING btree ("site_id","created_at");