-- 0079 — `account_export_ready` notification type.
--
-- GDPR self-service data export: when a user's export artifact finishes
-- processing, they get an in-app + email notice carrying the (time-limited)
-- signed download link, instead of having to poll the export history. Wiring
-- lives in index.ts (account router `notifyExportReady` -> notify()).
--
-- Re-stating the full IN-list is the established pattern (0054 / 0071 / 0072 /
-- 0078) for a taxonomy bump under the text+CHECK posture — ALTER TYPE ... ADD
-- VALUE can't run inside a transaction.

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
		'editing_taken_over',
		'ticket_opened',
		'ticket_replied',
		'ticket_escalated',
		'ticket_resolved',
		'account_export_ready'
	));
