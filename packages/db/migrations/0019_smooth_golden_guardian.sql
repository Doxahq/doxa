ALTER TABLE "docs_sites" ALTER COLUMN "preview_visibility" SET DEFAULT 'public';--> statement-breakpoint
UPDATE "docs_sites" SET "preview_visibility" = 'public';
