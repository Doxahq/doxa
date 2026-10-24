ALTER TYPE "public"."docs_prerender_task_reason" ADD VALUE 'restore' BEFORE 'editor_publication';--> statement-breakpoint
DROP INDEX "docs_versions_site_version_idx";--> statement-breakpoint
-- Hand-written: previews move to their own sequence, 1, 2, 3 per site, in
-- creation order. Production numbers stay as they are, so no published
-- version changes its number. This runs before the preview index exists.
UPDATE "docs_versions" AS v
SET "version_number" = numbered."preview_number"
FROM (
  SELECT "id",
    row_number() OVER (
      PARTITION BY "site_id"
      ORDER BY "created_at", "version_number", "id"
    ) AS "preview_number"
  FROM "docs_versions"
  WHERE "channel" = 'preview'
) AS numbered
WHERE v."id" = numbered."id";--> statement-breakpoint
CREATE UNIQUE INDEX "docs_versions_site_production_number_idx" ON "docs_versions" USING btree ("site_id","version_number") WHERE "docs_versions"."channel" = 'production';--> statement-breakpoint
CREATE UNIQUE INDEX "docs_versions_site_preview_number_idx" ON "docs_versions" USING btree ("site_id","version_number") WHERE "docs_versions"."channel" = 'preview';--> statement-breakpoint
ALTER TABLE "docs_versions" ADD CONSTRAINT "docs_versions_number_positive" CHECK ("docs_versions"."version_number" > 0);