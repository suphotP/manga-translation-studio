-- Session-invalidation watermark: epoch-ms before which previously-issued access
-- JWTs are no longer trusted. Bumped on password reset/change, account disable,
-- and admin email change so stale access tokens are rejected immediately instead
-- of lingering until expiry. NOTE: migration number may be renumbered at merge.
ALTER TABLE auth_users
	ADD COLUMN IF NOT EXISTS tokens_valid_from_ms bigint NOT NULL DEFAULT 0;
