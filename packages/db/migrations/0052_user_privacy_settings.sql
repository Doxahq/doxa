CREATE TABLE "user_privacy_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"product_analytics" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_privacy_settings" ADD CONSTRAINT "user_privacy_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;