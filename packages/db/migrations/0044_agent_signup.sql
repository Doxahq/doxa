CREATE TYPE "public"."agent_claim_status" AS ENUM('pending', 'approved', 'denied', 'locked', 'redeemed');--> statement-breakpoint
CREATE TABLE "agent_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_token_hash" text NOT NULL,
	"attempt_token_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"client_name" text NOT NULL,
	"token_name" text NOT NULL,
	"login_hint" text,
	"client_ip_key" text,
	"requested_scopes" text[] NOT NULL,
	"status" "agent_claim_status" DEFAULT 'pending' NOT NULL,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"approved_user_id" text,
	"approved_scopes" text[],
	"approved_project_scope" jsonb,
	"opened_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_claims_claim_token_hash_unique" UNIQUE("claim_token_hash"),
	CONSTRAINT "agent_claims_attempt_token_hash_unique" UNIQUE("attempt_token_hash")
);
--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_name" text NOT NULL,
	"client_name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"project_scope" jsonb NOT NULL,
	"grant_ref" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_claims" ADD CONSTRAINT "agent_claims_approved_user_id_user_id_fk" FOREIGN KEY ("approved_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_claims_expires_idx" ON "agent_claims" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_claims_login_hint_created_idx" ON "agent_claims" USING btree ("login_hint","created_at");--> statement-breakpoint
CREATE INDEX "agent_claims_client_ip_created_idx" ON "agent_claims" USING btree ("client_ip_key","created_at");--> statement-breakpoint
CREATE INDEX "agent_tokens_user_created_idx" ON "agent_tokens" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tokens_expires_idx" ON "agent_tokens" USING btree ("expires_at");