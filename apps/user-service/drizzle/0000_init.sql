CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
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
CREATE TABLE "friendships" (
	"user_low" uuid NOT NULL,
	"user_high" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_pkey" PRIMARY KEY("user_low","user_high"),
	CONSTRAINT "friendships_ordered" CHECK ("friendships"."user_low" < "friendships"."user_high"),
	CONSTRAINT "friendships_requester" CHECK ("friendships"."requested_by" in ("friendships"."user_low", "friendships"."user_high")),
	CONSTRAINT "friendships_status" CHECK ("friendships"."status" in ('pending','accepted','ignored'))
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
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"username" "citext" NOT NULL,
	"fullname" text NOT NULL,
	"avatar_url" text,
	"bio" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_username_key" UNIQUE("username")
);
--> statement-breakpoint
CREATE INDEX "friendships_high_status_idx" ON "friendships" USING btree ("user_high","status");--> statement-breakpoint
CREATE INDEX "friendships_low_status_idx" ON "friendships" USING btree ("user_low","status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_outbox_queue_job_id_uq" ON "job_outbox" USING btree ("queue","job_id");--> statement-breakpoint
CREATE INDEX "job_outbox_pending_idx" ON "job_outbox" USING btree ("created_at") WHERE "job_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "profiles_username_trgm" ON "profiles" USING gin ("username" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "profiles_username_prefix" ON "profiles" USING btree (lower("username"::text) text_pattern_ops);