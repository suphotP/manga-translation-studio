-- 0088 — Multi-duty per member per story.
--
-- The original PK (workspace_id, story_id, user_id) allowed exactly ONE duty
-- per member per series. Real teams hand one person several jobs on the same
-- series (e.g. แปล + ลงคำ), so the duty key now INCLUDES `role`: a member can
-- hold any subset of the four duties on a story, one row per held duty.
--
-- The resolver (story-duties.ts) accumulates every matching row into the
-- member's duty set; a chapter-team override still wins per chapter. Idempotent
-- so a re-run is a no-op; existing single-duty rows survive unchanged (the new
-- PK is a strict superset of the old key, so no row collides).

ALTER TABLE story_role_assignments
	DROP CONSTRAINT IF EXISTS story_role_assignments_pkey;

ALTER TABLE story_role_assignments
	ADD CONSTRAINT story_role_assignments_pkey
	PRIMARY KEY (workspace_id, story_id, user_id, role);
