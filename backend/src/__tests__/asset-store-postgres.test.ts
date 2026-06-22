import { describe, expect, test } from "bun:test";
import {
	type AssetStoreSqlClient,
	PostgresAssetStore,
} from "../services/assets.js";
import type { AssetRecord } from "../types/index.js";

/**
 * In-memory fake SQL client for the Postgres asset store. Mirrors the
 * fake-client seam used by the project-catalog and usage-ledger store tests:
 * it records every query and executes a minimal subset of the SQL the store
 * issues (INSERT ... ON CONFLICT, SELECT, paginated SELECT, DELETE) against an
 * in-memory table keyed by (project_id, asset_id).
 */
class FakeAssetStoreSqlClient implements AssetStoreSqlClient {
	readonly queries: Array<{ query: string; params: unknown[] }> = [];
	readonly rows: Array<Record<string, unknown>> = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		const normalized = query.replace(/\s+/g, " ").trim();

		if (normalized.startsWith("INSERT INTO asset_records")) {
			const row = this.toRow(params);
			const existingIndex = this.rows.findIndex(
				(candidate) => candidate.project_id === row.project_id && candidate.asset_id === row.asset_id,
			);
			if (existingIndex >= 0) {
				this.rows[existingIndex] = { ...this.rows[existingIndex], ...row };
			} else {
				this.rows.push(row);
			}
			return [] as T[];
		}

		if (normalized.startsWith("DELETE FROM asset_records")) {
			const projectId = params[0];
			// Batch delete: WHERE project_id = $1 AND asset_id = ANY(ARRAY[$2,...]::text[]).
			if (normalized.includes("asset_id = ANY(ARRAY[")) {
				const ids = new Set(params.slice(1).map(String));
				const removed: Array<Record<string, unknown>> = [];
				this.rows = this.rows.filter((row) => {
					if (row.project_id === projectId && ids.has(String(row.asset_id))) {
						removed.push(row);
						return false;
					}
					return true;
				});
				return removed.map((row) => ({ asset_id: row.asset_id })) as T[];
			}
			const assetId = params[1];
			const index = this.rows.findIndex(
				(candidate) => candidate.project_id === projectId && candidate.asset_id === assetId,
			);
			if (index < 0) return [] as T[];
			const [removed] = this.rows.splice(index, 1);
			return removed ? [{ asset_id: removed.asset_id }] as T[] : [] as T[];
		}

		// Grouped storage aggregate (summarizeByWorkspace). Replicate the SQL the
		// store issues: SUM(byte_size) per project, COUNT(*) assets, and the
		// per-derivative positive-sizeBytes sum + count unnested from the JSONB array.
		if (normalized.includes("GROUP BY ar.project_id")) {
			const byProjectId = normalized.includes("ar.project_id = ANY");
			// Scalar ARRAY[$1,$2,...] binds: each project id is its own param, so
			// the scope is the full params array (mirrors the real-PG fix that
			// stopped binding a JS array, which Bun.SQL serializes malformed).
			const scope = byProjectId ? (params as string[]) : null;
			const workspaceId = byProjectId ? null : params[0];
			const grouped = new Map<string, { original: number; assets: number; derivativeBytes: number; derivativeCount: number }>();
			for (const row of this.rows) {
				const inScope = byProjectId
					? scope!.includes(String(row.project_id))
					: row.workspace_id === workspaceId;
				if (!inScope) continue;
				const projectId = String(row.project_id);
				const bucket = grouped.get(projectId) ?? { original: 0, assets: 0, derivativeBytes: 0, derivativeCount: 0 };
				bucket.original += safeBytes(row.byte_size);
				bucket.assets += 1;
				for (const derivative of parseDerivatives(row.derivatives)) {
					bucket.derivativeCount += 1;
					bucket.derivativeBytes += safeBytes(derivative.sizeBytes);
				}
				grouped.set(projectId, bucket);
			}
			return [...grouped.entries()].map(([projectId, totals]) => ({
				project_id: projectId,
				original_bytes: totals.original,
				asset_count: totals.assets,
				derivative_bytes: totals.derivativeBytes,
				derivative_count: totals.derivativeCount,
			})) as T[];
		}

		if (normalized.startsWith("SELECT") && normalized.includes("FROM asset_records")) {
			const projectId = params[0];
			let matched = this.rows
				.filter((row) => row.project_id === projectId)
				.sort((a, b) => {
					const createdCompare = String(b.created_at).localeCompare(String(a.created_at));
					return createdCompare || String(b.asset_id).localeCompare(String(a.asset_id));
				});

			const isPaginated = normalized.includes("LIMIT $");
			const hasCursor = normalized.includes("created_at <");

			// Batch lookup by asset ids (getManyByProject / getManyWriteContexts):
			// "AND asset_id = ANY(ARRAY[$2,...]::text[])".
			if (normalized.includes("asset_id = ANY(ARRAY[")) {
				const ids = new Set(params.slice(1).map(String));
				return matched.filter((row) => ids.has(String(row.asset_id))) as T[];
			}

			// Single-record lookup by asset id (get): "AND asset_id = $2 LIMIT 1".
			if (normalized.includes("AND asset_id = $2") && !hasCursor && !isPaginated) {
				return matched.filter((row) => row.asset_id === params[1]) as T[];
			}

			if (isPaginated) {
				// The last bound param is always limit + 1.
				const limitPlusOne = Number(params[params.length - 1]);
				if (hasCursor) {
					// The cursor's createdAt + assetId are the two params before the limit.
					const cursorCreatedAt = String(params[params.length - 3]);
					const cursorAssetId = String(params[params.length - 2]);
					matched = matched.filter((row) => {
						const created = String(row.created_at);
						return created < cursorCreatedAt
							|| (created === cursorCreatedAt && String(row.asset_id) < cursorAssetId);
					});
				}
				return matched.slice(0, limitPlusOne) as T[];
			}

			return matched as T[];
		}

		return [] as T[];
	}

	private toRow(params: unknown[]): Record<string, unknown> {
		// Param order tracks PostgresAssetStore.write(); migration 0033 added a
		// stable UUID `id` surrogate at position 2 (between asset_id and
		// project_id) so asset_versions can FK to it, which shifts every
		// downstream param by one.
		return {
			asset_id: params[0],
			id: params[1],
			project_id: params[2],
			workspace_id: params[3],
			image_id: params[4],
			original_name: params[5],
			mime_type: params[6],
			kind: params[7],
			sha256: params[8],
			byte_size: params[9],
			width: params[10],
			height: params[11],
			storage_driver: params[12],
			storage_key: params[13],
			storage_status: params[14],
			moderation_status: params[15],
			moderation_provider: params[16],
			moderation_reason: params[17],
			moderation_detail: params[18],
			moderation_checked_at: params[19],
			moderation_ruleset_version: params[20],
			derivatives: params[21],
			uploaded_by: params[22],
			upload_audit_id: params[23],
			metadata: params[24],
			created_at: params[25],
			updated_at: params[26],
		};
	}
}

/** Mirror PostgresAssetStore.summarizeByWorkspace's positive-finite-rounded byte rule. */
function safeBytes(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** The fake stores `derivatives` as the JSON string the store binds; parse it back. */
function parseDerivatives(value: unknown): Array<{ sizeBytes?: number }> {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return Array.isArray(value) ? (value as Array<{ sizeBytes?: number }>) : [];
}

function createRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
	const base: AssetRecord = {
		assetId: "asset-1.png",
		projectId: "project-1",
		imageId: "asset-1.png",
		originalName: "page-001.png",
		mimeType: "image/png",
		sizeBytes: 4096,
		sha256: "a".repeat(64),
		storageDriver: "local",
		storageKey: "projects/project-1/images/asset-1.png",
		width: 1280,
		height: 1920,
		storageStatus: "released",
		moderation: {
			status: "passed",
			provider: "local-development-rules",
			checkedAt: "2026-05-29T00:00:00.000Z",
			reason: undefined,
			categories: { localHighRiskPrompt: 0 },
		},
		derivatives: [{
			id: "moderation-overview",
			purpose: "moderation_overview",
			status: "planned",
			width: 1024,
			height: 1536,
			sourceRect: { x: 0, y: 0, w: 1280, h: 1920 },
			scale: 0.8,
			createdAt: "2026-05-29T00:00:00.000Z",
		}],
		uploadedBy: { source: "human", userId: "user-1" },
		uploadAuditId: "audit-1",
		createdAt: "2026-05-29T00:00:00.000Z",
		updatedAt: "2026-05-29T00:00:00.000Z",
	};
	return { ...base, ...overrides };
}

describe("PostgresAssetStore", () => {
	test("constructor rejects missing DATABASE_URL when no client is injected", () => {
		expect(() => new PostgresAssetStore(undefined, "")).toThrow(/requires DATABASE_URL/);
	});

	test("write upserts the record and persists the moderation verdict in the DB row", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		const record = createRecord({
			moderation: {
				status: "needs_review",
				provider: "local-development-rules",
				checkedAt: "2026-05-29T00:00:00.000Z",
				reason: "borderline",
				categories: { localHighRiskPrompt: 0.7 },
			},
		});

		await store.write(record, { workspaceId: "workspace-1", metadata: { storageReservationId: "res-1" } });

		const insert = client.queries.find((entry) => entry.query.includes("INSERT INTO asset_records"));
		expect(insert?.query).toContain("ON CONFLICT (project_id, asset_id)");
		// Migration 0033 adds the `id` UUID surrogate at param index 1, so every
		// downstream column shifts by one — moderation verdict at 15..18 etc.
		expect(insert?.params[15]).toBe("needs_review");
		expect(insert?.params[16]).toBe("local-development-rules");
		expect(insert?.params[17]).toBe("borderline");
		expect(JSON.parse(String(insert?.params[18]))).toEqual({ localHighRiskPrompt: 0.7 });
		// Moderation checkedAt is persisted to a dedicated column (not derived from
		// updated_at, which advances for non-moderation writes).
		expect(insert?.query).toContain("moderation_checked_at");
		expect(insert?.params[19]).toBe("2026-05-29T00:00:00.000Z");
		// kind is sourced from the actor source so AI outputs are queryable.
		expect(insert?.params[7]).toBe("human");
		expect(insert?.params[3]).toBe("workspace-1");
		// metadata is the last jsonb column; with the `id` surrogate at index 1
		// and moderation_ruleset_version at index 20, metadata lands at index 24.
		expect(JSON.parse(String(insert?.params[24]))).toEqual({ storageReservationId: "res-1" });
		expect(client.rows).toHaveLength(1);
	});

	test("get round-trips a persisted record including moderation and derivatives", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		const record = createRecord();

		await store.write(record, { workspaceId: "workspace-1" });
		const loaded = await store.get(record.projectId, record.assetId);

		expect(loaded).toBeDefined();
		expect(loaded?.assetId).toBe(record.assetId);
		expect(loaded?.sizeBytes).toBe(4096);
		expect(loaded?.storageStatus).toBe("released");
		expect(loaded?.moderation.status).toBe("passed");
		expect(loaded?.moderation.provider).toBe("local-development-rules");
		expect(loaded?.moderation.categories).toEqual({ localHighRiskPrompt: 0 });
		expect(loaded?.derivatives).toHaveLength(1);
		expect(loaded?.derivatives[0]?.id).toBe("moderation-overview");
		expect(loaded?.uploadedBy).toEqual({ source: "human", userId: "user-1" });
	});

	test("get surfaces provenance metadata on the loaded record (AI-generated discovery)", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		const record = createRecord({ uploadedBy: { source: "ai_job", userId: "project-1" } });
		const aiMetadata = {
			assetKind: "ai-generated",
			ai: { jobId: "job-1", sourceImageId: "src.png", provider: "openai-gpt-image-2", tier: "sfx-pro" },
		};

		await store.write(record, { workspaceId: "workspace-1", metadata: aiMetadata });
		const loaded = await store.get(record.projectId, record.assetId);

		// The metadata JSONB column round-trips onto AssetRecord.metadata so the
		// asset-library listing path can surface/trace AI-generated assets in DB mode.
		expect(loaded?.metadata).toEqual(aiMetadata);
		expect(loaded?.uploadedBy).toEqual({ source: "ai_job", userId: "project-1" });
	});

	test("get returns undefined for an unknown asset", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await expect(store.get("project-1", "missing.png")).resolves.toBeUndefined();
	});

	test("moderation checkedAt round-trips from its dedicated column, not updated_at", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		// Moderation ran earlier; the row was later touched for a non-moderation
		// reason (e.g. a derivative upsert), advancing updated_at past checkedAt.
		const record = createRecord({
			moderation: {
				status: "passed",
				provider: "local-development-rules",
				checkedAt: "2026-05-29T00:00:00.000Z",
				categories: { localHighRiskPrompt: 0 },
			},
			updatedAt: "2026-05-30T12:00:00.000Z",
		});

		await store.write(record, { workspaceId: "workspace-1" });
		const loaded = await store.get(record.projectId, record.assetId);

		expect(loaded?.moderation.checkedAt).toBe("2026-05-29T00:00:00.000Z");
		expect(loaded?.updatedAt).toBe("2026-05-30T12:00:00.000Z");
	});

	test("moderation checkedAt falls back to updated_at for legacy rows without the column", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await store.write(createRecord(), { workspaceId: "workspace-1" });
		// Simulate a pre-migration row: clear the dedicated moderation timestamp.
		client.rows[0]!.moderation_checked_at = null;
		client.rows[0]!.updated_at = "2026-05-30T09:00:00.000Z";

		const loaded = await store.get("project-1", "asset-1.png");
		expect(loaded?.moderation.checkedAt).toBe("2026-05-30T09:00:00.000Z");
	});

	test("listByProject returns newest-first records scoped to the project", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await store.write(createRecord({ assetId: "a.png", imageId: "a.png", createdAt: "2026-05-29T00:00:00.000Z" }));
		await store.write(createRecord({ assetId: "b.png", imageId: "b.png", createdAt: "2026-05-29T01:00:00.000Z" }));
		await store.write(createRecord({ assetId: "other.png", imageId: "other.png", projectId: "project-2" }));

		const records = await store.listByProject("project-1");
		expect(records.map((asset) => asset.assetId)).toEqual(["b.png", "a.png"]);
	});

	test("listPageByProject paginates with a stable cursor", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await store.write(createRecord({ assetId: "a.png", imageId: "a.png", createdAt: "2026-05-29T00:00:00.000Z" }));
		await store.write(createRecord({ assetId: "b.png", imageId: "b.png", createdAt: "2026-05-29T01:00:00.000Z" }));
		await store.write(createRecord({ assetId: "c.png", imageId: "c.png", createdAt: "2026-05-29T02:00:00.000Z" }));

		const firstPage = await store.listPageByProject("project-1", { limit: 2 });
		expect(firstPage.assets.map((asset) => asset.assetId)).toEqual(["c.png", "b.png"]);
		expect(firstPage.nextCursor).toBeTruthy();

		const secondPage = await store.listPageByProject("project-1", { limit: 2, cursor: firstPage.nextCursor });
		expect(secondPage.assets.map((asset) => asset.assetId)).toEqual(["a.png"]);
		expect(secondPage.nextCursor).toBeUndefined();

		// The cursor predicate is bound as timestamptz + asset id tie-breaker.
		// The second page's cursor comes from the first page's last asset (b.png @ 01:00).
		const pagedQuery = client.queries.at(-1);
		expect(pagedQuery?.query).toContain("created_at <");
		expect(pagedQuery?.params).toContain("2026-05-29T01:00:00.000Z");
		expect(pagedQuery?.params).toContain("b.png");
	});

	test("listPageByProject pushes storage/moderation/source filters into SQL", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);

		await store.listPageByProject("project-1", {
			storageStatus: "released",
			moderationStatus: "passed",
			source: "ai_job",
		});

		const query = client.queries.at(-1);
		expect(query?.query).toContain("storage_status = $2");
		expect(query?.query).toContain("moderation_status = $3");
		expect(query?.query).toContain("kind = $4");
		expect(query?.params).toEqual(["project-1", "released", "passed", "ai_job", 101]);
	});

	test("remove deletes only the targeted asset and reports whether a row existed", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await store.write(createRecord({ assetId: "a.png", imageId: "a.png" }));

		await expect(store.remove("project-1", "a.png")).resolves.toBe(true);
		await expect(store.remove("project-1", "a.png")).resolves.toBe(false);
		expect(client.rows).toHaveLength(0);
	});

	// Round-3 #4: workspace_id + metadata live on the row but are NOT part of
	// AssetRecord, so getWriteContext recovers them for upload-cleanup rollback
	// (capture-before-delete -> restore-with-context) instead of nulling them.
	test("getWriteContext recovers the persisted workspace_id and metadata", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await store.write(createRecord(), { workspaceId: "workspace-1", metadata: { storageReservationId: "res-1" } });

		await expect(store.getWriteContext("project-1", "asset-1.png")).resolves.toEqual({
			workspaceId: "workspace-1",
			metadata: { storageReservationId: "res-1" },
		});
	});

	test("getWriteContext returns undefined for an unknown asset", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await expect(store.getWriteContext("project-1", "missing.png")).resolves.toBeUndefined();
	});

	// rank3 P1 N+1 fix: summarizeByWorkspace aggregates a workspace's projects in a
	// SINGLE grouped query instead of one listByProject per project + JS reduce.
	test("summarizeByWorkspace aggregates N projects in ONE grouped query (not N)", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		const projectIds = ["p-1", "p-2", "p-3"];
		for (const projectId of projectIds) {
			await store.write(createRecord({
				projectId,
				assetId: `${projectId}-a.png`,
				imageId: `${projectId}-a.png`,
				sizeBytes: 100,
				derivatives: [{
					id: "thumb",
					purpose: "thumbnail",
					status: "ready",
					width: 1,
					height: 1,
					sourceRect: { x: 0, y: 0, w: 1, h: 1 },
					scale: 1,
					sizeBytes: 20,
					createdAt: "2026-05-29T00:00:00.000Z",
				}],
			}), { workspaceId: "ws-1" });
		}
		client.queries.length = 0;

		const usage = await store.summarizeByWorkspace("ws-1", projectIds);

		// ONE query served all three projects — not three list queries.
		const selects = client.queries.filter((entry) => entry.query.replace(/\s+/g, " ").includes("FROM asset_records"));
		expect(selects).toHaveLength(1);
		expect(selects[0]?.query).toContain("GROUP BY ar.project_id");
		expect(usage.size).toBe(3);
		for (const projectId of projectIds) {
			expect(usage.get(projectId)).toEqual({ originalBytes: 100, derivativeBytes: 20, assetCount: 1, derivativeCount: 1 });
		}
	});

	test("summarizeByWorkspace byte accounting matches a per-project list+reduce", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		// Project p-1: two assets, mixed derivative sizes (one missing sizeBytes).
		await store.write(createRecord({
			projectId: "p-1", assetId: "p-1-a.png", imageId: "p-1-a.png", sizeBytes: 70,
			derivatives: [
				{ id: "d1", purpose: "thumbnail", status: "ready", width: 1, height: 1, sourceRect: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, sizeBytes: 15, createdAt: "2026-05-29T00:00:00.000Z" },
				{ id: "d2", purpose: "moderation_overview", status: "planned", width: 1, height: 1, sourceRect: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, createdAt: "2026-05-29T00:00:00.000Z" },
			],
		}), { workspaceId: "ws-1" });
		await store.write(createRecord({
			projectId: "p-1", assetId: "p-1-b.png", imageId: "p-1-b.png", sizeBytes: 30, derivatives: [],
		}), { workspaceId: "ws-1" });
		// Project p-2: one asset.
		await store.write(createRecord({
			projectId: "p-2", assetId: "p-2-a.png", imageId: "p-2-a.png", sizeBytes: 80,
			derivatives: [
				{ id: "d3", purpose: "thumbnail", status: "ready", width: 1, height: 1, sourceRect: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, sizeBytes: 5, createdAt: "2026-05-29T00:00:00.000Z" },
			],
		}), { workspaceId: "ws-1" });

		const projectIds = ["p-1", "p-2"];
		const usage = await store.summarizeByWorkspace("ws-1", projectIds);

		// Independently reduce the same rows via listByProject (the OLD path).
		const expected = new Map<string, { originalBytes: number; derivativeBytes: number; assetCount: number; derivativeCount: number }>();
		for (const projectId of projectIds) {
			const records = await store.listByProject(projectId);
			let originalBytes = 0;
			let derivativeBytes = 0;
			let derivativeCount = 0;
			for (const record of records) {
				originalBytes += safeBytes(record.sizeBytes);
				for (const derivative of record.derivatives) {
					derivativeBytes += safeBytes(derivative.sizeBytes);
					derivativeCount += 1;
				}
			}
			expected.set(projectId, { originalBytes, derivativeBytes, assetCount: records.length, derivativeCount });
		}

		expect(usage.get("p-1")).toEqual(expected.get("p-1"));
		expect(usage.get("p-2")).toEqual(expected.get("p-2"));
		// p-1: originals 70+30=100, derivatives 15 (missing-size derivative => 0), count 2.
		expect(usage.get("p-1")).toEqual({ originalBytes: 100, derivativeBytes: 15, assetCount: 2, derivativeCount: 2 });
		expect(usage.get("p-2")).toEqual({ originalBytes: 80, derivativeBytes: 5, assetCount: 1, derivativeCount: 1 });
	});

	test("summarizeByWorkspace scopes by project list, not by stale workspace_id", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		// p-1's row has a NULL workspace_id (legacy/unbackfilled) but still belongs to
		// the resolved workspace project list, so it must be counted — matching the
		// old per-project path which never filtered on workspace_id.
		await store.write(createRecord({ projectId: "p-1", assetId: "a.png", imageId: "a.png", sizeBytes: 42, derivatives: [] }));
		const usage = await store.summarizeByWorkspace("ws-1", ["p-1"]);
		expect(usage.get("p-1")).toEqual({ originalBytes: 42, derivativeBytes: 0, assetCount: 1, derivativeCount: 0 });
	});
});

describe("PostgresAssetStore batch upload-cleanup helpers (rank 19)", () => {
	function selectQueries(client: FakeAssetStoreSqlClient): Array<{ query: string; params: unknown[] }> {
		return client.queries.filter((q) => /^\s*SELECT/i.test(q.query) && /FROM asset_records/i.test(q.query));
	}
	function deleteQueries(client: FakeAssetStoreSqlClient): Array<{ query: string; params: unknown[] }> {
		return client.queries.filter((q) => /^\s*DELETE FROM asset_records/i.test(q.query));
	}

	test("getManyByProject issues ONE SELECT for N ids and returns only the requested rows", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await store.write(createRecord({ projectId: "p-1", assetId: "a.png", imageId: "a.png" }));
		await store.write(createRecord({ projectId: "p-1", assetId: "b.png", imageId: "b.png" }));
		await store.write(createRecord({ projectId: "p-1", assetId: "c.png", imageId: "c.png" }));
		client.queries.length = 0;

		const result = await store.getManyByProject("p-1", ["a.png", "c.png", "missing.png"]);

		// One query for the whole batch (NOT one per id) using the scalar ANY(ARRAY[...]).
		expect(selectQueries(client)).toHaveLength(1);
		const sql = selectQueries(client)[0]!.query.replace(/\s+/g, " ");
		expect(sql).toMatch(/asset_id = ANY\(ARRAY\[\$2, \$3, \$4\]::text\[\]\)/);
		// No JS array is ever bound — every id is its own scalar param.
		for (const param of selectQueries(client)[0]!.params) expect(Array.isArray(param)).toBe(false);
		expect([...result.keys()].sort()).toEqual(["a.png", "c.png"]);
		expect(result.get("a.png")?.assetId).toBe("a.png");
	});

	test("getManyWriteContexts issues ONE SELECT and carries workspace_id + metadata", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await store.write(
			createRecord({ projectId: "p-1", assetId: "a.png", imageId: "a.png" }),
			{ workspaceId: "ws-9", metadata: { reservationId: "r-1" } },
		);
		await store.write(
			createRecord({ projectId: "p-1", assetId: "b.png", imageId: "b.png" }),
			{ workspaceId: "ws-9" },
		);
		client.queries.length = 0;

		const contexts = await store.getManyWriteContexts("p-1", ["a.png", "b.png"]);
		expect(selectQueries(client)).toHaveLength(1);
		expect(contexts.get("a.png")).toEqual({ workspaceId: "ws-9", metadata: { reservationId: "r-1" } });
		expect(contexts.get("b.png")?.workspaceId).toBe("ws-9");
	});

	test("removeManyByProject issues ONE DELETE and returns the ids actually removed", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		await store.write(createRecord({ projectId: "p-1", assetId: "a.png", imageId: "a.png" }));
		await store.write(createRecord({ projectId: "p-1", assetId: "b.png", imageId: "b.png" }));
		client.queries.length = 0;

		const removed = await store.removeManyByProject("p-1", ["a.png", "b.png", "missing.png"]);
		expect(deleteQueries(client)).toHaveLength(1);
		const sql = deleteQueries(client)[0]!.query.replace(/\s+/g, " ");
		expect(sql).toMatch(/asset_id = ANY\(ARRAY\[\$2, \$3, \$4\]::text\[\]\)/);
		expect([...removed].sort()).toEqual(["a.png", "b.png"]);
		// The rows are gone — a follow-up batch read returns nothing.
		const after = await store.getManyByProject("p-1", ["a.png", "b.png"]);
		expect(after.size).toBe(0);
	});

	test("the three batch methods collapse an N-image cleanup into 3 total queries", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		const ids = ["a.png", "b.png", "c.png", "d.png", "e.png"];
		for (const assetId of ids) {
			await store.write(createRecord({ projectId: "p-1", assetId, imageId: assetId }));
		}
		client.queries.length = 0;

		// Mirror the cleanup path's DB work: batch-read records, batch-read contexts,
		// batch-delete. Previously this was ~3 queries PER image (3N = 15 for 5 images).
		await store.getManyByProject("p-1", ids);
		await store.getManyWriteContexts("p-1", ids);
		await store.removeManyByProject("p-1", ids);

		expect(client.queries).toHaveLength(3);
		expect(selectQueries(client)).toHaveLength(2);
		expect(deleteQueries(client)).toHaveLength(1);
	});

	test("empty id list does no DB work", async () => {
		const client = new FakeAssetStoreSqlClient();
		const store = new PostgresAssetStore(client);
		expect((await store.getManyByProject("p-1", [])).size).toBe(0);
		expect((await store.getManyWriteContexts("p-1", [])).size).toBe(0);
		expect((await store.removeManyByProject("p-1", [])).size).toBe(0);
		expect(client.queries).toHaveLength(0);
	});
});
