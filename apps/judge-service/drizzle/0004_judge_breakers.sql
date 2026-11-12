CREATE TABLE "judge_breakers" (
	"node_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"open_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
