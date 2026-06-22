CREATE INDEX IF NOT EXISTS workspaces_updated_id_idx
	ON workspaces(updated_at DESC, workspace_id DESC);

CREATE INDEX IF NOT EXISTS workspace_members_user_workspace_idx
	ON workspace_members(user_id, workspace_id)
	WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_members_user_updated_idx
	ON workspace_members(user_id, updated_at DESC, workspace_id DESC)
	WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_members_workspace_updated_idx
	ON workspace_members(workspace_id, updated_at DESC, user_id DESC)
	WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_invites_workspace_created_id_idx
	ON workspace_invites(workspace_id, created_at DESC, invite_id DESC);
