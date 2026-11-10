ALTER TABLE "submissions" DROP CONSTRAINT "submissions_mode";--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "cpu_limit_override_ms" integer;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_request_key_key" UNIQUE("request_key");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_mode" CHECK ("submissions"."mode" in ('submit','run','calibrate'));