-- Phase D: support the orphan-edit-asset GC candidate scan
-- (services/assets.ts listEditAssetCandidatesAcrossProjects) without a full
-- asset_records table scan. The query filters by the server-tagged
-- metadata->>'assetKind' (edit mask/patch/cache), bounds by created_at (grace
-- period), and orders by (project_id, created_at, asset_id). A PARTIAL index over
-- exactly those edit-asset rows keeps it tiny (only non-destructive edit assets,
-- a small fraction of all assets) and matches the filter + ordering.
CREATE INDEX IF NOT EXISTS asset_records_edit_kind_created_idx
  ON asset_records (project_id, created_at, asset_id)
  WHERE metadata->>'assetKind' IN ('image-edit-mask', 'image-edit-patch', 'image-edit-cache');
