-- 0080 — Race-authoritative UNIQUE index for in-app notification dedupe.
--
-- Codex P2 (PR #436, round-3): PostgresNotificationStore.create dedupes a durable
-- in-app notification by INSERT … SELECT … WHERE NOT EXISTS on the dedupe key
-- (metadata->>'__dedupeKey'). With NO unique constraint backing it, READ COMMITTED
-- lets two CONCURRENT inserts for the same (user_id, __dedupeKey) BOTH pass the
-- NOT EXISTS subquery and BOTH insert — so two webhook workers firing the same
-- charge's receipt post-commit could write TWO in-app rows. (The File store is
-- single-threaded and unaffected; only Postgres has the concurrency window.)
--
-- This partial UNIQUE index makes the constraint the AUTHORITATIVE backstop: a
-- concurrent double-insert now raises SQLSTATE 23505, which create() catches and
-- resolves by SELECTing the row that won, collapsing the race to exactly ONE row.
-- The pre-check (WHERE NOT EXISTS) is kept as the fast path for the common
-- sequential replay; the index only fires on the genuine race.
--
-- PARTIAL on `metadata->>'__dedupeKey' IS NOT NULL`: the vast majority of
-- notifications carry NO dedupe key (no `__dedupeKey` in metadata), and those MUST
-- remain freely insertable per (user_id) — only keyed rows participate in the
-- uniqueness constraint. The index expression matches EXACTLY how the store reads
-- the key (metadata->>'__dedupeKey'), so the planner can also use it for the
-- existence pre-check / findByDedupeKey lookup.
--
-- SAFETY on existing data: the `__dedupeKey` slice is new this PR (#436) — no
-- pre-existing rows carry it — so the NULL-excluded partial index can never collide
-- with historical rows. (If a deployment somehow had pre-existing duplicate keyed
-- rows, this CREATE would fail; none can exist since the key did not exist before.)
-- Run inside the migration transaction (no CONCURRENTLY) — consistent with the
-- rest of this repo's migrations, which execute in a single transaction.

CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_dedupe_key_uniq
	ON notifications (user_id, (metadata->>'__dedupeKey'))
	WHERE metadata->>'__dedupeKey' IS NOT NULL;
