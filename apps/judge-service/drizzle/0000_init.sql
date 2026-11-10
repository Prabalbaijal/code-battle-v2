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
CREATE TABLE "judge_budget_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"calls_used" integer DEFAULT 0 NOT NULL,
	"calls_limit" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"stage" smallint NOT NULL,
	"file_ordinal" smallint NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"judge0_token" text,
	"status" text NOT NULL,
	"judge0_status_id" smallint,
	"cpu_ms" integer,
	"wall_ms" integer,
	"mem_kb" integer,
	"stdout_trunc" text,
	"stderr_trunc" text,
	"compile_output" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "judge_runs_token_key" UNIQUE("judge0_token"),
	CONSTRAINT "judge_runs_file_attempt_key" UNIQUE("submission_id","file_ordinal","attempt"),
	CONSTRAINT "judge_runs_status" CHECK ("judge_runs"."status" in ('pending','submitted','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "language_profiles" (
	"language_key" text PRIMARY KEY NOT NULL,
	"judge0_language_id" integer NOT NULL,
	"name" text NOT NULL,
	"default_time_factor" numeric(3, 1) NOT NULL,
	"mem_overhead_kb" integer DEFAULT 0 NOT NULL,
	"max_processes" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
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
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"match_id" uuid,
	"problem_id" uuid NOT NULL,
	"problem_version" integer NOT NULL,
	"mode" text NOT NULL,
	"language_key" text NOT NULL,
	"code" text NOT NULL,
	"code_hash" text NOT NULL,
	"custom_input" text,
	"status" text NOT NULL,
	"stage" smallint DEFAULT 0 NOT NULL,
	"verdict" text,
	"failed_file" smallint,
	"failed_kind" text,
	"failed_case" integer,
	"max_cpu_ms" integer,
	"max_mem_kb" integer,
	"message" text,
	"from_cache" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"judged_at" timestamp with time zone,
	CONSTRAINT "submissions_mode" CHECK ("submissions"."mode" in ('submit','run')),
	CONSTRAINT "submissions_status" CHECK ("submissions"."status" in ('queued','running','done')),
	CONSTRAINT "submissions_verdict" CHECK (verdict is null or verdict in ('AC','WA','TLE','MLE','RE','CE','OLE','IE')),
	CONSTRAINT "submissions_code_size" CHECK (octet_length("submissions"."code") <= 65536)
);
--> statement-breakpoint
ALTER TABLE "judge_runs" ADD CONSTRAINT "judge_runs_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_outbox_queue_job_id_uq" ON "job_outbox" USING btree ("queue","job_id");--> statement-breakpoint
CREATE INDEX "job_outbox_pending_idx" ON "job_outbox" USING btree ("created_at") WHERE "job_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "judge_runs_awaiting" ON "judge_runs" USING btree ("submitted_at") WHERE "judge_runs"."status" = 'submitted';--> statement-breakpoint
CREATE INDEX "judge_runs_submission_idx" ON "judge_runs" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "submissions_match_idx" ON "submissions" USING btree ("match_id","submitted_at");--> statement-breakpoint
CREATE INDEX "submissions_user_idx" ON "submissions" USING btree ("user_id","submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "submissions_cache_idx" ON "submissions" USING btree ("problem_id","problem_version","code_hash") WHERE "submissions"."status" = 'done' and "submissions"."mode" = 'submit';