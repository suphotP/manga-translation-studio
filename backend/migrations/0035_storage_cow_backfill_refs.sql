-- Backfill account-level references. Workspace-owned assets land on the
-- workspace ledger; personal (workspace-less) projects land on the OWNING
-- user's ledger, matching 0034's asset_versions attribution and the runtime
-- CoW paths (Codex P2: "Backfill personal assets onto owner ledgers").

INSERT INTO asset_refs (
	account_kind,
	account_id,
	sha256,
	ref_count,
	added_at
)
SELECT
	-- Mirror 0034's account resolution exactly so refs land on the SAME ledger
	-- the version rows were charged to.
	(CASE
		WHEN COALESCE(asset_records.workspace_id, projects.workspace_id) IS NOT NULL
			THEN 'workspace'
		WHEN projects.owner_user_id IS NOT NULL
			THEN 'user'
		ELSE 'workspace'
	END)::asset_account_kind,
	CASE
		WHEN COALESCE(asset_records.workspace_id, projects.workspace_id) IS NOT NULL
			THEN COALESCE(asset_records.workspace_id, projects.workspace_id)
		WHEN projects.owner_user_id IS NOT NULL
			THEN projects.owner_user_id
		ELSE asset_records.project_id
	END,
	decode(asset_records.sha256, 'hex'),
	COUNT(*),
	MIN(asset_records.created_at)
FROM asset_records
LEFT JOIN projects ON projects.project_id = asset_records.project_id
WHERE asset_records.sha256 IS NOT NULL
	AND asset_records.sha256 <> ''
GROUP BY
	(CASE
		WHEN COALESCE(asset_records.workspace_id, projects.workspace_id) IS NOT NULL
			THEN 'workspace'
		WHEN projects.owner_user_id IS NOT NULL
			THEN 'user'
		ELSE 'workspace'
	END),
	CASE
		WHEN COALESCE(asset_records.workspace_id, projects.workspace_id) IS NOT NULL
			THEN COALESCE(asset_records.workspace_id, projects.workspace_id)
		WHEN projects.owner_user_id IS NOT NULL
			THEN projects.owner_user_id
		ELSE asset_records.project_id
	END,
	decode(asset_records.sha256, 'hex')
ON CONFLICT (account_kind, account_id, sha256) DO UPDATE SET
	ref_count = asset_refs.ref_count + EXCLUDED.ref_count;

-- Materialize storage_used_bytes for EVERY workspace that owns backfilled refs,
-- including free/prototype workspaces that never had a workspace_billing_accounts
-- row. A plain UPDATE here would skip those workspaces; their pre-CoW bytes would
-- then be excluded from freeze/limit checks until the first later write inserted a
-- fresh used=0 row. Upsert from the usage set instead so existing bytes are
-- counted from the moment the migration runs (Codex P2: "Create quota rows during
-- the backfill"). Only workspaces that actually exist get a billing row (the JOIN
-- on workspaces guards the workspace_billing_accounts -> workspaces FK), so
-- synthetic project-id accounts without a workspace are intentionally skipped.
INSERT INTO workspace_billing_accounts (
	workspace_id,
	plan_id,
	status,
	storage_used_bytes,
	storage_limit_bytes
)
SELECT
	usage.workspace_id,
	'free',
	'mock_active',
	usage.used_bytes,
	1073741824
FROM (
	SELECT
		refs.account_id AS workspace_id,
		COALESCE(SUM(blobs.byte_size), 0) AS used_bytes
	FROM asset_refs refs
	JOIN content_blobs blobs ON blobs.sha256 = refs.sha256
	WHERE refs.account_kind = 'workspace'
	GROUP BY refs.account_id
) AS usage
JOIN workspaces ON workspaces.workspace_id = usage.workspace_id
ON CONFLICT (workspace_id) DO UPDATE SET
	storage_used_bytes = EXCLUDED.storage_used_bytes;

-- Same materialization for USER accounts: personal-project masters are now
-- charged to the owning user (above), so seed used_bytes for every user that
-- owns backfilled refs. Without this, user freeze/limit checks and
-- /api/quota/user/:id would report 0 for pre-CoW personal assets until the
-- first runtime write inserted a fresh used=0 row (Codex P2: "Backfill personal
-- assets onto owner ledgers"). The JOIN on auth_users guards the
-- user_storage_accounts -> auth_users FK so only real users get a row.
INSERT INTO user_storage_accounts (
	user_id,
	used_bytes,
	limit_bytes,
	plan_tier
)
SELECT
	usage.user_id,
	usage.used_bytes,
	1073741824,
	'free'
FROM (
	SELECT
		refs.account_id AS user_id,
		COALESCE(SUM(blobs.byte_size), 0) AS used_bytes
	FROM asset_refs refs
	JOIN content_blobs blobs ON blobs.sha256 = refs.sha256
	WHERE refs.account_kind = 'user'
	GROUP BY refs.account_id
) AS usage
JOIN auth_users ON auth_users.user_id = usage.user_id
ON CONFLICT (user_id) DO UPDATE SET
	used_bytes = EXCLUDED.used_bytes;
