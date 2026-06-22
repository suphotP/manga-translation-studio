-- Usage ledger team/user attribution (roadmap: per-user usage attribution).
-- Adds an authenticated-actor column to usage_events so AI credit
-- reservations/capture/release can be attributed to the user who triggered them.
-- The actor is always derived from the authenticated session in the API layer,
-- never from a client-supplied header. Upload/export attribution is a noted
-- follow-up and intentionally out of scope here.

ALTER TABLE usage_events
	ADD COLUMN IF NOT EXISTS actor_user_id text;

-- Supports per-actor usage lookups within a workspace, mirroring the
-- audit_events(workspace_id, actor_user_id, created_at DESC) access pattern.
CREATE INDEX IF NOT EXISTS usage_events_workspace_actor_time_idx
	ON usage_events(workspace_id, actor_user_id, created_at DESC, event_id DESC)
	WHERE actor_user_id IS NOT NULL;
