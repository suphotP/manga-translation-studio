import type { RightPanelMode } from "$lib/stores/editor-ui.svelte.ts";
import { WORKFLOW_TASK_PRIORITY_OPTIONS } from "$lib/project/task-priority.js";
import type { AiTier, TextLayer, WorkflowTaskPriority, WorkflowTaskStatus, WorkspaceFeedItem } from "$lib/types.js";
import { _ } from "$lib/i18n";
import { get } from "svelte/store";

export interface RightPanelTab {
	id: RightPanelMode;
	// i18n keys (resolved in RightPanelHeader). The tabs used to carry rendered
	// Thai `label`/`description`; those are now localized so non-Thai locales no
	// longer see Thai tab chrome.
	labelKey: string;
	descriptionKey: string;
}

export interface RightPanelContextMetrics {
	mode: RightPanelMode;
	projectOpen: boolean;
	pageLabel: string;
	activeTool: string;
	aiTier: AiTier;
	isGenerating: boolean;
	brushTargetLabel: string;
	brushCanBrush: boolean;
	hasBaseImage: boolean;
	textLayerCount: number;
	imageLayerCount: number;
	selectedLayerText: string | null;
	selectedLayerLocked: boolean;
	selectedImageLayerName: string | null;
	selectedImageLayerLocked: boolean;
	currentPageInboxCount: number;
	workspaceFeedCount: number;
	currentPageWorkspaceFeedCount: number;
	qcErrorCount: number;
	qcWarningCount: number;
	currentPageCommentCount: number;
	currentPageTaskCount: number;
	workflowDoneCount: number;
	workflowTaskCount: number;
	pageCount: number;
	versionCount: number;
}

export type RightPanelContextTone = "neutral" | "attention" | "ready" | "running";

// Localizable text slot: either a plain `value` already in the viewer's language
// (a count/name/interpolated string the builder assembles) OR an i18n `key`
// (+ optional `values` for interpolation) the consumer resolves via $_(). The
// builder used to render Thai directly; it now emits keys so non-Thai locales
// localize the right-panel context header correctly.
export interface RightPanelTextSlot {
	key?: string;
	values?: Record<string, string | number>;
	value?: string;
}

export interface RightPanelContext {
	panelLabel?: RightPanelTextSlot;
	eyebrow: RightPanelTextSlot;
	title: RightPanelTextSlot;
	detail: RightPanelTextSlot;
	badge: RightPanelTextSlot;
	tone: RightPanelContextTone;
}

export const RIGHT_PANEL_TABS: readonly RightPanelTab[] = [
	{ id: "work", labelKey: "rightPanel.tabs.workLabel", descriptionKey: "rightPanel.tabs.workDescription" },
	{ id: "layers", labelKey: "rightPanel.tabs.layersLabel", descriptionKey: "rightPanel.tabs.layersDescription" },
	{ id: "ai", labelKey: "rightPanel.tabs.aiLabel", descriptionKey: "rightPanel.tabs.aiDescription" },
	{ id: "translate", labelKey: "rightPanel.tabs.translateLabel", descriptionKey: "rightPanel.tabs.translateDescription" },
	{ id: "project", labelKey: "rightPanel.tabs.projectLabel", descriptionKey: "rightPanel.tabs.projectDescription" },
];

// Slot helpers: `k(key, values?)` for an i18n-keyed slot, `v(text)` for an
// already-localized literal value.
function k(key: string, values?: Record<string, string | number>): RightPanelTextSlot {
	return values ? { key, values } : { key };
}
function v(value: string): RightPanelTextSlot {
	return { value };
}

function interpolateFallback(fallback: string, values?: Record<string, string | number>): string {
	if (!values) return fallback;
	return Object.entries(values).reduce(
		(text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
		fallback,
	);
}

function t(key: string, fallback: string, values?: Record<string, string | number>): string {
	try {
		const translate = get(_);
		const value = translate(key, values ? { values } : undefined);
		if (value && value !== key) return value;
	} catch {
		// Locale may be unavailable in isolated unit tests; fall back below.
	}
	return interpolateFallback(fallback, values);
}

// Workflow status options carry only the stable `id`; consumers localize the
// label via `$_("workWorkflow.status<Id>")` (the option list used to ship rendered
// Thai labels, which leaked into non-Thai locales through the status <select>).
export const RIGHT_PANEL_WORKFLOW_STATUS_OPTIONS: readonly { id: WorkflowTaskStatus }[] = [
	{ id: "todo" },
	{ id: "doing" },
	{ id: "review" },
	{ id: "done" },
];

export const RIGHT_PANEL_WORKFLOW_PRIORITY_OPTIONS: readonly { id: WorkflowTaskPriority; label: string }[] = WORKFLOW_TASK_PRIORITY_OPTIONS;

/**
 * Stable, locale-independent CODE for a text layer's source category. Returns the
 * category code itself (1:1 with `TextLayer["sourceCategory"]`); consumers localize
 * via `$_("layerCategory.<code>")`. This used to return rendered Thai (บทพูด/บรรยาย/…),
 * which leaked into already-localized panels for non-Thai locales.
 */
export function layerCategoryCode(category: TextLayer["sourceCategory"]): string {
	return category ?? "";
}

export function formatLayerConfidence(confidence: number | undefined): string {
	if (!Number.isFinite(confidence)) return "";
	const normalized = confidence! <= 1 ? confidence! * 100 : confidence!;
	return `${Math.max(0, Math.min(100, Math.round(normalized)))}%`;
}

export function formatLayerProvider(provider: string | undefined): string {
	if (!provider) return "";
	if (provider.includes("json")) return t("rightPanel.model.providerJson", "JSON");
	if (provider.includes("credit")) return t("rightPanel.model.providerPreset", "พรีเซ็ต");
	if (provider.includes("ai")) return t("rightPanel.model.providerAi", "AI");
	return provider.replace(/[-_]+/g, " ").slice(0, 18);
}

export function formatVersionSource(source: string): string {
	const labels: Record<string, [string, string]> = {
		save: ["rightPanel.model.versionSource.save", "บันทึก"],
		"import-json": ["rightPanel.model.versionSource.importJson", "Import JSON"],
		restore: ["rightPanel.model.versionSource.restore", "ย้อนเวอร์ชัน"],
		manual: ["rightPanel.model.versionSource.manual", "เวอร์ชันตั้งชื่อ"],
	};
	const label = labels[source];
	return label ? t(label[0], label[1]) : source.replace(/[-_]+/g, " ");
}

export function formatSignedDelta(value: number): string {
	if (value > 0) return `+${value}`;
	return `${value}`;
}

export function qcSeverityLabel(severity: string): string {
	const labels: Record<string, [string, string]> = {
		error: ["rightPanel.model.qcSeverity.error", "จุดบล็อก"],
		warning: ["rightPanel.model.qcSeverity.warning", "ต้องเช็ก"],
		info: ["rightPanel.model.qcSeverity.info", "ข้อมูล"],
	};
	const label = labels[severity];
	return label ? t(label[0], label[1]) : severity;
}

export function inboxSeverityLabel(severity: string): string {
	const labels: Record<string, [string, string]> = {
		error: ["rightPanel.model.inboxSeverity.error", "จุดบล็อก"],
		warning: ["rightPanel.model.inboxSeverity.warning", "ต้องเช็ก"],
		info: ["rightPanel.model.inboxSeverity.info", "งานด่วน"],
	};
	const label = labels[severity];
	return label ? t(label[0], label[1]) : severity;
}

export function workspaceKindLabel(kind: WorkspaceFeedItem["kind"]): string {
	const labels: Record<WorkspaceFeedItem["kind"], [string, string]> = {
		message: ["rightPanel.model.workspaceKind.message", "โน้ต"],
		activity: ["rightPanel.model.workspaceKind.activity", "เหตุการณ์"],
		comment: ["rightPanel.model.workspaceKind.comment", "โน้ต"],
		review_decision: ["rightPanel.model.workspaceKind.reviewDecision", "รีวิว"],
		version_review: ["rightPanel.model.workspaceKind.versionReview", "เวอร์ชัน"],
		task: ["rightPanel.model.workspaceKind.task", "งาน"],
		ai_marker: ["rightPanel.model.workspaceKind.aiMarker", "AI"],
		export_run: ["rightPanel.model.workspaceKind.exportRun", "Export"],
	};
	const [key, fallback] = labels[kind];
	return t(key, fallback);
}

export function buildRightPanelTabMeta(id: RightPanelMode, metrics: RightPanelContextMetrics): string {
	// แท็บแปลไม่มี meta พิเศษ (กัน fallthrough ไปโชว์ป้าย AI tier)
	if (id === "translate") return "";
	if (id === "work") {
		return metrics.currentPageInboxCount > 0 ? `${metrics.currentPageInboxCount}` : "";
	}
	if (id === "layers") {
		const editableCount = metrics.textLayerCount + metrics.imageLayerCount;
		return metrics.hasBaseImage
			? t("rightPanel.model.tabMeta.layersWithBase", "ฐาน 1 / แก้ {count}", { count: editableCount })
			: `${editableCount}`;
	}
	if (id === "project") return metrics.projectOpen ? metrics.pageLabel : "";
	if (id === "ai" && metrics.activeTool === "brush") return t("rightPanel.model.tabMeta.brush", "แปรง");
	return metrics.aiTier === "sfx-pro"
		? t("rightPanel.model.tabMeta.sfx", "SFX")
		: t("rightPanel.model.tabMeta.clean", "คลีน");
}

export function buildRightPanelContext(metrics: RightPanelContextMetrics): RightPanelContext {
	if (!metrics.projectOpen) {
		return {
			eyebrow: k("rightPanel.context.noProjectEyebrow"),
			title: k("rightPanel.context.noProjectTitle"),
			detail: k("rightPanel.context.noProjectDetail"),
			badge: k("rightPanel.context.noProjectBadge"),
			tone: "neutral",
		};
	}

		if (metrics.mode === "work") {
			const needsAttention = metrics.currentPageInboxCount > 0 || metrics.qcErrorCount > 0;
			return {
				eyebrow: k("rightPanel.context.workEyebrow"),
				title: metrics.currentPageInboxCount > 0
					? k("rightPanel.context.workHandoffCount", { count: metrics.currentPageInboxCount })
					: k("rightPanel.context.workCleared"),
				detail: k("rightPanel.context.workDetail", {
					errors: metrics.qcErrorCount,
					warnings: metrics.qcWarningCount,
					notes: metrics.currentPageCommentCount,
				}),
				badge: k("rightPanel.context.workBadge", {
					done: metrics.workflowDoneCount,
					total: metrics.workflowTaskCount || 0,
				}),
				tone: needsAttention ? "attention" : "ready",
			};
		}

	if (metrics.mode === "layers") {
		const totalLayerCount = metrics.textLayerCount + metrics.imageLayerCount;
		const selectedText = metrics.selectedLayerText?.trim();
		const selectedImage = metrics.selectedImageLayerName?.trim();
		const hasSelectedText = metrics.selectedLayerText !== null;
		const hasSelectedImage = metrics.selectedImageLayerName !== null;
		const hasSelectedEditableLayer = hasSelectedImage || hasSelectedText;
		const titleName = selectedImage || selectedText;
		return {
			eyebrow: k("rightPanel.context.layersEyebrow"),
			title: titleName
				? v(titleName)
				: (hasSelectedImage
					? k("rightPanel.context.layersSelectedImage")
					: (hasSelectedText
						? k("rightPanel.context.layersSelectedEmptyText")
						: (metrics.hasBaseImage
							? k("rightPanel.context.layersBaseLocked")
							: k("rightPanel.context.layersCount", { count: totalLayerCount })))),
			detail: hasSelectedEditableLayer
				? k("rightPanel.context.layersSelectedDetail", {
					images: metrics.imageLayerCount,
					texts: metrics.textLayerCount,
				})
				: (metrics.hasBaseImage
					? k("rightPanel.context.layersOverBaseDetail", { count: totalLayerCount })
					: k("rightPanel.context.layersEmptyDetail")),
			badge: metrics.selectedImageLayerLocked || metrics.selectedLayerLocked
				? k("rightPanel.context.layersBadgeLocked")
				: (hasSelectedEditableLayer
					? k("rightPanel.context.layersBadgeEditable")
					: (metrics.hasBaseImage
						? k("rightPanel.context.layersBadgeOriginal")
						: k("rightPanel.context.layersBadgeEmpty"))),
			tone: totalLayerCount > 0 || metrics.hasBaseImage ? "ready" : "neutral",
		};
	}

	if (metrics.mode === "ai") {
		if (metrics.activeTool === "brush") {
			return {
				panelLabel: k("rightPanel.context.aiBrushPanelLabel"),
				eyebrow: k("rightPanel.context.aiBrushEyebrow"),
				title: metrics.brushCanBrush
					? k("rightPanel.context.aiBrushReadyTitle")
					: k("rightPanel.context.aiBrushPickTitle"),
				detail: metrics.brushCanBrush
					? k("rightPanel.context.aiBrushReadyDetail")
					: k("rightPanel.context.aiBrushPickDetail"),
				// brushTargetLabel is the rendered brush-target name (out-of-batch #492
				// status path); fall back to the localized "brush" badge when empty.
				badge: metrics.brushTargetLabel ? v(metrics.brushTargetLabel) : k("rightPanel.context.aiBrushBadge"),
				tone: metrics.brushCanBrush ? "ready" : "attention",
			};
		}
		const cleanMode = metrics.aiTier !== "sfx-pro";
		return {
			eyebrow: cleanMode ? k("rightPanel.context.aiCleanEyebrow") : k("rightPanel.context.aiSfxEyebrow"),
			title: cleanMode ? k("rightPanel.context.aiCleanTitle") : k("rightPanel.context.aiSfxTitle"),
			detail: cleanMode ? k("rightPanel.context.aiCleanDetail") : k("rightPanel.context.aiSfxDetail"),
			badge: metrics.isGenerating
				? k("rightPanel.context.aiRunningBadge")
				: (cleanMode ? k("rightPanel.context.aiCleanBadge") : k("rightPanel.context.aiSfxBadge")),
			tone: metrics.isGenerating ? "running" : "neutral",
		};
	}

	return {
		eyebrow: k("rightPanel.context.projectEyebrow"),
		title: k("rightPanel.context.projectTitle", { count: metrics.pageCount }),
		detail: k("rightPanel.context.projectDetail", {
			pageLabel: metrics.pageLabel,
			versions: metrics.versionCount,
			events: metrics.workspaceFeedCount,
		}),
		badge: k("rightPanel.context.projectBadge"),
		tone: "neutral",
	};
}
