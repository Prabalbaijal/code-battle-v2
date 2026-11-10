CREATE TABLE "calibrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"runs" jsonb DEFAULT '[]' NOT NULL,
	"limits" jsonb DEFAULT '[]' NOT NULL,
	"problems" jsonb DEFAULT '[]' NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "calibrations_status" CHECK ("calibrations"."status" in ('pending','running','passed','failed'))
);
--> statement-breakpoint
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calibrations_problem_idx" ON "calibrations" USING btree ("problem_id","created_at");