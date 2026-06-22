ALTER TABLE workspace_members
	ADD COLUMN IF NOT EXISTS scope jsonb NOT NULL DEFAULT '{}'::jsonb,
	ADD COLUMN IF NOT EXISTS invited_by_user_id text,
	ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_role_check'
	) THEN
		ALTER TABLE workspace_members
			ADD CONSTRAINT workspace_members_role_check
			CHECK (role IN ('owner', 'admin', 'editor', 'viewer')) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_members_user_role_idx
	ON workspace_members(user_id, role)
	WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_invites (
	invite_id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	email text NOT NULL,
	role text NOT NULL,
	scope jsonb NOT NULL DEFAULT '{}'::jsonb,
	token_hash text NOT NULL UNIQUE,
	status text NOT NULL DEFAULT 'pending',
	invited_by_user_id text NOT NULL,
	accepted_by_user_id text,
	expires_at timestamptz NOT NULL,
	accepted_at timestamptz,
	revoked_at timestamptz,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'workspace_invites_role_check'
	) THEN
		ALTER TABLE workspace_invites
			ADD CONSTRAINT workspace_invites_role_check
			CHECK (role IN ('admin', 'editor', 'viewer')) NOT VALID;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'workspace_invites_status_check'
	) THEN
		ALTER TABLE workspace_invites
			ADD CONSTRAINT workspace_invites_status_check
			CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')) NOT VALID;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_invites_workspace_status_idx
	ON workspace_invites(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS workspace_invites_email_status_idx
	ON workspace_invites(lower(email), status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_one_pending_email_idx
	ON workspace_invites(workspace_id, lower(email))
	WHERE status = 'pending';
