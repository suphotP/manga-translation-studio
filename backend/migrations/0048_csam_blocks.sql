-- Legal-hold audit table for mandatory CSAM/extreme moderation blocks.
-- Do not cascade-delete these rows from asset cleanup paths; future W4 reporting
-- can use this table as the source for the NCMEC pipeline.

CREATE TABLE IF NOT EXISTS csam_blocks (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	asset_id text,
	sha256 text,
	scores jsonb NOT NULL DEFAULT '{}'::jsonb,
	blocked_at timestamptz NOT NULL DEFAULT now(),
	ip_address text,
	user_agent text,
	workspace_id text
);

CREATE INDEX IF NOT EXISTS csam_blocks_workspace_blocked_idx
	ON csam_blocks(workspace_id, blocked_at DESC)
	WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS csam_blocks_sha256_idx
	ON csam_blocks(sha256)
	WHERE sha256 IS NOT NULL;
