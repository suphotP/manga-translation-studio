-- 0078 — `editing_taken_over` notification type.
--
-- Concurrent-edit Phase 1 cross-user takeover: when an authorized member takes
-- over a page another user is editing, the displaced holder gets a mandatory
-- in-app notice ("Y took over editing page N"). Their stale save is then steered
-- by CAS into the #412 recovery-draft flow rather than silently clobbering the
-- taker. Re-stating the full IN-list is the established pattern (0054 / 0071 /
-- 0072) for a taxonomy bump under the text+CHECK posture — ALTER TYPE ... ADD
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
		'ticket_resolved'
	));
