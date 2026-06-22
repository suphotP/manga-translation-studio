-- Support/notifications wave — flexible notification preferences + a future-proof
-- notification taxonomy.
--
-- Two concerns land together because they are coupled by the type taxonomy:
--
-- (a) notification_preferences — a SPARSE per-user override table. A row only
--     exists when a user has explicitly turned a (type × channel) on/off. The
--     code-side DEFAULT_CHANNEL_PREFS supplies the default for every absent row
--     (opt-out model: absent row = the coded default, almost always "on" for
--     in_app). No hard FK to a users table — same file/postgres-dual posture as
--     notifications / workspace_billing_accounts (workspace+user identity lives
--     in JSON on disk in file mode), so we key on a plain text user_id.
--
-- (b) notifications.type enum → text + CHECK conversion. migrations.ts wraps
--     every migration in a transaction (client.begin(run)), and Postgres forbids
--     `ALTER TYPE ... ADD VALUE` inside a transaction block. The 0041 enum
--     therefore makes adding a notification type (ticket_opened, work_assigned,
--     …) an impossible-in-a-normal-migration operation. Converting the column to
--     text + a CHECK constraint (the project_tasks text-status precedent) removes
--     that wall permanently: a new type is a one-line CHECK swap, never enum
--     surgery. The conversion is reversible (recreate the enum + cast back) and
--     preserves every existing row because each existing enum label is included
--     verbatim in the new CHECK list.
--
-- NOTE: the 0041 file header has a code-comment bug — it repeatedly calls the
-- enum "the 0028 migration enum"; the enum is actually defined in 0041. The
-- conversion below makes that comment moot (the enum is gone afterwards).

-- ── (b) Convert notifications.type from enum to text + CHECK ──────────────────
-- gen_random_uuid()/DEFAULT on type was never set, so there is no default to
-- drop. Cast the enum column to text in place (USING type::text preserves every
-- existing label), then add the CHECK with the full taxonomy INCLUDING the new
-- support/work types, then retire the now-unused enum type.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_name = 'notifications'
		  AND column_name = 'type'
		  AND udt_name = 'notification_type'
	) THEN
		ALTER TABLE notifications
			ALTER COLUMN type TYPE text USING type::text;
	END IF;
END $$;

-- Drop any prior CHECK so re-running (idempotent migrations posture) or a future
-- taxonomy bump can replace it without colliding on the constraint name.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
	ADD CONSTRAINT notifications_type_check CHECK (type IN (
		-- existing 0041 values (preserved verbatim so every existing row stays valid)
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
		-- new types unblocked by the text+CHECK conversion
		'task_assigned',
		'work_assigned',
		'ticket_opened',
		'ticket_replied',
		'ticket_escalated',
		'ticket_resolved'
	));

-- The enum type is no longer referenced by any column once the cast above runs.
-- Drop it so future type additions never tempt anyone back into ALTER TYPE.
DROP TYPE IF EXISTS notification_type;

-- ── (a) notification_preferences (sparse override rows) ───────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
	user_id text NOT NULL,
	notification_type text NOT NULL,
	channel text NOT NULL CHECK (channel IN ('email', 'in_app')),
	enabled boolean NOT NULL DEFAULT true,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, notification_type, channel)
);

-- All reads are "give me every override row for this user" (we merge with the
-- coded defaults in app code), and the PK already leads with user_id, so the PK
-- index covers that lookup — no extra index needed.
