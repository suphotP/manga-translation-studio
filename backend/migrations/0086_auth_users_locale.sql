ALTER TABLE auth_users
	ADD COLUMN IF NOT EXISTS locale text;

ALTER TABLE auth_users
	DROP CONSTRAINT IF EXISTS auth_users_locale_supported_check;

ALTER TABLE auth_users
	ADD CONSTRAINT auth_users_locale_supported_check
	CHECK (locale IS NULL OR locale IN ('th', 'en', 'id', 'ms'));

COMMENT ON COLUMN auth_users.locale IS
	'Optional UI locale preference for signed-in users. Local device choice remains in frontend storage; this syncs the preference across sessions/devices.';
