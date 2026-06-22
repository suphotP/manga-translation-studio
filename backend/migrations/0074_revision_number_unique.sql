-- 0074 — UNIQUE(project_id, revision_number) on project_revision_requests.
--
-- Codex P2 (PR #395): the 0072 mirror table for revision send-back requests
-- (project_revision_requests) keys on (project_id, revision_id) but lacked a
-- uniqueness guarantee on the human-facing (project_id, revision_number) pair.
-- Duplicate numbers are already prevented upstream — the canonical source of
-- truth is the project state JSON slice `revisionRequests`, and the
-- file-state + CAS write path allocates the next revision_number atomically per
-- project — so this index is parity hardening that makes the Postgres mirror
-- enforce what the canonical path already guarantees.
--
-- Idempotent (IF NOT EXISTS) and safe to apply on an existing populated table:
-- because dup (project_id, revision_number) rows cannot exist via the canonical
-- allocation path, the index build will succeed on real data. (If a corrupt
-- corpus ever held a duplicate, this build would surface it loudly rather than
-- silently — which is the intended hardening.)

CREATE UNIQUE INDEX IF NOT EXISTS project_revision_requests_project_number_key
	ON project_revision_requests(project_id, revision_number);
