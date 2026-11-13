-- pgvector: created by the init scripts as superuser (dev and prod); a no-op when it exists.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "ai_budget_daily" (
	"day" date NOT NULL,
	"model" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_budget_daily_day_model_pk" PRIMARY KEY("day","model")
);
--> statement-breakpoint
CREATE TABLE "ai_hints" (
	"user_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"level" smallint NOT NULL,
	"text" text NOT NULL,
	"match_id" uuid,
	"paid" boolean NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_hints_user_id_problem_id_level_pk" PRIMARY KEY("user_id","problem_id","level"),
	CONSTRAINT "ai_hints_level" CHECK ("ai_hints"."level" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "ai_matches" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"user_ids" uuid[] NOT NULL,
	"status" text NOT NULL,
	"winner_id" uuid,
	"end_reason" text,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_problems" (
	"problem_id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"difficulty" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_reviews" (
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"content" jsonb,
	"prompt_version" text,
	"model" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_reviews_match_id_user_id_pk" PRIMARY KEY("match_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_submissions" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"match_id" uuid,
	"verdict" text NOT NULL,
	"judged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_user_usage" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_user_usage_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text NOT NULL,
	"anchor" text,
	"content" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', heading || ' ' || content)) STORED NOT NULL,
	"embedding" vector(384) NOT NULL
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
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrity_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"other_user_id" uuid NOT NULL,
	"other_submission_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"similarity" double precision NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"reviewed_by" uuid,
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
CREATE TABLE "processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_matches_users_idx" ON "ai_matches" USING gin ("user_ids");--> statement-breakpoint
CREATE INDEX "ai_requests_created_idx" ON "ai_requests" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_submissions_user_idx" ON "ai_submissions" USING btree ("user_id","judged_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tasks_key" ON "ai_tasks" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "ai_tasks_due_idx" ON "ai_tasks" USING btree ("run_after") WHERE "ai_tasks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "documents_ref_key" ON "documents" USING btree ("kind","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "integrity_flags_pair_key" ON "integrity_flags" USING btree ("submission_id","other_submission_id");--> statement-breakpoint
CREATE INDEX "integrity_flags_open_idx" ON "integrity_flags" USING btree ("created_at" DESC NULLS LAST) WHERE "integrity_flags"."status" = 'open';--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;