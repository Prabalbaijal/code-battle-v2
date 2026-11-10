CREATE TABLE "blobs" (
	"key" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"solution_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"cpu_ms" integer,
	"verdict" text,
	"drift_factor" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "match_problem" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "problem_language_limits" (
	"problem_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"language_key" text NOT NULL,
	"cpu_limit_ms" integer NOT NULL,
	CONSTRAINT "problem_language_limits_pkey" PRIMARY KEY("problem_id","ordinal","language_key")
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"statement_md" text NOT NULL,
	"input_format_md" text NOT NULL,
	"output_format_md" text NOT NULL,
	"constraints" text[] DEFAULT '{}' NOT NULL,
	"examples" jsonb DEFAULT '[]' NOT NULL,
	"difficulty" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"memory_limit_kb" integer DEFAULT 196608 NOT NULL,
	"output_limit_kb" integer DEFAULT 1024 NOT NULL,
	"checker_type" text DEFAULT 'tokens' NOT NULL,
	"float_eps" double precision,
	"random_key" double precision DEFAULT random() NOT NULL,
	"calibrated_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"legacy_mongo_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "problems_slug_key" UNIQUE("slug"),
	CONSTRAINT "problems_legacy_mongo_id_key" UNIQUE("legacy_mongo_id"),
	CONSTRAINT "problems_difficulty" CHECK ("problems"."difficulty" in ('Easy','Medium','Hard')),
	CONSTRAINT "problems_status" CHECK ("problems"."status" in ('draft','published','archived')),
	CONSTRAINT "problems_checker" CHECK ("problems"."checker_type" in ('tokens','float','exact'))
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "reference_solutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"language_key" text NOT NULL,
	"expected_verdict" text NOT NULL,
	"code_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_solutions_verdict" CHECK ("reference_solutions"."expected_verdict" in ('AC','TLE','WA'))
);
--> statement-breakpoint
CREATE TABLE "test_files" (
	"problem_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"kind" text NOT NULL,
	"case_count" integer NOT NULL,
	"input_uri" text NOT NULL,
	"output_uri" text NOT NULL,
	"output_case_line_counts" integer[],
	"input_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "test_files_pkey" PRIMARY KEY("problem_id","ordinal"),
	CONSTRAINT "test_files_kind" CHECK ("test_files"."kind" in ('sample','small','large')),
	CONSTRAINT "test_files_input_bytes" CHECK ("test_files"."input_bytes" <= 2097152),
	CONSTRAINT "test_files_ordinal" CHECK ("test_files"."ordinal" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "user_problem_seen" (
	"user_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_problem_seen_pkey" PRIMARY KEY("user_id","problem_id")
);
--> statement-breakpoint
ALTER TABLE "calibration_runs" ADD CONSTRAINT "calibration_runs_solution_id_reference_solutions_id_fk" FOREIGN KEY ("solution_id") REFERENCES "public"."reference_solutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_language_limits" ADD CONSTRAINT "problem_language_limits_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_solutions" ADD CONSTRAINT "reference_solutions_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_files" ADD CONSTRAINT "test_files_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_outbox_queue_job_id_uq" ON "job_outbox" USING btree ("queue","job_id");--> statement-breakpoint
CREATE INDEX "job_outbox_pending_idx" ON "job_outbox" USING btree ("created_at") WHERE "job_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "problems_published_random" ON "problems" USING btree ("random_key") WHERE "problems"."status" = 'published';--> statement-breakpoint
CREATE INDEX "problems_published_difficulty" ON "problems" USING btree ("difficulty","random_key") WHERE "problems"."status" = 'published';--> statement-breakpoint
CREATE INDEX "problems_tags" ON "problems" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "reference_solutions_problem_idx" ON "reference_solutions" USING btree ("problem_id");