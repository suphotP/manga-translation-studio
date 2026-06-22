-- W2.10: role-based locking + workflow state machine.
--
-- Soft-lock model (no CRDT): work_locks owns a per-(scope, scope_id) advisory
-- lock so a single user can edit a page/object/layer/chapter at a time. Auto
-- release on submit, idle timeout, or logout. work_states drives the linear
-- production workflow Draft -> In progress -> Submitted -> QC -> Approved ->
-- Released, with explicit Rejected bounce back to In progress.
--
-- ENUM-free / text+CHECK constraints to match the project convention
-- (0002, 0021) so prototype/file-mode environments and Postgres test runners
-- without ENUM ALTER privileges keep working. UNIQUE partial index enforces
-- "only one active lock per (scope, scope_id)" without bumping into the
-- "scope IS NOT NULL" requirement of a CREATE UNIQUE INDEX ... WHERE clause.

CREATE TABLE IF NOT EXISTS work_locks (
	lock_id text PRIMARY KEY,
	scope text NOT NULL,
	scope_id text NOT NULL,
	owner_user_id text NOT NULL,
	project_id text,
	chapter_id text,
	page_id text,
	workspace_id text,
	acquired_at timestamptz NOT NULL DEFAULT now(),
	auto_release_at timestamptz NOT NULL,
	released_at timestamptz,
	released_by text,
	release_reason text,
	CONSTRAINT work_locks_scope_check CHECK (scope IN ('page', 'object', 'layer', 'chapter'))
);

CREATE UNIQUE INDEX IF NOT EXISTS work_locks_active_scope_idx
	ON work_locks(scope, scope_id)
	WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS work_locks_chapter_active_idx
	ON work_locks(chapter_id, auto_release_at, scope, scope_id)
	WHERE released_at IS NULL AND chapter_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS work_locks_page_active_idx
	ON work_locks(page_id, auto_release_at, scope, scope_id)
	WHERE released_at IS NULL AND page_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS work_locks_owner_active_idx
	ON work_locks(owner_user_id, auto_release_at)
	WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS work_locks_project_active_idx
	ON work_locks(project_id, auto_release_at)
	WHERE released_at IS NULL AND project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS work_locks_expiry_sweep_idx
	ON work_locks(auto_release_at)
	WHERE released_at IS NULL;

-- Current workflow state per subject (chapter or page). One row per subject,
-- enforced by the unique constraint. Transitions log the history.
CREATE TABLE IF NOT EXISTS work_states (
	id text PRIMARY KEY,
	subject_kind text NOT NULL,
	subject_id text NOT NULL,
	state text NOT NULL DEFAULT 'draft',
	assignee_user_id text,
	due_at timestamptz,
	comment text,
	transitioned_by text,
	created_by text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT work_states_subject_kind_check CHECK (subject_kind IN ('chapter', 'page')),
	CONSTRAINT work_states_state_check CHECK (state IN ('draft', 'in_progress', 'submitted', 'in_qc', 'approved', 'released', 'rejected')),
	CONSTRAINT work_states_subject_unique UNIQUE (subject_kind, subject_id)
);

CREATE INDEX IF NOT EXISTS work_states_state_updated_idx
	ON work_states(state, updated_at DESC);

CREATE INDEX IF NOT EXISTS work_states_assignee_updated_idx
	ON work_states(assignee_user_id, updated_at DESC)
	WHERE assignee_user_id IS NOT NULL;

-- Append-only transition log. Captures the full audit trail (who, when, from,
-- to, optional comment, admin force flag) for compliance and downstream
-- notifications via the W2.7 SSE bridge.
CREATE TABLE IF NOT EXISTS work_state_transitions (
	id text PRIMARY KEY,
	subject_kind text NOT NULL,
	subject_id text NOT NULL,
	from_state text NOT NULL,
	to_state text NOT NULL,
	comment text,
	user_id text NOT NULL,
	role text,
	forced boolean NOT NULL DEFAULT FALSE,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT work_state_transitions_subject_kind_check CHECK (subject_kind IN ('chapter', 'page')),
	CONSTRAINT work_state_transitions_from_check CHECK (from_state IN ('draft', 'in_progress', 'submitted', 'in_qc', 'approved', 'released', 'rejected')),
	CONSTRAINT work_state_transitions_to_check CHECK (to_state IN ('draft', 'in_progress', 'submitted', 'in_qc', 'approved', 'released', 'rejected'))
);

CREATE INDEX IF NOT EXISTS work_state_transitions_subject_idx
	ON work_state_transitions(subject_kind, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS work_state_transitions_user_idx
	ON work_state_transitions(user_id, created_at DESC);
