-- Stream C PR-1: additive per-language track anchors.
--
-- `target_locale` remains the existing primary/default track. The new nullable
-- columns let later API/UI changes scope AI jobs, exports, and tasks by language
-- without rewriting existing JSON payloads or changing current project filters.

ALTER TABLE projects
	ADD COLUMN IF NOT EXISTS target_locales text[];

UPDATE projects
SET target_locales = ARRAY[target_locale]::text[]
WHERE target_locales IS NULL
	AND target_locale IS NOT NULL;

UPDATE projects
SET target_locales = '{}'::text[]
WHERE target_locales IS NULL;

ALTER TABLE ai_jobs
	ADD COLUMN IF NOT EXISTS target_lang text;

UPDATE ai_jobs
SET target_lang = NULLIF(metadata->>'lang', '')
WHERE target_lang IS NULL
	AND NULLIF(metadata->>'lang', '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_jobs_project_target_lang_status_idx
	ON ai_jobs(project_id, target_lang, status);

ALTER TABLE export_jobs
	ADD COLUMN IF NOT EXISTS target_lang text;

UPDATE export_jobs
SET target_lang = NULLIF(params->>'targetLang', '')
WHERE target_lang IS NULL
	AND NULLIF(params->>'targetLang', '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS export_jobs_project_target_lang_created_idx
	ON export_jobs(project_id, target_lang, created_at DESC);

ALTER TABLE project_tasks
	ADD COLUMN IF NOT EXISTS target_lang text;

CREATE INDEX IF NOT EXISTS project_tasks_project_target_lang_status_idx
	ON project_tasks(project_id, target_lang, status, priority, page_index);
