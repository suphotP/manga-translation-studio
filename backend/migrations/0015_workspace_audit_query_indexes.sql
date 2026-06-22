CREATE INDEX IF NOT EXISTS audit_events_workspace_created_id_idx
	ON audit_events(workspace_id, created_at DESC, audit_event_id DESC);

CREATE INDEX IF NOT EXISTS audit_events_workspace_action_created_idx
	ON audit_events(workspace_id, action, created_at DESC, audit_event_id DESC);

CREATE INDEX IF NOT EXISTS audit_events_workspace_entity_created_idx
	ON audit_events(workspace_id, entity_type, created_at DESC, audit_event_id DESC);

CREATE INDEX IF NOT EXISTS audit_events_workspace_actor_created_idx
	ON audit_events(workspace_id, actor_user_id, created_at DESC, audit_event_id DESC)
	WHERE actor_user_id IS NOT NULL;
