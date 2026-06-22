import { describe, expect, it } from "vitest";
import {
	buildRightPanelContext,
	buildRightPanelTabMeta,
	layerCategoryCode,
	formatLayerConfidence,
	formatLayerProvider,
	formatSignedDelta,
	formatVersionSource,
	inboxSeverityLabel,
	qcSeverityLabel,
	workspaceKindLabel,
	type RightPanelContextMetrics,
} from "$lib/panels/right-panel-model.js";

function metrics(overrides: Partial<RightPanelContextMetrics> = {}): RightPanelContextMetrics {
	return {
		mode: "work",
		projectOpen: true,
		pageLabel: "1/4",
		activeTool: "select",
		aiTier: "budget-clean",
		isGenerating: false,
		brushTargetLabel: "ยังไม่เลือกเลเยอร์",
		brushCanBrush: false,
		hasBaseImage: true,
		textLayerCount: 2,
		imageLayerCount: 0,
		selectedLayerText: null,
		selectedLayerLocked: false,
		selectedImageLayerName: null,
		selectedImageLayerLocked: false,
		currentPageInboxCount: 0,
		workspaceFeedCount: 9,
		currentPageWorkspaceFeedCount: 2,
		qcErrorCount: 0,
		qcWarningCount: 1,
		currentPageCommentCount: 1,
		currentPageTaskCount: 4,
		workflowDoneCount: 3,
		workflowTaskCount: 8,
		pageCount: 4,
		versionCount: 2,
		...overrides,
	};
}

describe("right panel model", () => {
	it("formats existing right-panel labels outside the Svelte component", () => {
		expect(layerCategoryCode("page_number")).toBe("page_number");
		expect(formatLayerConfidence(0.724)).toBe("72%");
		expect(formatLayerProvider("import-json")).toBe("JSON");
		expect(formatVersionSource("import-json")).toBe("นำเข้า JSON");
		expect(formatSignedDelta(3)).toBe("+3");
		expect(qcSeverityLabel("error")).toBe("จุดบล็อก");
		expect(inboxSeverityLabel("info")).toBe("งานด่วน");
		expect(workspaceKindLabel("version_review")).toBe("เวอร์ชัน");
	});

	it("keeps tab meta compact and mode-specific", () => {
		const base = metrics({ currentPageInboxCount: 5, textLayerCount: 7, imageLayerCount: 2, aiTier: "sfx-pro" });

		expect(buildRightPanelTabMeta("work", base)).toBe("5");
		expect(buildRightPanelTabMeta("layers", base)).toBe("ฐาน 1 / แก้ 9");
		expect(buildRightPanelTabMeta("ai", base)).toBe("SFX");
		expect(buildRightPanelTabMeta("ai", metrics({ activeTool: "brush" }))).toBe("แปรง");
		expect(buildRightPanelTabMeta("project", base)).toBe("1/4");
		expect(buildRightPanelTabMeta("work", metrics({ currentPageInboxCount: 0 }))).toBe("");
		expect(buildRightPanelTabMeta("layers", metrics({ hasBaseImage: false, textLayerCount: 7, imageLayerCount: 2 }))).toBe("9");
	});

	it("summarizes work mode with attention tone when urgent work or blockers exist", () => {
		// buildRightPanelContext now emits localizable text SLOTS ({ key, values } /
		// { value }) instead of rendered Thai; RightPanelHeader resolves them via $_.
		const context = buildRightPanelContext(metrics({
			mode: "work",
			currentPageInboxCount: 2,
			qcErrorCount: 1,
		}));

			expect(context).toMatchObject({
				eyebrow: { key: "rightPanel.context.workEyebrow" },
				title: { key: "rightPanel.context.workHandoffCount", values: { count: 2 } },
				badge: { key: "rightPanel.context.workBadge", values: { done: 3, total: 8 } },
				tone: "attention",
			});
			expect(context.detail).toMatchObject({
				key: "rightPanel.context.workDetail",
				values: { errors: 1, warnings: 1, notes: 1 },
			});
	});

	it("summarizes layer, ai, and project modes for the context slot", () => {
		expect(buildRightPanelContext(metrics({
			mode: "layers",
			selectedLayerText: "Hello",
			selectedLayerLocked: true,
			imageLayerCount: 1,
		}))).toMatchObject({
			eyebrow: { key: "rightPanel.context.layersEyebrow" },
			title: { value: "Hello" },
			badge: { key: "rightPanel.context.layersBadgeLocked" },
			tone: "ready",
		});

		expect(buildRightPanelContext(metrics({
			mode: "layers",
			selectedImageLayerName: "reference-card.png",
			selectedImageLayerLocked: false,
			textLayerCount: 1,
			imageLayerCount: 2,
		}))).toMatchObject({
			eyebrow: { key: "rightPanel.context.layersEyebrow" },
			title: { value: "reference-card.png" },
			detail: { key: "rightPanel.context.layersSelectedDetail", values: { images: 2, texts: 1 } },
			badge: { key: "rightPanel.context.layersBadgeEditable" },
			tone: "ready",
		});

		expect(buildRightPanelContext(metrics({
			mode: "layers",
			textLayerCount: 0,
			imageLayerCount: 0,
			selectedLayerText: null,
			selectedImageLayerName: null,
		}))).toMatchObject({
			eyebrow: { key: "rightPanel.context.layersEyebrow" },
			title: { key: "rightPanel.context.layersBaseLocked" },
			detail: { key: "rightPanel.context.layersOverBaseDetail", values: { count: 0 } },
			badge: { key: "rightPanel.context.layersBadgeOriginal" },
			tone: "ready",
		});

		expect(buildRightPanelContext(metrics({
			mode: "ai",
			aiTier: "clean-pro",
			isGenerating: true,
		}))).toMatchObject({
			eyebrow: { key: "rightPanel.context.aiCleanEyebrow" },
			badge: { key: "rightPanel.context.aiRunningBadge" },
			tone: "running",
		});

		expect(buildRightPanelContext(metrics({
			mode: "ai",
			activeTool: "brush",
			brushTargetLabel: "ยังไม่เลือกเลเยอร์",
			brushCanBrush: false,
		}))).toMatchObject({
			panelLabel: { key: "rightPanel.context.aiBrushPanelLabel" },
			eyebrow: { key: "rightPanel.context.aiBrushEyebrow" },
			title: { key: "rightPanel.context.aiBrushPickTitle" },
			// brushTargetLabel passes through as an already-localized literal value.
			badge: { value: "ยังไม่เลือกเลเยอร์" },
			tone: "attention",
		});

		expect(buildRightPanelContext(metrics({
			mode: "project",
			pageCount: 12,
			versionCount: 4,
		}))).toMatchObject({
			eyebrow: { key: "rightPanel.context.projectEyebrow" },
			title: { key: "rightPanel.context.projectTitle", values: { count: 12 } },
			badge: { key: "rightPanel.context.projectBadge" },
		});
	});
});
