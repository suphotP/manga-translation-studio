-- Wave 3 W3.10: server-side export pipeline.
--
-- `export_jobs` is the durable record of a server-side render/optimization run.
-- The pipeline reads project source images (NEVER mutating them), produces a
-- web-optimized derivative under an `exports/` key in object storage, and mints
-- a short-TTL signed URL for direct client download. Job lifecycle:
--   queued -> processing -> done | error
--
-- `export_presets` lets a workspace persist named, reusable export configs
-- (e.g. a house "Web reader @ q82") on top of the built-in presets.
--
-- Following the relaxed posture used by asset_records (0021) and
-- upload_audit_events (0003): no hard FK to projects/workspaces, because in
-- prototype/file mode those rows may only exist as JSON on disk. workspace_id /
-- project_id are plain text and workspace-scoped reads filter on them.

CREATE TABLE IF NOT EXISTS export_jobs (
	id text PRIMARY KEY,
	workspace_id text,
	project_id text NOT NULL,
	chapter_id text,
	requested_by text,
	-- Built-in pipeline preset selected for this run.
	preset text NOT NULL,
	-- queued | processing | done | error
	status text NOT NULL DEFAULT 'queued',
	-- Object-storage key of the produced derivative (exports/...). NULL until done.
	result_key text,
	-- Short-TTL signed URL minted when the job completes. Nullable and ephemeral:
	-- it expires, so it is regenerated on read rather than trusted long-term.
	result_signed_url text,
	-- Failure detail when status = error.
	error text,
	-- Resolved render parameters (preset config + any per-request overrides) and
	-- the produced manifest/output metadata.
	params jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	completed_at timestamptz
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'export_jobs_status_check'
	) THEN
		ALTER TABLE export_jobs
			ADD CONSTRAINT export_jobs_status_check
			CHECK (status IN ('queued', 'processing', 'done', 'error')) NOT VALID;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'export_jobs_preset_check'
	) THEN
		ALTER TABLE export_jobs
			ADD CONSTRAINT export_jobs_preset_check
			CHECK (preset IN ('master', 'web_reader', 'webtoon_split', 'mobile', 'webp_avif')) NOT VALID;
	END IF;
END $$;

-- Listing a project's exports newest-first, tie-broken by id for a stable cursor.
CREATE INDEX IF NOT EXISTS export_jobs_project_created_id_idx
	ON export_jobs(project_id, created_at DESC, id DESC);

-- Workspace-scoped listing / accounting.
CREATE INDEX IF NOT EXISTS export_jobs_workspace_idx
	ON export_jobs(workspace_id)
	WHERE workspace_id IS NOT NULL;

-- The processor claims queued jobs; index the queue scan.
CREATE INDEX IF NOT EXISTS export_jobs_status_created_idx
	ON export_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS export_presets (
	id text PRIMARY KEY,
	workspace_id text NOT NULL,
	name text NOT NULL,
	config jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Presets are always listed within a workspace; a name is unique per workspace
-- so a saved preset can be referenced by name and re-saving upserts it.
CREATE UNIQUE INDEX IF NOT EXISTS export_presets_workspace_name_idx
	ON export_presets(workspace_id, name);
