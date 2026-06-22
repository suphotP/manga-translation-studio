-- 0072 — Revision send-back requests + revision_requested notification type.
--
-- Ships the durable "reviewer returned this work to a worker as revision #X"
-- record behind the RevisionSendBackDialog. The canonical source of truth is the
-- project state JSON slice `revisionRequests` (file-mode parity is automatic);
-- this table is the additive, migration-safe Postgres mirror the catalog store
-- upserts on every save, alongside project_review_assignments / project_tasks.
--
-- Also extends the notifications type CHECK so the mandatory send-back
-- notification (`revision_requested`) can be written. Re-stating the full IN-list
-- is the established pattern (0054 / 0071) for a taxonomy bump under the
-- text+CHECK posture — ALTER TYPE ... ADD VALUE can't run inside a transaction.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
	ADD CONSTRAINT notifications_type_check CHECK (type IN (
		'comment_new',
		'comment_reply',
		'ai_job_complete',
		'ai_job_failed',
		'chapter_submitted',
		'chapter_approved',
		'chapter_rejected',
		'invite_received',
		'quota_warning_80pct',
		'quota_frozen',
		'payment_succeeded',
		'payment_failed',
		'team_member_joined',
		'task_assigned',
		'work_assigned',
		'review_cancelled',
		'revision_requested',
		'ticket_opened',
		'ticket_replied',
		'ticket_escalated',
		'ticket_resolved'
	));

CREATE TABLE IF NOT EXISTS project_revision_requests (
	revision_id text NOT NULL,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	revision_number integer NOT NULL,
	assigned_to_user_id text NOT NULL,
	assigned_to_handle text,
	reason text NOT NULL,
	requested_by text,
	target_lang text,
	page_indexes integer[] NOT NULL DEFAULT '{}',
	source_review_decision_id text,
	status text NOT NULL,
	priority text,
	due_at timestamptz,
	resolved_by text,
	resolved_at timestamptz,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, revision_id)
);

CREATE INDEX IF NOT EXISTS project_revision_requests_project_status_idx
	ON project_revision_requests(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS project_revision_requests_assignee_idx
	ON project_revision_requests(assigned_to_user_id, status)
	WHERE status NOT IN ('accepted', 'cancelled');
