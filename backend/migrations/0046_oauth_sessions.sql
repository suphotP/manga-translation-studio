CREATE TABLE IF NOT EXISTS auth_external_identities (
	user_id text NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE,
	provider text NOT NULL,
	provider_user_id text NOT NULL,
	email_verified boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS auth_external_identities_user_idx
	ON auth_external_identities(user_id, provider, updated_at DESC);

INSERT INTO auth_external_identities (
	user_id,
	provider,
	provider_user_id,
	email_verified,
	created_at,
	updated_at
)
SELECT
	user_id,
	auth_provider,
	external_subject,
	email_verified,
	created_at,
	updated_at
FROM auth_users
WHERE auth_provider <> 'local'
	AND external_subject IS NOT NULL
ON CONFLICT (provider, provider_user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS oauth_link_intent_tokens (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE,
	provider text NOT NULL,
	provider_user_id text NOT NULL,
	token_hash text NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_link_intent_tokens_user_active_idx
	ON oauth_link_intent_tokens(user_id, expires_at DESC)
	WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS oauth_link_intent_tokens_provider_idx
	ON oauth_link_intent_tokens(provider, provider_user_id, created_at DESC);
