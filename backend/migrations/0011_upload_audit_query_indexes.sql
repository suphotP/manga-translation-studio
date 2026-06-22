CREATE INDEX IF NOT EXISTS upload_audit_project_created_id_idx
	ON upload_audit_events(project_id, created_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS upload_audit_project_source_created_idx
	ON upload_audit_events(project_id, actor_source, created_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS upload_audit_project_actor_created_idx
	ON upload_audit_events(project_id, actor_user_id, created_at DESC, audit_id DESC)
	WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS upload_audit_project_image_created_idx
	ON upload_audit_events(project_id, image_id, created_at DESC, audit_id DESC);
