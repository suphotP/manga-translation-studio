CREATE TABLE IF NOT EXISTS auth_sessions (
	session_id text PRIMARY KEY,
	user_id text NOT NULL,
	token_hash text NOT NULL UNIQUE,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	revoked_at timestamptz,
	rotated_from_session_id text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_active_idx
	ON auth_sessions(user_id, expires_at DESC)
	WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS upload_audit_events (
	audit_id text PRIMARY KEY,
	workspace_id text REFERENCES workspaces(workspace_id) ON DELETE SET NULL,
	project_id text REFERENCES projects(project_id) ON DELETE SET NULL,
	asset_id text,
	image_id text NOT NULL,
	actor_user_id text,
	actor_source text NOT NULL,
	original_name text NOT NULL,
	mime_type text NOT NULL,
	size_bytes bigint NOT NULL,
	sha256 text NOT NULL,
	storage_driver text NOT NULL,
	storage_key text NOT NULL,
	width integer,
	height integer,
	ip text,
	user_agent text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS upload_audit_project_time_idx
	ON upload_audit_events(project_id, created_at DESC);

ALTER TABLE ai_jobs
	ADD COLUMN IF NOT EXISTS quality text,
	ADD COLUMN IF NOT EXISTS credit_units integer NOT NULL DEFAULT 0;
