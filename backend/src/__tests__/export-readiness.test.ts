import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import {
	computeExportReadiness,
	EXPORT_BLOCKER_LABELS,
	type ExportBlockerType,
} from "../services/export-readiness.js";
import { InMemoryWorkStateStore } from "../services/work-states.js";
import { exportRoutes, setExportReadinessWorkStateStoreForTests } from "../routes/export.js";
import type { ProjectState } from "../types/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const createdProjectDirs: string[] = [];

function page(overrides: Partial<ProjectState["pages"][number]> = {}): ProjectState["pages"][number] {
	return {
		imageId: `${uuid()}.png`,
		imageName: "p.png",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: uuid(),
		userId: "",
		name: "Readiness Test",
		createdAt: new Date().toISOString(),
		pages: [page()],
		currentPage: 0,
		targetLang: "th",
		...overrides,
	};
}

function writeProjectState(state: ProjectState): void {
	const projectDir = join(PROJECTS_DIR, state.projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify(state));
	createdProjectDirs.push(projectDir);
}

function enableLegacyAnonymous(): () => void {
	const snapshot = {
		apiAuthRequired: serverConfig.apiAuthRequired,
		allowLegacyAnonymousProjects: serverConfig.allowLegacyAnonymousProjects,
	};
	Object.assign(serverConfig as unknown as Record<string, unknown>, {
		apiAuthRequired: false,
		allowLegacyAnonymousProjects: true,
	});
	return () => Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
}

function disableLegacyAnonymous(): () => void {
	const snapshot = {
		apiAuthRequired: serverConfig.apiAuthRequired,
		allowLegacyAnonymousProjects: serverConfig.allowLegacyAnonymousProjects,
	};
	Object.assign(serverConfig as unknown as Record<string, unknown>, {
		apiAuthRequired: false,
		allowLegacyAnonymousProjects: false,
	});
	return () => Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
}

function buildApp(): Hono {
	const app = new Hono();
	app.route("/api/export", exportRoutes);
	return app;
}

function blockerType(readiness: ReturnType<typeof computeExportReadiness>, type: ExportBlockerType) {
	return readiness.blockers.find((group) => group.type === type);
}

afterEach(() => {
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const dir of createdProjectDirs.splice(0)) {
		const resolved = resolve(dir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

// ── Aggregation ──────────────────────────────────────────────────────────────

describe("computeExportReadiness aggregation", () => {
	test("a clean chapter with passing moderation is export-ready", () => {
		const state = makeState({
			pages: [page({ imageId: "a.png" }), page({ imageId: "b.png" })],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([
				["a.png", "passed"],
				["b.png", "passed"],
			]),
		});
		expect(readiness.canExport).toBe(true);
		expect(readiness.blockers).toHaveLength(0);
		expect(readiness.readyPageCount).toBe(2);
		expect(readiness.blockedPageCount).toBe(0);
	});

	test("aggregates ALL blocker types across ALL pages (not just the first)", () => {
		const state = makeState({
			pages: [
				// Page 0: untranslated text + open comment.
				page({
					imageId: "p0.png",
					translationScriptSlots: [
						{ id: "s1", label: "1", x: 0, y: 0, translatedText: "" },
						{ id: "s2", label: "2", x: 0, y: 0, translatedText: "done" },
					],
				}),
				// Page 1: unresolved AI marker.
				page({ imageId: "p1.png" }),
				// Page 2: clean text but failing moderation.
				page({ imageId: "p2.png" }),
			],
			comments: [
				{ id: "c1", pageIndex: 0, body: "fix", author: "qc", status: "open", createdAt: "", updatedAt: "" },
				{ id: "c2", pageIndex: 0, body: "ok", author: "qc", status: "resolved", createdAt: "", updatedAt: "" },
			],
			aiReviewMarkers: [
				{ id: "m1", jobId: "j1", pageIndex: 1, imageId: "p1.png", region: { x: 0, y: 0, w: 1, h: 1 }, status: "needs_review", tier: "clean-pro", createdAt: "", updatedAt: "" },
				{ id: "m2", jobId: "j2", pageIndex: 1, imageId: "p1.png", region: { x: 0, y: 0, w: 1, h: 1 }, status: "accepted", tier: "clean-pro", createdAt: "", updatedAt: "" },
			],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([
				["p0.png", "passed"],
				["p1.png", "passed"],
				["p2.png", "blocked"],
			]),
		});

		expect(readiness.canExport).toBe(false);
		// All distinct blocker types are present, regardless of which page they're on.
		const types = readiness.blockers.map((group) => group.type).sort();
		expect(types).toEqual(["moderation_not_passed", "open_qc_comment", "unresolved_ai_marker", "untranslated_text"]);

		// Untranslated: exactly 1 (the empty slot), only resolved/filled slots excluded.
		expect(blockerType(readiness, "untranslated_text")?.count).toBe(1);
		expect(blockerType(readiness, "untranslated_text")?.pages[0]?.pageNumber).toBe(1);

		// Open comments: only the open one counts.
		expect(blockerType(readiness, "open_qc_comment")?.count).toBe(1);

		// AI markers: only the active (needs_review) one; "accepted" is not active.
		expect(blockerType(readiness, "unresolved_ai_marker")?.count).toBe(1);

		// Moderation: page 2's blocked image.
		expect(blockerType(readiness, "moderation_not_passed")?.count).toBe(1);
		expect(blockerType(readiness, "moderation_not_passed")?.pages[0]?.imageId).toBe("p2.png");

		expect(readiness.blockedPageCount).toBe(3);
	});

	test("multi-page blocker counts roll up across pages with jump-to-page refs", () => {
		const state = makeState({
			pages: [page({ imageId: "p0.png" }), page({ imageId: "p1.png" }), page({ imageId: "p2.png" })],
			comments: [
				{ id: "c1", pageIndex: 0, body: "a", author: "qc", status: "open", createdAt: "", updatedAt: "" },
				{ id: "c2", pageIndex: 2, body: "b", author: "qc", status: "open", createdAt: "", updatedAt: "" },
				{ id: "c3", pageIndex: 2, body: "c", author: "qc", status: "open", createdAt: "", updatedAt: "" },
			],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([
				["p0.png", "passed"],
				["p1.png", "passed"],
				["p2.png", "passed"],
			]),
		});
		const group = blockerType(readiness, "open_qc_comment");
		expect(group?.count).toBe(3);
		// Two affected pages, in page order, with per-page counts.
		expect(group?.pages.map((p) => p.pageNumber)).toEqual([1, 3]);
		expect(group?.pages.map((p) => p.count)).toEqual([1, 2]);
	});

	test("an image with no registered moderation row is held (not silently passed)", () => {
		const state = makeState({ pages: [page({ imageId: "unregistered.png" })] });
		const readiness = computeExportReadiness({ state, moderationByImageId: new Map() });
		expect(readiness.canExport).toBe(false);
		expect(blockerType(readiness, "moderation_not_passed")?.count).toBe(1);
	});

	test("a chapter with no pages reports the no_pages blocker and cannot export", () => {
		const readiness = computeExportReadiness({ state: makeState({ pages: [] }) });
		expect(readiness.canExport).toBe(false);
		expect(readiness.pageCount).toBe(0);
		expect(blockerType(readiness, "no_pages")).toBeDefined();
	});

	test("accepted/applied AI results that are not placed as a layer still block export", () => {
		const state = makeState({
			pages: [
				// Accepted result with an image but NO placed ai-result layer -> blocks.
				page({ imageId: "p0.png", imageLayers: [] }),
				// Applied result WITH its placed layer -> clears.
				page({
					imageId: "p1.png",
					imageLayers: [
						{ id: "ai-result-m2", imageId: "r2.png", imageName: "r2", index: 0, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
					],
				}),
			],
			aiReviewMarkers: [
				{ id: "m1", jobId: "j1", pageIndex: 0, imageId: "p0.png", region: { x: 0, y: 0, w: 1, h: 1 }, status: "accepted", resultImageId: "r1.png", tier: "clean-pro", createdAt: "", updatedAt: "" },
				{ id: "m2", jobId: "j2", pageIndex: 1, imageId: "p1.png", region: { x: 0, y: 0, w: 1, h: 1 }, status: "applied", resultImageId: "r2.png", tier: "clean-pro", createdAt: "", updatedAt: "" },
			],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["p0.png", "passed"], ["p1.png", "passed"]]),
		});
		const group = blockerType(readiness, "unresolved_ai_marker");
		expect(group?.count).toBe(1);
		expect(group?.pages.map((p) => p.pageNumber)).toEqual([1]); // only page 0
	});

	test("server-computable QC issues (empty/invalid box + unchanged source) block export", () => {
		const state = makeState({
			pages: [
				page({
					imageId: "p0.png",
					textLayers: [
						// empty text -> error; box ok.
						{ id: "t1", text: "", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12 },
						// invalid box (w<=0) -> error; has text.
						{ id: "t2", text: "ok", x: 0, y: 0, w: 0, h: 10, rotation: 0, fontSize: 12 },
						// unchanged source text -> warning.
						{ id: "t3", text: "same", sourceText: "Same", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12 },
					],
				}),
			],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["p0.png", "passed"]]),
		});
		expect(readiness.canExport).toBe(false);
		const group = blockerType(readiness, "qc_issue");
		// 2 errors (empty + invalid box) + 1 warning (unchanged) = 3.
		expect(group?.count).toBe(3);
	});

	test("moderation is checked on the edited export image, not just the original", () => {
		const state = makeState({
			pages: [page({ imageId: "orig.png", edits: { imageId: "edited.png" } })],
		});
		// Original passed, but the edited image used as the export background is blocked.
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["orig.png", "passed"], ["edited.png", "blocked"]]),
		});
		expect(readiness.canExport).toBe(false);
		const group = blockerType(readiness, "moderation_not_passed");
		expect(group?.count).toBe(1);
		// A single page ref (merged), not two.
		expect(group?.pages).toHaveLength(1);
		expect(group?.pages[0]?.pageNumber).toBe(1);
	});

	test("SECURITY: a per-language output's typesetImageId is moderated (CSAM export bypass)", () => {
		// The export PIPELINE renders the page background from the per-language render
		// id (languageRenderImageId: typesetImageId/exportImageId/renderedImageId/imageId).
		// Readiness MUST moderate that same id, else a member can point typesetImageId at
		// an unmoderated/unregistered object (a raw aijob_provider_* checkpoint) and slip
		// raw bytes into the export. The source page itself passes moderation.
		const state = makeState({
			targetLang: "th",
			pages: [page({
				imageId: "src.png",
				languageOutputs: {
					th: { typesetImageId: "aijob_provider_job123.png" },
				},
			} as never)],
		});
		const readiness = computeExportReadiness({
			state,
			targetLang: "th",
			// Source passed; the laundered render-background id has NO moderation row =>
			// held (not silently passed).
			moderationByImageId: new Map([["src.png", "passed"]]),
		});
		expect(readiness.canExport).toBe(false);
		const group = blockerType(readiness, "moderation_not_passed");
		expect(group?.count).toBe(1);
		expect(group?.pages[0]?.detail).toContain("Render background");
	});

	test("SECURITY: a BLOCKED per-language exportImageId/renderedImageId render background blocks export", () => {
		for (const field of ["exportImageId", "renderedImageId", "imageId"] as const) {
			const state = makeState({
				targetLang: "th",
				pages: [page({
					imageId: "src.png",
					languageOutputs: { th: { [field]: "render-bg.png" } },
				} as never)],
			});
			const readiness = computeExportReadiness({
				state,
				targetLang: "th",
				moderationByImageId: new Map([["src.png", "passed"], ["render-bg.png", "blocked"]]),
			});
			expect(readiness.canExport).toBe(false);
			expect(blockerType(readiness, "moderation_not_passed")?.count).toBe(1);
		}
	});

	test("a registered+passed per-language render background still exports (legit path intact)", () => {
		const state = makeState({
			targetLang: "th",
			pages: [page({
				imageId: "src.png",
				languageOutputs: { th: { typesetImageId: "typeset-passed.png" } },
			} as never)],
		});
		const readiness = computeExportReadiness({
			state,
			targetLang: "th",
			moderationByImageId: new Map([["src.png", "passed"], ["typeset-passed.png", "passed"]]),
		});
		expect(readiness.canExport).toBe(true);
		expect(blockerType(readiness, "moderation_not_passed")).toBeUndefined();
	});

	test("same-page multi-instance blockers merge into one page ref with summed count", () => {
		const state = makeState({
			pages: [page({ imageId: "orig.png", edits: { imageId: "edited.png" } })],
		});
		// BOTH original and edited fail moderation on the same page -> one merged ref, count 2.
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["orig.png", "blocked"], ["edited.png", "pending"]]),
		});
		const group = blockerType(readiness, "moderation_not_passed");
		expect(group?.pages).toHaveLength(1);
		expect(group?.pages[0]?.count).toBe(2);
		expect(group?.count).toBe(2);
	});

	test("a visible image layer with BLOCKED moderation blocks export", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageLayers: [
					{ id: "ref-1", imageId: "layer-blocked.png", imageName: "ref", index: 0, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
				],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["src.png", "passed"], ["layer-blocked.png", "blocked"]]),
		});
		expect(readiness.canExport).toBe(false);
		const group = blockerType(readiness, "moderation_not_passed");
		expect(group?.count).toBe(1);
		expect(group?.pages).toHaveLength(1);
		expect(group?.pages[0]?.detail).toContain("Layer image");
	});

	test("a visible image layer with NO registered moderation row is held (not silently passed)", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageLayers: [
					{ id: "ref-1", imageId: "layer-unregistered.png", imageName: "ref", index: 0, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
				],
			})],
		});
		// Source passes, but the layer asset has no moderation row at all.
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["src.png", "passed"]]),
		});
		expect(readiness.canExport).toBe(false);
		const group = blockerType(readiness, "moderation_not_passed");
		expect(group?.count).toBe(1);
		expect(group?.pages[0]?.detail).toContain("Layer image");
	});

	test("a visible image layer with PENDING moderation blocks export", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageLayers: [
					{ id: "ai-result-x", imageId: "layer-pending.png", imageName: "ai", index: 0, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
				],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["src.png", "passed"], ["layer-pending.png", "pending"]]),
		});
		expect(readiness.canExport).toBe(false);
		expect(blockerType(readiness, "moderation_not_passed")?.count).toBe(1);
	});

	test("a page whose source + every visible layer passed moderation exports fine", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageLayers: [
					{ id: "ref-1", imageId: "layer-a.png", imageName: "a", index: 0, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
					{ id: "ref-2", imageId: "layer-b.png", imageName: "b", index: 1, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
				],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([
				["src.png", "passed"],
				["layer-a.png", "passed"],
				["layer-b.png", "passed"],
			]),
		});
		expect(readiness.canExport).toBe(true);
		expect(readiness.blockers).toHaveLength(0);
	});

	test("a HIDDEN (visible:false) layer is NOT composited, so its bad moderation does not block", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageLayers: [
					// Hidden layer with blocked moderation -> not in output -> must not block.
					{ id: "ref-hidden", imageId: "layer-blocked.png", imageName: "ref", index: 0, visible: false, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
				],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["src.png", "passed"], ["layer-blocked.png", "blocked"]]),
		});
		expect(readiness.canExport).toBe(true);
		expect(blockerType(readiness, "moderation_not_passed")).toBeUndefined();
	});

	test("a layer asset reused as the source/background is only checked once per page", () => {
		const state = makeState({
			pages: [page({
				imageId: "shared.png",
				imageLayers: [
					{ id: "ref-1", imageId: "shared.png", imageName: "ref", index: 0, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
				],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["shared.png", "blocked"]]),
		});
		const group = blockerType(readiness, "moderation_not_passed");
		// One asset -> one blocker, not double-counted.
		expect(group?.count).toBe(1);
		expect(group?.pages).toHaveLength(1);
	});

	test("source + edited + multiple bad layers report distinct moderation blockers (merged per page)", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				edits: { imageId: "edited.png" },
				imageLayers: [
					{ id: "l1", imageId: "layer-a.png", imageName: "a", index: 0, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
					{ id: "l2", imageId: "layer-b.png", imageName: "b", index: 1, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
				],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([
				["src.png", "passed"],
				["edited.png", "blocked"],
				["layer-a.png", "blocked"],
				["layer-b.png", "pending"],
			]),
		});
		const group = blockerType(readiness, "moderation_not_passed");
		// edited + layer-a + layer-b = 3 failing assets on a single page, merged into one ref.
		expect(group?.count).toBe(3);
		expect(group?.pages).toHaveLength(1);
		expect(group?.pages[0]?.pageNumber).toBe(1);
	});

	test("pages without image layers are unchanged (only source/edited moderation applies)", () => {
		const state = makeState({
			pages: [
				page({ imageId: "p0.png" }),
				page({ imageId: "p1.png", imageLayers: [] }),
			],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["p0.png", "passed"], ["p1.png", "passed"]]),
		});
		expect(readiness.canExport).toBe(true);
		expect(readiness.blockers).toHaveLength(0);
	});

	test("a layer with no asset id is not treated as a moderation blocker (separate missing-asset concern)", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageLayers: [
					{ id: "empty", imageId: "", imageName: "x", index: 0, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1 },
				],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["src.png", "passed"]]),
		});
		// The empty-id layer carries no asset to moderate; moderation gate stays clear.
		expect(blockerType(readiness, "moderation_not_passed")).toBeUndefined();
	});

	// ── Phase B edit-layer assets (codex #392 P1-2) ──────────────────────────────
	// A visible patch/healing/clone edit layer composites a REALIZED ROI asset into the
	// export. If that realized asset is pending/needs_review, readiness must HOLD the page
	// (otherwise it reports READY and the durable processor fails async).

	test("a visible healing layer with a needs_review realized patch HOLDS the page", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageEditLayers: [
					{
						id: "heal-1",
						visible: true,
						bbox: { x: 1, y: 1, w: 8, h: 8 },
						index: 0,
						payload: { type: "healing", realizedPatchAssetId: "heal-roi.png", maskAssetId: "heal-mask.png", patchEncoding: "png-rgba" },
					},
				] as ProjectState["pages"][number]["imageEditLayers"],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([
				["src.png", "passed"],
				["heal-roi.png", "needs_review"],
				["heal-mask.png", "passed"],
			]),
		});
		const group = blockerType(readiness, "moderation_not_passed");
		expect(group?.count).toBe(1);
		expect(group?.pages[0]?.detail).toContain("Edit mask");
		expect(readiness.canExport).toBe(false);
	});

	test("a visible patch layer with a pending patch asset HOLDS the page", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageEditLayers: [
					{
						id: "patch-1",
						visible: true,
						bbox: { x: 0, y: 0, w: 4, h: 4 },
						index: 0,
						payload: { type: "patch", patchAssetId: "patch-roi.png", patchEncoding: "png-rgba" },
					},
				] as ProjectState["pages"][number]["imageEditLayers"],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["src.png", "passed"], ["patch-roi.png", "pending"]]),
		});
		expect(blockerType(readiness, "moderation_not_passed")?.count).toBe(1);
		expect(readiness.canExport).toBe(false);
	});

	test("a HIDDEN clone layer does not hold the page (not composited)", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageEditLayers: [
					{
						id: "clone-1",
						visible: false,
						bbox: { x: 0, y: 0, w: 4, h: 4 },
						index: 0,
						payload: { type: "clone", realizedPatchAssetId: "clone-roi.png", maskAssetId: "clone-mask.png", patchEncoding: "png-rgba" },
					},
				] as ProjectState["pages"][number]["imageEditLayers"],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			// The hidden layer's assets are missing from the map; if they were collected this
			// would HOLD. They must NOT be collected (hidden = not in the output).
			moderationByImageId: new Map([["src.png", "passed"]]),
		});
		expect(blockerType(readiness, "moderation_not_passed")).toBeUndefined();
		expect(readiness.canExport).toBe(true);
	});

	test("a visible healing layer with all-passing realized assets is export-ready", () => {
		const state = makeState({
			pages: [page({
				imageId: "src.png",
				imageEditLayers: [
					{
						id: "heal-ok",
						visible: true,
						bbox: { x: 1, y: 1, w: 8, h: 8 },
						index: 0,
						payload: { type: "healing", realizedPatchAssetId: "heal-roi.png", maskAssetId: "heal-mask.png", patchEncoding: "png-rgba" },
					},
				] as ProjectState["pages"][number]["imageEditLayers"],
			})],
		});
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([
				["src.png", "passed"],
				["heal-roi.png", "passed"],
				["heal-mask.png", "passed"],
			]),
		});
		expect(blockerType(readiness, "moderation_not_passed")).toBeUndefined();
		expect(readiness.canExport).toBe(true);
	});

	test("page-scope filter limits readiness to the caller's assigned pages", () => {
		const state = makeState({
			pages: [page({ imageId: "p0.png" }), page({ imageId: "p1.png" }), page({ imageId: "p2.png" })],
			comments: [
				{ id: "c0", pageIndex: 0, body: "out of scope", author: "qc", status: "open", createdAt: "", updatedAt: "" },
				{ id: "c1", pageIndex: 1, body: "in scope", author: "qc", status: "open", createdAt: "", updatedAt: "" },
			],
		});
		// Member scoped to page index 1 only.
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["p0.png", "passed"], ["p1.png", "passed"], ["p2.png", "passed"]]),
			includePageIndex: (pageIndex) => pageIndex === 1,
		});
		// Only page 1 is counted; page 0's comment + page 2 are not visible.
		expect(readiness.pageCount).toBe(1);
		const group = blockerType(readiness, "open_qc_comment");
		expect(group?.count).toBe(1);
		expect(group?.pages.map((p) => p.pageNumber)).toEqual([2]); // original index 1 -> pageNumber 2
		expect(group?.pages.map((p) => p.imageId)).toEqual(["p1.png"]);
	});

	test("targetLang evaluates text/QC blockers from that language output and omitted keeps legacy page data", () => {
		const state = makeState({
			pages: [page({
				imageId: "p0.png",
				textLayers: [
					{ id: "legacy", text: "legacy ready", sourceText: "source", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12, alignment: "left", index: 0 },
				],
				languageOutputs: {
					th: {
						textLayers: [
							{ id: "th", text: "แปลแล้ว", sourceText: "source", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12, alignment: "left", index: 0 },
						],
					},
					en: {
						textLayers: [
							{ id: "en", text: "", sourceText: "source", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12, alignment: "left", index: 0 },
						],
					},
				},
			} as never)],
		});
		const moderationByImageId = new Map([["p0.png", "passed" as const]]);

		const english = computeExportReadiness({ state, targetLang: "en", moderationByImageId });
		expect(english.targetLang).toBe("en");
		expect(english.canExport).toBe(false);
		expect(blockerType(english, "untranslated_text")?.count).toBe(1);
		expect(blockerType(english, "qc_issue")?.count).toBe(1);

		const thai = computeExportReadiness({ state, targetLang: "th", moderationByImageId });
		expect(thai.canExport).toBe(true);
		expect(blockerType(thai, "untranslated_text")).toBeUndefined();
		expect(blockerType(thai, "qc_issue")).toBeUndefined();

		const legacy = computeExportReadiness({ state, moderationByImageId });
		expect(legacy.targetLang).toBeUndefined();
		expect(legacy.canExport).toBe(true);
	});

	test("explicit non-default targetLang with no per-page output blocks (canExport=false) instead of passing on legacy/source data", () => {
		// Project default is "th"; the page has a th output but NO en output. A
		// caller requesting "en" must NOT silently pass the gate on the (ready)
		// legacy/source text — that would export the wrong language.
		const state = makeState({
			targetLang: "th",
			pages: [page({
				imageId: "p0.png",
				textLayers: [
					{ id: "legacy", text: "legacy ready", sourceText: "source", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12, alignment: "left", index: 0 },
				],
				languageOutputs: {
					th: {
						textLayers: [
							{ id: "th", text: "แปลแล้ว", sourceText: "source", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12, alignment: "left", index: 0 },
						],
					},
				},
			} as never)],
		});
		const moderationByImageId = new Map([["p0.png", "passed" as const]]);

		// Explicit en (request value carried via requestedTargetLang) => hard blocker.
		const english = computeExportReadiness({
			state,
			targetLang: "en",
			requestedTargetLang: "en",
			moderationByImageId,
		});
		expect(english.canExport).toBe(false);
		expect(blockerType(english, "missing_language_output")?.count).toBe(1);
		expect(blockerType(english, "missing_language_output")?.pages[0]?.imageId).toBe("p0.png");
		// The legacy/source text/QC checks must be skipped for the missing-language
		// page (they would have evaluated the wrong-language data).
		expect(blockerType(english, "untranslated_text")).toBeUndefined();
		expect(blockerType(english, "qc_issue")).toBeUndefined();

		// The present "th" track (default) still exports cleanly.
		const thai = computeExportReadiness({ state, targetLang: "th", moderationByImageId });
		expect(thai.canExport).toBe(true);
		expect(blockerType(thai, "missing_language_output")).toBeUndefined();

		// Omitted track => legacy path, unchanged. The ready legacy text exports.
		const legacy = computeExportReadiness({ state, moderationByImageId });
		expect(legacy.canExport).toBe(true);
		expect(blockerType(legacy, "missing_language_output")).toBeUndefined();
	});
});

// ── Workflow gate ──────────────────────────────────────────────────────────

describe("workflow gate", () => {
	test("pages not approved/released block export when the workflow store is enabled", () => {
		const state = makeState({ pages: [page({ imageId: "a.png" }), page({ imageId: "b.png" })] });
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["a.png", "passed"], ["b.png", "passed"]]),
			workflowGateEnabled: true,
			workStateByPageIndex: new Map([[0, "approved"], [1, "in_qc"]]),
		});
		expect(readiness.canExport).toBe(false);
		const group = blockerType(readiness, "workflow_not_approved");
		expect(group?.count).toBe(1);
		expect(group?.pages[0]?.pageNumber).toBe(2);
	});

	test("approved/released pages clear the workflow gate", () => {
		const state = makeState({ pages: [page({ imageId: "a.png" }), page({ imageId: "b.png" })] });
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["a.png", "passed"], ["b.png", "passed"]]),
			workflowGateEnabled: true,
			workStateByPageIndex: new Map([[0, "approved"], [1, "released"]]),
		});
		expect(readiness.canExport).toBe(true);
	});

	test("chapter state is the fallback when a page has no page-level state", () => {
		const state = makeState({ pages: [page({ imageId: "a.png" })] });
		const approved = computeExportReadiness({
			state,
			moderationByImageId: new Map([["a.png", "passed"]]),
			workflowGateEnabled: true,
			chapterWorkState: "approved",
		});
		expect(approved.canExport).toBe(true);

		const draft = computeExportReadiness({
			state,
			moderationByImageId: new Map([["a.png", "passed"]]),
			workflowGateEnabled: true,
			chapterWorkState: "draft",
		});
		expect(draft.canExport).toBe(false);
		expect(blockerType(draft, "workflow_not_approved")?.count).toBe(1);
	});

	test("workflow gate is skipped when no store is available (prototype/no-DB)", () => {
		const state = makeState({ pages: [page({ imageId: "a.png" })] });
		const readiness = computeExportReadiness({
			state,
			moderationByImageId: new Map([["a.png", "passed"]]),
			workflowGateEnabled: false,
		});
		expect(readiness.canExport).toBe(true);
		expect(blockerType(readiness, "workflow_not_approved")).toBeUndefined();
	});

	test("labels expose every blocker type", () => {
		expect(EXPORT_BLOCKER_LABELS.untranslated_text).toBeTruthy();
		expect(EXPORT_BLOCKER_LABELS.workflow_not_approved).toBeTruthy();
	});
});

// ── Route: GET /:chapter/readiness ───────────────────────────────────────────

describe("GET /api/export/:chapter/readiness", () => {
	test("returns the readiness checklist for an anonymous project", async () => {
		const restoreConfig = enableLegacyAnonymous();
		try {
			const state = makeState({
				pages: [page({ imageId: "a.png" })],
				comments: [{ id: "c1", pageIndex: 0, body: "x", author: "qc", status: "open", createdAt: "", updatedAt: "" }],
			});
			writeProjectState(state);
			const res = await buildApp().request(`/api/export/${state.projectId}/readiness`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { readiness: ReturnType<typeof computeExportReadiness> };
			expect(body.readiness.chapterId).toBe(state.projectId);
			expect(body.readiness.canExport).toBe(false);
			// No DB in tests -> no workflow store -> moderation held (no asset row) +
			// the open comment are the blockers.
			const types = body.readiness.blockers.map((g) => g.type);
			expect(types).toContain("open_qc_comment");
		} finally {
			restoreConfig();
		}
	});

	test("reads work-states through the injected store without a database (no N+1)", async () => {
		const restoreConfig = enableLegacyAnonymous();
		const store = new InMemoryWorkStateStore();
		// Count how many work-state queries the route issues — must be O(1), not O(pages).
		let batchCalls = 0;
		const wrapped = {
			getWorkState: store.getWorkState.bind(store),
			getWorkStatesForSubjects: (kind: "chapter" | "page", ids: string[]) => {
				batchCalls += 1;
				return store.getWorkStatesForSubjects(kind, ids);
			},
		};
		const restoreStore = setExportReadinessWorkStateStoreForTests(wrapped);
		try {
			const state = makeState({
				pages: [page({ imageId: "a.png" }), page({ imageId: "b.png" }), page({ imageId: "c.png" })],
			});
			writeProjectState(state);
			const res = await buildApp().request(`/api/export/${state.projectId}/readiness`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { readiness: ReturnType<typeof computeExportReadiness> };
			// Workflow gate is enabled (a store is present) and no page has an
			// approved/released state, so workflow blocks every page.
			expect(body.readiness.canExport).toBe(false);
			expect(blockerType(body.readiness, "workflow_not_approved")?.count).toBe(3);
			// A SINGLE batched page-state query for all 3 pages.
			expect(batchCalls).toBe(1);
		} finally {
			restoreStore();
			restoreConfig();
		}
	});

	test("rejects an invalid chapter id", async () => {
		const res = await buildApp().request(`/api/export/${"x".repeat(201)}/readiness`);
		expect(res.status).toBe(400);
	});

	test("returns 404 for a missing chapter", async () => {
		const restoreConfig = enableLegacyAnonymous();
		try {
			const res = await buildApp().request(`/api/export/${uuid()}/readiness`);
			expect(res.status).toBe(404);
		} finally {
			restoreConfig();
		}
	});

	test("denies an anonymous caller for an owner-bound chapter (authz isolation)", async () => {
		const state = makeState({ userId: "owner-1", pages: [page({ imageId: "a.png" })] });
		writeProjectState(state);
		const res = await buildApp().request(`/api/export/${state.projectId}/readiness`);
		// Owner-bound, no auth -> 401.
		expect(res.status).toBe(401);
	});

	test("denies an ownerless chapter under the hardened posture (hatch off)", async () => {
		const restoreConfig = disableLegacyAnonymous();
		try {
			const state = makeState({ pages: [page({ imageId: "a.png" })] });
			writeProjectState(state);
			const res = await buildApp().request(`/api/export/${state.projectId}/readiness`);
			expect(res.status).toBe(401);
		} finally {
			restoreConfig();
		}
	});
});
