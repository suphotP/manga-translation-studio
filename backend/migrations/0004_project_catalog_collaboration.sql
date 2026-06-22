CREATE TABLE IF NOT EXISTS users (
	user_id text PRIMARY KEY,
	email text NOT NULL,
	password_hash text NOT NULL,
	name text NOT NULL,
	role text NOT NULL,
	auth_provider text NOT NULL DEFAULT 'local',
	external_subject text,
	email_verified boolean NOT NULL DEFAULT false,
	last_login timestamptz,
	is_active boolean NOT NULL DEFAULT true,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
	ON users (lower(email))
	WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_external_identity_unique_idx
	ON users (auth_provider, external_subject)
	WHERE external_subject IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE projects
	ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS projects_owner_updated_idx
	ON projects(owner_user_id, updated_at DESC)
	WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS project_tasks (
	task_id text NOT NULL,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	page_id text REFERENCES project_pages(page_id) ON DELETE SET NULL,
	page_index integer NOT NULL,
	type text NOT NULL,
	status text NOT NULL,
	priority text NOT NULL,
	title text NOT NULL,
	assignee_user_id text,
	layer_id text,
	due_at timestamptz,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, task_id)
);

CREATE INDEX IF NOT EXISTS project_tasks_project_status_idx
	ON project_tasks(project_id, status, priority, page_index);

CREATE INDEX IF NOT EXISTS project_tasks_assignee_due_idx
	ON project_tasks(assignee_user_id, due_at)
	WHERE assignee_user_id IS NOT NULL AND status <> 'done';

CREATE TABLE IF NOT EXISTS project_comments (
	comment_id text NOT NULL,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	page_id text REFERENCES project_pages(page_id) ON DELETE SET NULL,
	page_index integer NOT NULL,
	layer_id text,
	status text NOT NULL,
	body text NOT NULL,
	author_user_id text,
	mentions text[] NOT NULL DEFAULT '{}',
	region jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, comment_id)
);

CREATE INDEX IF NOT EXISTS project_comments_project_status_idx
	ON project_comments(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_review_decisions (
	review_decision_id text NOT NULL,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	page_id text REFERENCES project_pages(page_id) ON DELETE SET NULL,
	page_index integer NOT NULL,
	status text NOT NULL,
	body text,
	actor_user_id text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, review_decision_id)
);

CREATE INDEX IF NOT EXISTS project_review_decisions_project_page_idx
	ON project_review_decisions(project_id, page_index, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_versions (
	version_id text PRIMARY KEY,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	name text NOT NULL,
	source text NOT NULL,
	state_hash text,
	page_count integer NOT NULL DEFAULT 0,
	text_layer_count integer NOT NULL DEFAULT 0,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	state jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_versions_project_time_idx
	ON project_versions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_version_reviews (
	version_review_id text NOT NULL,
	version_id text NOT NULL,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	status text NOT NULL,
	body text,
	requester_user_id text,
	reviewer_user_id text,
	mentions text[] NOT NULL DEFAULT '{}',
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	decided_at timestamptz,
	PRIMARY KEY (project_id, version_review_id)
);

CREATE INDEX IF NOT EXISTS project_version_reviews_project_status_idx
	ON project_version_reviews(project_id, status, updated_at DESC);
