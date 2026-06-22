import { describe, expect, it } from "vitest";
import {
	resolveVisiblePageLayerCount,
	summarizePageBatch,
	summarizePageWork,
	summarizePageWorkBatch,
	pageNeedsAttention,
} from "$lib/project/page-work-summary.js";
import type { PageAssetIntegrity } from "$lib/project/page-assets.js";
import type { QcIssue } from "$lib/project/qc-checks.js";
import type {
	AiReviewMarker,
	Page,
	PageReviewDecision,
	ProjectComment,
	WorkflowTask,
} from "$lib/types.js";

function makePage(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "img-1",
		imageName: "image-01.webp",
		originalName: "image-01.webp",
		textLayers: [{
			id: "layer-1",
			text: "Translated",
			x: 10,
			y: 20,
			w: 120,
			h: 60,
			rotation: 0,
			fontSize: 24,
			alignment: "center",
			index: 0,
		}],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function makeTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "review",
		status: "review",
		priority: "normal",
		pageIndex: 0,
		title: "Review page",
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

function makeComment(overrides: Partial<ProjectComment> = {}): ProjectComment {
	return {
		id: "comment-1",
		pageIndex: 0,
		body: "Fix this edge",
		author: "tester",
		status: "open",
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

function makeMarker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "img-1",
		region: { x: 0, y: 0, w: 100, h: 80 },
		status: "needs_review",
		tier: "clean-pro",
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

describe("resolveVisiblePageLayerCount", () => {
	it("uses persisted current-page layers until the editor image is loaded", () => {
		expect(resolveVisiblePageLayerCount(makePage(), true, 0, false)).toBe(1);
	});

	it("uses live editor layers for the loaded current page", () => {
		expect(resolveVisiblePageLayerCount(makePage(), true, 0, true)).toBe(0);
		expect(resolveVisiblePageLayerCount(makePage(), true, 3, true)).toBe(3);
	});

	it("uses persisted layers for non-current pages", () => {
		expect(resolveVisiblePageLayerCount(makePage(), false, 4, true)).toBe(1);
	});
});

describe("summarizePageWork", () => {
	it("marks a complete page as ready", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
		});

		expect(summary.status).toBe("ready");
		expect(summary.statusLabel).toBe("Ready");
		expect(summary.layerCount).toBe(1);
		expect(summary.exportReady).toBe(true);
		expect(summary.exportBlockers).toEqual([]);
		expect(pageNeedsAttention(summary)).toBe(false);
	});

	it("prioritizes missing assets and blocking AI markers", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "failed",
				label: "Failed",
				detail: "404",
			},
			aiReviewMarkers: [makeMarker({ status: "failed" })],
		});

		expect(summary.status).toBe("blocked");
		expect(summary.aiAttentionCount).toBe(1);
		expect(summary.nextAction).toBe("Relink or restore page image");
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toEqual([
			"image asset not ready",
			"1 AI review item",
		]);
	});

	it("names missing supplemental image assets in export blockers", () => {
		const summary = summarizePageWork({
			page: makePage({
				imageLayers: [{
					id: "credit-logo",
					imageId: "",
					imageName: "credit-logo.webp",
					x: 20,
					y: 20,
					w: 120,
					h: 80,
					rotation: 0,
					opacity: 1,
					index: 0,
					role: "credit",
				}],
			}),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			qcIssues: [{
				id: "page-0-image-layer-credit-logo-missing-asset",
				code: "image_layer_missing_asset",
				severity: "error",
				messageCode: "image_layer_missing_asset",
				messageValues: { page: 1, layerName: "credit-logo.webp" },
				pageIndex: 0,
				layerId: "credit-logo",
				layerKind: "image",
			}],
		});

		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toEqual(["image layer asset missing: credit-logo.webp"]);
	});

	it("names supplemental image assets missing from inventory in export blockers", () => {
		const summary = summarizePageWork({
			page: makePage({
				imageLayers: [{
					id: "credit-logo",
					imageId: "missing-credit-logo",
					imageName: "credit-logo.webp",
					x: 20,
					y: 20,
					w: 120,
					h: 80,
					rotation: 0,
					opacity: 1,
					index: 0,
					role: "credit",
				}],
			}),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			qcIssues: [{
				id: "page-0-image-layer-credit-logo-asset-missing-from-inventory",
				code: "image_layer_asset_missing_from_inventory",
				severity: "error",
				messageCode: "image_layer_asset_missing_from_inventory",
				messageValues: { page: 1, layerName: "credit-logo.webp" },
				pageIndex: 0,
				layerId: "credit-logo",
				layerKind: "image",
			}],
		});

		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toEqual(["image layer asset missing from inventory: credit-logo.webp"]);
	});

	it("blocks export when asset inventory is unknown", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "unknown",
				label: "Unknown",
				detail: "ตรวจคลังรูปไม่ได้: network down",
			},
		});

		expect(summary.status).toBe("blocked");
		expect(summary.nextAction).toBe("Retry asset inventory check");
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("image asset inventory unknown");
	});

	it("blocks export when an accepted AI result has not been placed as an editable layer", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			aiReviewMarkers: [makeMarker({
				status: "accepted",
				resultImageId: "ai-result-image-1",
			})],
		});

		expect(summary.status).toBe("blocked");
		expect(summary.nextAction).toBe("Place accepted AI result layer");
		expect(summary.aiAttentionCount).toBe(1);
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("1 accepted AI result not placed");
	});

	it("treats accepted AI results as ready only after the generated layer exists", () => {
		const summary = summarizePageWork({
			page: makePage({
				imageLayers: [{
					id: "ai-result-marker-1",
					imageId: "ai-result-image-1",
					imageName: "ai-result-image-1.png",
					x: 0,
					y: 0,
					w: 100,
					h: 80,
					rotation: 0,
					opacity: 1,
					index: 0,
					role: "overlay",
				}],
			}),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			aiReviewMarkers: [makeMarker({
				status: "accepted",
				resultImageId: "ai-result-image-1",
			})],
		});

		expect(summary.status).toBe("ready");
		expect(summary.aiAttentionCount).toBe(0);
		expect(summary.exportReady).toBe(true);
		expect(summary.exportBlockers).toEqual([]);
	});

	it("keeps team-production pages out of export until final QC is closed", () => {
		const summary = summarizePageWork({
			page: makePage({
				cleaningHandoff: {
					status: "clean_ready",
					updatedAt: "2026-05-12T00:00:00.000Z",
				},
				translationHandoff: {
					status: "translated",
					updatedAt: "2026-05-12T00:00:00.000Z",
				},
				translationScriptSlots: [{
					id: "slot-1",
					label: "คำพูด 1",
					x: 10,
					y: 20,
					category: "dialogue",
					translatedText: "พร้อมส่ง",
					updatedAt: "2026-05-12T00:00:00.000Z",
				}],
			}),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			reviewDecisions: [{
				id: "decision-1",
				pageIndex: 0,
				status: "approved",
				body: "ผ่านรีวิว",
				actor: "lead",
				createdAt: "2026-05-12T00:00:00.000Z",
				updatedAt: "2026-05-12T00:00:00.000Z",
			}],
		});

		expect(summary.status).toBe("review");
		expect(summary.nextAction).toBe("Close final QC handoff");
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("final QC handoff not closed");
	});

	it("keeps team-production pages out of export until review approval is recorded", () => {
		const summary = summarizePageWork({
			page: makePage({
				cleaningHandoff: {
					status: "clean_ready",
					updatedAt: "2026-05-12T00:00:00.000Z",
					typesetRecheckStatus: "verified",
				},
				translationHandoff: {
					status: "translated",
					updatedAt: "2026-05-12T00:00:00.000Z",
				},
				translationScriptSlots: [{
					id: "slot-1",
					label: "คำพูด 1",
					x: 10,
					y: 20,
					category: "dialogue",
					translatedText: "พร้อมส่ง",
					updatedAt: "2026-05-12T00:00:00.000Z",
				}],
				textLayers: [{
					id: "typeset-slot-1",
					text: "พร้อมส่ง",
					sourceProvider: "translation-slot:slot-1",
					x: 10,
					y: 20,
					w: 120,
					h: 60,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
			}),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			reviewDecisions: [],
		});

		expect(summary.status).toBe("review");
		expect(summary.nextAction).toBe("Approve page review");
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("page review approval not recorded");
	});

	it("allows team-production pages to export after final QC is closed", () => {
		const summary = summarizePageWork({
			page: makePage({
				cleaningHandoff: {
					status: "clean_ready",
					updatedAt: "2026-05-12T00:00:00.000Z",
				},
				translationHandoff: {
					status: "translated",
					updatedAt: "2026-05-12T00:00:00.000Z",
				},
				qcHandoff: {
					status: "ready",
					updatedAt: "2026-05-12T00:00:00.000Z",
					updatedBy: "qc",
				},
			}),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			reviewDecisions: [{
				id: "decision-1",
				pageIndex: 0,
				status: "approved",
				body: "ผ่านรีวิว",
				actor: "lead",
				createdAt: "2026-05-12T00:00:00.000Z",
				updatedAt: "2026-05-12T00:00:00.000Z",
			}],
		});

		expect(summary.status).toBe("ready");
		expect(summary.exportReady).toBe(true);
		expect(summary.exportBlockers).toEqual([]);
	});

	it("treats project-level team mode as a review/QC export contract even without handoff artifacts", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			productionMode: "team",
		});

		expect(summary.status).toBe("review");
		expect(summary.nextAction).toBe("Approve page review");
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("page review approval not recorded");
	});

	it("keeps project-level team pages blocked after review until final QC closes", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			reviewDecisions: [{
				id: "decision-team",
				pageIndex: 0,
				status: "approved",
				body: "ผ่านรีวิว",
				actor: "lead",
				createdAt: "2026-05-12T00:00:00.000Z",
				updatedAt: "2026-05-12T00:00:00.000Z",
			}],
			productionMode: "team",
		});

		expect(summary.status).toBe("review");
		expect(summary.nextAction).toBe("Close final QC handoff");
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("final QC handoff not closed");
	});

	it("lets project-level team pages export only after review and final QC", () => {
		const summary = summarizePageWork({
			page: makePage({
				qcHandoff: {
					status: "ready",
					updatedAt: "2026-05-12T00:00:00.000Z",
					updatedBy: "qc",
				},
			}),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			reviewDecisions: [{
				id: "decision-team",
				pageIndex: 0,
				status: "approved",
				body: "ผ่านรีวิว",
				actor: "lead",
				createdAt: "2026-05-12T00:00:00.000Z",
				updatedAt: "2026-05-12T00:00:00.000Z",
			}],
			productionMode: "team",
		});

		expect(summary.status).toBe("ready");
		expect(summary.exportReady).toBe(true);
		expect(summary.exportBlockers).toEqual([]);
	});

	it("blocks export when an applied AI marker lost its generated layer", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
			aiReviewMarkers: [makeMarker({
				status: "applied",
				resultImageId: "ai-result-image-1",
			})],
		});

		expect(summary.status).toBe("blocked");
		expect(summary.nextAction).toBe("Recover missing applied AI layer");
		expect(summary.aiAttentionCount).toBe(1);
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("1 applied AI layer missing");
	});

	it("holds scanning assets out of export readiness", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "scanning",
				label: "Review",
				detail: "Needs moderation review",
			},
		});

		expect(summary.status).toBe("blocked");
		expect(summary.nextAction).toBe("Wait for asset scan or moderation review");
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("image asset still scanning");
	});

	it("holds blocked assets out of export readiness", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "blocked",
				label: "Blocked",
				detail: "Blocked by moderation policy",
			},
		});

		expect(summary.status).toBe("blocked");
		expect(summary.nextAction).toBe("Replace blocked page image");
		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("image asset not ready");
	});

	it("aggregates review work from tasks, comments, warnings, and assignees", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			qcIssues: [{
				id: "page-0-warning",
				code: "unchanged_source_text",
				severity: "warning",
				messageCode: "unchanged_source_text",
				messageValues: { page: 1 },
				pageIndex: 0,
			}],
			tasks: [
				makeTask({ id: "task-1", assignee: "@Mina", status: "review" }),
				makeTask({ id: "task-2", assignee: "Ari", status: "done" }),
			],
			comments: [makeComment()],
			aiReviewMarkers: [makeMarker({ status: "accepted", assignee: "@@Nok" })],
		});

		expect(summary.status).toBe("review");
		expect(summary.qcWarningCount).toBe(1);
		expect(summary.openCommentCount).toBe(1);
		expect(summary.taskTotalCount).toBe(2);
		expect(summary.taskOpenCount).toBe(1);
		expect(summary.urgentTaskCount).toBe(0);
		expect(summary.highTaskCount).toBe(0);
		expect(summary.dueTaskCount).toBe(0);
		expect(summary.overdueTaskCount).toBe(0);
		expect(summary.nextDueAt).toBeNull();
		expect(summary.highestTaskPriority).toBe("normal");
		expect(summary.assignees).toEqual(["Ari", "Mina", "Nok"]);
		expect(summary.exportReady).toBe(false);
		// Open workflow tasks are NOT export blockers (the backend readiness contract
		// gates on work-state, not auto-seeded per-page tasks); the open comment +
		// QC warning are the real blockers here. The page still shows "review" status
		// (task is surfaced as a workflow signal), it just doesn't block export.
		expect(summary.exportBlockers).toEqual([
			"1 open comment",
			"1 QC warning",
		]);
		expect(summary.exportBlockers).not.toContain("1 open task");
	});

	it("keeps latest page review decision available for the UI", () => {
		const decisions: PageReviewDecision[] = [{
			id: "decision-1",
			pageIndex: 0,
			status: "approved",
			actor: "lead",
			createdAt: "2026-05-12T00:00:00.000Z",
			updatedAt: "2026-05-12T00:00:00.000Z",
		}, {
			id: "decision-2",
			pageIndex: 0,
			status: "changes_requested",
			body: "Tighten redraw",
			actor: "lead",
			createdAt: "2026-05-12T01:00:00.000Z",
			updatedAt: "2026-05-12T01:00:00.000Z",
		}];

		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			reviewDecisions: decisions,
		});

		expect(summary.status).toBe("review");
		expect(summary.latestReviewDecision?.id).toBe("decision-2");
		expect(summary.exportBlockers).toContain("review changes requested");
	});

	it("summarizes page batches for chapter manager actions", () => {
		const ready = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
		});
		const blocked = summarizePageWork({
			page: makePage(),
			pageIndex: 1,
			assetIntegrity: {
				pageIndex: 1,
				status: "failed",
				label: "Failed",
				detail: "404",
			},
			comments: [makeComment({ pageIndex: 1 })],
		});

		expect(summarizePageBatch([ready, blocked])).toMatchObject({
			pageCount: 2,
			layerCount: 2,
			exportReadyCount: 1,
			blockedCount: 1,
			reviewCount: 0,
			attentionCount: 1,
			assetScanningCount: 0,
			assetBlockedCount: 0,
			commentCount: 1,
			urgentTaskCount: 0,
			highTaskCount: 0,
			dueTaskCount: 0,
			overdueTaskCount: 0,
		});
	});

	it("counts asset scanning and blocked states for chapter operations", () => {
		const scanning = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "scanning",
				label: "Scanning",
				detail: "Waiting for release",
			},
		});
		const blocked = summarizePageWork({
			page: makePage(),
			pageIndex: 1,
			assetIntegrity: {
				pageIndex: 1,
				status: "blocked",
				label: "Blocked",
				detail: "Blocked by moderation",
			},
		});

		expect(summarizePageBatch([scanning, blocked])).toMatchObject({
			pageCount: 2,
			exportReadyCount: 0,
			blockedCount: 2,
			attentionCount: 2,
			assetScanningCount: 1,
			assetBlockedCount: 1,
		});
	});

	it("counts urgent and high open tasks for chapter triage", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			tasks: [
				makeTask({ id: "task-urgent", priority: "urgent", status: "review" }),
				makeTask({ id: "task-high", priority: "high", status: "doing" }),
				makeTask({ id: "task-done", priority: "urgent", status: "done" }),
			],
		});

		expect(summary.urgentTaskCount).toBe(1);
		expect(summary.highTaskCount).toBe(1);
		expect(summary.highestTaskPriority).toBe("urgent");
		expect(summary.priorityLabel).toBe("Urgent");
	});

	it("tracks due and overdue open tasks for chapter triage", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			tasks: [
				makeTask({
					id: "task-overdue",
					status: "doing",
					dueAt: "2000-01-01T00:00:00.000Z",
				}),
				makeTask({
					id: "task-future",
					status: "todo",
					dueAt: "2999-01-01T00:00:00.000Z",
				}),
				makeTask({
					id: "task-done",
					status: "done",
					dueAt: "2000-01-01T00:00:00.000Z",
				}),
			],
		});

		expect(summary.status).toBe("review");
		expect(summary.nextAction).toBe("Clear overdue task handoff");
		expect(summary.dueTaskCount).toBe(2);
		expect(summary.overdueTaskCount).toBe(1);
		expect(summary.nextDueAt).toBe("2000-01-01T00:00:00.000Z");
		// Overdue tasks drive the "review" status + next-action triage, but they are
		// NOT export blockers — the backend readiness contract does not gate on
		// per-page workflow tasks (auto-seeded todos are the default chapter state).
		expect(summary.exportBlockers).not.toContain("1 overdue task");
		// This page is otherwise clean (one translated text layer, no QC/comment
		// issues), so with tasks no longer blocking it is genuinely export-ready.
		expect(summary.exportReady).toBe(true);
	});

	it("treats art-only pages (no editable text layers) as export-ready", () => {
		// An art-only / cleaning-only / SFX page legitimately carries no text layers.
		// The backend readiness contract intentionally does NOT flag zero-text pages,
		// so the FE gate must not block them either.
		const summary = summarizePageWork({
			page: makePage({ textLayers: [] }),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "ready",
				label: "Ready",
				detail: "Available",
			},
		});

		expect(summary.layerCount).toBe(0);
		expect(summary.exportBlockers).not.toContain("no editable text layers");
		expect(summary.exportBlockers).toEqual([]);
		expect(summary.exportReady).toBe(true);
	});

	it("does not let a page_without_text QC warning block export", () => {
		// The QC engine emits `page_without_text` (warning) for a text-less page. That
		// is the same art-only condition as "no editable text layers" routed through
		// QC, and the backend readiness contract never flags it, so it must NOT block
		// export — but it should still count toward the status warning surface.
		const summary = summarizePageWork({
			page: makePage({ textLayers: [] }),
			pageIndex: 0,
			assetIntegrity: { pageIndex: 0, status: "ready", label: "Ready", detail: "Available" },
			qcIssues: [{
				id: "page-0-without-text",
				code: "page_without_text",
				severity: "warning",
				messageCode: "page_without_text",
				messageValues: { page: 1 },
				pageIndex: 0,
			}],
		});

		expect(summary.qcWarningCount).toBe(1); // still surfaced for status/triage
		expect(summary.exportBlockers).not.toContain("1 QC warning");
		expect(summary.exportBlockers).toEqual([]);
		expect(summary.exportReady).toBe(true);
	});

	it("still blocks export on a REAL QC warning (not page_without_text)", () => {
		const summary = summarizePageWork({
			page: makePage(),
			pageIndex: 0,
			assetIntegrity: { pageIndex: 0, status: "ready", label: "Ready", detail: "Available" },
			qcIssues: [{
				id: "page-0-warning",
				code: "unchanged_source_text",
				severity: "warning",
				messageCode: "unchanged_source_text",
				messageValues: { page: 1 },
				pageIndex: 0,
			}],
		});

		expect(summary.exportBlockers).toContain("1 QC warning");
		expect(summary.exportReady).toBe(false);
	});

	it("keeps GENUINE blockers (asset/QC error) even when text layers are absent", () => {
		// Removing the text-layer + open-task gates must NOT make a truly broken page
		// look exportable: a failed image asset is still a hard blocker.
		const summary = summarizePageWork({
			page: makePage({ textLayers: [] }),
			pageIndex: 0,
			assetIntegrity: {
				pageIndex: 0,
				status: "failed",
				label: "Failed",
				detail: "404",
			},
		});

		expect(summary.exportReady).toBe(false);
		expect(summary.exportBlockers).toContain("image asset not ready");
	});
});

describe("summarizePageWorkBatch", () => {
	// A 3-page fixture with mixed records spread across pages so the bucketed batch
	// path and the per-page path each have to route records to the right page.
	const pages: Page[] = [
		makePage({ imageId: "img-0", originalName: "p0.webp", textLayers: [] }),
		makePage({ imageId: "img-1", originalName: "p1.webp" }),
		makePage({ imageId: "img-2", originalName: "p2.webp" }),
	];
	const tasks: WorkflowTask[] = [
		makeTask({ id: "t-0", pageIndex: 0, status: "todo", priority: "urgent", title: "Clean p0" }),
		makeTask({ id: "t-1", pageIndex: 2, status: "doing", priority: "high", title: "Typeset p2" }),
		makeTask({ id: "t-2", pageIndex: 0, status: "done", priority: "normal", title: "Done p0" }),
	];
	const comments: ProjectComment[] = [
		makeComment({ id: "c-0", pageIndex: 1, status: "open", body: "Note p1" }),
		makeComment({ id: "c-1", pageIndex: 1, status: "resolved", body: "Resolved p1" }),
		makeComment({ id: "c-2", pageIndex: 2, status: "open", body: "Note p2" }),
	];
	const aiReviewMarkers: AiReviewMarker[] = [
		makeMarker({ id: "m-0", pageIndex: 0, status: "needs_review", assignee: "alice" }),
		makeMarker({ id: "m-1", pageIndex: 2, status: "failed", assignee: "bob" }),
	];
	const reviewDecisions: PageReviewDecision[] = [
		{
			id: "d-2",
			pageIndex: 2,
			status: "changes_requested",
			body: "fix p2",
			actor: "lead",
			createdAt: "2026-05-12T00:00:00.000Z",
			updatedAt: "2026-05-12T00:00:00.000Z",
		},
	];
	const qcIssues: QcIssue[] = [
		{ id: "q-0", code: "page_without_text", severity: "warning", messageCode: "page_without_text", messageValues: { page: 1 }, pageIndex: 0 },
		{ id: "q-2", code: "unchanged_source_text", severity: "warning", messageCode: "unchanged_source_text", messageValues: { page: 3 }, pageIndex: 2 },
	];
	const assetIntegrityFor = (pageIndex: number): PageAssetIntegrity => ({
		pageIndex,
		status: "ready",
		label: "Ready",
		detail: "Available",
	});

	it("produces byte-identical summaries to the per-page summarizePageWork path", () => {
		const batch = summarizePageWorkBatch({
			pages,
			assetIntegrityFor,
			qcIssues,
			tasks,
			comments,
			aiReviewMarkers,
			reviewDecisions,
			productionMode: "solo",
		});

		const perPage = pages.map((page, pageIndex) => summarizePageWork({
			page,
			pageIndex,
			assetIntegrity: assetIntegrityFor(pageIndex),
			qcIssues,
			tasks,
			comments,
			aiReviewMarkers,
			reviewDecisions,
			productionMode: "solo",
		}));

		expect(batch).toHaveLength(3);
		expect(batch).toEqual(perPage);
	});

	it("routes each record to its own page bucket (no cross-page leakage)", () => {
		const [p0, p1, p2] = summarizePageWorkBatch({
			pages,
			assetIntegrityFor,
			qcIssues,
			tasks,
			comments,
			aiReviewMarkers,
			reviewDecisions,
		});

		// p0: one open urgent task, an AI marker needing review, a page_without_text warning.
		expect(p0.taskOpenCount).toBe(1);
		expect(p0.urgentTaskCount).toBe(1);
		expect(p0.aiAttentionCount).toBe(1);
		expect(p0.assignees).toEqual(["alice"]);
		// p1: one open comment only.
		expect(p1.openCommentCount).toBe(1);
		expect(p1.taskOpenCount).toBe(0);
		expect(p1.aiAttentionCount).toBe(0);
		// p2: high task, open comment, failed AI marker, changes-requested review.
		expect(p2.highTaskCount).toBe(1);
		expect(p2.openCommentCount).toBe(1);
		expect(p2.aiAttentionCount).toBe(1);
		expect(p2.latestReviewDecision?.status).toBe("changes_requested");
		expect(p2.assignees).toEqual(["bob"]);
	});

	it("uses persisted layer counts and does NOT depend on a live editor layer count", () => {
		// The bulk path takes no live-editor layer count: each page's layerCount comes from
		// its persisted textLayers. This is what lets PageNavigator skip the full N-page
		// rebuild on every text-layer add/remove (only the open page is re-merged live).
		const summaries = summarizePageWorkBatch({ pages, assetIntegrityFor });
		expect(summaries[0].layerCount).toBe(0); // p0 has no persisted text layers
		expect(summaries[1].layerCount).toBe(1); // p1 has the default single layer
		expect(summaries[2].layerCount).toBe(1);

		// Mutating page 1's persisted layers changes only page 1; there is no live-count input.
		const grown = summarizePageWorkBatch({
			pages: [pages[0], makePage({ textLayers: [...(pages[1].textLayers ?? []), { ...(pages[1].textLayers ?? [])[0], id: "extra" }] }), pages[2]],
			assetIntegrityFor,
		});
		expect(grown[1].layerCount).toBe(2);
		expect(grown[0].layerCount).toBe(summaries[0].layerCount);
		expect(grown[2].layerCount).toBe(summaries[2].layerCount);
	});

	it("respects a per-page layerCountFor override (e.g. live editor count for the open page)", () => {
		const summaries = summarizePageWorkBatch({
			pages,
			assetIntegrityFor,
			layerCountFor: (_page, pageIndex) => (pageIndex === 1 ? 7 : undefined),
		});
		expect(summaries[0].layerCount).toBe(0); // persisted
		expect(summaries[1].layerCount).toBe(7); // overridden
		expect(summaries[2].layerCount).toBe(1); // persisted
	});

	it("returns an empty array for an empty page list", () => {
		expect(summarizePageWorkBatch({ pages: [] })).toEqual([]);
	});
});
