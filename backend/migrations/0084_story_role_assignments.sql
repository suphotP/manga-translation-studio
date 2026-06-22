-- 0084 — Series-level duty assignments.
--
-- A story ("series") is a VIRTUAL grouping of chapter projects that share
-- projects.metadata->>'storyId' (0069) — there is no stories table to hang a
-- per-row FK on. A series-level duty therefore lives in its own table keyed
-- (workspace_id, story_id, user_id) and is resolved AT READ TIME against each
-- chapter of that story, so it automatically applies to chapters created in
-- the future with zero backfill writes. A chapter-level role (the ProjectState
-- `chapterTeam` slice) overrides the series-level duty on conflict.
--
-- `role` is the chapter-team duty vocabulary minus `guest` (a series-level
-- "no duty" assignment is just the row's absence). text + CHECK, per the
-- established no-ENUM posture.

CREATE TABLE IF NOT EXISTS story_role_assignments (
	workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
	story_id text NOT NULL,
	user_id text NOT NULL,
	role text NOT NULL CHECK (role IN ('translator', 'cleaner', 'typesetter', 'qc')),
	assigned_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (workspace_id, story_id, user_id)
);

-- Inbox resolution: "every series duty THIS user holds in THIS workspace".
CREATE INDEX IF NOT EXISTS story_role_assignments_user_idx
	ON story_role_assignments(workspace_id, user_id);
