CREATE TABLE "agent_live_events" (
	"project_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"branch_id" uuid,
	"user_id" text NOT NULL,
	"grant_ref" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"tool" text NOT NULL,
	"kind" text NOT NULL,
	"page_href" text,
	"page_title" text,
	"detail" text,
	"note" text,
	"lines_added" integer,
	"lines_removed" integer,
	"branch_revision" integer,
	"diff" text,
	CONSTRAINT "agent_live_events_project_id_seq_pk" PRIMARY KEY("project_id","seq")
);
--> statement-breakpoint
ALTER TABLE "agent_live_events" ADD CONSTRAINT "agent_live_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_live_events" ADD CONSTRAINT "agent_live_events_branch_id_docs_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."docs_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_live_events" ADD CONSTRAINT "agent_live_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_live_events_occurred_idx" ON "agent_live_events" USING btree ("occurred_at");