CREATE INDEX IF NOT EXISTS project_tasks_project_updated_idx
	ON project_tasks(project_id, updated_at DESC, task_id DESC);

CREATE INDEX IF NOT EXISTS project_tasks_project_status_updated_idx
	ON project_tasks(project_id, status, updated_at DESC, task_id DESC);

CREATE INDEX IF NOT EXISTS project_tasks_project_type_updated_idx
	ON project_tasks(project_id, type, updated_at DESC, task_id DESC);

CREATE INDEX IF NOT EXISTS project_tasks_project_assignee_updated_idx
	ON project_tasks(project_id, assignee_user_id, updated_at DESC, task_id DESC)
	WHERE assignee_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_tasks_project_page_updated_idx
	ON project_tasks(project_id, page_index, updated_at DESC, task_id DESC);

CREATE INDEX IF NOT EXISTS project_comments_project_updated_idx
	ON project_comments(project_id, updated_at DESC, comment_id DESC);

CREATE INDEX IF NOT EXISTS project_comments_project_page_updated_idx
	ON project_comments(project_id, page_index, updated_at DESC, comment_id DESC);

CREATE INDEX IF NOT EXISTS project_comments_project_layer_updated_idx
	ON project_comments(project_id, layer_id, updated_at DESC, comment_id DESC)
	WHERE layer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_comments_project_author_updated_idx
	ON project_comments(project_id, author_user_id, updated_at DESC, comment_id DESC)
	WHERE author_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_review_decisions_project_updated_idx
	ON project_review_decisions(project_id, updated_at DESC, review_decision_id DESC);

CREATE INDEX IF NOT EXISTS project_review_decisions_project_status_updated_idx
	ON project_review_decisions(project_id, status, updated_at DESC, review_decision_id DESC);

CREATE INDEX IF NOT EXISTS project_review_decisions_project_actor_updated_idx
	ON project_review_decisions(project_id, actor_user_id, updated_at DESC, review_decision_id DESC)
	WHERE actor_user_id IS NOT NULL;
