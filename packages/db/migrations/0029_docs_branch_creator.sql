ALTER TABLE "docs_branches" ADD COLUMN "created_by_client_id" text;--> statement-breakpoint
ALTER TABLE "docs_branches" ADD COLUMN "created_by_client_name" text;--> statement-breakpoint
ALTER TABLE "docs_branches" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "docs_branches" ADD CONSTRAINT "docs_branches_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_branches" ADD CONSTRAINT "docs_branches_creator_client_complete" CHECK (("docs_branches"."created_by_client_id" IS NULL) = ("docs_branches"."created_by_client_name" IS NULL));--> statement-breakpoint
ALTER TABLE "docs_branches" ADD CONSTRAINT "docs_branches_creator_user_has_client" CHECK ("docs_branches"."created_by_user_id" IS NULL OR "docs_branches"."created_by_client_id" IS NOT NULL);