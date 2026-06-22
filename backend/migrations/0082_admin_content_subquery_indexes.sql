-- Back the two correlated per-row subqueries in the admin content-moderation list
-- (project-catalog.ts AdminContentStore.listProjects / getProject) that have no
-- supporting index today and therefore re-scan a whole table for EVERY project row
-- the admin list returns.
--
-- The list runs, per project row:
--   flagged_asset_count := (SELECT count(*) FROM asset_records
--                             WHERE project_id = projects.project_id
--                               AND moderation_status <> 'passed')
--   csam_block_count    := (SELECT count(*) FROM csam_blocks
--                             WHERE asset_id IN (SELECT asset_id FROM asset_records
--                                                  WHERE project_id = projects.project_id))
--
-- asset_records is already indexed on a leading project_id (asset_records_pkey,
-- asset_records_project_created_id_idx), so the flagged subquery can find the row set
-- but must then filter moderation_status across ALL of a project's assets. A PARTIAL
-- index on project_id over only the non-passed rows turns it into a small index-only
-- count of exactly the flagged assets (the partial predicate matches the query's
-- `moderation_status <> 'passed'` exactly; NULL is excluded from both, consistently).
--
-- csam_blocks has NO index on asset_id at all, so the IN (...) semi-join seqscans the
-- entire csam_blocks table once per project row in the result page — O(projects × blocks).
-- A plain btree on asset_id makes it an index probe.
--
-- Both are additive, IF NOT EXISTS, and serve admin-only surfaces, so this is zero-risk.
-- Plain CREATE INDEX (not CONCURRENTLY): migrations.ts wraps each file in a single
-- transaction. Both target tables are low-to-moderate volume; if csam_blocks has grown
-- large in a given deployment, build this index off-peak or promote it out-of-band.

CREATE INDEX IF NOT EXISTS csam_blocks_asset_id_idx
	ON csam_blocks(asset_id);

CREATE INDEX IF NOT EXISTS asset_records_project_flagged_idx
	ON asset_records(project_id)
	WHERE moderation_status <> 'passed';
