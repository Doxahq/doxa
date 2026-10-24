CREATE TABLE "generation_repair_diagnostics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diagnostic_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"stage_execution_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"page_title" text NOT NULL,
	"page_retry" integer NOT NULL,
	"writer_attempt" integer NOT NULL,
	"attempt" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"model" text NOT NULL,
	"rule" text NOT NULL,
	"message" text NOT NULL,
	"line" integer,
	"column" integer,
	"snippet" text,
	"draft_key" text NOT NULL,
	"draft_sha256" text NOT NULL,
	"draft_truncated" boolean NOT NULL,
	"repair_kind" text NOT NULL,
	"repair_succeeded" boolean NOT NULL,
	"rejection_reason" text,
	"validation_issue_codes" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"stage_execution_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"operation" text NOT NULL,
	"model_role" text NOT NULL,
	"model" text NOT NULL,
	"page_id" text,
	"page_title" text,
	"page_retry" integer,
	"attempt" integer,
	"iteration" integer NOT NULL,
	"provider_generation_id" text,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"cached_tokens" integer,
	"cache_write_tokens" integer,
	"reasoning_tokens" integer,
	"cost_usd" numeric(24, 12),
	"prompt_cost_usd" numeric(24, 12),
	"completion_cost_usd" numeric(24, 12),
	"upstream_cost_usd" numeric(24, 12),
	"duration_ms" integer,
	"finish_reason" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "planner_model" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "writer_model" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "planning_fingerprint" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "writing_fingerprint" text;--> statement-breakpoint
ALTER TABLE "generation_repair_diagnostics" ADD CONSTRAINT "generation_repair_diagnostics_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_usage_records" ADD CONSTRAINT "generation_usage_records_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_repair_diagnostics_diagnostic_id_idx" ON "generation_repair_diagnostics" USING btree ("diagnostic_id");--> statement-breakpoint
CREATE INDEX "generation_repair_diagnostics_job_id_idx" ON "generation_repair_diagnostics" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "generation_repair_diagnostics_expires_at_idx" ON "generation_repair_diagnostics" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_usage_records_call_id_idx" ON "generation_usage_records" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "generation_usage_records_job_id_idx" ON "generation_usage_records" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "generation_usage_records_expires_at_idx" ON "generation_usage_records" USING btree ("expires_at");
