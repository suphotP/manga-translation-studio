-- Authz/data-integrity (#356 re-review P1): expression index backing the
-- AUTHORITATIVE storyId-ownership lookup used by the create-project gate.
--
-- A client-supplied `storyId` ("add a chapter to an existing story") must be
-- classified against the create's scope so a crafted caller cannot stamp a
-- chapter with a storyId owned by ANOTHER workspace/owner (the Library groups
-- purely by storyId and would silently merge it). The previous classifier
-- scanned the caller's VISIBLE project list and STOPPED after a cap (1000) —
-- a caller who could see more than that many projects could reuse a foreign
-- storyId that sorts after the cap, the scan missed it, and the create
-- persisted the cross-workspace merge. The classifier now resolves ownership
-- AUTHORITATIVELY via PostgresProjectCatalogStore.resolveStoryIdOwnership:
--   SELECT workspace_id, owner_user_id, metadata
--   FROM projects
--   WHERE deleted_at IS NULL AND metadata->>'storyId' = $1
-- which is an UNSCOPED, UNCAPPED point lookup on the storyId. This expression
-- index turns that probe into an index scan instead of a full-table seqscan
-- (mirrors workspace_billing_accounts_dodo_payment_id_idx in 0051_perf_indexes).
--
-- Plain (non-partial) expression index: the served query filters on
-- `metadata->>'storyId' = $1` and carries no `metadata ? 'storyId'` predicate,
-- so a partial index with that WHERE clause would not be matched by the
-- planner. Indexing every row (absent keys index a NULL — cheap, never matched
-- by an `= $1` probe) keeps the index expression identical to the query's
-- extraction (`->>'storyId'`), so this is a true point lookup.
CREATE INDEX IF NOT EXISTS projects_story_id_idx
	ON projects((metadata->>'storyId'))
	WHERE deleted_at IS NULL;
