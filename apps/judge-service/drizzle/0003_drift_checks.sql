CREATE TABLE "judge_drift_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"samples" jsonb,
	"ratio" numeric(5, 2),
	"factor" numeric(4, 2) NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "judge_drift_checks_ran_at_idx" ON "judge_drift_checks" USING btree ("ran_at");