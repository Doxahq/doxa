CREATE TYPE "public"."docs_version_status" AS ENUM('staged', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."generation_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now(),
	"updatedAt" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "docs_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"published_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "docs_version_status" DEFAULT 'staged' NOT NULL,
	"artifact_prefix" text NOT NULL,
	"manifest_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"status" "generation_job_status" DEFAULT 'queued' NOT NULL,
	"docs_version_id" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"permissions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"github_repo_id" text NOT NULL,
	"full_name" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"github_repository_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_sites" ADD CONSTRAINT "docs_sites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_versions" ADD CONSTRAINT "docs_versions_site_id_docs_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."docs_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_docs_version_id_docs_versions_id_fk" FOREIGN KEY ("docs_version_id") REFERENCES "public"."docs_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_github_repository_id_github_repositories_id_fk" FOREIGN KEY ("github_repository_id") REFERENCES "public"."github_repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_sites_project_id_idx" ON "docs_sites" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_sites_slug_idx" ON "docs_sites" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_versions_site_version_idx" ON "docs_versions" USING btree ("site_id","version_number");--> statement-breakpoint
CREATE INDEX "docs_versions_site_id_idx" ON "docs_versions" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_project_id_idx" ON "generation_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_requested_by_user_id_idx" ON "generation_jobs" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_id_idx" ON "github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_installations_user_id_idx" ON "github_installations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_github_repo_id_idx" ON "github_repositories" USING btree ("github_repo_id");--> statement-breakpoint
CREATE INDEX "github_repositories_installation_id_idx" ON "github_repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "job_events_job_id_idx" ON "job_events" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_idx" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" USING btree ("user_id");