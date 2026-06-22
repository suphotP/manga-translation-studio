import { describe, test, expect } from "bun:test";
import { gcOrphanEditAssets } from "../services/edit-asset-gc.js";
import type { EditAssetGcDeps } from "../services/edit-asset-gc.js";
import { PostgresAssetStore, EDIT_ASSET_GC_GRACE_HOURS } from "../services/assets.js";
import type { ImageEditLayerData, PageState, ProjectState } from "../types/index.js";
import type { CapturedCowVersion } from "../services/storage-cow.js";

function editLayer(id: string, maskAssetId: string): ImageEditLayerData {
	return {
		id,
		kind: "bubble-clean",
		target: "page-background",
		visible: true,
		opacity: 1,
		sourceImageId: "img-page",
		bbox: { x: 0, y: 0, w: 10, h: 10 },
		payload: { type: "fill-mask", maskAssetId, maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } },
		index: 0,
		tool: { id: "bubble-clean" },
		createdAt: new Date().toISOString(),
	};
}

function page(overrides: Partial<PageState> = {}): PageState {
	return { imageId: "img-page", imageName: "p.png", textLayers: [], pendingAiJobs: [], coverRect: null, ...overrides };
}

function state(pages: PageState[]): ProjectState {
	return { projectId: "p1", userId: "u1", name: "Demo", createdAt: new Date().toISOString(), pages, currentPage: 0, targetLang: "en" };
}

interface Harness {
	deps: EditAssetGcDeps;
	removed: string[];
	released: string[];
}

function harness(opts: {
	candidates: Array<{ projectId: string; imageId: string }>;
	liveByProject: Record<string, ProjectState | null>;
	snapshotByProject: Record<string, Set<string>>;
	snapshotThrowsForProject?: string;
}): Harness {
	const removed: string[] = [];
	const released: string[] = [];
	const deps: EditAssetGcDeps = {
		listCandidates: async () => opts.candidates,
		getProjectState: async (projectId) => opts.liveByProject[projectId] ?? null,
		// Mirrors the production `referencingPageNumbers` + cover scan: an imageId referenced
		// ANYWHERE in live state (page image / baked edit / image layer + restore source /
		// edit-layer mask|patch|realized|source / project cover) is in-use.
		isReferencedLive: (st, imageId) => {
			if (!st) return false;
			if (st.coverImageId === imageId) return true;
			for (const pg of st.pages ?? []) {
				if (pg.imageId === imageId || pg.edits?.imageId === imageId) return true;
				for (const l of pg.imageLayers ?? []) if (l.imageId === imageId || l.restoreImageId === imageId) return true;
				for (const el of pg.imageEditLayers ?? []) {
					if (el.sourceImageId === imageId) return true;
					const p = el.payload as { maskAssetId?: string; realizedPatchAssetId?: string; patchAssetId?: string };
					if (p?.maskAssetId === imageId || p?.realizedPatchAssetId === imageId || p?.patchAssetId === imageId) return true;
				}
			}
			return false;
		},
		collectSnapshotEditAssetIds: async (projectId) => {
			if (opts.snapshotThrowsForProject === projectId) throw new Error("snapshot list failed");
			return opts.snapshotByProject[projectId] ?? new Set<string>();
		},
		captureCow: async (_projectId, imageId): Promise<CapturedCowVersion[]> => [
			{ accountKind: "workspace", accountId: "w1", sha: Buffer.alloc(32), size: 10 } as unknown as CapturedCowVersion,
		].map((v) => ({ ...v, _imageId: imageId } as unknown as CapturedCowVersion)),
		removeRecord: async (_projectId, imageId) => {
			removed.push(imageId);
			return { removed: true, durableRemoved: true };
		},
		releaseCow: async (captured) => {
			for (const c of captured) released.push((c as unknown as { _imageId: string })._imageId);
			return captured.length;
		},
	};
	return { deps, removed, released };
}

describe("Phase D — orphan edit-asset GC", () => {
	test("reclaims an edit asset referenced by NEITHER live state NOR any snapshot", async () => {
		const h = harness({
			candidates: [{ projectId: "p1", imageId: "orphan-mask" }],
			liveByProject: { p1: state([page({ imageEditLayers: [] })]) },
			snapshotByProject: { p1: new Set<string>() },
		});
		const result = await gcOrphanEditAssets({ deps: h.deps });
		expect(result.reclaimed).toBe(1);
		expect(h.removed).toEqual(["orphan-mask"]);
		expect(h.released).toEqual(["orphan-mask"]); // CoW accounting released so the blob can drop to ref_count=0.
	});

	test("does NOT reclaim an edit asset still referenced by LIVE state", async () => {
		const h = harness({
			candidates: [{ projectId: "p1", imageId: "live-mask" }],
			liveByProject: { p1: state([page({ imageEditLayers: [editLayer("e1", "live-mask")] })]) },
			snapshotByProject: { p1: new Set<string>() },
		});
		const result = await gcOrphanEditAssets({ deps: h.deps });
		expect(result.reclaimed).toBe(0);
		expect(h.removed).toEqual([]);
	});

	test("does NOT reclaim an edit asset still pinned by a VERSION SNAPSHOT (reverted out of live state)", async () => {
		const h = harness({
			candidates: [{ projectId: "p1", imageId: "snapshot-mask" }],
			// Live state no longer references it (the layer was reverted)…
			liveByProject: { p1: state([page({ imageEditLayers: [] })]) },
			// …but a saved version snapshot still does → must be protected.
			snapshotByProject: { p1: new Set<string>(["snapshot-mask"]) },
		});
		const result = await gcOrphanEditAssets({ deps: h.deps });
		expect(result.reclaimed).toBe(0);
		expect(h.removed).toEqual([]);
	});

	test("mixed batch: reclaims only the truly-orphaned asset, protects live + snapshot ones", async () => {
		const h = harness({
			candidates: [
				{ projectId: "p1", imageId: "orphan-mask" },
				{ projectId: "p1", imageId: "live-mask" },
				{ projectId: "p1", imageId: "snapshot-mask" },
			],
			liveByProject: { p1: state([page({ imageEditLayers: [editLayer("e1", "live-mask")] })]) },
			snapshotByProject: { p1: new Set<string>(["snapshot-mask"]) },
		});
		const result = await gcOrphanEditAssets({ deps: h.deps });
		expect(result.scanned).toBe(3);
		expect(result.reclaimed).toBe(1);
		expect(h.removed).toEqual(["orphan-mask"]);
	});

	test("a snapshot-scan failure SKIPS the whole project (never reaps a possibly-pinned asset)", async () => {
		const h = harness({
			candidates: [{ projectId: "p1", imageId: "maybe-pinned" }],
			liveByProject: { p1: state([page({ imageEditLayers: [] })]) },
			snapshotByProject: {},
			snapshotThrowsForProject: "p1",
		});
		const result = await gcOrphanEditAssets({ deps: h.deps });
		expect(result.reclaimed).toBe(0);
		expect(h.removed).toEqual([]);
	});

	test("does NOT reap a candidate that is actually a PAGE IMAGE or COVER (forged/stale assetKind tag, codex P0-3)", async () => {
		// An asset tagged image-edit-* (candidate) but ACTUALLY referenced as the page image
		// and as the project cover — the full live scanner must protect it, not just the
		// edit-layer scan. Reaping it would destroy a real page/cover image.
		const st = state([page({ imageId: "actually-page-img", imageEditLayers: [] })]);
		st.coverImageId = "actually-cover-img";
		const h = harness({
			candidates: [
				{ projectId: "p1", imageId: "actually-page-img" },
				{ projectId: "p1", imageId: "actually-cover-img" },
				{ projectId: "p1", imageId: "true-orphan" },
			],
			liveByProject: { p1: st },
			snapshotByProject: { p1: new Set<string>() },
		});
		const result = await gcOrphanEditAssets({ deps: h.deps });
		expect(result.reclaimed).toBe(1);
		expect(h.removed).toEqual(["true-orphan"]); // page image + cover protected.
	});

	test("no candidates → no-op", async () => {
		const h = harness({ candidates: [], liveByProject: {}, snapshotByProject: {} });
		const result = await gcOrphanEditAssets({ deps: h.deps });
		expect(result).toEqual({ scanned: 0, reclaimed: 0 });
	});
});

describe("Phase D — candidate query grace period (codex P0-1)", () => {
	test("only selects edit assets older than the grace window (guards the upload→save gap)", async () => {
		const captured: Array<{ sql: string; params: unknown[] }> = [];
		const fakeClient = {
			unsafe: async (sql: string, params: unknown[]) => {
				captured.push({ sql, params });
				return [] as Array<{ project_id: string; image_id: string }>;
			},
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const store = new PostgresAssetStore(fakeClient as any, "postgres://test");
		await store.listEditAssetCandidatesAcrossProjects(100);
		expect(captured).toHaveLength(1);
		const { sql, params } = captured[0];
		// The query bounds candidates by created_at against the grace interval — a brand-new
		// (about-to-be-referenced) edit asset is NOT a candidate.
		expect(sql).toContain("created_at <");
		expect(sql.toLowerCase()).toContain("interval");
		// The grace hours are bound as a parameter (no SQL injection / literal drift).
		expect(params).toContain(String(EDIT_ASSET_GC_GRACE_HOURS));
		expect(EDIT_ASSET_GC_GRACE_HOURS).toBeGreaterThanOrEqual(1);
	});
});
