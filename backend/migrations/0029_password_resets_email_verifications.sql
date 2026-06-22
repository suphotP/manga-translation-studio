CREATE TABLE IF NOT EXISTS password_resets (
	id uuid PRIMARY KEY,
	token_hash text NOT NULL UNIQUE,
	user_id text NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE,
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	ip_address inet,
	user_agent text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_created_idx
	ON password_resets(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS password_resets_active_expiry_idx
	ON password_resets(expires_at)
	WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
	id uuid PRIMARY KEY,
	token_hash text NOT NULL UNIQUE,
	user_id text NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE,
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	ip_address inet,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_user_created_idx
	ON email_verification_tokens(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS email_verification_tokens_active_expiry_idx
	ON email_verification_tokens(expires_at)
	WHERE used_at IS NULL;
