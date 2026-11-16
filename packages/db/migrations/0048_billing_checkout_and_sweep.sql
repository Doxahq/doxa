ALTER TABLE "billing_accounts" ADD COLUMN "open_checkout_id" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "open_checkout_price_key" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "open_checkout_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "payg_swept_window_start" timestamp with time zone;