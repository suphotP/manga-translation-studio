-- Back-office content management (rank 17-18): distinct platform-admin
-- moderation columns on projects.
--
-- WHY a new migration (not reuse of existing columns):
--   * projects.deleted_at is the USER-facing soft-delete (every catalog query
--     filters `deleted_at IS NULL`). A back-office "hide" must be reversible AND
--     distinguishable from a user deleting their own project, so it cannot
--     overload deleted_at without conflating the two lifecycles (an admin unhide
--     would otherwise resurrect a user-deleted project).
--   * asset_records.moderation_* + csam_blocks (0021/0047/0048) hold the
--     per-asset moderation pipeline verdicts. There is NO project-level admin
--     flag/hide today, and an admin flag is a distinct human action (a reviewer
--     marking a whole project for attention), not an automated asset verdict.
--
-- These columns are platform-admin-only (set exclusively via /api/admin/content)
-- and never touched by the normal app project lifecycle.

ALTER TABLE projects
	ADD COLUMN IF NOT EXISTS admin_flagged_at timestamptz,
	ADD COLUMN IF NOT EXISTS admin_flagged_by text,
	ADD COLUMN IF NOT EXISTS admin_flag_reason text,
	ADD COLUMN IF NOT EXISTS admin_hidden_at timestamptz,
	ADD COLUMN IF NOT EXISTS admin_hidden_by text,
	ADD COLUMN IF NOT EXISTS admin_hide_reason text;

-- Back-office browser filters on flagged / hidden, newest activity first. Partial
-- indexes keep the moderation working set cheap to scan without bloating the
-- main project indexes (the vast majority of rows are neither flagged nor hidden).
CREATE INDEX IF NOT EXISTS projects_admin_flagged_idx
	ON projects(admin_flagged_at DESC, project_id DESC)
	WHERE admin_flagged_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS projects_admin_hidden_idx
	ON projects(admin_hidden_at DESC, project_id DESC)
	WHERE admin_hidden_at IS NOT NULL;
