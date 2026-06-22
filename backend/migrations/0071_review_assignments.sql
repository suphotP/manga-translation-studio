-- 0071 — Review assignments + review_cancelled notification type.
-- (Renamed from 0070 to avoid an id collision with 0070_workspace_contacts.sql
-- added by PR #388.)
--
-- Ships the durable "who owns this review, and what scope" record behind the
-- AssignReviewPanel + CancelReviewDialog. The canonical source of truth is the
-- project state JSON slice `reviewAssignments` (file-mode parity is automatic);
-- this table is the additive, migration-safe Postgres mirror the catalog store
-- upserts on every save, alongside project_tasks / project_review_decisions.
--
-- Also extends the notifications type CHECK so the mandatory cancel notification
-- (`review_cancelled`) can be written. Re-stating the full IN-list is the
-- established pattern (0054) for a taxonomy bump under the text+CHECK posture —
-- ALTER TYPE ... ADD VALUE can't run inside a transaction.

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
		'ticket_opened',
		'ticket_replied',
		'ticket_escalated',
		'ticket_resolved'
	));

CREATE TABLE IF NOT EXISTS project_review_assignments (
	assignment_id text NOT NULL,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	assignee_user_id text NOT NULL,
	assignee_handle text,
	target_lang text,
	page_indexes integer[] NOT NULL DEFAULT '{}',
	status text NOT NULL,
	priority text,
	assigned_by text,
	due_at timestamptz,
	instructions text,
	cancel_reason text,
	cancelled_by text,
	cancelled_at timestamptz,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, assignment_id)
);

CREATE INDEX IF NOT EXISTS project_review_assignments_project_status_idx
	ON project_review_assignments(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS project_review_assignments_assignee_idx
	ON project_review_assignments(assignee_user_id, status)
	WHERE status <> 'cancelled';
