-- Concurrent-edit Phase 1: per-tab/session identity for work locks.
--
-- The soft-lease model needs to tell apart the SAME user's two browser tabs so
-- a second tab does not silently inherit the first tab's lease and clobber it.
-- We record an opaque per-tab client id alongside the owner. Acquire treats a
-- same-owner / same-client re-acquire as idempotent (heartbeat), but a
-- same-owner / different-client acquire as a same-user-tab conflict that the
-- caller must resolve with an explicit takeover. Different users keep the
-- existing hard lock_conflict.
--
-- Nullable + no new constraint so existing rows and any caller that omits a
-- client id keep working exactly as before (treated as a single anonymous tab).

ALTER TABLE work_locks
	ADD COLUMN IF NOT EXISTS client_id text;
