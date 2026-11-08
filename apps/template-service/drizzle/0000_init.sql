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
CREATE TABLE "greetings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"ack_count" integer DEFAULT 0 NOT NULL,
	"job_processed_at" timestamp with time zone
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
CREATE UNIQUE INDEX "job_outbox_queue_job_id_uq" ON "job_outbox" USING btree ("queue","job_id");--> statement-breakpoint
CREATE INDEX "job_outbox_pending_idx" ON "job_outbox" USING btree ("created_at") WHERE "job_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;