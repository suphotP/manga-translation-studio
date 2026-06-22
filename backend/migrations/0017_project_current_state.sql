ALTER TABLE projects
	ADD COLUMN IF NOT EXISTS current_state jsonb;

CREATE INDEX IF NOT EXISTS projects_current_state_updated_idx
	ON projects(updated_at DESC, project_id DESC)
	WHERE deleted_at IS NULL AND current_state IS NOT NULL;
