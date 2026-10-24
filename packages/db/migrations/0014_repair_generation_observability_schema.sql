ALTER TABLE "generation_repair_diagnostics"
	ADD COLUMN IF NOT EXISTS "writer_attempt" integer,
	ADD COLUMN IF NOT EXISTS "max_attempts" integer,
	ADD COLUMN IF NOT EXISTS "rejection_reason" text,
	ADD COLUMN IF NOT EXISTS "validation_issue_codes" jsonb;
--> statement-breakpoint
UPDATE "generation_repair_diagnostics"
SET
	"writer_attempt" = COALESCE("writer_attempt", "attempt", 1),
	"max_attempts" = COALESCE(
		"max_attempts",
		GREATEST(COALESCE("attempt", 1), 1)
	),
	"repair_succeeded" = COALESCE("repair_succeeded", false),
	"validation_issue_codes" = COALESCE("validation_issue_codes", '[]'::jsonb)
WHERE
	"writer_attempt" IS NULL
	OR "max_attempts" IS NULL
	OR "repair_succeeded" IS NULL
	OR "validation_issue_codes" IS NULL;
--> statement-breakpoint
ALTER TABLE "generation_repair_diagnostics"
	ALTER COLUMN "writer_attempt" SET NOT NULL,
	ALTER COLUMN "max_attempts" SET NOT NULL,
	ALTER COLUMN "repair_succeeded" SET NOT NULL,
	ALTER COLUMN "validation_issue_codes" SET NOT NULL;
