-- 0073 — Pending chapter-team invite INDEX.
--
-- Codex P1 (PR #394): GET /api/project/my/invites previously did a SYNCHRONOUS
-- global disk scan (readdirSync(PROJECTS_DIR) + parse up to 5000 state.json files)
-- on EVERY request, so any verified user hitting the notifications endpoint caused
-- event-loop-blocking read amplification, and invite discovery was incomplete past
-- the first 5000 projects. This table is the bounded, INDEXED lookup that replaces
-- the scan: one row per (project, pending email invite), keyed by the normalized
-- invitee email, so the endpoint resolves a caller's invites with an O(matches)
-- point query instead of a whole-corpus scan.
--
-- The canonical source of truth remains the project state JSON slice
-- `chapterTeam` (file-mode parity is automatic — the file index mirrors the same
-- derivation). This table is the additive, migration-safe Postgres mirror that the
-- route maintains on EVERY project state write (invite create, accept, remove/revoke
-- all flow through writeProjectState → syncPendingInviteIndex). A row exists IFF the
-- corresponding chapterTeam member is still status='pending' with NO linked userId
-- (i.e. an unaccepted email invite); accept/remove drops it via set-replace.
--
-- Security: a row carries ONLY what the invitee needs to recognize + accept the
-- invite (project id, role, inviter display, invitedAt). It never reveals roster
-- contents or whether any OTHER email is invited; the lookup is keyed by the
-- caller's authoritative VERIFIED email only.

CREATE TABLE IF NOT EXISTS project_pending_invites (
	-- Stable chapter-team membership id (so re-invite after removal never collides),
	-- scoped under its project. Matches ChapterTeamMember.id.
	member_id text NOT NULL,
	project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
	-- The invited email, already NORMALIZED (trimmed + lowercased) so the lookup is a
	-- plain equality match — exactly the key GET /my/invites probes with.
	invitee_email text NOT NULL,
	role text NOT NULL,
	-- Actor userId who sent the invite (resolved to a display name at read time).
	invited_by text,
	-- Snapshot of the chapter label at index time (best-effort, for the invitee UI).
	chapter_label text,
	story_title text,
	invited_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, member_id)
);

-- The ONLY read path: list a caller's pending invites by their verified email. The
-- index makes this a bounded point lookup (no global scan, no whole-corpus parse).
CREATE INDEX IF NOT EXISTS project_pending_invites_email_idx
	ON project_pending_invites (invitee_email, invited_at DESC);
