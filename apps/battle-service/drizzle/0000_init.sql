CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_user" uuid NOT NULL,
	"to_user" uuid NOT NULL,
	"status" text NOT NULL,
	"match_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenges_not_self" CHECK ("challenges"."to_user" <> "challenges"."from_user"),
	CONSTRAINT "challenges_status" CHECK ("challenges"."status" in ('pending','accepted','rejected','cancelled','expired'))
);
--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "job_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"job_id" text NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"run_at" timestamp with time zone,
	"priority" integer,
	"traceparent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "match_participants" (
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"result" text,
	CONSTRAINT "match_participants_match_id_user_id_pk" PRIMARY KEY("match_id","user_id"),
	CONSTRAINT "match_participants_result" CHECK ("match_participants"."result" is null or "match_participants"."result" in ('win','loss','draw'))
);
--> statement-breakpoint
CREATE TABLE "match_submissions" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"verdict" text,
	"judged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'friendly' NOT NULL,
	"status" text NOT NULL,
	"problem_id" uuid,
	"problem_slug" text,
	"started_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"decide_deadline" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"winner_id" uuid,
	"end_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_mode" CHECK ("matches"."mode" in ('friendly','ranked')),
	CONSTRAINT "matches_status" CHECK ("matches"."status" in ('created','in_progress','deciding','completed','aborted')),
	CONSTRAINT "matches_end_reason" CHECK ("matches"."end_reason" is null or "matches"."end_reason" in ('solved','forfeit','timeout','aborted','legacy'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "user_active_match" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_active_match" ADD CONSTRAINT "user_active_match_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "challenges_one_pending_per_pair" ON "challenges" USING btree ("from_user","to_user") WHERE "challenges"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "challenges_pending_to_idx" ON "challenges" USING btree ("to_user") WHERE "challenges"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "challenges_pending_from_idx" ON "challenges" USING btree ("from_user") WHERE "challenges"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "job_outbox_queue_job_id_uq" ON "job_outbox" USING btree ("queue","job_id");--> statement-breakpoint
CREATE INDEX "job_outbox_pending_idx" ON "job_outbox" USING btree ("created_at") WHERE "job_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "match_participants_user_idx" ON "match_participants" USING btree ("user_id","match_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "match_submissions_match_idx" ON "match_submissions" USING btree ("match_id","submitted_at");--> statement-breakpoint
CREATE INDEX "matches_open_by_deadline" ON "matches" USING btree ("ends_at") WHERE "matches"."status" in ('in_progress','deciding');--> statement-breakpoint
CREATE INDEX "matches_stuck_created" ON "matches" USING btree ("created_at") WHERE "matches"."status" = 'created';--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;