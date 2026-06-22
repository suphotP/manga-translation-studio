-- Persistent asset registry: moves the per-project assets.json index into a
-- DB-backed table so uploaded originals and AI outputs (their size/hash/
-- dimensions, moderation verdict, and derivative plan) survive beyond local
-- prototype storage. Mirrors the file|postgres toggle used by upload_audit,
-- project_catalog, auth, and the usage ledger.
--
-- No hard FK to projects/workspaces: the asset registry is its own source of
-- truth and, in prototype/file mode, project + workspace rows may only exist as
-- JSON on disk. This matches the relaxed posture applied to upload_audit_events
-- in 0003 (its project FK was dropped). workspace_id is nullable and best-effort.
CREATE TABLE IF NOT EXISTS asset_records (
	asset_id text NOT NULL,
	project_id text NOT NULL,
	workspace_id text,
	image_id text NOT NULL,
	original_name text NOT NULL,
	mime_type text NOT NULL,
	-- "purpose"/kind of the asset: human upload vs ai_job output vs system, etc.
	-- Sourced from the asset actor's source so AI outputs are queryable.
	kind text NOT NULL DEFAULT 'human',
	sha256 text NOT NULL,
	byte_size bigint NOT NULL DEFAULT 0,
	width integer,
	height integer,
	storage_driver text NOT NULL,
	storage_key text NOT NULL,
	storage_status text NOT NULL,
	-- Moderation verdict is persisted in the DB record (previously it only lived
	-- inside the JSON asset record): status + provider + reason + categories.
	moderation_status text NOT NULL,
	moderation_provider text,
	moderation_reason text,
	moderation_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
	-- When moderation last ran. Persisted separately from updated_at because the
	-- row's updated_at advances for non-moderation reasons (e.g. derivative
	-- upserts), which would otherwise corrupt the moderation checkedAt timestamp.
	moderation_checked_at timestamptz,
	-- Derivative plan/metadata (moderation tiles, thumbnails) and the asset actor.
	derivatives jsonb NOT NULL DEFAULT '[]'::jsonb,
	uploaded_by jsonb,
	upload_audit_id text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, asset_id)
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'asset_records_byte_size_check'
	) THEN
		ALTER TABLE asset_records
			ADD CONSTRAINT asset_records_byte_size_check
			CHECK (byte_size >= 0) NOT VALID;
	END IF;
END $$;

-- Browsing assets is always scoped by project, newest first, tie-broken by id
-- to match the file store's stable cursor ordering.
CREATE INDEX IF NOT EXISTS asset_records_project_created_id_idx
	ON asset_records(project_id, created_at DESC, asset_id DESC);

-- Workspace-wide storage accounting aggregates assets across a workspace.
CREATE INDEX IF NOT EXISTS asset_records_workspace_idx
	ON asset_records(workspace_id)
	WHERE workspace_id IS NOT NULL;

-- Dedupe/lookup by content hash within a project.
CREATE INDEX IF NOT EXISTS asset_records_project_sha256_idx
	ON asset_records(project_id, sha256);
