CREATE TABLE "billing_export_claims" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"last_export_at" timestamp with time zone,
	"previous_export_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_export_claims" ADD CONSTRAINT "billing_export_claims_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;