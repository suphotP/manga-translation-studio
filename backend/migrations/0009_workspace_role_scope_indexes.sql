CREATE INDEX IF NOT EXISTS workspace_members_workspace_role_updated_idx
	ON workspace_members(workspace_id, role, updated_at DESC)
	WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_members_scope_gin_idx
	ON workspace_members USING GIN (scope)
	WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_invites_workspace_status_expires_idx
	ON workspace_invites(workspace_id, status, expires_at, created_at DESC);

CREATE INDEX IF NOT EXISTS workspace_invites_scope_gin_idx
	ON workspace_invites USING GIN (scope)
	WHERE status = 'pending';
