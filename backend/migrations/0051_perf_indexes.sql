-- DB-optimization wave: batched performance indexes.
--
-- This migration is INDEX-ONLY. It adds the missing indexes surfaced by the DB
-- audit so the hottest read/sweep paths are index-served instead of seqscanning
-- (and sorting) the highest-volume tables. Every related query change is shipped
-- separately; this file never alters data, columns, or query code.
--
-- All indexes use IF NOT EXISTS so the migration is idempotent and re-applies
-- cleanly. The migration runner (backend/src/services/migrations.ts) wraps each
-- migration in a single transaction, so CREATE INDEX CONCURRENTLY is NOT used
-- here (it is illegal inside a transaction); on hot prod tables these should be
-- built off-peak or promoted to CONCURRENTLY out-of-band if needed.
--
-- Column/table names below were verified against the schema in earlier
-- migrations (usage_events 0001, auth_users 0008, projects 0001/0004/0017,
-- tm_entries 0038, workspace_billing_accounts 0006, audit_events 0001,
-- auth_sessions 0002, storage_packs 0020, workspace_invites 0005,
-- project_versions 0004).

-- [rank 1, P0] usage_events: partial index matching findReservationWorkspaceId.
-- Serves backend/src/services/usage-ledger.ts:1021-1031 (called from
-- resolveSettlementWorkspaceId on every AI credit settle):
--   SELECT workspace_id FROM usage_events
--   WHERE subject_id=$1 AND project_id=$2 AND kind='ai_credit_reserved'
--   ORDER BY created_at DESC LIMIT 1
-- Every existing usage_events index leads with workspace_id, which this query
-- omits, so without this index the highest-volume table is seqscanned + sorted
-- on every AI capture/release.
CREATE INDEX IF NOT EXISTS usage_events_subject_project_reserved_idx
	ON usage_events(subject_id, project_id, created_at DESC)
	WHERE kind = 'ai_credit_reserved';

-- [rank 2 / rank 12, P0/P3] auth_users: forward-keyset backing for the
-- keyset-paginated admin user list.
-- This index is SHAPED for the keyset-paginated admin user list that lands in a
-- separate PR, whose query is:
--   ... FROM auth_users WHERE (lower(name), user_id) > ($1, $2)
--   ORDER BY lower(name), user_id LIMIT $3
-- The (lower(name), user_id) tuple order is the forward keyset shape that lets
-- both the WHERE tuple-compare and the ORDER BY be served directly from the
-- index (no per-page sort).
-- DELIBERATELY does NOT match today's PostgresAuthUserStore.list query
-- (backend/src/services/auth-users.ts:409-415, ORDER BY lower(name),
-- created_at DESC) — re-shaping this index to (lower(name), created_at) would
-- mismatch the incoming keyset query, so the trailing column stays user_id.
-- NOTE: a trigram index for email/name ILIKE search was intentionally skipped —
-- the pg_trgm extension is not provisioned anywhere in the schema.
CREATE INDEX IF NOT EXISTS auth_users_lower_name_id_idx
	ON auth_users(lower(name), user_id);

-- [rank 3 / rank 9, P1] tm_entries: covering index for the TM keyset scan.
-- Serves backend/src/services/translation-memory.ts:294-332 (listCandidates):
--   SELECT ... FROM tm_entries
--   WHERE workspace_id=$1 AND source_lang=$2 AND target_lang=$3
--     AND (created_at, id) > ($4, $5)
--   ORDER BY created_at ASC, id ASC LIMIT $n
-- The existing tm_entries_workspace_langs_idx (0038) covers only the equality
-- predicate; appending (created_at, id) lets the paginated candidate stream be
-- served directly from the index (no per-page sort) which bounds the scan that
-- can otherwise page through up to 50k wide jsonb rows per TM search.
CREATE INDEX IF NOT EXISTS tm_entries_workspace_langs_created_id_idx
	ON tm_entries(workspace_id, source_lang, target_lang, created_at, id);

-- [rank 10, P2] projects: non-partial keyset index for the global dashboard feed.
-- Serves backend/src/services/project-catalog.ts:760-839 (listProjectSummaryPage),
-- route GET /api/projects (project.ts:1542-1559):
--   ... FROM projects WHERE deleted_at IS NULL
--   AND (projects.updated_at, projects.project_id) < ($2, $3)
--   ORDER BY projects.updated_at DESC, projects.project_id DESC LIMIT $4
-- The only matching index today (projects_current_state_updated_idx, 0017) is
-- PARTIAL on current_state IS NOT NULL, so the unconstrained feed seqscans +
-- sorts every project. This index serves the keyset page directly.
CREATE INDEX IF NOT EXISTS projects_updated_id_active_idx
	ON projects(updated_at DESC, project_id DESC)
	WHERE deleted_at IS NULL;

-- [rank 11, P2] workspace_billing_accounts: expression index for refund/dispute
-- webhook payment lookups. Serves backend/src/services/dodo.service.ts:795-803
-- (findWorkspaceIdByPaymentId):
--   SELECT workspace_id FROM workspace_billing_accounts
--   WHERE metadata->>'dodo_payment_id' = $1 LIMIT 1
-- The table has only its PK + plan_status_idx (0006), so each (retry-amplified)
-- webhook seqscans the table; the expression index turns it into a point lookup.
-- Plain (non-partial) expression index: the served query filters on
-- `metadata->>'dodo_payment_id' = $1` and does NOT carry a `metadata ?
-- 'dodo_payment_id'` predicate, so a partial index with that WHERE clause would
-- not be matched by the planner and would go unused. Indexing every row (absent
-- keys index a NULL — cheap, and never matched by an `= $1` probe) keeps the
-- index expression identical to the query's extraction (`->>'dodo_payment_id'`),
-- so this is a true point lookup.
CREATE INDEX IF NOT EXISTS workspace_billing_accounts_dodo_payment_id_idx
	ON workspace_billing_accounts((metadata->>'dodo_payment_id'));

-- [rank 12, P3] Cron sweeps + admin sorts: backing indexes for ORDER BY / range
-- predicates that currently have no leading index (every relevant index leads
-- with workspace_id/user_id).

-- audit retention prune (cron-scheduler.ts:449-451):
--   DELETE FROM audit_events WHERE created_at < now() - ($1 * interval '1 day')
CREATE INDEX IF NOT EXISTS audit_events_created_idx
	ON audit_events(created_at);

-- monthly reservation-release outer scan (cron-scheduler.ts:382-406):
--   ... FROM usage_events reserved
--   WHERE reserved.kind='ai_credit_reserved' AND reserved.created_at < $2 - ...
-- The rank-1 index above leads with subject_id, so it does not serve this
-- created_at range; this partial index does.
CREATE INDEX IF NOT EXISTS usage_events_reserved_created_idx
	ON usage_events(created_at)
	WHERE kind = 'ai_credit_reserved';

-- expired session GC (cron-scheduler.ts:409-411):
--   DELETE FROM auth_sessions WHERE expires_at < now() - interval '7 days'
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx
	ON auth_sessions(expires_at);

-- expired storage-pack sweep (cron-scheduler.ts:428-437):
--   UPDATE storage_packs SET active=false ...
--   WHERE active=true AND expires_at IS NOT NULL AND expires_at < now()
CREATE INDEX IF NOT EXISTS storage_packs_active_expires_idx
	ON storage_packs(expires_at)
	WHERE active = true AND expires_at IS NOT NULL;

-- expired invite cleanup (cron-scheduler.ts:418-421):
--   DELETE FROM workspace_invites WHERE expires_at < now()
-- (no status filter in the sweep, so a plain expires_at index serves it).
CREATE INDEX IF NOT EXISTS workspace_invites_expires_idx
	ON workspace_invites(expires_at);

-- admin billing-account list sort (billing-store.ts:341-347, GET /admin/workspaces):
--   ... FROM workspace_billing_accounts ORDER BY updated_at DESC, workspace_id ASC
CREATE INDEX IF NOT EXISTS workspace_billing_accounts_updated_id_idx
	ON workspace_billing_accounts(updated_at DESC, workspace_id);

-- [rank 23, P3] project_versions: dedupe lookup index for recordProjectVersion.
-- Serves the planned Postgres dedupe in backend/src/routes/project.ts:601-609
-- (one indexed lookup replacing N per-version file reads):
--   SELECT version_id FROM project_versions
--   WHERE project_id=$1 AND state_hash=$2 LIMIT 1
-- Only project_versions_project_time_idx (project_id, created_at) exists today.
-- Partial on state_hash IS NOT NULL because dedupe only matches non-null hashes.
CREATE INDEX IF NOT EXISTS project_versions_project_state_hash_idx
	ON project_versions(project_id, state_hash)
	WHERE state_hash IS NOT NULL;

-- [rank 21, P3] dodo subscription webhook (findWorkspaceIdByWebhook,
-- dodo.service.ts:785-791): NO new index added. The OR-across-two-columns query
-- targets workspace_billing_customers.dodo_subscription_id (already indexed by
-- workspace_billing_customers_subscription_idx, migration 0028) and
-- dodo_customer_id (already UNIQUE => implicit index). Both columns are already
-- indexed; the remaining problem is the OR defeating single-index use, which is
-- a query-shape change (split into two point lookups) that is OUT of scope for
-- this index-only migration.
