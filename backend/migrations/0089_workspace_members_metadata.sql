-- 0089 — Per-member metadata jsonb (durable stash for "Finish job" / "Reopen").
--
-- "Finish job" demotes a member to a free viewer seat (frees a paid seat) while
-- keeping them in the roster + their scope so they still SEE the work they did.
-- "Reopen" must restore their EXACT prior access role + studio role, so we stash
-- `{ finishedFrom: { role, memberStudioRole }, finishedAt }` here at finish time
-- and read it back on reopen. workspace_invites already carries a `metadata`
-- jsonb (0005), so this mirrors the established shape. Idempotent.

ALTER TABLE workspace_members
	ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
