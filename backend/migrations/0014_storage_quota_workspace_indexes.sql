CREATE INDEX IF NOT EXISTS projects_workspace_project_active_idx
	ON projects(workspace_id, project_id)
	WHERE deleted_at IS NULL;
