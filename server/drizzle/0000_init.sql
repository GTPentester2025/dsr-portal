CREATE TABLE "assignment_config" (
	"zone_id" text PRIMARY KEY NOT NULL,
	"strategy" text DEFAULT 'round_robin' NOT NULL,
	"escalation_email" text,
	"escalation_after_hours" integer DEFAULT 48 NOT NULL,
	"rr_cursor" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"zone_id" text,
	"before" jsonb,
	"after" jsonb,
	"source_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"value_json" jsonb,
	"value_enc" text,
	"encrypted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_sequences" (
	"zone_id" text NOT NULL,
	"year" integer NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "case_sequences_zone_id_year_pk" PRIMARY KEY("zone_id","year")
);
--> statement-breakpoint
CREATE TABLE "case_status_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_id" uuid,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_ref" text NOT NULL,
	"zone_id" text NOT NULL,
	"form_key" text NOT NULL,
	"form_version" integer NOT NULL,
	"request_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requester_email_enc" text NOT NULL,
	"requester_email_hmac" text NOT NULL,
	"requester_name_enc" text,
	"status" text NOT NULL,
	"assignee_id" uuid,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"outcome_code" text,
	"closure_note" text
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"provider" text NOT NULL,
	"from_addr" text NOT NULL,
	"to_addrs" jsonb NOT NULL,
	"cc_addrs" jsonb,
	"bcc_addrs" jsonb,
	"subject" text NOT NULL,
	"template_id" text,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_key" text NOT NULL,
	"session_id" text NOT NULL,
	"verified_email" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_key" text NOT NULL,
	"zone_id" text NOT NULL,
	"version" integer NOT NULL,
	"schema" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_counters_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "sla_clocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"original_due_at" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_total_secs" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"fired_thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extension_justification" text
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL,
	"request_type" text NOT NULL,
	"target_days" integer NOT NULL,
	"business_days" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"holidays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pause_allowed" boolean DEFAULT false NOT NULL,
	"extension_allowed_days" integer DEFAULT 0 NOT NULL,
	"reminder_thresholds" jsonb DEFAULT '[0.75,0.9,1]'::jsonb NOT NULL,
	"escalation_threshold" jsonb DEFAULT '0.9'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_transitions" (
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	CONSTRAINT "status_transitions_from_status_to_status_pk" PRIMARY KEY("from_status","to_status")
);
--> statement-breakpoint
CREATE TABLE "statuses" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"color" text DEFAULT '#6b7280' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"system" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text,
	"request_type" text,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"zone_id" text,
	"team_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"capacity_weight" integer DEFAULT 1 NOT NULL,
	"ooo_from" timestamp with time zone,
	"ooo_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignment_config" ADD CONSTRAINT "assignment_config_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_comments" ADD CONSTRAINT "case_comments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_comments" ADD CONSTRAINT "case_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_fields" ADD CONSTRAINT "case_fields_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_sequences" ADD CONSTRAINT "case_sequences_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_status_history" ADD CONSTRAINT "case_status_history_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_status_history" ADD CONSTRAINT "case_status_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_status_statuses_key_fk" FOREIGN KEY ("status") REFERENCES "public"."statuses"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_from_status_statuses_key_fk" FOREIGN KEY ("from_status") REFERENCES "public"."statuses"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_to_status_statuses_key_fk" FOREIGN KEY ("to_status") REFERENCES "public"."statuses"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_draft_id_form_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."form_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_ix" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_ix" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "case_attachments_case_ix" ON "case_attachments" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_comments_case_ix" ON "case_comments" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_fields_case_ix" ON "case_fields" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_status_history_case_ix" ON "case_status_history" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_ref_ux" ON "cases" USING btree ("case_ref");--> statement-breakpoint
CREATE INDEX "cases_zone_ix" ON "cases" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "cases_status_ix" ON "cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cases_email_hmac_ix" ON "cases" USING btree ("requester_email_hmac");--> statement-breakpoint
CREATE INDEX "email_log_case_ix" ON "email_log" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "form_drafts_session_ix" ON "form_drafts" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_key_ver_ux" ON "form_versions" USING btree ("form_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_clocks_case_ux" ON "sla_clocks" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_policies_zone_type_ux" ON "sla_policies" USING btree ("zone_id","request_type");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_ux" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_tokens_hash_ux" ON "verification_tokens" USING btree ("token_hash");