CREATE TABLE IF NOT EXISTS auth_login_failures (
	id bigserial PRIMARY KEY,
	email text NOT NULL,
	ip text,
	failure_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_login_failures_email_failure_at_idx
	ON auth_login_failures (email, failure_at DESC);

CREATE INDEX IF NOT EXISTS auth_login_failures_failure_at_idx
	ON auth_login_failures (failure_at);
