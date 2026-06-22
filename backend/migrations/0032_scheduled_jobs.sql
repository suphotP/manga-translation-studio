-- Wave 2 W2.4: scheduled_jobs registry + 7 initial cron jobs.
-- Each row tracks one named recurring job; the cron-worker process polls this
-- table and uses pg advisory locks to ensure only one replica runs a job at a
-- time. `schedule` is a 5-field cron expression interpreted by croner (UTC).

CREATE TABLE IF NOT EXISTS scheduled_jobs (
	name text PRIMARY KEY,
	schedule text NOT NULL DEFAULT '0 0 * * *',
	enabled boolean NOT NULL DEFAULT true,
	last_run_at timestamptz,
	last_status text,
	last_error text,
	next_run_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill schedule column for environments that ran an earlier version of this
-- migration (the table existed without schedule). Idempotent: ADD COLUMN IF
-- NOT EXISTS keeps re-runs safe.
ALTER TABLE scheduled_jobs
	ADD COLUMN IF NOT EXISTS schedule text NOT NULL DEFAULT '0 0 * * *';

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_last_status_check'
	) THEN
		ALTER TABLE scheduled_jobs
			ADD CONSTRAINT scheduled_jobs_last_status_check
			CHECK (last_status IS NULL OR last_status IN ('success', 'error', 'skipped')) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx
	ON scheduled_jobs(enabled, next_run_at, name);

INSERT INTO scheduled_jobs (name, schedule) VALUES
	('monthly-credit-reset',           '5 0 1 * *'),
	('expired-session-gc',             '0 3 * * *'),
	('expired-invite-cleanup',         '0 */6 * * *'),
	('expired-password-reset-cleanup', '0 */6 * * *'),
	('expired-storage-pack-sweep',     '0 4 * * *'),
	('audit-retention-prune',          '0 5 * * *'),
	('draft-export-cleanup',           '0 6 * * *')
ON CONFLICT (name) DO UPDATE SET schedule = EXCLUDED.schedule;
