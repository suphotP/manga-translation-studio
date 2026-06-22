-- Back-office: durable PostgresGdprStore — admin audit + impersonation.
--
-- The base tables (admin_audit, impersonation_events) were created in migration
-- 0044_gdpr_consent. This migration is the durable-back-office follow-up:
--   * Adds admin_audit.actor_role so EVERY audit row captures the platform role
--     of the acting admin (owner / admin / support / accountant) at the time of
--     the action — answering "who, in what capacity" without re-resolving the
--     user, and surviving a later role change without rewriting history.
--   * Re-asserts impersonation_events with the exact shape the store expects
--     (admin, target, started_at, ended_at), idempotently, so a fresh database
--     that has not run 0044 still gets the table.
--   * Re-asserts the read indexes the PostgresGdprStore relies on
--     (created_at DESC, actor, target) so audit queries stay index-driven.
--
-- Everything is ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE
-- INDEX IF NOT EXISTS, so it is safe to apply whether or not 0044 already ran.

-- ── admin_audit ───────────────────────────────────────────────────
-- 0044 created admin_audit without actor_role; add it now. Nullable so legacy
-- rows and synthetic/system actors (no resolvable role) remain valid.
CREATE TABLE IF NOT EXISTS admin_audit (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	admin_user_id text NOT NULL,
	actor_role text,
	action text NOT NULL,
	target_kind text,
	target_id text,
	detail jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS actor_role text;

CREATE INDEX IF NOT EXISTS admin_audit_created_at_idx
	ON admin_audit(created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_admin_idx
	ON admin_audit(admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_action_idx
	ON admin_audit(action, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_target_idx
	ON admin_audit(target_kind, target_id, created_at DESC)
	WHERE target_id IS NOT NULL;

-- Filtering by the acting role ("all support-staff actions") is a back-office
-- view we want index-driven too.
CREATE INDEX IF NOT EXISTS admin_audit_actor_role_idx
	ON admin_audit(actor_role, created_at DESC)
	WHERE actor_role IS NOT NULL;

-- ── impersonation_events ──────────────────────────────────────────
-- admin = admin_user_id, target = impersonated_user_id, started_at / ended_at.
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
