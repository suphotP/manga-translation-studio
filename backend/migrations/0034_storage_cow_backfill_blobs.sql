-- Backfill content_blobs from legacy asset_records physical columns.
-- This migration is intentionally additive; it does not delete or rewrite
-- asset_records yet.

INSERT INTO content_blobs (
	sha256,
	byte_size,
	mime_type,
	storage_driver,
	storage_key,
	ref_count,
	first_seen_at,
	last_referenced_at
)
SELECT
	decode(asset_records.sha256, 'hex') AS sha256,
	MAX(asset_records.byte_size) AS byte_size,
	MAX(asset_records.mime_type) AS mime_type,
	MAX(asset_records.storage_driver) AS storage_driver,
	MAX(asset_records.storage_key) AS storage_key,
	COUNT(*) AS ref_count,
	MIN(asset_records.created_at) AS first_seen_at,
	MAX(asset_records.updated_at) AS last_referenced_at
FROM asset_records
WHERE asset_records.sha256 IS NOT NULL
	AND asset_records.sha256 <> ''
GROUP BY decode(asset_records.sha256, 'hex')
ON CONFLICT (sha256) DO UPDATE SET
	ref_count = GREATEST(content_blobs.ref_count, EXCLUDED.ref_count),
	byte_size = EXCLUDED.byte_size,
	mime_type = EXCLUDED.mime_type,
	storage_driver = EXCLUDED.storage_driver,
	storage_key = EXCLUDED.storage_key,
	last_referenced_at = GREATEST(content_blobs.last_referenced_at, EXCLUDED.last_referenced_at);

INSERT INTO asset_versions (
	asset_id,
	parent_version_id,
	sha256,
	branch,
	account_kind,
	account_id,
	created_by_user_id,
	created_at
)
SELECT
	asset_records.id,
	NULL,
	decode(asset_records.sha256, 'hex'),
	'master',
	-- Match the RUNTIME ledger the CoW write/promote paths use (Codex P2:
	-- "Backfill personal assets onto owner ledgers"). A WORKSPACE-owned asset is
	-- charged to its workspace account; a PERSONAL project (no workspace) is
	-- charged to the OWNING USER. Backfilling personal masters as a synthetic
	-- workspace account meant they were never counted on the owner's
	-- user_storage_accounts ledger, so /api/quota/user and user freeze omitted
	-- all pre-CoW personal bytes until the asset was later touched/promoted.
	CASE
		WHEN COALESCE(asset_records.workspace_id, projects.workspace_id) IS NOT NULL
			THEN 'workspace'
		WHEN projects.owner_user_id IS NOT NULL
			THEN 'user'
		ELSE 'workspace'
	END,
	CASE
		WHEN COALESCE(asset_records.workspace_id, projects.workspace_id) IS NOT NULL
			THEN COALESCE(asset_records.workspace_id, projects.workspace_id)
		WHEN projects.owner_user_id IS NOT NULL
			THEN projects.owner_user_id
		-- Truly ownerless legacy project: fall back to the project id as a
		-- synthetic workspace account (no real owner to charge).
		ELSE asset_records.project_id
	END,
	NULL,
	asset_records.created_at
FROM asset_records
LEFT JOIN projects ON projects.project_id = asset_records.project_id
WHERE asset_records.sha256 IS NOT NULL
	AND asset_records.sha256 <> ''
ON CONFLICT DO NOTHING;
