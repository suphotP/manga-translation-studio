CREATE INDEX IF NOT EXISTS usage_events_workspace_created_idx
	ON usage_events(workspace_id, created_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS usage_events_workspace_kind_created_idx
	ON usage_events(workspace_id, kind, created_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS usage_events_workspace_project_created_idx
	ON usage_events(workspace_id, project_id, created_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS usage_events_workspace_subject_created_idx
	ON usage_events(workspace_id, subject_id, created_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS usage_events_workspace_ai_credit_subject_idx
	ON usage_events(workspace_id, subject_id, kind, created_at DESC)
	WHERE kind IN ('ai_credit_reserved', 'ai_credit_captured', 'ai_credit_released');
