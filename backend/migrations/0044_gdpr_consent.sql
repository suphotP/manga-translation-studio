-- W2.6 — GDPR (Data Subject Rights), cookie consent, admin audit, impersonation.
--
-- Adds the minimum schema required to ship EU day-1 GDPR obligations:
--   * consent_events: durable log of cookie/legal consent (what categories +
--     policy version a user accepted, with IP/UA evidence). Banked off the
--     primary auth_users row by user_id so anonymous pre-login consents are
--     also recordable (user_id is nullable for that case).
--   * account_export_jobs: queued/processing/ready snapshots for "download
--     all my data" requests, with the signed-URL + expiry for the artifact.
--   * auth_users.deleted_at / delete_grace_until: soft-delete fields for the
--     "delete my account" flow. We keep the row during the grace window so
--     the user can undo, then a separate cron hard-deletes after expiry.
--   * impersonation_events + admin_audit: durable record of sensitive admin
--     actions (impersonation start/end, credit grants, force-deletes…).

CREATE TABLE IF NOT EXISTS consent_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- Nullable: a fresh visitor can record consent before signing in. We backfill
	-- user_id on the next consent capture after login when that happens.
	user_id text,
	-- "cookie" today; "tos", "privacy", "marketing" reserved for future flows so
	-- one table covers every recorded consent.
	consent_type text NOT NULL,
	-- {"necessary":true,"functional":bool,"analytics":bool,"marketing":bool}
	-- for cookie consents; freeform for other types.
	categories jsonb NOT NULL DEFAULT '{}'::jsonb,
	granted_at timestamptz NOT NULL DEFAULT now(),
	ip_address inet,
	user_agent text,
	policy_version text NOT NULL,
	-- Optional anonymous device/visitor id (cookie) used to merge pre-login and
	-- post-login consents for the same browser. Free-form, never trusted.
	device_id text
);

CREATE INDEX IF NOT EXISTS consent_events_user_idx
	ON consent_events(user_id, granted_at DESC)
	WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS consent_events_device_idx
	ON consent_events(device_id, granted_at DESC)
	WHERE device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_export_jobs (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id text NOT NULL,
	status text NOT NULL DEFAULT 'queued',
	-- 'queued' | 'processing' | 'ready' | 'failed' | 'expired'
	zip_url text,
	failure_reason text,
	bytes bigint,
	expires_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS account_export_jobs_user_idx
	ON account_export_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS account_export_jobs_status_idx
	ON account_export_jobs(status, created_at DESC)
	WHERE status IN ('queued', 'processing');

-- Soft-delete columns on auth_users. We use ADD COLUMN IF NOT EXISTS so the
-- migration is safe to re-apply in environments that already ran a partial
-- rollout. The user-facing email is rewritten to "deleted+<id>@redacted.invalid"
-- when soft-deleted (frees the address for re-registration); the original
-- email is captured in admin_audit for the audit log only.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS delete_grace_until timestamptz;

CREATE INDEX IF NOT EXISTS auth_users_pending_delete_idx
	ON auth_users(delete_grace_until)
	WHERE deleted_at IS NOT NULL AND delete_grace_until IS NOT NULL;

-- Admin impersonation log. Every "log in as this user" action and its matching
-- end event lands here so we can show who-did-what on a workspace timeline.
CREATE TABLE IF NOT EXISTS impersonation_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	admin_user_id text NOT NULL,
	impersonated_user_id text NOT NULL,
	reason text,
	started_at timestamptz NOT NULL DEFAULT now(),
	ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS impersonation_events_admin_idx
	ON impersonation_events(admin_user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS impersonation_events_target_idx
	ON impersonation_events(impersonated_user_id, started_at DESC);

-- Sensitive admin actions outside the per-workspace audit_events table:
-- platform-wide credit grants, refunds, force-deletes, role escalations.
CREATE TABLE IF NOT EXISTS admin_audit (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	admin_user_id text NOT NULL,
	action text NOT NULL,
	target_kind text,
	target_id text,
	-- Captures the human-readable "what changed" payload (old/new values, the
	-- export request id, the refund amount, the redacted email, etc.). Stored
	-- as jsonb so the admin UI can render it without a custom mapper per type.
	detail jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_admin_idx
	ON admin_audit(admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_action_idx
	ON admin_audit(action, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_target_idx
	ON admin_audit(target_kind, target_id, created_at DESC)
	WHERE target_id IS NOT NULL;
