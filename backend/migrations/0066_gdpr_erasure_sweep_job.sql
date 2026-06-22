-- GDPR right-to-erasure: register the gdpr-erasure-sweep scheduled job.
--
-- The cron-worker's CronScheduler.initialize() already upserts every job from
-- createDefaultScheduledJobs() on boot (ON CONFLICT (name) DO UPDATE SET
-- schedule), so this row is also self-registered at runtime. We add it to a
-- migration too so a fresh database INSERT and the code-side default match
-- (mirrors 0032_scheduled_jobs.sql), and so the row exists before the first
-- cron-worker boot.
--
-- Schedule: daily 02:00 UTC. The job anonymizes soft-deleted accounts whose
-- configurable retention window (GDPR_ERASURE_GRACE_DAYS, default 30) has
-- elapsed. It drives the gdprStore/authUserStore abstractions rather than raw
-- SQL, so no new table is needed here — only the registry row.

INSERT INTO scheduled_jobs (name, schedule) VALUES
	('gdpr-erasure-sweep', '0 2 * * *')
ON CONFLICT (name) DO UPDATE SET schedule = EXCLUDED.schedule;
