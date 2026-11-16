CREATE TYPE "public"."billing_offer_slot_state" AS ENUM('held', 'claimed', 'released');--> statement-breakpoint
CREATE TYPE "public"."billing_owner_kind" AS ENUM('user', 'team');--> statement-breakpoint
CREATE TYPE "public"."billing_provider_event_status" AS ENUM('received', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."billing_subscription_status" AS ENUM('trialing', 'active', 'past_due', 'incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused');--> statement-breakpoint
CREATE TYPE "public"."credit_grant_kind" AS ENUM('allowance', 'trial', 'promo', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."credit_ledger_entry_kind" AS ENUM('grant', 'debit', 'debt', 'debt_paid', 'release', 'expire', 'revoke', 'adjust', 'shortfall');--> statement-breakpoint
CREATE TYPE "public"."credit_reservation_status" AS ENUM('held', 'settled', 'released');--> statement-breakpoint
CREATE TYPE "public"."credit_stop_reason" AS ENUM('credits_exhausted', 'credit_cap');--> statement-breakpoint
CREATE TYPE "public"."payg_invoice_reason" AS ENUM('threshold', 'sweep', 'pay_now', 'renewal');--> statement-breakpoint
CREATE TYPE "public"."payg_invoice_status" AS ENUM('draft', 'open', 'paid', 'failed', 'void');--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_kind" "billing_owner_kind" NOT NULL,
	"owner_user_id" text,
	"owner_team_id" uuid,
	"name" text,
	"provider" text NOT NULL,
	"provider_customer_id" text,
	"plan_key" text NOT NULL,
	"state_version" bigint DEFAULT 1 NOT NULL,
	"flagged_at" timestamp with time zone,
	"payg_enabled" boolean DEFAULT false NOT NULL,
	"payg_monthly_limit_cents" integer NOT NULL,
	"ai_paused_reason" text,
	"action_caps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_owner_matches_kind" CHECK (("billing_accounts"."owner_kind" = 'user' AND "billing_accounts"."owner_team_id" IS NULL) OR ("billing_accounts"."owner_kind" = 'team' AND "billing_accounts"."owner_user_id" IS NULL)),
	CONSTRAINT "billing_accounts_state_version_positive" CHECK ("billing_accounts"."state_version" >= 0),
	CONSTRAINT "billing_accounts_payg_monthly_limit_positive" CHECK ("billing_accounts"."payg_monthly_limit_cents" > 0),
	CONSTRAINT "billing_accounts_ai_paused_reason_valid" CHECK ("billing_accounts"."ai_paused_reason" IS NULL OR "billing_accounts"."ai_paused_reason" IN ('payment_failed', 'dispute')),
	CONSTRAINT "billing_accounts_action_caps_object" CHECK (jsonb_typeof("billing_accounts"."action_caps") = 'object')
);
--> statement-breakpoint
CREATE TABLE "billing_offer_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_key" text NOT NULL,
	"account_id" uuid NOT NULL,
	"state" "billing_offer_slot_state" NOT NULL,
	"checkout_session_id" text,
	"held_until" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_offer_slots_held_has_until" CHECK ("billing_offer_slots"."state" <> 'held' OR "billing_offer_slots"."held_until" IS NOT NULL),
	CONSTRAINT "billing_offer_slots_claimed_has_at" CHECK ("billing_offer_slots"."state" <> 'claimed' OR "billing_offer_slots"."claimed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "billing_offers" (
	"offer_key" text PRIMARY KEY NOT NULL,
	"max_accounts" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_offers_max_accounts_positive" CHECK ("billing_offers"."max_accounts" IS NULL OR "billing_offers"."max_accounts" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_overrides_window_order" CHECK ("billing_overrides"."expires_at" IS NULL OR "billing_overrides"."starts_at" IS NULL OR "billing_overrides"."expires_at" > "billing_overrides"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "billing_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "billing_provider_event_status" DEFAULT 'received' NOT NULL,
	"error" text,
	CONSTRAINT "billing_provider_events_error_length" CHECK ("billing_provider_events"."error" IS NULL OR char_length("billing_provider_events"."error") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"price_key" text NOT NULL,
	"plan_key" text,
	"status" "billing_subscription_status" NOT NULL,
	"billing_anchor" timestamp with time zone NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"trial_end" timestamp with time zone,
	"past_due_since" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_period_order" CHECK ("billing_subscriptions"."current_period_end" >= "billing_subscriptions"."current_period_start")
);
--> statement-breakpoint
CREATE TABLE "billing_sync_state" (
	"provider" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_counters" (
	"account_id" uuid NOT NULL,
	"meter_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "billing_usage_counters_account_id_meter_key_window_start_pk" PRIMARY KEY("account_id","meter_key","window_start"),
	CONSTRAINT "billing_usage_counters_count_positive" CHECK ("billing_usage_counters"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_accruals" (
	"call_id" text PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"cost_usd" numeric(24, 12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_accruals_cost_positive" CHECK ("credit_accruals"."cost_usd" IS NULL OR "credit_accruals"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "credit_grant_kind" NOT NULL,
	"amount" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"source_ref" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_remaining_in_range" CHECK ("credit_grants"."remaining" >= 0 AND "credit_grants"."remaining" <= "credit_grants"."amount"),
	CONSTRAINT "credit_grants_window_order" CHECK ("credit_grants"."expires_at" IS NULL OR "credit_grants"."expires_at" > "credit_grants"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "credit_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "credit_ledger_entries_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" uuid NOT NULL,
	"kind" "credit_ledger_entry_kind" NOT NULL,
	"credits" bigint NOT NULL,
	"grant_id" uuid,
	"reservation_id" uuid,
	"action_key" text,
	"subject_kind" text,
	"subject_id" text,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"project_id" uuid,
	"amount" bigint NOT NULL,
	"base_credits" bigint NOT NULL,
	"cap_credits" bigint NOT NULL,
	"consumed_cost_usd" numeric(24, 12) DEFAULT '0' NOT NULL,
	"markup_hundredths" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"in_flight_margin_credits" bigint NOT NULL,
	"stop_reason" "credit_stop_reason",
	"status" "credit_reservation_status" DEFAULT 'held' NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_amount" bigint,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_reservations_amounts_valid" CHECK ("credit_reservations"."base_credits" >= 0 AND "credit_reservations"."cap_credits" >= 0 AND "credit_reservations"."amount" >= 0 AND "credit_reservations"."amount" <= "credit_reservations"."cap_credits" AND "credit_reservations"."in_flight_margin_credits" >= 0),
	CONSTRAINT "credit_reservations_cost_positive" CHECK ("credit_reservations"."consumed_cost_usd" >= 0),
	CONSTRAINT "credit_reservations_markup_positive" CHECK ("credit_reservations"."markup_hundredths" > 0),
	CONSTRAINT "credit_reservations_unit_price_positive" CHECK ("credit_reservations"."unit_price_cents" >= 0),
	CONSTRAINT "credit_reservations_settled_amount_valid" CHECK ("credit_reservations"."settled_amount" IS NULL OR "credit_reservations"."settled_amount" >= 0),
	CONSTRAINT "credit_reservations_settled_has_amount" CHECK ("credit_reservations"."status" <> 'settled' OR "credit_reservations"."settled_amount" IS NOT NULL),
	CONSTRAINT "credit_reservations_closed_together" CHECK (("credit_reservations"."status" = 'held') = ("credit_reservations"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "payg_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"credits" bigint NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "payg_invoice_status" NOT NULL,
	"reason" "payg_invoice_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "payg_invoices_credits_positive" CHECK ("payg_invoices"."credits" >= 0),
	CONSTRAINT "payg_invoices_amount_positive" CHECK ("payg_invoices"."amount_cents" >= 0),
	CONSTRAINT "payg_invoices_paid_has_at" CHECK ("payg_invoices"."status" <> 'paid' OR "payg_invoices"."paid_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "payg_usage_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"credits" bigint NOT NULL,
	"reported_at" timestamp with time zone,
	"provider_event_ok" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payg_usage_reports_credits_positive" CHECK ("payg_usage_reports"."credits" > 0),
	CONSTRAINT "payg_usage_reports_attempts_positive" CHECK ("payg_usage_reports"."attempts" >= 0),
	CONSTRAINT "payg_usage_reports_ok_has_reported_at" CHECK ("payg_usage_reports"."provider_event_ok" = false OR "payg_usage_reports"."reported_at" IS NOT NULL),
	CONSTRAINT "payg_usage_reports_error_length" CHECK ("payg_usage_reports"."last_error" IS NULL OR char_length("payg_usage_reports"."last_error") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_owner_team_id_teams_id_fk" FOREIGN KEY ("owner_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_offer_slots" ADD CONSTRAINT "billing_offer_slots_offer_key_billing_offers_offer_key_fk" FOREIGN KEY ("offer_key") REFERENCES "public"."billing_offers"("offer_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_offer_slots" ADD CONSTRAINT "billing_offer_slots_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_overrides" ADD CONSTRAINT "billing_overrides_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_counters" ADD CONSTRAINT "billing_usage_counters_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_accruals" ADD CONSTRAINT "credit_accruals_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payg_invoices" ADD CONSTRAINT "payg_invoices_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payg_usage_reports" ADD CONSTRAINT "payg_usage_reports_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_owner_user_idx" ON "billing_accounts" USING btree ("owner_user_id") WHERE "billing_accounts"."owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_owner_team_idx" ON "billing_accounts" USING btree ("owner_team_id") WHERE "billing_accounts"."owner_team_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_provider_customer_idx" ON "billing_accounts" USING btree ("provider","provider_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_offer_slots_offer_account_idx" ON "billing_offer_slots" USING btree ("offer_key","account_id");--> statement-breakpoint
CREATE INDEX "billing_offer_slots_offer_state_idx" ON "billing_offer_slots" USING btree ("offer_key","state");--> statement-breakpoint
CREATE INDEX "billing_offer_slots_checkout_session_idx" ON "billing_offer_slots" USING btree ("checkout_session_id") WHERE "billing_offer_slots"."checkout_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "billing_offer_slots_held_until_idx" ON "billing_offer_slots" USING btree ("held_until") WHERE "billing_offer_slots"."state" = 'held';--> statement-breakpoint
CREATE INDEX "billing_overrides_account_key_idx" ON "billing_overrides" USING btree ("account_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_events_provider_event_idx" ON "billing_provider_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "billing_provider_events_received_idx" ON "billing_provider_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_provider_subscription_idx" ON "billing_subscriptions" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_account_idx" ON "billing_subscriptions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_status_idx" ON "billing_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_usage_counters_window_start_idx" ON "billing_usage_counters" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "credit_accruals_reservation_idx" ON "credit_accruals" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "credit_accruals_created_idx" ON "credit_accruals" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_account_source_ref_idx" ON "credit_grants" USING btree ("account_id","source_ref");--> statement-breakpoint
CREATE INDEX "credit_grants_account_expires_idx" ON "credit_grants" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_entries_idempotency_key_idx" ON "credit_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_entries_account_created_idx" ON "credit_ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_entries_account_sequence_idx" ON "credit_ledger_entries" USING btree ("account_id","sequence");--> statement-breakpoint
CREATE INDEX "credit_ledger_entries_grant_idx" ON "credit_ledger_entries" USING btree ("grant_id") WHERE "credit_ledger_entries"."grant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_ledger_entries_reservation_idx" ON "credit_ledger_entries" USING btree ("reservation_id") WHERE "credit_ledger_entries"."reservation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_idempotency_key_idx" ON "credit_reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_reservations_account_held_idx" ON "credit_reservations" USING btree ("account_id") WHERE "credit_reservations"."status" = 'held';--> statement-breakpoint
CREATE INDEX "credit_reservations_held_expires_idx" ON "credit_reservations" USING btree ("expires_at") WHERE "credit_reservations"."status" = 'held';--> statement-breakpoint
CREATE INDEX "credit_reservations_subject_idx" ON "credit_reservations" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "credit_reservations_project_action_idx" ON "credit_reservations" USING btree ("project_id","action_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payg_invoices_provider_invoice_idx" ON "payg_invoices" USING btree ("provider_invoice_id");--> statement-breakpoint
CREATE INDEX "payg_invoices_account_created_idx" ON "payg_invoices" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payg_usage_reports_identifier_idx" ON "payg_usage_reports" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "payg_usage_reports_pending_idx" ON "payg_usage_reports" USING btree ("created_at") WHERE "payg_usage_reports"."provider_event_ok" = false;--> statement-breakpoint
CREATE INDEX "payg_usage_reports_account_created_idx" ON "payg_usage_reports" USING btree ("account_id","created_at");