ALTER TABLE workspace_members
	ADD COLUMN IF NOT EXISTS member_studio_role text;

UPDATE workspace_members
SET member_studio_role = CASE role
	WHEN 'owner' THEN 'owner'
	WHEN 'admin' THEN 'admin'
	WHEN 'editor' THEN 'typesetter'
	ELSE 'guest'
END
WHERE member_studio_role IS NULL;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'workspace_members_studio_role_check'
	) THEN
		ALTER TABLE workspace_members
			ADD CONSTRAINT workspace_members_studio_role_check
			CHECK (member_studio_role IN ('owner', 'admin', 'team_lead', 'translator', 'cleaner', 'typesetter', 'qc', 'guest'));
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_members_studio_role_idx
	ON workspace_members(workspace_id, member_studio_role)
	WHERE disabled_at IS NULL;

UPDATE projects
SET source_locale = COALESCE(
	source_locale,
	NULLIF(metadata->>'sourceLang', ''),
	NULLIF(current_state->>'sourceLang', ''),
	'ja'
)
WHERE source_locale IS NULL;
