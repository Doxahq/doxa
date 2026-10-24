--> The generation is the only source of spend attribution today. Give the usage
--> records their own copy, so cost analysis survives the deletion of a generation.
ALTER TABLE "generation_usage_records" ADD COLUMN "project_id" uuid;--> statement-breakpoint

--> Backfill from the generation while the foreign key still guarantees one exists.
UPDATE "generation_usage_records" AS u
SET "project_id" = j."project_id"
FROM "generation_jobs" AS j
WHERE u."job_id" = j."id"
  AND u."project_id" IS NULL;--> statement-breakpoint

--> The old foreign key on "job_id" was NOT NULL and pointed at a live
--> generation, and every generation carries a project. So the backfill above
--> reaches every row, and this check passes. It fails only when the schema has
--> drifted and that foreign key is gone. Stop there. Never remove a spend row
--> to make a migration pass, because this migration exists to preserve them.
DO $$
DECLARE unattributed bigint;
BEGIN
  SELECT count(*) INTO unattributed
  FROM "generation_usage_records"
  WHERE "project_id" IS NULL;

  IF unattributed > 0 THEN
    RAISE EXCEPTION
      'generation_usage_records has % rows with no generation to attribute them to. Resolve them by hand before you apply 0016.',
      unattributed;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "generation_usage_records" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_usage_records" ADD CONSTRAINT "generation_usage_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_usage_records_project_id_idx" ON "generation_usage_records" USING btree ("project_id");--> statement-breakpoint

--> Deleting a generation now clears the link and keeps the spend row.
ALTER TABLE "generation_usage_records" DROP CONSTRAINT "generation_usage_records_job_id_generation_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "generation_usage_records" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_usage_records" ADD CONSTRAINT "generation_usage_records_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;
