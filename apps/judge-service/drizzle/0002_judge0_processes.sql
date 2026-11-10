ALTER TABLE "language_profiles" ALTER COLUMN "max_processes" SET DEFAULT 60;--> statement-breakpoint
-- Judge0 CE needs to fork its run wrapper; profiles created with the old default of 1 failed every run.
UPDATE "language_profiles" SET "max_processes" = 60 WHERE "max_processes" < 60;
