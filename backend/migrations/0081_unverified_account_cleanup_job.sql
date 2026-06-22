-- Register the unverified-account-cleanup scheduled job.
--
-- CronScheduler.initialize() already upserts every job from
-- createDefaultScheduledJobs() on boot (ON CONFLICT (name) DO UPDATE SET schedule),
-- so this row also self-registers at runtime. We add the migration too — mirroring
-- 0066_gdpr_erasure_sweep_job / 0068_orphan_blob_gc_job — so a freshly migrated
-- database has the registry row (and operators can see / disable this hard-delete
-- job) BEFORE the first cron-worker boot, and so the SQL default and the code-side
-- default match.
--
-- Schedule: daily 03:45 UTC. The job hard-deletes local sign-ups that never confirmed
-- their email after UNVERIFIED_ACCOUNT_MAX_AGE_DAYS (default 3), restricted to
-- accounts with no app data (no workspace / storage rows) and not soft-deleted, so it
-- never touches real or restorable accounts. No new table is needed — only the row.

INSERT INTO scheduled_jobs (name, schedule) VALUES
	('unverified-account-cleanup', '45 3 * * *')
ON CONFLICT (name) DO UPDATE SET schedule = EXCLUDED.schedule;

-- Index the one cleanup guard column that lacks a leading index. The job's eligibility
-- predicate (and Postgres's own non-cascading FK check on delete) probe
-- `asset_versions.created_by_user_id` via `NOT EXISTS`; every other guarded column
-- (workspace_members/user_storage_accounts/support_tickets/account_export_jobs/
-- notification_preferences/notifications/workspace_contacts) already has a leading index,
-- but asset_versions is only indexed on asset/version/account columns. Without this, each
-- reaped batch can seqscan the (high-volume) asset-history table and stall the nightly run.
-- Partial on IS NOT NULL keeps it small (the column is nullable). Plain CREATE INDEX (not
-- CONCURRENTLY): migrations.ts runs each file in a single transaction; on a hot prod table
-- build this off-peak or promote it out-of-band.
CREATE INDEX IF NOT EXISTS asset_versions_created_by_user_idx
	ON asset_versions (created_by_user_id)
	WHERE created_by_user_id IS NOT NULL;

-- Index the DRIVING scan of the unverified-account-cleanup itself. The job picks victims
-- from auth_users by (email_verified=false, auth_provider='local', role IN editor/viewer,
-- deleted_at IS NULL, created_at < cutoff), but the existing auth_users indexes lead with
-- other columns — so on a large abandoned/bot-signup backlog (exactly what this job targets)
-- each bounded batch could seqscan the whole user table. A PARTIAL index on created_at over
-- the eligible set turns the age cutoff into a small range scan within just the reapable rows.
-- The partial predicate uses only IMMUTABLE comparisons (no now()); the volatile created_at
-- cutoff is served by the indexed column. Plain CREATE INDEX per the migration runner's
-- single-transaction model (see the note above).
CREATE INDEX IF NOT EXISTS auth_users_unverified_cleanup_idx
	ON auth_users (created_at)
	WHERE email_verified = false AND auth_provider = 'local' AND deleted_at IS NULL AND role IN ('editor', 'viewer');
