-- Paid storage packs raise a workspace's effective storage quota.
-- Each row is one purchased pack of `pack_size_bytes`; the quota math sums
-- packs that are active and not yet expired. Purchasing/billing/payment
-- integration is intentionally out of scope here: this is only the data model.
CREATE TABLE IF NOT EXISTS storage_packs (
	storage_pack_id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	sku_id text,
	pack_size_bytes bigint NOT NULL DEFAULT 0,
	active boolean NOT NULL DEFAULT true,
	expires_at timestamptz,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'storage_packs_pack_size_bytes_check'
	) THEN
		ALTER TABLE storage_packs
			ADD CONSTRAINT storage_packs_pack_size_bytes_check
			CHECK (pack_size_bytes >= 0) NOT VALID;
	END IF;
END $$;

-- Lookups always scope by workspace, then filter active + unexpired packs.
CREATE INDEX IF NOT EXISTS storage_packs_workspace_active_idx
	ON storage_packs(workspace_id, active, expires_at);
