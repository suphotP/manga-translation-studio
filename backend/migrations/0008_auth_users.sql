CREATE TABLE IF NOT EXISTS auth_users (
	user_id text PRIMARY KEY,
	email text NOT NULL,
	email_normalized text NOT NULL UNIQUE,
	password_hash text NOT NULL,
	name text NOT NULL,
	role text NOT NULL,
	auth_provider text NOT NULL DEFAULT 'local',
	external_subject text,
	email_verified boolean NOT NULL DEFAULT false,
	is_active boolean NOT NULL DEFAULT true,
	last_login_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_external_identity_idx
	ON auth_users(auth_provider, external_subject)
	WHERE auth_provider <> 'local' AND external_subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS auth_users_active_role_idx
	ON auth_users(is_active, role, created_at DESC);
