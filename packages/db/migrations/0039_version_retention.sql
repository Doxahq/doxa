ALTER TABLE "docs_versions" ADD COLUMN "preview_replaced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "docs_versions" ADD COLUMN "artifacts_collected_at" timestamp with time zone;--> statement-breakpoint
-- A preview that no channel serves now was replaced before this column
-- existed. Its promote window starts now.
UPDATE "docs_versions" AS v
SET "preview_replaced_at" = now()
WHERE v."channel" = 'preview'
  AND NOT EXISTS (
    SELECT 1 FROM "docs_preview_channels" AS c
    WHERE c."current_version_id" = v."id"
  );--> statement-breakpoint
-- Queue every production version that production no longer serves, and every
-- generation preview that no channel serves, for the docs_retired_version
-- collector. The collector applies the retention policy when it inspects an
-- entry, so a version that the policy keeps only returns to the work list.
INSERT INTO "storage_gc_entries" ("target", "resource_key", "resource", "reason", "eligible_at", "next_attempt_at")
SELECT
  'docs_retired_version',
  v."site_id"::text || '/' || v."id"::text,
  jsonb_build_object('siteId', v."site_id"::text, 'versionId', v."id"::text),
  'retention_backfill',
  now() + interval '1 hour',
  now() + interval '1 hour'
FROM "docs_versions" AS v
INNER JOIN "docs_sites" AS s ON s."id" = v."site_id"
WHERE v."id" IS DISTINCT FROM s."published_version_id"
  AND (
    v."channel" = 'production'
    OR (
      v."preview_replaced_at" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "generation_jobs" AS j
        WHERE j."docs_version_id" = v."id"
      )
    )
  )
ON CONFLICT ("target", "resource_key") DO NOTHING;
