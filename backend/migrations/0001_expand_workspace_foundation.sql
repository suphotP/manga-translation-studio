CREATE TABLE IF NOT EXISTS workspaces (
	workspace_id text PRIMARY KEY,
	name text NOT NULL,
	plan_id text NOT NULL DEFAULT 'prototype',
	storage_included_bytes bigint NOT NULL DEFAULT 0,
	storage_extra_bytes bigint NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	user_id text NOT NULL,
	role text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
	project_id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
	owner_user_id text,
	title text NOT NULL,
	source_locale text,
	target_locale text,
	current_revision_id text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS projects_workspace_updated_idx
	ON projects(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_pages (
	page_id text PRIMARY KEY,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	page_index integer NOT NULL,
	image_id text,
	status text NOT NULL DEFAULT 'draft',
	revision_id text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (project_id, page_index)
);

CREATE INDEX IF NOT EXISTS project_pages_project_status_idx
	ON project_pages(project_id, status, page_index);

CREATE TABLE IF NOT EXISTS assets (
	asset_id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
	project_id text REFERENCES projects(project_id) ON DELETE CASCADE,
	storage_key text NOT NULL,
	mime_type text NOT NULL,
	size_bytes bigint NOT NULL,
	sha256 text NOT NULL,
	width integer,
	height integer,
	purpose text NOT NULL,
	moderation_status text NOT NULL DEFAULT 'pending',
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS assets_workspace_project_idx
	ON assets(workspace_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS assets_workspace_sha_idx
	ON assets(workspace_id, sha256);

CREATE TABLE IF NOT EXISTS ai_jobs (
	job_id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	page_id text REFERENCES project_pages(page_id) ON DELETE SET NULL,
	idempotency_key text,
	tier text NOT NULL,
	status text NOT NULL,
	provider text,
	estimated_cost_thb numeric(12, 4) NOT NULL DEFAULT 0,
	actual_cost_thb numeric(12, 4),
	input_asset_id text REFERENCES assets(asset_id) ON DELETE SET NULL,
	output_asset_id text REFERENCES assets(asset_id) ON DELETE SET NULL,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_project_idempotency_idx
	ON ai_jobs(project_id, idempotency_key)
	WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_jobs_workspace_status_idx
	ON ai_jobs(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
	event_id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	project_id text REFERENCES projects(project_id) ON DELETE SET NULL,
	user_id text,
	kind text NOT NULL,
	subject_id text NOT NULL,
	idempotency_key text,
	amount_bytes bigint,
	amount_thb numeric(12, 4),
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_events_workspace_idempotency_idx
	ON usage_events(workspace_id, idempotency_key)
	WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS usage_events_workspace_kind_time_idx
	ON usage_events(workspace_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
	audit_event_id text PRIMARY KEY,
	workspace_id text REFERENCES workspaces(workspace_id) ON DELETE SET NULL,
	project_id text REFERENCES projects(project_id) ON DELETE SET NULL,
	actor_user_id text,
	action text NOT NULL,
	entity_type text NOT NULL,
	entity_id text NOT NULL,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_workspace_time_idx
	ON audit_events(workspace_id, created_at DESC);
