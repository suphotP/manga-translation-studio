-- Storage copy-on-write foundation.
--
-- Repo compatibility note: existing IDs in this schema are text UUID strings
-- (`auth_users.user_id`, `workspaces.workspace_id`, `asset_records.asset_id`).
-- We add a stable UUID surrogate to asset_records for version rows while
-- keeping the existing project-scoped natural key intact during expand/backfill.

ALTER TABLE asset_records
	ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();

UPDATE asset_records
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE asset_records
	ALTER COLUMN id SET NOT NULL;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'asset_records_id_key'
	) THEN
		ALTER TABLE asset_records
			ADD CONSTRAINT asset_records_id_key UNIQUE (id);
	END IF;
END $$;

CREATE TABLE IF NOT EXISTS content_blobs (
	sha256 bytea PRIMARY KEY,
	byte_size bigint NOT NULL,
	mime_type text NOT NULL,
	storage_driver text NOT NULL,
	storage_key text NOT NULL,
	ref_count bigint NOT NULL DEFAULT 0,
	first_seen_at timestamptz DEFAULT now(),
	last_referenced_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_blobs_orphan
	ON content_blobs (sha256)
	WHERE ref_count = 0;

CREATE TABLE IF NOT EXISTS asset_versions (
	version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	asset_id uuid NOT NULL REFERENCES asset_records(id) ON DELETE CASCADE,
	parent_version_id uuid REFERENCES asset_versions(version_id),
	sha256 bytea NOT NULL REFERENCES content_blobs(sha256),
	branch text NOT NULL CHECK (branch IN ('master', 'working_copy')),
	account_kind text NOT NULL CHECK (account_kind IN ('workspace', 'user')),
	account_id text NOT NULL,
	created_by_user_id text REFERENCES auth_users(user_id),
	created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_versions_asset
	ON asset_versions (asset_id);

CREATE INDEX IF NOT EXISTS idx_asset_versions_chain
	ON asset_versions (parent_version_id);

CREATE INDEX IF NOT EXISTS idx_asset_versions_account
	ON asset_versions (account_kind, account_id, created_at DESC);

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_account_kind') THEN
		CREATE TYPE asset_account_kind AS ENUM ('workspace', 'user');
	END IF;
END $$;

CREATE TABLE IF NOT EXISTS asset_refs (
	account_kind asset_account_kind NOT NULL,
	account_id text NOT NULL,
	sha256 bytea NOT NULL REFERENCES content_blobs(sha256),
	ref_count bigint NOT NULL DEFAULT 1,
	added_at timestamptz DEFAULT now(),
	PRIMARY KEY (account_kind, account_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_asset_refs_account
	ON asset_refs (account_kind, account_id);

CREATE TABLE IF NOT EXISTS user_storage_accounts (
	user_id text PRIMARY KEY REFERENCES auth_users(user_id),
	used_bytes bigint NOT NULL DEFAULT 0,
	limit_bytes bigint NOT NULL,
	plan_tier text NOT NULL,
	frozen_at timestamptz,
	warned_at timestamptz
);

ALTER TABLE workspace_billing_accounts
	ADD COLUMN IF NOT EXISTS storage_used_bytes bigint NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS storage_limit_bytes bigint NOT NULL DEFAULT 1073741824,
	ADD COLUMN IF NOT EXISTS storage_frozen_at timestamptz;
