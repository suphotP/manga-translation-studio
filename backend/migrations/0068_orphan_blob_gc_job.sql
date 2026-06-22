-- Storage-leak fix: register the orphan-blob-gc scheduled job.
--
-- Project/asset deletes now decrement CoW content_blobs ref_counts + reclaim
-- the storage quota inline (services/storage-cow.ts). The now-unreferenced blob
-- ROWS + their object-storage objects are reclaimed by StorageCowService
-- .gcOrphanBlobs(), which previously had NO scheduled caller (dead code). This
-- job registers that sweep so orphaned blobs are eventually freed.
--
-- The cron-worker's CronScheduler.initialize() already upserts every job from
-- createDefaultScheduledJobs() on boot (ON CONFLICT (name) DO UPDATE SET
-- schedule), so this row is also self-registered at runtime. We add it to a
-- migration too so a fresh database INSERT and the code-side default match
-- (mirrors 0032_scheduled_jobs.sql / 0066_gdpr_erasure_sweep_job.sql), and so
-- the row exists before the first cron-worker boot.
--
-- Schedule: daily 04:30 UTC (after the 04:00 storage-pack sweep). The job is
-- idempotent + CoW-safe — it only evicts blobs that stay at ref_count=0 through
-- a re-locked re-check, so a re-run or a concurrent re-reference never loses a
-- live blob. No new table is needed — only the registry row.

INSERT INTO scheduled_jobs (name, schedule) VALUES
	('orphan-blob-gc', '30 4 * * *')
ON CONFLICT (name) DO UPDATE SET schedule = EXCLUDED.schedule;
