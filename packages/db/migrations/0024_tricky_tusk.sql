CREATE TYPE "public"."docs_branch_change_kind" AS ENUM('upsert', 'delete');--> statement-breakpoint
CREATE TYPE "public"."docs_branch_kind" AS ENUM('named', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."docs_preview_channel_kind" AS ENUM('source_change', 'branch');--> statement-breakpoint
CREATE TYPE "public"."docs_publication_kind" AS ENUM('import', 'generation', 'starter', 'editor', 'promotion', 'restore');--> statement-breakpoint
CREATE TABLE "docs_branch_changes" (
	"branch_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" "docs_branch_change_kind" NOT NULL,
	"content" text,
	"content_sha256" text,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"origin" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_branch_changes_branch_id_path_pk" PRIMARY KEY("branch_id","path"),
	CONSTRAINT "docs_branch_changes_content_matches_kind" CHECK (("docs_branch_changes"."kind" = 'upsert' AND "docs_branch_changes"."content" IS NOT NULL AND "docs_branch_changes"."content_sha256" IS NOT NULL)
       OR ("docs_branch_changes"."kind" = 'delete' AND "docs_branch_changes"."content" IS NULL AND "docs_branch_changes"."content_sha256" IS NULL)),
	CONSTRAINT "docs_branch_changes_byte_size_nonnegative" CHECK ("docs_branch_changes"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "docs_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" "docs_branch_kind" NOT NULL,
	"name" text,
	"owner_user_id" text NOT NULL,
	"base_version_id" uuid NOT NULL,
	"created_from_branch_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"preview_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_branches_name_matches_kind" CHECK (("docs_branches"."kind" = 'named' AND "docs_branches"."name" IS NOT NULL)
       OR ("docs_branches"."kind" = 'hidden' AND "docs_branches"."name" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "docs_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"previous_version_id" uuid,
	"kind" "docs_publication_kind" NOT NULL,
	"actor_user_id" text,
	"branch_name" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ALTER COLUMN "change_external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ADD COLUMN "kind" "docs_preview_channel_kind" DEFAULT 'source_change' NOT NULL;--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "docs_branch_changes" ADD CONSTRAINT "docs_branch_changes_branch_id_docs_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."docs_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_branch_changes" ADD CONSTRAINT "docs_branch_changes_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_branches" ADD CONSTRAINT "docs_branches_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_branches" ADD CONSTRAINT "docs_branches_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_branches" ADD CONSTRAINT "docs_branches_base_version_id_docs_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_branches" ADD CONSTRAINT "docs_branches_created_from_branch_id_docs_branches_id_fk" FOREIGN KEY ("created_from_branch_id") REFERENCES "public"."docs_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_publications" ADD CONSTRAINT "docs_publications_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_publications" ADD CONSTRAINT "docs_publications_version_id_docs_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."docs_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_publications" ADD CONSTRAINT "docs_publications_previous_version_id_docs_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_publications" ADD CONSTRAINT "docs_publications_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_branches_site_name_idx" ON "docs_branches" USING btree ("site_id","name") WHERE "docs_branches"."kind" = 'named';--> statement-breakpoint
CREATE UNIQUE INDEX "docs_branches_site_hidden_owner_idx" ON "docs_branches" USING btree ("site_id","owner_user_id") WHERE "docs_branches"."kind" = 'hidden';--> statement-breakpoint
CREATE INDEX "docs_branches_site_id_idx" ON "docs_branches" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "docs_publications_site_created_idx" ON "docs_publications" USING btree ("site_id","created_at");--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ADD CONSTRAINT "docs_preview_channels_branch_id_docs_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."docs_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_preview_channels_branch_id_idx" ON "docs_preview_channels" USING btree ("branch_id");--> statement-breakpoint
ALTER TABLE "docs_preview_channels" ADD CONSTRAINT "docs_preview_channels_kind_fields" CHECK (("docs_preview_channels"."kind" = 'source_change' AND "docs_preview_channels"."provider" IS NOT NULL AND "docs_preview_channels"."change_external_id" IS NOT NULL AND "docs_preview_channels"."branch_id" IS NULL)
       OR ("docs_preview_channels"."kind" = 'branch' AND "docs_preview_channels"."branch_id" IS NOT NULL AND "docs_preview_channels"."provider" IS NULL AND "docs_preview_channels"."change_external_id" IS NULL));--> statement-breakpoint
INSERT INTO "docs_publications" ("site_id", "version_id", "previous_version_id", "kind", "summary")
SELECT "id", "published_version_id", NULL, 'import', '{}'::jsonb
FROM "docs_sites"
WHERE "published_version_id" IS NOT NULL;
