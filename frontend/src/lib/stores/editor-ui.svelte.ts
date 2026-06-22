import {
	DEFAULT_CANVAS_OVERLAY_VISIBILITY,
	type CanvasOverlayVisibility,
	type CanvasWorkOverlayKind,
} from "$lib/editor/overlay-priority.js";
import type { ToolId } from "$lib/editor/tool-registry.svelte.js";

export type RightPanelMode = "work" | "layers" | "ai" | "project" | "translate";
export type WorkspaceView = "dashboard" | "inbox" | "tasks" | "library" | "pages" | "work" | "import" | "editor" | "review" | "settings" | "reports";
export type WorkspaceMode = "solo" | "team";
export type WorkspaceTeamMode = "lead" | "assigned";
export type WorkspaceEditorEntrySource = "library";
export type ChapterSetupMode = "create" | "add-chapter-to-title" | "fill-existing-zero-page";
export type ChapterSetupCompletionView = "editor" | "import-review";
export interface OpenPagesOptions {
	exportHistory?: boolean;
}

export interface ChapterSetupContext {
	mode: ChapterSetupMode;
	projectId?: string | null;
	titleKey?: string | null;
	titleName?: string | null;
	targetLang?: string | null;
	completionView?: ChapterSetupCompletionView;
	// First-run workspace-scope guard. A brand-new ("create" mode) chapter is always a
	// first project inside the active workspace, so the resulting `api.createProject`
	// MUST be workspace-scoped and must NOT silently mint an unscoped/orphan project
	// when the workspace context is still resolving. This flag is threaded into the
	// store create call (`loadFilesWithSetup`/`fillEmptyProjectWithPages`) so the store
	// guard fires for EVERY create entry point (dashboard CTA, top utility bar, command
	// palette, library "new story"), not just the dashboard CTA. It defaults to `true`
	// for `mode: "create"` (see `openChapterSetup`) so a caller cannot bypass the guard
	// by forgetting the flag; "fill-existing-zero-page"/"add-chapter-to-title" already
	// carry a resolved (already-scoped) projectId, so they leave it off.
	requireScopedCreate?: boolean;
}

export interface WorkspaceEditorEntryContext {
	source: WorkspaceEditorEntrySource;
	projectId: string;
	titleKey: string | null;
	title: string;
	chapterLabel: string;
	language: string;
	reason: string;
}

const WORKSPACE_EDITOR_ENTRY_KEY = "manga-editor.workspaceEditorEntry";
const WORKSPACE_MODE_KEY = "manga-editor.workspaceMode";
const WORKSPACE_TEAM_MODE_KEY = "manga-editor.workspaceTeamMode";

function readStoredWorkspaceMode(): WorkspaceMode {
	if (typeof localStorage === "undefined") return "solo";
	const stored = localStorage.getItem(WORKSPACE_MODE_KEY);
	return stored === "team" ? "team" : "solo";
}

function writeStoredWorkspaceMode(mode: WorkspaceMode): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(WORKSPACE_MODE_KEY, mode);
}

function readStoredWorkspaceTeamMode(): WorkspaceTeamMode {
	if (typeof localStorage === "undefined") return "lead";
	const stored = localStorage.getItem(WORKSPACE_TEAM_MODE_KEY);
	return stored === "assigned" ? "assigned" : "lead";
}

function writeStoredWorkspaceTeamMode(mode: WorkspaceTeamMode): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(WORKSPACE_TEAM_MODE_KEY, mode);
}

function readStoredWorkspaceEditorEntry(): WorkspaceEditorEntryContext | null {
	if (typeof sessionStorage === "undefined") return null;
	try {
		const raw = sessionStorage.getItem(WORKSPACE_EDITOR_ENTRY_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<WorkspaceEditorEntryContext>;
		if (
			parsed.source !== "library"
			|| typeof parsed.projectId !== "string"
			|| typeof parsed.title !== "string"
			|| typeof parsed.chapterLabel !== "string"
			|| typeof parsed.language !== "string"
			|| typeof parsed.reason !== "string"
		) {
			return null;
		}
		return {
			source: "library",
			projectId: parsed.projectId,
			titleKey: typeof parsed.titleKey === "string" ? parsed.titleKey : null,
			title: parsed.title,
			chapterLabel: parsed.chapterLabel,
			language: parsed.language,
			reason: parsed.reason,
		};
	} catch {
		return null;
	}
}

function writeStoredWorkspaceEditorEntry(context: WorkspaceEditorEntryContext | null): void {
	if (typeof sessionStorage === "undefined") return;
	if (!context) {
		sessionStorage.removeItem(WORKSPACE_EDITOR_ENTRY_KEY);
		return;
	}
	sessionStorage.setItem(WORKSPACE_EDITOR_ENTRY_KEY, JSON.stringify(context));
}

type TextInspectorFocusHandler = (layerId: string) => void;
type ImageInspectorFocusHandler = (layerId: string) => void;

class EditorUiStore {
	rightPanelMode = $state<RightPanelMode>("layers");
	/** Selected translate-script slot (แผงแปล ↔ หมุดบนภาพ). */
	translateSelectedSlotId = $state<string | null>(null);
	/** Slot ที่คนลงคำกด "วางบนภาพ" ค้างไว้ — คลิกถัดไปบน overlay = จุดวาง. */
	translatePlacingSlotId = $state<string | null>(null);
	inspectorOpen = $state(true);
	// Active dock tool id (Photopea-style left dock). The Fabric engine truth
	// stays `editorStore.currentTool`; this disambiguates dock tools that share
	// one engine tool — notably crop vs AI which both drive "cover".
	activeDockTool = $state<ToolId>("select");
	workspaceNavOpen = $state(false);
	notificationPanelOpen = $state(false);
	workspaceView = $state<WorkspaceView>("dashboard");
	workspaceMode = $state<WorkspaceMode>(readStoredWorkspaceMode());
	workspaceTeamMode = $state<WorkspaceTeamMode>(readStoredWorkspaceTeamMode());
	workspaceTitleKey = $state<string | null>(null);
	workspaceLanguageKey = $state<string | null>(null);
	workspaceEditorEntry = $state<WorkspaceEditorEntryContext | null>(readStoredWorkspaceEditorEntry());
	workspacePagesExportHistoryToken = $state(0);
	chapterSetupOpen = $state(false);
	chapterSetupContext = $state<ChapterSetupContext>({ mode: "create" });
	// Wave 3 W3.16: bulk image import (folder drag -> keep / merge-N / auto-split).
	bulkImportOpen = $state(false);
	textInspectorFocusLayerId = $state<string | null>(null);
	textInspectorFocusToken = $state(0);
	imageInspectorFocusLayerId = $state<string | null>(null);
	imageInspectorFocusToken = $state(0);
	creditToolsFocusToken = $state(0);
	brushLayerPickIntent = $state(false);
	showBrushHud = $state(false);
	canvasOverlayVisibility = $state<CanvasOverlayVisibility>({ ...DEFAULT_CANVAS_OVERLAY_VISIBILITY });
	private textInspectorFocusHandlers = new Set<TextInspectorFocusHandler>();
	private imageInspectorFocusHandlers = new Set<ImageInspectorFocusHandler>();

	setRightPanelMode(mode: RightPanelMode): void {
		this.rightPanelMode = mode;
		this.inspectorOpen = true;
	}

	setActiveDockTool(toolId: ToolId): void {
		this.activeDockTool = toolId;
	}

	setInspectorOpen(open: boolean): void {
		this.inspectorOpen = open;
	}

	toggleInspector(): void {
		this.inspectorOpen = !this.inspectorOpen;
	}

	setWorkspaceNavOpen(open: boolean): void {
		this.workspaceNavOpen = open;
	}

	toggleWorkspaceNav(): void {
		this.workspaceNavOpen = !this.workspaceNavOpen;
	}

	closeWorkspaceNav(): void {
		this.workspaceNavOpen = false;
	}

	openNotificationPanel(): void {
		this.notificationPanelOpen = true;
	}

	closeNotificationPanel(): void {
		this.notificationPanelOpen = false;
	}

	toggleNotificationPanel(): void {
		this.notificationPanelOpen = !this.notificationPanelOpen;
	}

	setWorkspaceView(view: WorkspaceView): void {
		this.workspaceView = view;
		this.workspaceNavOpen = false;
	}

	setWorkspaceMode(mode: WorkspaceMode): void {
		this.workspaceMode = mode;
		writeStoredWorkspaceMode(mode);
	}

	setWorkspaceTeamMode(mode: WorkspaceTeamMode): void {
		this.workspaceTeamMode = mode;
		writeStoredWorkspaceTeamMode(mode);
	}

	setWorkspaceTitleKey(titleKey: string | null): void {
		this.workspaceTitleKey = titleKey;
	}

	setWorkspaceLanguageKey(languageKey: string | null): void {
		this.workspaceLanguageKey = languageKey;
	}

	setWorkspaceEditorEntry(context: WorkspaceEditorEntryContext | null): void {
		this.workspaceEditorEntry = context;
		writeStoredWorkspaceEditorEntry(context);
	}

	openEditor(context: WorkspaceEditorEntryContext | null | undefined = undefined): void {
		if (context !== undefined) {
			this.setWorkspaceEditorEntry(context);
		}
		this.workspaceView = "editor";
	}

	openDashboard(): void {
		this.workspaceView = "dashboard";
	}

	openTasks(): void {
		this.workspaceView = "tasks";
	}

	openInbox(): void {
		this.workspaceView = "inbox";
	}

	openSettings(): void {
		this.workspaceView = "settings";
	}

	openReports(): void {
		this.workspaceView = "reports";
	}

	openLibrary(titleKey?: string | null): void {
		if (titleKey !== undefined) this.workspaceTitleKey = titleKey;
		this.workspaceView = "library";
	}

	openPages(options: OpenPagesOptions = {}): void {
		if (options.exportHistory) {
			this.workspacePagesExportHistoryToken += 1;
		}
		this.workspaceView = "pages";
	}

	openWorkBoard(): void {
		this.workspaceView = "work";
	}

	openReview(): void {
		this.workspaceView = "review";
	}

	openImportReview(): void {
		this.workspaceView = "import";
	}

	openChapterSetup(context: ChapterSetupContext = { mode: "create" }): void {
		// Default the first-run scope guard ON for brand-new creates so it can't be
		// bypassed by an entry point that forgets the flag (top utility bar, command
		// palette, …). Callers that already scope to an existing project (fill/add-chapter)
		// leave it off; an explicit `requireScopedCreate` on the context still wins.
		const requireScopedCreate =
			context.requireScopedCreate ?? context.mode === "create";
		this.chapterSetupContext = { ...context, requireScopedCreate };
		this.chapterSetupOpen = true;
	}

	closeChapterSetup(): void {
		this.chapterSetupOpen = false;
		this.chapterSetupContext = { mode: "create" };
	}

	openBulkImport(): void {
		this.bulkImportOpen = true;
	}

	closeBulkImport(): void {
		this.bulkImportOpen = false;
	}

	focusTextInspector(layerId: string): void {
		this.workspaceView = "editor";
		this.rightPanelMode = "layers";
		this.inspectorOpen = true;
		this.textInspectorFocusLayerId = layerId;
		this.textInspectorFocusToken += 1;
		for (const handler of this.textInspectorFocusHandlers) {
			handler(layerId);
		}
	}

	focusImageInspector(layerId: string): void {
		this.workspaceView = "editor";
		this.rightPanelMode = "layers";
		this.inspectorOpen = true;
		this.imageInspectorFocusLayerId = layerId;
		this.imageInspectorFocusToken += 1;
		this.brushLayerPickIntent = false;
		for (const handler of this.imageInspectorFocusHandlers) {
			handler(layerId);
		}
	}

	focusCreditTools(): void {
		this.workspaceView = "editor";
		this.rightPanelMode = "layers";
		this.inspectorOpen = true;
		this.creditToolsFocusToken += 1;
	}

	clearImageInspectorFocus(): void {
		this.imageInspectorFocusLayerId = null;
		this.imageInspectorFocusToken += 1;
	}

	startBrushLayerPick(): void {
		this.workspaceView = "editor";
		this.rightPanelMode = "layers";
		this.inspectorOpen = true;
		this.brushLayerPickIntent = true;
	}

	onTextInspectorFocus(handler: TextInspectorFocusHandler): () => void {
		this.textInspectorFocusHandlers.add(handler);
		return () => {
			this.textInspectorFocusHandlers.delete(handler);
		};
	}

	onImageInspectorFocus(handler: ImageInspectorFocusHandler): () => void {
		this.imageInspectorFocusHandlers.add(handler);
		return () => {
			this.imageInspectorFocusHandlers.delete(handler);
		};
	}

	isCanvasOverlayVisible(kind: CanvasWorkOverlayKind): boolean {
		return this.canvasOverlayVisibility[kind];
	}

	setCanvasOverlayVisible(kind: CanvasWorkOverlayKind, visible: boolean): void {
		if (this.canvasOverlayVisibility[kind] === visible) return;
		this.canvasOverlayVisibility = {
			...this.canvasOverlayVisibility,
			[kind]: visible,
		};
	}

	toggleCanvasOverlay(kind: CanvasWorkOverlayKind): void {
		this.setCanvasOverlayVisible(kind, !this.canvasOverlayVisibility[kind]);
	}

	setShowBrushHud(value: boolean): void {
		this.showBrushHud = value;
	}

	toggleBrushHud(): void {
		this.showBrushHud = !this.showBrushHud;
	}

	__resetForTesting(): void {
		this.rightPanelMode = "layers";
		this.inspectorOpen = true;
		this.activeDockTool = "select";
		this.workspaceView = "dashboard";
		this.workspaceMode = "solo";
		writeStoredWorkspaceMode("solo");
		this.workspaceTeamMode = "lead";
		writeStoredWorkspaceTeamMode("lead");
		this.workspaceTitleKey = null;
		this.workspaceLanguageKey = null;
		this.setWorkspaceEditorEntry(null);
		this.workspacePagesExportHistoryToken = 0;
		this.chapterSetupOpen = false;
		this.chapterSetupContext = { mode: "create" };
		this.textInspectorFocusLayerId = null;
		this.textInspectorFocusToken = 0;
		this.imageInspectorFocusLayerId = null;
		this.imageInspectorFocusToken = 0;
		this.brushLayerPickIntent = false;
		this.showBrushHud = false;
		this.canvasOverlayVisibility = { ...DEFAULT_CANVAS_OVERLAY_VISIBILITY };
		this.textInspectorFocusHandlers.clear();
		this.imageInspectorFocusHandlers.clear();
	}
}

export const editorUiStore = new EditorUiStore();
