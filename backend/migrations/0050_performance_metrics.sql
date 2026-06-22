-- W2.15 Performance Intelligence: derived work-event telemetry + computed
-- per-dimension performance scores.
--
-- DESIGN: This is DERIVED telemetry only. There is intentionally NO raw click,
-- mouse, keystroke, or wall-clock activity tracking here — only meaningful
-- domain events (a page submitted, a QC rejection, a comment resolved, an AI
-- suggestion accepted/edited, a TM/glossary hit, a lock handoff). Durations are
-- optional and are the caller's already-derived task duration, never a surveilled
-- timer. Mirrors the file|postgres toggle used by upload_audit, project_catalog,
-- asset_records, auth, and the usage ledger.
--
-- No hard FK to workspaces/projects/users: in prototype/file mode those rows may
-- only exist as JSON on disk, matching the relaxed posture applied to
-- upload_audit_events (0003) and asset_records (0021). workspace_id is always
-- required for isolation; project_id is best-effort/nullable.
CREATE TABLE IF NOT EXISTS work_events (
	id text PRIMARY KEY,
	-- Workspace isolation key. Every query is scoped by this; never optional.
	workspace_id text NOT NULL,
	-- Subject of the event: the member whose performance this contributes to.
	user_id text NOT NULL,
	project_id text,
	-- Role at the time of the event (translator|cleaner|typesetter|qc|reviewer|...).
	role text NOT NULL,
	-- Domain event type. Open-ended text rather than an enum so new derived event
	-- kinds can be added without a migration; the service validates known kinds.
	-- Known: page_submitted | qc_rejected | comment_resolved |
	--        ai_suggestion_accepted | ai_suggestion_edited | tm_hit |
	--        glossary_hit | glossary_miss | lock_handoff | revision_requested
	event_type text NOT NULL,
	-- Relative complexity of the unit of work (e.g. dense page = higher weight).
	-- Used to complexity-adjust throughput. Defaults to 1.0 (a normal page).
	complexity_weight double precision NOT NULL DEFAULT 1.0,
	-- Optional, already-derived task duration in ms. NEVER a surveilled timer.
	duration_ms bigint,
	-- Free-form derived metadata (e.g. handoff latency, edit distance ratio).
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'work_events_complexity_weight_check'
	) THEN
		ALTER TABLE work_events
			ADD CONSTRAINT work_events_complexity_weight_check
			CHECK (complexity_weight >= 0) NOT VALID;
	END IF;
END $$;

-- Per-member, per-dimension scoring is the dominant read pattern (GET /me,
-- GET /member/:id), newest period first, tie-broken by id-less natural order.
CREATE INDEX IF NOT EXISTS work_events_workspace_user_created_idx
	ON work_events(workspace_id, user_id, created_at DESC);

-- Workspace-wide aggregate (GET /workspace) scans by workspace + period window.
CREATE INDEX IF NOT EXISTS work_events_workspace_created_idx
	ON work_events(workspace_id, created_at DESC);

-- Per-event-type rollups (quality = reject rate, ai_leverage = accept/edit rate)
-- within a workspace+member window.
CREATE INDEX IF NOT EXISTS work_events_workspace_user_type_idx
	ON work_events(workspace_id, user_id, event_type);

-- Computed, smoothed performance scores. One row per
-- (workspace_id, user_id, dimension, period_start). Recomputed on demand and
-- cached for trend/baseline comparison. user_id NULL = workspace-aggregate row.
CREATE TABLE IF NOT EXISTS perf_scores (
	workspace_id text NOT NULL,
	-- NULL user_id denotes a workspace-aggregate score (visible to all members).
	user_id text,
	-- One of: throughput | quality | consistency | ai_leverage | collaboration |
	-- composite.
	dimension text NOT NULL,
	-- 0-100 normalized, EWMA-smoothed, Bayesian-shrunk score.
	score double precision NOT NULL,
	-- Start of the scoring period (week bucket, UTC).
	period_start timestamptz NOT NULL,
	-- Number of underlying events that fed this score (drives Bayesian shrinkage).
	sample_size integer NOT NULL DEFAULT 0,
	computed_at timestamptz NOT NULL DEFAULT now()
	-- NOTE: no table-level PRIMARY KEY. Including user_id in a PK implicitly marks
	-- it NOT NULL, which would make the documented workspace-aggregate rows
	-- (user_id IS NULL) impossible to insert. Uniqueness is instead enforced by
	-- the two partial unique indexes below (one for member rows, one for the
	-- single aggregate row per dimension+period).
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'perf_scores_score_range_check'
	) THEN
		ALTER TABLE perf_scores
			ADD CONSTRAINT perf_scores_score_range_check
			CHECK (score >= 0 AND score <= 100) NOT VALID;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'perf_scores_sample_size_check'
	) THEN
		ALTER TABLE perf_scores
			ADD CONSTRAINT perf_scores_sample_size_check
			CHECK (sample_size >= 0) NOT VALID;
	END IF;
END $$;

-- Member-scoped uniqueness: exactly one score row per
-- (workspace_id, user_id, dimension, period_start) when user_id is present.
-- This replaces the previous table-level PRIMARY KEY (which would have forced
-- user_id NOT NULL and blocked the aggregate rows below).
CREATE UNIQUE INDEX IF NOT EXISTS perf_scores_member_unique_idx
	ON perf_scores(workspace_id, user_id, dimension, period_start)
	WHERE user_id IS NOT NULL;

-- Postgres treats NULLs as distinct in a unique index, so workspace-aggregate
-- rows (user_id IS NULL) need their own partial unique index to pin exactly one
-- aggregate row per dimension+period.
CREATE UNIQUE INDEX IF NOT EXISTS perf_scores_workspace_aggregate_idx
	ON perf_scores(workspace_id, dimension, period_start)
	WHERE user_id IS NULL;

-- Trend reads pull a member's score history for a dimension, newest first.
CREATE INDEX IF NOT EXISTS perf_scores_workspace_user_dimension_idx
	ON perf_scores(workspace_id, user_id, dimension, period_start DESC);
