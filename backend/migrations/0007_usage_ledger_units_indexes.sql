ALTER TABLE usage_events
	ADD COLUMN IF NOT EXISTS amount_units bigint;

CREATE INDEX IF NOT EXISTS usage_events_workspace_subject_kind_idx
	ON usage_events(workspace_id, subject_id, kind, created_at DESC);
