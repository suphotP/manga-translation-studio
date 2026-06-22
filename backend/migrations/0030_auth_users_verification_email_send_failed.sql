ALTER TABLE auth_users
	ADD COLUMN IF NOT EXISTS verification_email_send_failed boolean NOT NULL DEFAULT false;

