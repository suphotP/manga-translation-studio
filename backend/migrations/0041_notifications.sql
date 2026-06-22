-- Wave 2 W2.5: durable user-scoped notifications backing the topbar bell + the
-- workspace notification panel. Mirrors the same posture used by
-- workspace_billing_accounts / asset_records / upload_audit_events: no hard FK
-- to projects or workspaces (prototype/file mode workspaces only exist as JSON
-- on disk), nullable workspace_id, typed enum payload.
--
-- The frontend consumes this table through:
--   GET    /api/notifications?limit=20&before=<id>&unread_only=true
--   POST   /api/notifications/:id/read
--   POST   /api/notifications/mark-all-read
--   GET    /api/notifications/unread-count
--
-- Indexes are sized for two read paths:
--   (1) unread badge / panel head — user_id where read_at IS NULL, newest first
--   (2) full panel + /notifications page — user_id, newest first (any read state)

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
		CREATE TYPE notification_type AS ENUM (
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
			'team_member_joined'
		);
	END IF;
END $$;

CREATE TABLE IF NOT EXISTS notifications (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id text NOT NULL,
	workspace_id text,
	type notification_type NOT NULL,
	title text NOT NULL,
	body text,
	link_url text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	read_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Unread badge / "what's new" head: this is the hottest read path and it MUST
-- stay cheap as a user accumulates notifications.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
	ON notifications (user_id, created_at DESC, id DESC)
	WHERE read_at IS NULL;

-- Full panel + /notifications page paginate over (user_id, created_at, id).
-- id is tie-broken DESC so the cursor (before=<id>) is deterministic when two
-- rows share the same created_at.
CREATE INDEX IF NOT EXISTS idx_notifications_user_all
	ON notifications (user_id, created_at DESC, id DESC);
