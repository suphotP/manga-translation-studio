import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import type { ProjectImageAssetSummary, ProjectVersion, ProjectVersionDetail } from "$lib/api/client.ts";
import { formatExportArtifactPersistenceError, formatExportArtifactPersistenceMessage, projectStore } from "$lib/stores/project.svelte.ts";
import type {
	ActivityEvent,
	AiReviewMarker,
	ImageLayer,
	Page,
	PageReviewDecision,
	ProjectComment,
	ProjectState,
	TextLayer,
	WorkflowTask,
	WorkspaceMessage,
} from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => {
	const UPLOAD_TOO_LARGE_MESSAGE =
		"ไฟล์รวมกันใหญ่เกินไป — อัปโหลดทีละน้อยลง หรือย่อขนาด/บีบอัดรูปก่อน แล้วลองอีกครั้ง";
	class ApiError extends Error {
		readonly status: number;
		readonly statusText: string;
		readonly code?: string;
		readonly body?: unknown;

		constructor(
			message: string,
			details: { status: number; statusText: string; code?: string; body?: unknown },
		) {
			super(message);
			this.name = "ApiError";
			this.status = details.status;
			this.statusText = details.statusText;
			this.code = details.code;
			this.body = details.body;
		}
	}
	return {
	ApiError,
	UPLOAD_TOO_LARGE_MESSAGE,
	isUploadTooLargeError: (error: unknown) => {
		// Mirror production: unwrap a batch-failure wrapper (cause holds the ApiError)
		// so a 413 is still recognized when annotated with a failed page span.
		if (error && typeof error === "object" && !(error instanceof ApiError) && "cause" in error) {
			const cause = (error as { cause?: unknown }).cause;
			if (cause instanceof ApiError) error = cause;
		}
		if (!(error instanceof ApiError)) return false;
		if (error.code === "upload_batch_size_exceeded") return true;
		if (error.status === 0) return true;
		// A coded quota 413 (storage_quota_exceeded) keeps its own message.
		if (error.status === 413) return error.code !== "storage_quota_exceeded";
		return false;
	},
	createProject: vi.fn(),
	loadProject: vi.fn(),
	listProjects: vi.fn(),
	saveProject: vi.fn(),
	downloadExportArtifact: vi.fn(),
	uploadImages: vi.fn(),
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
	isApiAssetUrl: vi.fn((url: string) => typeof url === "string" && url.startsWith("/api/")),
	signedImageUrl: vi.fn((projectId: string, imageId: string) =>
		Promise.resolve(`/api/project/${projectId}/images/${imageId}?assetToken=mock`)),
	// Default: export token mints OK (asset `passed`) → tokened URL distinct from input,
	// so the fail-closed single-page export gate passes.
	signedAssetUrl: vi.fn((url: string) => Promise.resolve(`${url}?assetToken=mock`)),
	ExportAssetNotAuthorizedError: class ExportAssetNotAuthorizedError extends Error {
		readonly projectId: string;
		readonly imageId: string;
		constructor(projectId: string, imageId: string) {
			super(`Asset ${projectId}/${imageId} is not authorized for export`);
			this.name = "ExportAssetNotAuthorizedError";
			this.projectId = projectId;
			this.imageId = imageId;
		}
	},
	fetchAuthedObjectUrl: vi.fn(() => Promise.resolve("blob:mock-export")),
	fetchAuthedObjectUrlWithBlob: vi.fn(() =>
		Promise.resolve({ objectUrl: "blob:mock-export", blob: new Blob([new Uint8Array(2048)]) })),
	recordExportUsage: vi.fn(() => Promise.resolve({ ok: true, eventId: "evt-mock", usage: {} })),
	importTranslations: vi.fn(),
	getProjectVersions: vi.fn(),
	getProjectVersionDetail: vi.fn(),
	getProjectComments: vi.fn(),
	getProjectWorkflow: vi.fn(),
	updateTaskStatus: vi.fn(),
	updateProjectTask: vi.fn(),
	bulkUpdateProjectTasks: vi.fn(),
	getAiReviewMarkers: vi.fn(),
	createAiReviewMarker: vi.fn(),
	getProjectReviewDecisions: vi.fn(),
	createProjectReviewDecision: vi.fn(),
	getWorkspaceFeed: vi.fn(),
	createWorkspaceMessage: vi.fn(),
	updateAiReviewMarker: vi.fn(),
	createAiReviewMarkerComment: vi.fn(),
	linkAiReviewMarkerReviewTask: vi.fn(),
	createProjectComment: vi.fn(),
	updateProjectComment: vi.fn(),
	listProjectImageAssets: vi.fn(),
	restoreProjectVersion: vi.fn(),
	applyAiResultToPage: vi.fn(),
	};
});

vi.mock("$lib/stores/import-remap.svelte.ts", () => ({
	importRemapStore: {
		open: vi.fn(),
	},
}));

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "layer-1",
		text: "แปลเสร็จแล้ว",
		x: 10,
		y: 20,
		w: 160,
		h: 48,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "image-layer-1",
		imageId: "overlay.webp",
		imageName: "overlay.webp",
		x: 10,
		y: 20,
		w: 240,
		h: 120,
		rotation: 0,
		opacity: 1,
		index: 0,
		role: "overlay",
		...overrides,
	};
}

function comment(overrides: Partial<ProjectComment> = {}): ProjectComment {
	return {
		id: "comment-1",
		pageIndex: 0,
		layerId: "layer-1",
		body: "Please check this page",
		author: "lead",
		mentions: [],
		status: "open",
		createdAt: "2026-05-14T00:00:00.000Z",
		updatedAt: "2026-05-14T00:00:00.000Z",
		...overrides,
	};
}

function aiReviewMarker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 10, y: 20, w: 120, h: 80 },
		status: "needs_review",
		tier: "budget-clean",
		createdAt: "2026-05-14T00:00:00.000Z",
		updatedAt: "2026-05-14T00:00:00.000Z",
		...overrides,
	};
}

function reviewDecision(overrides: Partial<PageReviewDecision> = {}): PageReviewDecision {
	return {
		id: "decision-1",
		pageIndex: 0,
		status: "changes_requested",
		body: "Check page copy",
		actor: "lead",
		createdAt: "2026-05-14T00:00:00.000Z",
		updatedAt: "2026-05-14T00:00:00.000Z",
		...overrides,
	};
}

function workspaceMessage(overrides: Partial<WorkspaceMessage> = {}): WorkspaceMessage {
	return {
		id: "message-1",
		pageIndex: 0,
		body: "Local workspace note",
		author: "lead",
		createdAt: "2026-05-14T00:00:00.000Z",
		updatedAt: "2026-05-14T00:00:00.000Z",
		...overrides,
	};
}

function activityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
	return {
		id: "activity-1",
		type: "task_updated",
		message: "Local workflow already seeded",
		actor: "system",
		createdAt: "2026-05-14T00:00:00.000Z",
		...overrides,
	};
}

function workflowTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "translate",
		status: "todo",
		priority: "normal",
		pageIndex: 0,
		title: "Translate page 1",
		createdAt: "2026-05-14T00:00:00.000Z",
		updatedAt: "2026-05-14T00:00:00.000Z",
		...overrides,
	};
}

function imageAsset(overrides: Partial<ProjectImageAssetSummary> = {}): ProjectImageAssetSummary {
	return {
		assetId: "asset-image-1",
		imageId: "image-1.webp",
		originalName: "image-1.webp",
		mimeType: "image/webp",
		sizeBytes: 1024,
		sha256: "sha-image-1",
		storageDriver: "debug",
		storageKey: "objects/image-1.webp",
		width: 1000,
		height: 1600,
		storageStatus: "released",
		moderationStatus: "passed",
		derivativeCount: 0,
		createdAt: "2026-05-14T00:00:00.000Z",
		updatedAt: "2026-05-14T00:00:00.000Z",
		...overrides,
	};
}

function projectVersion(overrides: Partial<ProjectVersion> = {}): ProjectVersion {
	return {
		versionId: "version-1",
		projectId: "flow208-project",
		source: "save",
		createdAt: "2026-05-14T00:00:00.000Z",
		pageCount: 1,
		textLayerCount: 1,
		...overrides,
	};
}

function projectVersionDetail(overrides: Partial<ProjectVersionDetail> = {}): ProjectVersionDetail {
	const version = projectVersion();
	return {
		version,
		diff: {
			current: {
				name: "Base Project",
				pageCount: 1,
				textLayerCount: 1,
				pages: [{ pageIndex: 0, imageId: "image-1.webp", imageName: "image-1.webp", textLayerCount: 1 }],
			},
			snapshot: {
				name: "Base Project",
				pageCount: 1,
				textLayerCount: 1,
				pages: [{ pageIndex: 0, imageId: "image-1.webp", imageName: "image-1.webp", textLayerCount: 1 }],
			},
			pageDelta: 0,
			textLayerDelta: 0,
			changedPages: [],
			changedPageCount: 0,
		},
		reviews: [],
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Base Project",
		createdAt: "2026-05-14T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [page()],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

async function runImportJsonWithFile(file: File, editor?: any): Promise<void> {
	const createElement = document.createElement.bind(document);
	const input = createElement("input") as HTMLInputElement;
	let changePromise: Promise<void> | void;
	Object.defineProperty(input, "files", {
		value: [file],
		configurable: true,
	});
	input.click = vi.fn(() => {
		changePromise = input.onchange?.(new Event("change")) as Promise<void> | void;
	});
	const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
		if (tagName.toLowerCase() === "input") return input;
		return createElement(tagName);
	});

	try {
		await projectStore.importJson(editor);
		await changePromise;
	} finally {
		createElementSpy.mockRestore();
	}
}

beforeEach(() => {
	projectStore.__resetForTesting();
	// The Library fetch is workspace-scoped and intentionally fetches NOTHING when no
	// current workspace resolves (cross-workspace isolation). Persist a current
	// workspace id so `loadRecentProjects()` exercises a real scoped fetch in these
	// recent-project error-formatting / local-merge cases.
	window.localStorage.setItem("manga-editor.currentWorkspaceId", "ws-test");
	vi.clearAllMocks();
	vi.mocked(api.importTranslations).mockResolvedValue({ imported: 1, skipped: 0 });
	vi.mocked(api.getProjectVersions).mockResolvedValue({ versions: [] });
	vi.mocked(api.getProjectVersionDetail).mockResolvedValue(projectVersionDetail());
	vi.mocked(api.getProjectComments).mockResolvedValue({ comments: [] });
	vi.mocked(api.getProjectWorkflow).mockResolvedValue({ tasks: [], activityLog: [] });
	vi.mocked(api.getAiReviewMarkers).mockResolvedValue({ markers: [] });
	vi.mocked(api.getProjectReviewDecisions).mockResolvedValue({ decisions: [] });
	vi.mocked(api.getWorkspaceFeed).mockResolvedValue({
		items: [],
		messages: [],
		activityLog: [],
	});
	vi.mocked(api.listProjects).mockResolvedValue({ projects: [] });
	vi.mocked(api.listProjectImageAssets).mockResolvedValue({ assets: [] });
	vi.mocked(api.saveProject).mockResolvedValue(undefined);
	vi.mocked(api.restoreProjectVersion).mockResolvedValue({ ok: true, restoredVersionId: "version-default" });
});

describe("ProjectStore stale save guard", () => {
	it("downloads a local conflict copy after syncing live editor layers", async () => {
		const layer = textLayer({ id: "local-layer", text: "Unsaved line" });
		projectStore.__setProjectForTesting(project({
			name: "Conflict Chapter",
			pages: [page({ textLayers: [] })],
		}));
		projectStore.saveErrorMessage = "โปรเจกต์ถูกแก้จากที่อื่น";
		const editor = {
			getAllTextLayers: vi.fn(() => [layer]),
			getAllImageLayers: vi.fn(() => []),
		};
		const downloadBlob = vi
			.spyOn(projectStore as unknown as { downloadBlob: (blob: Blob, filename: string) => void }, "downloadBlob")
			.mockImplementation(() => {});

		await projectStore.downloadLocalConflictCopy(editor);

		expect(projectStore.project?.pages[0].textLayers).toEqual([layer]);
		expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^Conflict-Chapter_local-copy_/));
		const blob = downloadBlob.mock.calls[0][0] as Blob;
		const payload = JSON.parse(await blob.text());
		expect(payload.kind).toBe("manga-editor-conflict-local-copy");
		expect(payload.reason).toBe("project_save_conflict");
		expect(payload.message).toBe("งานถูกแก้จากที่อื่น โหลดใหม่ก่อนบันทึก");
		expect(payload.projectId).toBe(projectStore.project?.projectId);
		expect(payload.projectName).toBe("Conflict Chapter");
		expect(payload.pageCount).toBe(1);
		expect(payload.textLayerCount).toBe(1);
		expect(payload.imageLayerCount).toBe(0);
		expect(payload.project.pages[0].textLayers).toEqual([layer]);
		expect(projectStore.statusMsg).toBe("ดาวน์โหลดสำเนางานในแท็บนี้แล้ว");
	});

	it("stores a local recovery draft before reloading after a save conflict", async () => {
		const layer = textLayer({ id: "recovery-layer", text: "Keep me" });
		projectStore.__setProjectForTesting(project({
			projectId: "11111111-1111-4111-8111-111111111111",
			name: "Recoverable Chapter",
			pages: [page({ textLayers: [] })],
		}));
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "conflict";
		projectStore.saveErrorMessage = "งานถูกแก้จากที่อื่น";
		const editor = {
			getAllTextLayers: vi.fn(() => [layer]),
			getAllImageLayers: vi.fn(() => []),
		};
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(true);
		window.localStorage.clear();
		try {
			const opened = await projectStore.reloadProjectAfterConflict(editor, { createRecoveryCopy: true });

			expect(opened).toBe(true);
			expect(openProject).toHaveBeenCalledWith(projectStore.project?.projectId, editor);
			const index = JSON.parse(window.localStorage.getItem("manga-editor:conflict-recovery:index") ?? "[]") as string[];
			expect(index).toHaveLength(1);
			const stored = JSON.parse(window.localStorage.getItem(`manga-editor:conflict-recovery:${index[0]}`) ?? "{}");
			expect(stored.kind).toBe("manga-editor-conflict-local-copy");
			expect(stored.projectName).toBe("Recoverable Chapter");
			expect(stored.project.pages[0].textLayers).toEqual([layer]);
			expect(projectStore.statusMsg).toBe("โหลดล่าสุดแล้ว และเก็บสำเนากู้คืนไว้ในเครื่อง: Recoverable Chapter");
		} finally {
			openProject.mockRestore();
		}
	});

	it("does not claim the recovery draft was stored when browser persistence fails", async () => {
		const layer = textLayer({ id: "quota-recovery-layer", text: "Keep me even if quota fails" });
		projectStore.__setProjectForTesting(project({
			projectId: "11111111-1111-4111-8111-111111111112",
			name: "Quota Blocked Chapter",
			pages: [page({ textLayers: [] })],
		}));
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "conflict";
		projectStore.saveErrorMessage = "งานถูกแก้จากที่อื่น";
		const editor = {
			getAllTextLayers: vi.fn(() => [layer]),
			getAllImageLayers: vi.fn(() => []),
		};
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(true);
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("quota exceeded", "QuotaExceededError");
		});
		window.localStorage.clear();
		try {
			const opened = await projectStore.reloadProjectAfterConflict(editor, { createRecoveryCopy: true });

			expect(opened).toBe(true);
			expect(openProject).toHaveBeenCalledWith(projectStore.project?.projectId, editor);
			expect(projectStore.project?.pages[0].textLayers).toEqual([layer]);
			expect(projectStore.statusMsg).toBe("โหลดล่าสุดแล้ว แต่สำเนากู้คืนเก็บใน browser ไม่สำเร็จ ดาวน์โหลดสำเนาไว้ก่อน");
			expect(window.localStorage.getItem("manga-editor:conflict-recovery:index")).toBeNull();
		} finally {
			setItem.mockRestore();
			openProject.mockRestore();
		}
	});

	it("stores a local recovery draft before restoring a version with dirty local edits", async () => {
		const localLayer = textLayer({ id: "dirty-version-layer", text: "Unsaved before restore" });
		const restored = project({
			projectId: "11111111-1111-4111-8111-111111111113",
			name: "Restored Chapter",
			pages: [page({ textLayers: [textLayer({ id: "restored-layer", text: "Server version" })] })],
		});
		projectStore.__setProjectForTesting(project({
			projectId: restored.projectId,
			name: "Dirty Version Chapter",
			pages: [page({ textLayers: [localLayer] })],
		}));
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.restoreProjectVersion).mockResolvedValue({ ok: true, restoredVersionId: "version-1" });
		vi.mocked(api.loadProject).mockResolvedValue(restored);
		window.localStorage.clear();

		await projectStore.restoreVersion("version-1");

		// W3.9: restoreProjectVersion gained an optional `scope` arg; a full
		// (legacy) restore passes `undefined` so nothing outside scope is touched.
		expect(api.restoreProjectVersion).toHaveBeenCalledWith(restored.projectId, "version-1", undefined);
		const index = JSON.parse(window.localStorage.getItem("manga-editor:conflict-recovery:index") ?? "[]") as string[];
		expect(index).toHaveLength(1);
		const stored = JSON.parse(window.localStorage.getItem(`manga-editor:conflict-recovery:${index[0]}`) ?? "{}");
		expect(stored.projectName).toBe("Dirty Version Chapter");
		expect(stored.project.pages[0].textLayers).toEqual([localLayer]);
		expect(projectStore.project?.name).toBe("Restored Chapter");
		expect(projectStore.statusMsg).toBe("ย้อนงานไปจุดบันทึกแล้ว และเก็บสำเนากู้คืนไว้ในเครื่อง: Dirty Version Chapter");
	});

	it("blocks dirty version restore when the recovery draft cannot be persisted", async () => {
		const localLayer = textLayer({ id: "dirty-version-quota-layer", text: "Do not lose this" });
		projectStore.__setProjectForTesting(project({
			projectId: "11111111-1111-4111-8111-111111111114",
			name: "Quota Restore Chapter",
			pages: [page({ textLayers: [localLayer] })],
		}));
		projectStore.markCurrentPageUnsaved();
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("quota exceeded", "QuotaExceededError");
		});
		window.localStorage.clear();
		try {
			await projectStore.restoreVersion("version-quota");

			expect(api.restoreProjectVersion).not.toHaveBeenCalled();
			expect(projectStore.project?.name).toBe("Quota Restore Chapter");
			expect(projectStore.project?.pages[0].textLayers).toEqual([localLayer]);
			expect(projectStore.saveSyncStatus).toBe("error");
			expect(projectStore.saveErrorMessage).toBe("สำเนากู้คืนเก็บใน browser ไม่สำเร็จ");
			expect(projectStore.statusMsg).toBe("ยังไม่ย้อนเวอร์ชัน: สำเนากู้คืนเก็บใน browser ไม่สำเร็จ ดาวน์โหลดสำเนาไว้ก่อน");
		} finally {
			setItem.mockRestore();
		}
	});

	it("keeps backend-ineligible debug projects local after storing a recovery draft", async () => {
		const layer = textLayer({ id: "debug-recovery-layer", text: "Keep local debug edit" });
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			name: "Debug Recoverable Chapter",
			pages: [page({ textLayers: [] })],
		}));
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "conflict";
		projectStore.saveErrorMessage = "งานถูกแก้จากที่อื่น";
		const editor = {
			getAllTextLayers: vi.fn(() => [layer]),
			getAllImageLayers: vi.fn(() => []),
		};
		const openProject = vi.spyOn(projectStore, "openProject");
		window.localStorage.clear();

		const opened = await projectStore.reloadProjectAfterConflict(editor, { createRecoveryCopy: true });

		expect(opened).toBe(true);
		expect(openProject).not.toHaveBeenCalled();
		const index = JSON.parse(window.localStorage.getItem("manga-editor:conflict-recovery:index") ?? "[]") as string[];
		expect(index).toHaveLength(1);
		const stored = JSON.parse(window.localStorage.getItem(`manga-editor:conflict-recovery:${index[0]}`) ?? "{}");
		expect(stored.projectName).toBe("Debug Recoverable Chapter");
		expect(stored.project.pages[0].textLayers).toEqual([layer]);
		expect(projectStore.saveSyncStatus).toBe("unsaved");
		expect(projectStore.saveErrorKind).toBeNull();
		expect(projectStore.saveErrorMessage).toBeNull();
		expect(api.loadProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("เก็บสำเนากู้คืนไว้ในเครื่องแล้ว: Debug Recoverable Chapter");
	});

	it("restores a local recovery draft and keeps the current state recoverable", async () => {
		const restoredLayer = textLayer({ id: "restored-layer", text: "Recovered line" });
		const currentLayer = textLayer({ id: "current-layer", text: "Current line before restore" });
		const draft = {
			kind: "manga-editor-conflict-local-copy",
			id: "draft-restore-1",
			exportedAt: "2026-05-20T09:00:00.000Z",
			reason: "project_save_conflict",
			message: "งานถูกแก้จากที่อื่น",
			projectId: "project-restore",
			projectName: "Recovered Chapter",
			pageIndex: 0,
			pageCount: 1,
			textLayerCount: 1,
			imageLayerCount: 0,
			project: project({
				projectId: "project-restore",
				name: "Recovered Chapter",
				pages: [page({ textLayers: [restoredLayer] })],
			}),
		};
		window.localStorage.clear();
		window.localStorage.setItem("manga-editor:conflict-recovery:index", JSON.stringify([draft.id]));
		window.localStorage.setItem(`manga-editor:conflict-recovery:${draft.id}`, JSON.stringify(draft));
		projectStore.__setProjectForTesting(project({
			projectId: "project-current",
			name: "Current Chapter",
			pages: [page({ textLayers: [] })],
		}));
		const editor = {
			getAllTextLayers: vi.fn(() => [currentLayer]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.registerLocalImageUrl("image-1.webp", "data:image/png;base64,recovery");

		expect(projectStore.loadLocalConflictRecoveryDrafts().map((item) => item.id)).toEqual([draft.id]);
		const restored = await projectStore.restoreLocalConflictRecoveryDraft(draft.id, editor);

		expect(restored).toBe(true);
		expect(projectStore.project?.name).toBe("Recovered Chapter");
		expect(projectStore.project?.pages[0].textLayers).toEqual([restoredLayer]);
		expect(editor.loadImage).toHaveBeenCalledWith("data:image/png;base64,recovery");
		expect(editor.addTextLayer).toHaveBeenCalledWith(restoredLayer);
		expect(projectStore.saveSyncStatus).toBe("unsaved");
		expect(projectStore.statusMsg).toBe("กู้คืนสำเนาในเครื่องแล้ว: Recovered Chapter");
		const index = JSON.parse(window.localStorage.getItem("manga-editor:conflict-recovery:index") ?? "[]") as string[];
		expect(index[0]).toContain("project-current-");
		expect(index).toContain(draft.id);
	});

	it("places text credits on the first and last page for chapter-edge scope", () => {
		const chapter = project({
			currentPage: 1,
			pages: [
				page({ imageId: "page-1.webp", textLayers: [] }),
				page({ imageId: "page-2.webp", textLayers: [] }),
				page({ imageId: "page-3.webp", textLayers: [] }),
			],
		});
		projectStore.__setProjectForTesting(chapter);
		const editor = {
			imageWidth: 800,
			imageHeight: 1200,
			addTextLayer: vi.fn(),
			getAllTextLayers: vi.fn(() => []),
		};

		const selected = projectStore.addCreditLayer(
			editor,
			"credit-bottom-center",
			"Chapter team",
			32,
			"chapter-edges",
		);

		expect(selected).toBeNull();
		expect(editor.addTextLayer).not.toHaveBeenCalled();
		expect(projectStore.project?.pages[0].textLayers).toHaveLength(1);
		expect(projectStore.project?.pages[1].textLayers).toHaveLength(0);
		expect(projectStore.project?.pages[2].textLayers).toHaveLength(1);
		expect(projectStore.project?.pages[0].textLayers[0]).toMatchObject({
			text: "Chapter team",
			sourceCategory: "credit",
			y: 32,
		});
		expect(projectStore.project?.pages[2].textLayers[0]?.y).toBeGreaterThan(1000);
		expect(projectStore.statusMsg).toBe("เพิ่มเครดิตแล้ว: หัวหน้าแรกและท้ายหน้าสุดท้าย - เปิดแต่ละหน้าแล้วลากเครดิตเพื่อจูนตำแหน่ง");
		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});

	it("adds text credits in editor-only image sessions instead of silently doing nothing", () => {
		const addedLayers: TextLayer[] = [];
		const editor = {
			imageWidth: 1600,
			imageHeight: 2400,
			addTextLayer: vi.fn((layer: TextLayer) => addedLayers.push(layer)),
			getAllTextLayers: vi.fn(() => addedLayers),
		};

		const selected = projectStore.addCreditLayer(
			editor,
			"credit-bottom-center",
			"Translator: QA Team",
			30,
			"current",
		);

		expect(selected).toMatchObject({
			text: "Translator: QA Team",
			sourceCategory: "credit",
			sourceProvider: "credit-preset",
			protected: true,
			locked: true,
		});
		expect(editor.addTextLayer).toHaveBeenCalledWith(expect.objectContaining({
			text: "Translator: QA Team",
			sourceCategory: "credit",
		}));
		expect(projectStore.statusMsg).toBe("เพิ่มเครดิตแล้ว: ล่างกลาง - ลากเครดิตบนพื้นที่รูปเพื่อจัดตำแหน่ง");
		expect(projectStore.project).toBeNull();
	});

	it("keeps editor-only text credit scope truthful when all-page scope is requested", () => {
		const addedLayers: TextLayer[] = [];
		const editor = {
			imageWidth: 1600,
			imageHeight: 2400,
			addTextLayer: vi.fn((layer: TextLayer) => addedLayers.push(layer)),
			getAllTextLayers: vi.fn(() => addedLayers),
		};

		const selected = projectStore.addCreditLayer(
			editor,
			"credit-bottom-center",
			"Translator: QA Team",
			30,
			"all",
		);

		expect(selected).toMatchObject({
			text: "Translator: QA Team",
			sourceCategory: "credit",
		});
		expect(addedLayers).toHaveLength(1);
		expect(projectStore.statusMsg).toBe("เพิ่มเครดิตบนหน้านี้แล้ว: เปิดงานก่อนใช้เครดิตทุกหน้า/หัวท้าย");
		expect(projectStore.project).toBeNull();
	});

	it("repeats text credits on long current pages when repeat spacing is set", () => {
		const chapter = project({
			currentPage: 0,
			pages: [
				page({ imageId: "long-page.webp", textLayers: [] }),
			],
		});
		projectStore.__setProjectForTesting(chapter);
		const addedLayers: TextLayer[] = [];
		const editor = {
			imageWidth: 800,
			imageHeight: 15000,
			addTextLayer: vi.fn((layer: TextLayer) => addedLayers.push(layer)),
			getAllTextLayers: vi.fn(() => addedLayers),
		};

		const selected = projectStore.addCreditLayer(
			editor,
			"credit-bottom-center",
			"Translator: Long Page Team",
			24,
			"current",
			3000,
		);
		const pageCredits = projectStore.project?.pages[0].textLayers?.filter((layer) => layer.sourceCategory === "credit") ?? [];

		expect(selected?.id).toBe(pageCredits.at(-1)?.id);
		expect(editor.addTextLayer).toHaveBeenCalledTimes(5);
		expect(pageCredits).toHaveLength(5);
		expect(pageCredits.map((layer) => Math.round(layer.y))).toEqual([24, 3024, 6024, 9024, 12024]);
		expect(pageCredits.map((layer) => layer.name)).toEqual([
			"เครดิตข้อความ 1/5",
			"เครดิตข้อความ 2/5",
			"เครดิตข้อความ 3/5",
			"เครดิตข้อความ 4/5",
			"เครดิตข้อความ 5/5",
		]);
		expect(pageCredits.every((layer) => layer.text === "Translator: Long Page Team")).toBe(true);
		expect(projectStore.statusMsg).toBe("เพิ่มเครดิตแล้ว: ล่างกลาง / ซ้ำ 5 จุด - ลากเครดิตบนพื้นที่รูปเพื่อจัดตำแหน่ง");
		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});

	it("uses edited non-current page dimensions when repeating all-page text credits", () => {
		const chapter = project({
			projectId: "123e4567-e89b-42d3-a456-426614174610",
			currentPage: 0,
			pages: [
				page({ imageId: "page-1.webp", textLayers: [] }),
				page({
					imageId: "page-2-original.webp",
					edits: { imageId: "page-2-cleaned-long.webp" },
					textLayers: [],
				}),
			],
		});
		projectStore.__setProjectForTesting(chapter);
		projectStore.imageAssets = [
			imageAsset({ imageId: "page-2-original.webp", assetId: "page-2-original.webp", width: 900, height: 1200 }),
			imageAsset({ imageId: "page-2-cleaned-long.webp", assetId: "page-2-cleaned-long.webp", width: 900, height: 6000 }),
		];
		projectStore.imageAssetsProjectId = chapter.projectId;
		const currentLayers: TextLayer[] = [];
		const editor = {
			imageWidth: 900,
			imageHeight: 1350,
			addTextLayer: vi.fn((layer: TextLayer) => currentLayers.push(layer)),
			getAllTextLayers: vi.fn(() => currentLayers),
		};

		projectStore.addCreditLayer(
			editor,
			"credit-bottom-center",
			"Clean edit credits",
			24,
			"all",
			1500,
		);

		const editedPageCredits = projectStore.project?.pages[1].textLayers.filter((layer) => layer.sourceCategory === "credit") ?? [];
		expect(editedPageCredits).toHaveLength(4);
		expect(editedPageCredits.map((layer) => Math.round(layer.y))).toEqual([24, 1524, 3024, 4524]);
		expect(editedPageCredits.map((layer) => layer.name)).toEqual([
			"เครดิตข้อความ 1/4",
			"เครดิตข้อความ 2/4",
			"เครดิตข้อความ 3/4",
			"เครดิตข้อความ 4/4",
		]);
		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});

	it("adds image credits across every chapter page when all-page scope is selected", async () => {
		const chapter = project({
			projectId: "123e4567-e89b-42d3-a456-426614174601",
			currentPage: 1,
			pages: [
				page({ imageId: "page-1.webp", imageLayers: [] }),
				page({ imageId: "page-2.webp", imageLayers: [] }),
				page({ imageId: "page-3.webp", imageLayers: [] }),
			],
		});
		projectStore.__setProjectForTesting(chapter);
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["credit-logo"],
			assets: [{
				assetId: "credit-logo",
				imageId: "credit-logo",
				originalName: "credit-logo.webp",
				mimeType: "image/webp",
				sizeBytes: 11,
				sha256: "hash",
				storageDriver: "local",
				storageKey: "objects/credit-logo.webp",
				width: 300,
				height: 100,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: "2026-05-23T00:00:00.000Z",
				updatedAt: "2026-05-23T00:00:00.000Z",
			}],
		});
		const addedCurrentLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 800,
			imageHeight: 1200,
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => {
				addedCurrentLayers.push(layer);
				return layer;
			}),
			getAllImageLayers: vi.fn(() => addedCurrentLayers),
		};

		const added = await projectStore.addCreditImageLayer(
			new File(["credit"], "credit-logo.webp", { type: "image/webp" }),
			editor,
			{ presetId: "credit-bottom-center", maxWidth: 120, repeatEveryPx: 0, scope: "all" },
		);

		expect(added).toHaveLength(1);
		expect(editor.addImageLayerWithHistory).toHaveBeenCalledTimes(1);
		expect(projectStore.project?.pages.map((item) => item.imageLayers?.filter((layer) => layer.role === "credit").length)).toEqual([1, 1, 1]);
		expect(projectStore.project?.pages[0].imageLayers?.[0]).toMatchObject({ role: "credit", w: 120 });
		expect(projectStore.project?.pages[1].imageLayers?.[0]?.id).toBe(added[0].id);
		expect(projectStore.statusMsg).toBe("เพิ่มรูปเครดิตแล้ว ทุกหน้า: credit-logo.webp - เปิดแต่ละหน้าแล้วลากรูปเครดิตเพื่อจูนตำแหน่ง");
	});

	it("uses edited non-current page dimensions when repeating all-page image credits", async () => {
		const chapter = project({
			projectId: "123e4567-e89b-42d3-a456-426614174611",
			currentPage: 0,
			pages: [
				page({ imageId: "page-1.webp", imageLayers: [] }),
				page({
					imageId: "page-2-original.webp",
					edits: { imageId: "page-2-cleaned-long.webp" },
					imageLayers: [],
				}),
			],
		});
		projectStore.__setProjectForTesting(chapter);
		projectStore.imageAssets = [
			imageAsset({ imageId: "page-2-original.webp", assetId: "page-2-original.webp", width: 900, height: 1200 }),
			imageAsset({ imageId: "page-2-cleaned-long.webp", assetId: "page-2-cleaned-long.webp", width: 900, height: 6000 }),
		];
		projectStore.imageAssetsProjectId = chapter.projectId;
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["clean-edit-credit-logo"],
			assets: [{
				assetId: "clean-edit-credit-logo",
				imageId: "clean-edit-credit-logo",
				originalName: "clean-edit-credit-logo.webp",
				mimeType: "image/webp",
				sizeBytes: 11,
				sha256: "hash",
				storageDriver: "local",
				storageKey: "objects/clean-edit-credit-logo.webp",
				width: 320,
				height: 160,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: "2026-05-23T00:00:00.000Z",
				updatedAt: "2026-05-23T00:00:00.000Z",
			}],
		});
		const currentLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 900,
			imageHeight: 1350,
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => {
				currentLayers.push(layer);
				return layer;
			}),
			getAllImageLayers: vi.fn(() => currentLayers),
		};

		await projectStore.addCreditImageLayer(
			new File(["credit"], "clean-edit-credit-logo.webp", { type: "image/webp" }),
			editor,
			{ presetId: "credit-bottom-center", maxWidth: 160, repeatEveryPx: 1500, scope: "all" },
		);

		const editedPageCredits = projectStore.project?.pages[1].imageLayers?.filter((layer) => layer.role === "credit") ?? [];
		expect(editedPageCredits).toHaveLength(4);
		expect(editedPageCredits.map((layer) => Math.round(layer.y))).toEqual([24, 1524, 3024, 4524]);
		expect(editedPageCredits.map((layer) => layer.name)).toEqual([
			"รูปเครดิต 1/4",
			"รูปเครดิต 2/4",
			"รูปเครดิต 3/4",
			"รูปเครดิต 4/4",
		]);
		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});

	it("places right image credits at the bottom-right instead of vertical center", async () => {
		const base = project({
			projectId: "123e4567-e89b-42d3-a456-426614174603",
			currentPage: 0,
			pages: [page({ imageId: "page-1.webp", imageLayers: [] })],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["right-credit-logo"],
			assets: [{
				assetId: "right-credit-logo",
				imageId: "right-credit-logo",
				originalName: "right-credit-logo.webp",
				mimeType: "image/webp",
				sizeBytes: 11,
				sha256: "hash",
				storageDriver: "local",
				storageKey: "objects/right-credit-logo.webp",
				width: 320,
				height: 160,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: "2026-05-23T00:00:00.000Z",
				updatedAt: "2026-05-23T00:00:00.000Z",
			}],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 900,
			imageHeight: 1350,
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => {
				liveImageLayers.push(layer);
				return layer;
			}),
			getAllImageLayers: vi.fn(() => liveImageLayers),
		};

		const added = await projectStore.addCreditImageLayer(
			new File(["credit"], "right-credit-logo.webp", { type: "image/webp" }),
			editor,
			{ presetId: "credit-right-bottom", maxWidth: 160, repeatEveryPx: 0, scope: "current" },
		);

		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({
			role: "credit",
			x: 716,
			y: 1246,
			w: 160,
			h: 80,
		});
		expect(projectStore.project?.pages[0].imageLayers?.[0]).toMatchObject({ id: added[0].id, x: 716, y: 1246 });
	});

	it("adds image credits only to first and last pages for chapter-edge scope", async () => {
		const chapter = project({
			projectId: "123e4567-e89b-42d3-a456-426614174602",
			currentPage: 1,
			pages: [
				page({ imageId: "page-1.webp", imageLayers: [] }),
				page({ imageId: "page-2.webp", imageLayers: [] }),
				page({ imageId: "page-3.webp", imageLayers: [] }),
			],
		});
		projectStore.__setProjectForTesting(chapter);
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["edge-credit-logo"],
			assets: [{
				assetId: "edge-credit-logo",
				imageId: "edge-credit-logo",
				originalName: "edge-credit-logo.webp",
				mimeType: "image/webp",
				sizeBytes: 11,
				sha256: "hash",
				storageDriver: "local",
				storageKey: "objects/edge-credit-logo.webp",
				width: 300,
				height: 100,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: "2026-05-23T00:00:00.000Z",
				updatedAt: "2026-05-23T00:00:00.000Z",
			}],
		});
		const editor = {
			imageWidth: 800,
			imageHeight: 1200,
			addImageLayerWithHistory: vi.fn(),
			getAllImageLayers: vi.fn(() => []),
		};

		const added = await projectStore.addCreditImageLayer(
			new File(["credit"], "edge-credit-logo.webp", { type: "image/webp" }),
			editor,
			{ presetId: "credit-bottom-center", maxWidth: 120, repeatEveryPx: 300, scope: "chapter-edges" },
		);

		const pageCreditCounts = projectStore.project?.pages.map((item) => item.imageLayers?.filter((layer) => layer.role === "credit").length);
		const firstCredit = projectStore.project?.pages[0].imageLayers?.[0];
		const lastCredit = projectStore.project?.pages[2].imageLayers?.[0];

		expect(added).toEqual([]);
		expect(editor.addImageLayerWithHistory).not.toHaveBeenCalled();
		expect(pageCreditCounts).toEqual([1, 0, 1]);
		expect(firstCredit).toMatchObject({ role: "credit", w: 120, y: 24 });
		expect(lastCredit).toMatchObject({ role: "credit", w: 120 });
		expect(lastCredit?.y ?? 0).toBeGreaterThan(1100);
		expect(projectStore.statusMsg).toBe("เพิ่มรูปเครดิตแล้ว หัวหน้าแรกและท้ายหน้าสุดท้าย: edge-credit-logo.webp - เปิดแต่ละหน้าแล้วลากรูปเครดิตเพื่อจูนตำแหน่ง");
	});

	it("deletes current editor-only credit layers instead of leaving visible credits behind", () => {
		const creditText = textLayer({ id: "credit-text-editor-only", sourceCategory: "credit" });
		const normalText = textLayer({ id: "normal-text-editor-only" });
		const creditImage = imageLayer({ id: "credit-image-editor-only", role: "credit" });
		const normalImage = imageLayer({ id: "normal-image-editor-only", role: "overlay" });
		let currentTextLayers = [creditText, normalText];
		let currentImageLayers = [creditImage, normalImage];
		const editor = {
			removeTextLayerWithHistory: vi.fn((layerId: string) => {
				currentTextLayers = currentTextLayers.filter((layer) => layer.id !== layerId);
			}),
			removeImageLayerWithHistory: vi.fn((layerId: string) => {
				currentImageLayers = currentImageLayers.filter((layer) => layer.id !== layerId);
			}),
			getAllTextLayers: vi.fn(() => currentTextLayers),
			getAllImageLayers: vi.fn(() => currentImageLayers),
		};

		const removed = projectStore.deleteCreditLayers(editor, false);

		expect(removed).toBe(2);
		expect(currentTextLayers.map((layer) => layer.id)).toEqual(["normal-text-editor-only"]);
		expect(currentImageLayers.map((layer) => layer.id)).toEqual(["normal-image-editor-only"]);
		expect(projectStore.statusMsg).toBe("ลบเครดิตบนหน้านี้แล้ว: 2 เลเยอร์ (ข้อความ 1 / รูป 1)");
		expect(projectStore.project).toBeNull();
	});

	it("reports current-page credit deletion with text and image counts", () => {
		const creditText = textLayer({ id: "credit-text-1", sourceCategory: "credit" });
		const normalText = textLayer({ id: "normal-text-1" });
		const creditImage = imageLayer({ id: "credit-image-1", role: "credit" });
		const normalImage = imageLayer({ id: "normal-image-1", role: "overlay" });
		let currentTextLayers = [creditText, normalText];
		let currentImageLayers = [creditImage, normalImage];
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page({ textLayers: currentTextLayers, imageLayers: currentImageLayers }),
				page({
					textLayers: [textLayer({ id: "other-page-credit", sourceCategory: "credit" })],
					imageLayers: [imageLayer({ id: "other-page-credit-image", role: "credit" })],
				}),
			],
		}));
		const editor = {
			removeTextLayerWithHistory: vi.fn((layerId: string) => {
				currentTextLayers = currentTextLayers.filter((layer) => layer.id !== layerId);
			}),
			removeImageLayerWithHistory: vi.fn((layerId: string) => {
				currentImageLayers = currentImageLayers.filter((layer) => layer.id !== layerId);
			}),
			getAllTextLayers: vi.fn(() => currentTextLayers),
			getAllImageLayers: vi.fn(() => currentImageLayers),
		};

		const removed = projectStore.deleteCreditLayers(editor, false);

		expect(removed).toBe(2);
		expect(projectStore.project?.pages[0].textLayers.map((layer) => layer.id)).toEqual(["normal-text-1"]);
		expect(projectStore.project?.pages[0].imageLayers?.map((layer) => layer.id)).toEqual(["normal-image-1"]);
		expect(projectStore.project?.pages[1].textLayers).toHaveLength(1);
		expect(projectStore.project?.pages[1].imageLayers).toHaveLength(1);
		expect(projectStore.statusMsg).toBe("ลบเครดิตหน้า 1 แล้ว: 2 เลเยอร์ (ข้อความ 1 / รูป 1) / เครดิตหน้าอื่นยังอยู่ 2 เลเยอร์");
		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});

	it("deletes only current-page credit text when a text target is requested", () => {
		const creditText = textLayer({ id: "credit-text-1", sourceCategory: "credit" });
		const creditImage = imageLayer({ id: "credit-image-1", role: "credit" });
		let currentTextLayers = [creditText, textLayer({ id: "normal-text-1" })];
		let currentImageLayers = [creditImage];
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page({ textLayers: currentTextLayers, imageLayers: currentImageLayers }),
				page({ textLayers: [textLayer({ id: "other-credit-text", sourceCategory: "credit" })], imageLayers: [] }),
			],
		}));
		const editor = {
			removeTextLayerWithHistory: vi.fn((layerId: string) => {
				currentTextLayers = currentTextLayers.filter((layer) => layer.id !== layerId);
			}),
			removeImageLayerWithHistory: vi.fn((layerId: string) => {
				currentImageLayers = currentImageLayers.filter((layer) => layer.id !== layerId);
			}),
			getAllTextLayers: vi.fn(() => currentTextLayers),
			getAllImageLayers: vi.fn(() => currentImageLayers),
		};

		const removed = projectStore.deleteCreditLayers(editor, false, "text");

		expect(removed).toBe(1);
		expect(projectStore.project?.pages[0].textLayers.map((layer) => layer.id)).toEqual(["normal-text-1"]);
		expect(projectStore.project?.pages[0].imageLayers?.map((layer) => layer.id)).toEqual(["credit-image-1"]);
		expect(projectStore.project?.pages[1].textLayers.map((layer) => layer.id)).toEqual(["other-credit-text"]);
		expect(projectStore.statusMsg).toBe("ลบข้อความเครดิตในหน้า 1 แล้ว: 1 เลเยอร์ (ข้อความ 1 / รูป 0)");
	});

	it("deletes matching credit text across pages without removing other credits", () => {
		const matchingText = "Team credit";
		const currentCredit = textLayer({ id: "current-credit-match", text: matchingText, sourceCategory: "credit" });
		const currentOtherCredit = textLayer({ id: "current-credit-other", text: "Other credit", sourceCategory: "credit" });
		const currentImageCredit = imageLayer({ id: "current-image-credit", role: "credit" });
		let currentTextLayers = [currentCredit, currentOtherCredit];
		let currentImageLayers = [currentImageCredit];
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page({ textLayers: currentTextLayers, imageLayers: currentImageLayers }),
				page({
					textLayers: [
						textLayer({ id: "page-2-credit-match", text: matchingText, sourceCategory: "credit" }),
						textLayer({ id: "page-2-credit-other", text: "Other credit", sourceCategory: "credit" }),
					],
					imageLayers: [imageLayer({ id: "page-2-image-credit", role: "credit" })],
				}),
			],
		}));
		const editor = {
			removeTextLayerWithHistory: vi.fn((layerId: string) => {
				currentTextLayers = currentTextLayers.filter((layer) => layer.id !== layerId);
			}),
			removeImageLayerWithHistory: vi.fn((layerId: string) => {
				currentImageLayers = currentImageLayers.filter((layer) => layer.id !== layerId);
			}),
			getAllTextLayers: vi.fn(() => currentTextLayers),
			getAllImageLayers: vi.fn(() => currentImageLayers),
		};

		const removed = projectStore.deleteCreditLayers(editor, true, "text", { text: matchingText });

		expect(removed).toBe(2);
		expect(projectStore.project?.pages[0].textLayers.map((layer) => layer.id)).toEqual(["current-credit-other"]);
		expect(projectStore.project?.pages[0].imageLayers?.map((layer) => layer.id)).toEqual(["current-image-credit"]);
		expect(projectStore.project?.pages[1].textLayers.map((layer) => layer.id)).toEqual(["page-2-credit-other"]);
		expect(projectStore.project?.pages[1].imageLayers?.map((layer) => layer.id)).toEqual(["page-2-image-credit"]);
		expect(projectStore.statusMsg).toBe('ลบข้อความเครดิต "Team credit"จากทุกหน้าแล้ว: 2 เลเยอร์จาก 2 หน้า (ข้อความ 2 / รูป 0)');
	});

	it("keeps current-page empty delete feedback scoped when other pages still have credits", () => {
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page({ textLayers: [], imageLayers: [] }),
				page({
					textLayers: [textLayer({ id: "other-page-credit", sourceCategory: "credit" })],
					imageLayers: [imageLayer({ id: "other-page-credit-image", role: "credit" })],
				}),
			],
		}));
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
		};

		const removed = projectStore.deleteCreditLayers(editor, false);

		expect(removed).toBe(0);
		expect(projectStore.project?.pages[1].textLayers).toHaveLength(1);
		expect(projectStore.project?.pages[1].imageLayers).toHaveLength(1);
		expect(projectStore.statusMsg).toBe("ไม่มีเครดิตให้ลบในหน้า 1 / เครดิตหน้าอื่นยังอยู่ 2 เลเยอร์");
	});

	it("reports all-page credit deletion with affected page counts and an empty-state message", () => {
		const currentCredit = textLayer({ id: "current-credit", sourceCategory: "credit" });
		let currentTextLayers = [currentCredit];
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page({ textLayers: currentTextLayers, imageLayers: [] }),
				page({ textLayers: [], imageLayers: [imageLayer({ id: "page-2-credit-image", role: "credit" })] }),
				page({ textLayers: [], imageLayers: [] }),
			],
		}));
		const editor = {
			removeTextLayerWithHistory: vi.fn((layerId: string) => {
				currentTextLayers = currentTextLayers.filter((layer) => layer.id !== layerId);
			}),
			getAllTextLayers: vi.fn(() => currentTextLayers),
			getAllImageLayers: vi.fn(() => []),
		};

		const removed = projectStore.deleteCreditLayers(editor, true);

		expect(removed).toBe(2);
		expect(projectStore.project?.pages[0].textLayers).toHaveLength(0);
		expect(projectStore.project?.pages[1].imageLayers).toHaveLength(0);
		expect(projectStore.statusMsg).toBe("ลบเครดิตทุกหน้าแล้ว: 2 เลเยอร์จาก 2 หน้า (ข้อความ 1 / รูป 1) / ตอนนี้ไม่มีเครดิตเหลือในตอน");

		const removedAgain = projectStore.deleteCreditLayers(editor, true);

		expect(removedAgain).toBe(0);
		expect(projectStore.statusMsg).toBe("ไม่มีเครดิตให้ลบในทั้งตอน");
	});

	it("keeps local workflow state for backend-ineligible project ids", async () => {
		const localTask = workflowTask();
		const localActivity = {
			id: "activity-1",
			type: "task_updated" as const,
			message: "Local workflow already seeded",
			actor: "system",
			createdAt: "2026-05-14T00:00:00.000Z",
		};
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			tasks: [localTask],
			activityLog: [localActivity],
		}));
		projectStore.statusMsg = "Ready";

		await projectStore.loadWorkflow();

		expect(api.getProjectWorkflow).not.toHaveBeenCalled();
		expect(projectStore.tasks).toEqual([localTask]);
		expect(projectStore.activityLog).toEqual([localActivity]);
		expect(projectStore.statusMsg).toBe("Ready");
	});

	it("keeps local version state for backend-ineligible project ids", async () => {
		const localVersion = projectVersion();
		projectStore.__setProjectForTesting(project({ projectId: "flow208-project" }));
		projectStore.versions = [localVersion];
		projectStore.statusMsg = "Ready";

		await projectStore.loadVersions();

		expect(api.getProjectVersions).not.toHaveBeenCalled();
		expect(projectStore.versions).toEqual([localVersion]);
		expect(projectStore.versionsLoading).toBe(false);
		expect(projectStore.statusMsg).toBe("Ready");
	});

	it("keeps local version detail for backend-ineligible project ids", async () => {
		const localDetail = projectVersionDetail({ version: projectVersion({ versionId: "local-version" }) });
		projectStore.__setProjectForTesting(project({ projectId: "flow208-project" }));
		projectStore.versionDetail = localDetail;
		projectStore.statusMsg = "Ready";

		await projectStore.loadVersionDetail("local-version");

		expect(api.getProjectVersionDetail).not.toHaveBeenCalled();
		expect(projectStore.versionDetail).toEqual(localDetail);
		expect(projectStore.versionDetailLoading).toBe(false);
		expect(projectStore.statusMsg).toBe("Ready");

		await projectStore.loadVersionDetail("missing-version");

		expect(api.getProjectVersionDetail).not.toHaveBeenCalled();
		expect(projectStore.versionDetail).toBeNull();
		expect(projectStore.versionDetailLoading).toBe(false);
		expect(projectStore.statusMsg).toBe("Ready");
	});

	it("keeps local review and comment state for backend-ineligible project ids", async () => {
		const localComment = comment();
		const localMarker = aiReviewMarker();
		const localDecision = reviewDecision();
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			comments: [localComment],
			aiReviewMarkers: [localMarker],
			reviewDecisions: [localDecision],
		}));
		projectStore.selectProjectComment("missing-comment");
		projectStore.selectAiReviewMarker("missing-marker");
		projectStore.selectReviewDecision("missing-decision");
		projectStore.statusMsg = "Ready";

		await projectStore.loadComments();
		await projectStore.loadAiReviewMarkers();
		await projectStore.loadReviewDecisions();

		expect(api.getProjectComments).not.toHaveBeenCalled();
		expect(api.getAiReviewMarkers).not.toHaveBeenCalled();
		expect(api.getProjectReviewDecisions).not.toHaveBeenCalled();
		expect(projectStore.comments).toEqual([localComment]);
		expect(projectStore.aiReviewMarkers).toEqual([localMarker]);
		expect(projectStore.reviewDecisions).toEqual([localDecision]);
		expect(projectStore.selectedProjectComment).toBeNull();
		expect(projectStore.selectedAiReviewMarker).toBeNull();
		expect(projectStore.selectedReviewDecision).toBeNull();
		expect(projectStore.statusMsg).toBe("Ready");
	});

	it("keeps local workspace hub state for backend-ineligible project ids", async () => {
		const localMessage = workspaceMessage();
		const localActivity = activityEvent();
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			workspaceMessages: [localMessage],
			activityLog: [localActivity],
		}));
		projectStore.statusMsg = "Ready";

		await projectStore.loadWorkspaceHub();

		expect(api.getWorkspaceFeed).not.toHaveBeenCalled();
		expect(projectStore.workspaceMessages).toEqual([localMessage]);
		expect(projectStore.activityLog).toEqual([localActivity]);
		expect(projectStore.statusMsg).toBe("Ready");
	});

	it("updates local workflow task actions for backend-ineligible project ids", async () => {
		const localTask = workflowTask();
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			tasks: [localTask],
			activityLog: [],
		}));

		await projectStore.updateTaskStatus(localTask.id, "review");
		await projectStore.updateTaskPriority(localTask.id, "urgent");
		await projectStore.updateTaskAssignee(localTask.id, "@solo");
		await projectStore.updateTaskDueAt(localTask.id, "2026-05-20T00:00:00.000Z");

		expect(api.updateTaskStatus).not.toHaveBeenCalled();
		expect(api.updateProjectTask).not.toHaveBeenCalled();
		const updatedTask = projectStore.tasks[0];
		expect(updatedTask).toMatchObject({
			id: localTask.id,
			status: "review",
			priority: "urgent",
			assignee: "solo",
			dueAt: "2026-05-20T00:00:00.000Z",
		});
		expect(projectStore.project?.tasks?.[0]).toEqual(updatedTask);
		expect(projectStore.activityLog).toHaveLength(4);
		expect(projectStore.statusMsg).toBe(`อัปเดตวันครบกำหนด: ${localTask.title}`);
	});

	it("bulk updates local workflow task state for backend-ineligible project ids", async () => {
		const firstTask = workflowTask({ id: "task-1", status: "todo" });
		const secondTask = workflowTask({ id: "task-2", status: "doing" });
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			tasks: [firstTask, secondTask],
			activityLog: [],
		}));

		const changedCount = await projectStore.bulkUpdateTaskStatus([firstTask.id, secondTask.id], "done");

		expect(api.bulkUpdateProjectTasks).not.toHaveBeenCalled();
		expect(changedCount).toBe(2);
		expect(projectStore.tasks.map((task) => task.status)).toEqual(["done", "done"]);
		expect(projectStore.activityLog[0]).toMatchObject({
			type: "task_updated",
			message: "อัปเดตสถานะ 2 งานแล้ว",
		});
		expect(projectStore.statusMsg).toBe("อัปเดตสถานะ 2 งานแล้ว");
	});

	it("keeps local review, comment, workspace note, and AI marker actions for backend-ineligible project ids", async () => {
		const localComment = comment();
		const localMarker = aiReviewMarker();
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			comments: [localComment],
			aiReviewMarkers: [localMarker],
			reviewDecisions: [],
			workspaceMessages: [],
			activityLog: [],
		}));

		const addedComment = await projectStore.addPageComment("Local note");
		expect(projectStore.statusMsg).toBe("เพิ่มโน้ตหน้า 1 แล้ว");
		await projectStore.resolveComment(localComment.id);
		expect(projectStore.statusMsg).toBe("ปิดโน้ตแล้ว");
		const decision = await projectStore.createReviewDecision("approved", "Looks good");
		const message = await projectStore.addWorkspaceMessage("Handoff note");
		expect(projectStore.statusMsg).toBe("เพิ่มโน้ตทีมหน้า 1 แล้ว");
		const marker = await projectStore.updateAiReviewMarker(localMarker.id, { status: "accepted", assignee: "@solo" });

		expect(api.createProjectComment).not.toHaveBeenCalled();
		expect(api.updateProjectComment).not.toHaveBeenCalled();
		expect(api.createProjectReviewDecision).not.toHaveBeenCalled();
		expect(api.createWorkspaceMessage).not.toHaveBeenCalled();
		expect(api.updateAiReviewMarker).not.toHaveBeenCalled();
		expect(addedComment).toMatchObject({ body: "Local note", status: "open", author: "local" });
		expect(projectStore.comments.find((item) => item.id === localComment.id)?.status).toBe("resolved");
		expect(decision).toMatchObject({ status: "approved", body: "Looks good", actor: "local" });
		expect(message).toMatchObject({ body: "Handoff note", author: "local" });
		expect(marker).toMatchObject({ id: localMarker.id, status: "accepted", assignee: "@solo" });
		expect(projectStore.workspaceFeed.length).toBeGreaterThanOrEqual(1);
		expect(projectStore.activityLog.map((event) => event.type)).toEqual([
			"ai_marker_updated",
			"workspace_message_added",
			"review_decision_added",
			"comment_resolved",
			"comment_added",
		]);
		expect(projectStore.activityLog.map((event) => event.message)).toContain("เพิ่มโน้ตหน้า 1 แล้ว");
		expect(projectStore.activityLog.map((event) => event.message)).toContain("ปิดโน้ตแล้ว");
		expect(projectStore.activityLog.map((event) => event.message)).toContain("เพิ่มโน้ตทีมหน้า 1 แล้ว");
		expect(projectStore.statusMsg).toBe("ยืนยันผล AI ผ่านแล้ว");
	});

	it("clears local page review tasks when a pre-auth review decision approves the page", async () => {
		const reviewTask = workflowTask({
			id: "review-p1",
			type: "review",
			status: "review",
			pageIndex: 0,
			title: "Review page 1 before export",
		});
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			tasks: [reviewTask],
			reviewDecisions: [],
			activityLog: [],
		}));

		await projectStore.createReviewDecision("approved", "Looks good");

		expect(api.createProjectReviewDecision).not.toHaveBeenCalled();
		expect(projectStore.tasks).toEqual([
			expect.objectContaining({ id: "review-p1", status: "done" }),
		]);
		expect(projectStore.project?.tasks).toEqual([
			expect.objectContaining({ id: "review-p1", status: "done" }),
		]);
		expect(projectStore.reviewDecisions[0]).toMatchObject({
			pageIndex: 0,
			status: "approved",
			body: "Looks good",
		});
		expect(projectStore.statusMsg).toBe("ผ่านรีวิวหน้า 1 แล้ว");
	});

	it("creates a page review task when final QC needs a Focus decision", () => {
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			pages: [page({ imageId: "page-1.webp", textLayers: [textLayer()] })],
			tasks: [],
			reviewDecisions: [],
			activityLog: [],
		}));

		const task = projectStore.ensurePageReviewTask(0);

		expect(task).toMatchObject({
			type: "review",
			status: "review",
			pageIndex: 0,
			pageImageId: "page-1.webp",
			title: "ตรวจหน้า 1 ก่อน Export",
		});
		expect(projectStore.tasks).toHaveLength(1);
		expect(projectStore.project?.tasks).toHaveLength(1);
		expect(projectStore.selectedWorkflowTaskId).toBe(task?.id);
		expect(projectStore.statusMsg).toBe("สร้างงานตรวจหน้า 1 แล้ว");
	});

	it("can update a local AI marker result without stealing the selected review focus", async () => {
		const activeMarker = aiReviewMarker({ id: "marker-active", status: "needs_review" });
		const completedMarker = aiReviewMarker({ id: "marker-completed", status: "running" });
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			aiReviewMarkers: [activeMarker, completedMarker],
			activityLog: [],
		}));
		projectStore.selectAiReviewMarker(activeMarker.id);

		const marker = await projectStore.updateAiReviewMarker(completedMarker.id, {
			status: "needs_review",
			resultImageId: "result-completed.webp",
		}, { select: false });

		expect(marker).toMatchObject({
			id: completedMarker.id,
			status: "needs_review",
			resultImageId: "result-completed.webp",
		});
		expect(projectStore.selectedAiReviewMarkerId).toBe(activeMarker.id);
		expect(projectStore.statusMsg).toBe("ผล AI รอรีวิว");
	});

	it("keeps local AI marker follow-through actions for backend-ineligible project ids", async () => {
		const localMarker = aiReviewMarker({ linkedCommentIds: [], linkedTaskIds: [] });
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			aiReviewMarkers: [localMarker],
			comments: [],
			tasks: [],
			activityLog: [],
		}));

		const createdMarker = await projectStore.createAiReviewMarker({
			jobId: "job-2",
			pageIndex: 0,
			imageId: "image-1.webp",
			region: { x: 20, y: 30, w: 90, h: 70 },
			tier: "clean-pro",
			status: "needs_review",
		});
		const markerComment = await projectStore.createAiReviewMarkerComment(localMarker.id, "Please fix this marker");
		const markerTask = await projectStore.linkAiReviewMarkerReviewTask(localMarker.id, "@reviewer");

		expect(api.createAiReviewMarker).not.toHaveBeenCalled();
		expect(api.createAiReviewMarkerComment).not.toHaveBeenCalled();
		expect(api.linkAiReviewMarkerReviewTask).not.toHaveBeenCalled();
		expect(createdMarker).toMatchObject({
			jobId: "job-2",
			status: "needs_review",
			tier: "clean-pro",
		});
		expect(markerComment).toMatchObject({
			body: "Please fix this marker",
			status: "open",
			author: "local",
		});
		expect(markerTask).toMatchObject({
			type: "review",
			status: "todo",
			priority: "high",
			assignee: "reviewer",
		});
		const updatedOriginalMarker = projectStore.aiReviewMarkers.find((marker) => marker.id === localMarker.id);
		expect(updatedOriginalMarker?.linkedCommentIds).toContain(markerComment?.id);
		expect(updatedOriginalMarker?.linkedTaskIds).toContain(markerTask?.id);
		expect(projectStore.selectedProjectComment).toEqual(markerComment);
		expect(projectStore.selectedWorkflowTask).toEqual(markerTask);
		expect(projectStore.statusMsg).toBe(`สร้างงานแก้จากผล AI แล้ว: ${markerTask?.title}`);
	});

	it("aborts JSON import on save conflict before backend import", async () => {
		const base = project();
		const editor = {
			getAllTextLayers: vi.fn(() => [{ id: "local-text", text: "local edit" }]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(project({ name: "Remote edit" }));

		await runImportJsonWithFile(
			new File([JSON.stringify({ entries: [{ text: "hello" }] })], "translations.json", { type: "application/json" }),
			editor,
		);

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(api.importTranslations).not.toHaveBeenCalled();
		expect(api.getProjectVersions).not.toHaveBeenCalled();
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("ยกเลิกImport: ต้องโหลดงานใหม่ก่อนImport JSON");
	});

	it("aborts JSON import on generic save failure before backend import", async () => {
		const base = project();
		const remoteBase = structuredClone(base);
		const editor = {
			getAllTextLayers: vi.fn(() => [{ id: "local-text", text: "local edit" }]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(remoteBase);
		vi.mocked(api.saveProject).mockRejectedValue(new Error("disk is full"));

		await runImportJsonWithFile(
			new File([JSON.stringify({ entries: [{ text: "hello" }] })], "translations.json", { type: "application/json" }),
			editor,
		);

		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(api.importTranslations).not.toHaveBeenCalled();
		expect(api.getProjectVersions).not.toHaveBeenCalled();
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(projectStore.statusMsg).toBe("ยกเลิกImport: บันทึกงานไม่สำเร็จ (disk is full)");
	});

	it("imports JSON locally for backend-ineligible debug projects after syncing editor layers", async () => {
		const liveTextLayers = [textLayer({ id: "live-text", text: "Unsaved local line" })];
		const editor = {
			getAllTextLayers: vi.fn(() => liveTextLayers),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			pages: [page({ textLayers: [] })],
		}));

		await runImportJsonWithFile(
			new File([JSON.stringify({ entries: [{ text: "hello from local import", bbox: [20, 30, 120, 80] }] })], "translations.json", { type: "application/json" }),
			editor,
		);

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(api.importTranslations).not.toHaveBeenCalled();
		expect(api.loadProject).not.toHaveBeenCalled();
		expect(projectStore.project?.pages[0].textLayers.map((layer) => layer.text)).toEqual([
			"Unsaved local line",
			"hello from local import",
		]);
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(editor.addTextLayer).toHaveBeenCalledWith(expect.objectContaining({ text: "hello from local import" }));
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.statusMsg).toContain("Import 1 เลเยอร์ข้อความ");
	});

	it("reports local debug duplicate mapping errors with import recovery copy", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		}));

		await runImportJsonWithFile(
			new File([JSON.stringify({
				mappings: [
					{ targetPageIndex: 0, sourcePageNumber: 1 },
					{ targetPageIndex: 0, sourcePageNumber: 2 },
				],
				entries: [
					{ pageNumber: 1, text: "page one" },
					{ pageNumber: 2, text: "page two" },
				],
			})], "translations.json", { type: "application/json" }),
		);

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(api.importTranslations).not.toHaveBeenCalled();
		expect(projectStore.project?.pages[0].textLayers).toHaveLength(0);
		expect(projectStore.project?.pages[1].textLayers).toHaveLength(0);
		expect(projectStore.statusMsg).toBe("Importไม่สำเร็จ: มีหน้าในตอนซ้ำในการจับคู่");
	});

	it("saves dirty text and image layers before backend import and reload", async () => {
		const liveTextLayers: TextLayer[] = [{
			id: "live-text",
			text: "Unsaved text",
			x: 12,
			y: 34,
			w: 180,
			h: 48,
			rotation: 0,
			fontSize: 24,
			alignment: "center",
			index: 0,
		}];
		const liveImageLayers: ImageLayer[] = [{
			id: "live-image",
			imageId: "asset-1",
			imageName: "asset-1.webp",
			x: 20,
			y: 30,
			w: 200,
			h: 120,
			rotation: 0,
			opacity: 0.8,
			index: 1,
		}];
		const base = project();
		const remoteBase = structuredClone(base);
		const importedProject = project({
			pages: [page({
				textLayers: liveTextLayers,
				imageLayers: liveImageLayers,
			})],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => liveTextLayers),
			getAllImageLayers: vi.fn(() => liveImageLayers),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(remoteBase)
			.mockResolvedValueOnce(importedProject);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await runImportJsonWithFile(
			new File([JSON.stringify({ entries: [{ text: "hello" }] })], "translations.json", { type: "application/json" }),
			editor,
		);

		const savedProject = vi.mocked(api.saveProject).mock.calls[0][1] as ProjectState;
		expect(savedProject.pages[0].textLayers).toEqual(liveTextLayers);
		expect(savedProject.pages[0].imageLayers).toEqual(liveImageLayers);
		expect(api.importTranslations).toHaveBeenCalledWith("project-1", {
			entries: [{ text: "hello" }],
			lang: "th",
		});
		expect(api.loadProject).toHaveBeenCalledTimes(2);
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-1/images/image-1.webp");
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.statusMsg).toBe("Import 1 เลเยอร์ข้อความ");
	});

	it("reports backend JSON import validation errors without throwing out of the file picker", async () => {
		const base = project({
			pages: [page()],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		vi.mocked(api.importTranslations).mockRejectedValueOnce(new api.ApiError("Validation failed", {
			status: 400,
			statusText: "Bad Request",
			body: { error: "Validation failed", details: [{ message: "Expected entries or items" }] },
		}));

		await runImportJsonWithFile(
			new File([JSON.stringify({ entries: [{ text: "hello" }] })], "translations.json", { type: "application/json" }),
		);

		expect(api.importTranslations).toHaveBeenCalledWith("project-1", {
			entries: [{ text: "hello" }],
			lang: "th",
		});
		expect(api.loadProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("Importไม่สำเร็จ: โครงสร้าง JSON ไม่ตรงรูปแบบที่รองรับ");
	});

	it("does not leak backend validation error codes into import recovery copy", async () => {
		const base = project({
			pages: [page()],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		vi.mocked(api.importTranslations).mockRejectedValueOnce(new api.ApiError("validation_failed", {
			status: 400,
			statusText: "Bad Request",
			body: { error: "validation_failed", message: "Invalid translation payload" },
		}));

		await runImportJsonWithFile(
			new File([JSON.stringify({ entries: [{ text: "hello" }] })], "translations.json", { type: "application/json" }),
		);

		expect(projectStore.statusMsg).toBe("Importไม่สำเร็จ: โครงสร้าง JSON ไม่ตรงรูปแบบที่รองรับ");
		expect(projectStore.statusMsg).not.toContain("validation_failed");
	});

	it("reports duplicate JSON mapping errors as import recovery copy", async () => {
		const base = project({
			pages: [page()],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		vi.mocked(api.importTranslations).mockRejectedValueOnce(new api.ApiError("Duplicate target page mapping", {
			status: 400,
			statusText: "Bad Request",
			body: { error: "Duplicate target page mapping", targetPageIndex: 0 },
		}));

		await runImportJsonWithFile(
			new File([JSON.stringify({ entries: [{ text: "hello" }] })], "translations.json", { type: "application/json" }),
		);

		expect(projectStore.statusMsg).toBe("Importไม่สำเร็จ: มีหน้าในตอนซ้ำในการจับคู่");
	});

	it("reports refresh failure after a successful backend JSON import", async () => {
		const base = project({
			pages: [page()],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockRejectedValueOnce(new Error("network down"));
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		vi.mocked(api.importTranslations).mockResolvedValueOnce({ imported: 2, skipped: 0 });

		await runImportJsonWithFile(
			new File([JSON.stringify({ entries: [{ text: "hello" }] })], "translations.json", { type: "application/json" }),
		);

		expect(api.importTranslations).toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("Import JSON แล้ว แต่เปิดตอนที่อัปเดตไม่สำเร็จ (network down)");
		expect(projectStore.statusMsg).not.toContain("refresh Chapter");
		expect(projectStore.statusMsg).not.toContain("Refresh");
	});

	it("opens an explicit route page without flashing the saved current page first", async () => {
		const remoteProject = project({
			currentPage: 2,
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
				page({ imageId: "image-3.webp", imageName: "image-3.webp" }),
			],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(api.loadProject).mockResolvedValue(remoteProject);

		await projectStore.openProject("project-1", editor, { initialPageIndex: 0 });

		expect(projectStore.project?.currentPage).toBe(0);
		expect(editor.loadImage).toHaveBeenCalledTimes(1);
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-1/images/image-1.webp");
		expect(editor.loadImage).not.toHaveBeenCalledWith("/api/project/project-1/images/image-3.webp");
	});

	it("does not let a stale page load mutate the editor after switching projects", async () => {
		const staleLayer = textLayer({ id: "stale-layer", text: "Old project" });
		const nextLayer = textLayer({ id: "next-layer", text: "Next project" });
		projectStore.__setProjectForTesting(project({
			projectId: "project-1",
			pages: [page({
				imageId: "old-image.webp",
				textLayers: [staleLayer],
			})],
		}));
		let resolveStaleLoad: (() => void) | undefined;
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn()
				.mockImplementationOnce(() => new Promise<void>((resolve) => {
					resolveStaleLoad = resolve;
				}))
				.mockResolvedValueOnce(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(api.loadProject).mockResolvedValueOnce(project({
			projectId: "project-2",
			pages: [page({
				imageId: "next-image.webp",
				textLayers: [nextLayer],
			})],
		}));

		const staleLoad = projectStore.loadPage(0, editor);
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-1/images/old-image.webp");

		await projectStore.openProject("project-2", editor, { initialPageIndex: 0 });
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-2/images/next-image.webp");
		expect(editor.addTextLayer).toHaveBeenCalledWith(nextLayer);

		resolveStaleLoad?.();
		await staleLoad;

		expect(editor.addTextLayer).not.toHaveBeenCalledWith(staleLayer);
		expect(projectStore.project?.projectId).toBe("project-2");
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("does not let a slower overlapping project open replace the newer project", async () => {
		const staleLayer = textLayer({ id: "stale-open-layer", text: "Old project" });
		const nextLayer = textLayer({ id: "next-open-layer", text: "Next project" });
		const staleProject = project({
			projectId: "project-1",
			pages: [page({
				imageId: "old-image.webp",
				textLayers: [staleLayer],
			})],
		});
		const nextProject = project({
			projectId: "project-2",
			pages: [page({
				imageId: "next-image.webp",
				textLayers: [nextLayer],
			})],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		const pendingLoads = new Map<string, (value: ProjectState) => void>();
		vi.mocked(api.loadProject).mockImplementation((projectId: string) => new Promise<ProjectState>((resolve) => {
			pendingLoads.set(projectId, resolve);
		}));

		const staleOpen = projectStore.openProject("project-1", editor, { initialPageIndex: 0 });
		const nextOpen = projectStore.openProject("project-2", editor, { initialPageIndex: 0 });

		await vi.waitFor(() => expect(pendingLoads.has("project-2")).toBe(true));
		pendingLoads.get("project-2")?.(structuredClone(nextProject));
		await expect(nextOpen).resolves.toBe(true);
		expect(projectStore.project?.projectId).toBe("project-2");
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-2/images/next-image.webp");
		expect(editor.addTextLayer).toHaveBeenCalledWith(nextLayer);

		await expect(staleOpen).resolves.toBe(false);

		expect(projectStore.project?.projectId).toBe("project-2");
		expect(api.loadProject).not.toHaveBeenCalledWith("project-1");
		expect(editor.loadImage).not.toHaveBeenCalledWith("/api/project/project-1/images/old-image.webp");
		expect(editor.addTextLayer).not.toHaveBeenCalledWith(staleLayer);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("saves dirty editor layers before switching to another project", async () => {
		const base = project({
			projectId: "project-1",
			pages: [page({ imageId: "old-image.webp", textLayers: [] })],
		});
		const next = project({
			projectId: "project-2",
			pages: [page({ imageId: "next-image.webp" })],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => [textLayer({ id: "local-layer", text: "local edit" })]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(structuredClone(base))
			.mockResolvedValueOnce(next);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await projectStore.openProject("project-2", editor, { initialPageIndex: 0 });

		expect(api.saveProject).toHaveBeenCalledWith("project-1", expect.objectContaining({
			projectId: "project-1",
			pages: [expect.objectContaining({
				textLayers: [expect.objectContaining({ id: "local-layer", text: "local edit" })],
			})],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(projectStore.project?.projectId).toBe("project-2");
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-2/images/next-image.webp");
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("waits for pending AI-mask background brush commits before switching projects", async () => {
		const base = project({
			projectId: "project-1",
			pages: [page({ imageId: "old-image.webp", textLayers: [] })],
		});
		const next = project({
			projectId: "project-2",
			pages: [page({ imageId: "next-image.webp" })],
		});
		const calls: string[] = [];
		let resolveCommit!: () => void;
		const pendingCommit = new Promise<void>((resolve) => {
			resolveCommit = resolve;
		});
		// Mirror the real editor: once the commit resolves there is nothing pending,
		// so navigation's belt-and-braces drain in performLoadPage is a no-op (no
		// second wait). cancelImageToolDeferredReplay is the unconditional P1 step.
		let commitPending = true;
		const editor = {
			hasPendingBrushCommit: vi.fn(() => commitPending),
			cancelImageToolDeferredReplay: vi.fn(),
			waitForPendingBrushCommit: vi.fn(async () => {
				calls.push("wait-start");
				await pendingCommit;
				commitPending = false;
				projectStore.project!.pages[0].edits = { imageId: "persisted-ai-mask.png" };
				calls.push("wait-end");
			}),
			getAllTextLayers: vi.fn(() => {
				calls.push("sync-text");
				return [];
			}),
			getAllImageLayers: vi.fn(() => {
				calls.push("sync-image");
				return [];
			}),
			loadImage: vi.fn(async () => {
				calls.push("load-target");
			}),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(structuredClone(base))
			.mockResolvedValueOnce(next);
		vi.mocked(api.saveProject).mockImplementation(async (_projectId, payload) => {
			expect(payload.pages[0].edits?.imageId).toBe("persisted-ai-mask.png");
			calls.push("save");
		});

		const openPromise = projectStore.openProject("project-2", editor, { initialPageIndex: 0 });
		await Promise.resolve();

		expect(calls).toEqual(["wait-start"]);
		expect(projectStore.project?.projectId).toBe("project-1");
		expect(editor.loadImage).not.toHaveBeenCalled();

		resolveCommit();
		await openPromise;

		expect(calls).toEqual(["wait-start", "wait-end", "sync-text", "sync-image", "save", "load-target"]);
		expect(projectStore.project?.projectId).toBe("project-2");
		expect(api.saveProject).toHaveBeenCalledWith("project-1", expect.objectContaining({
			pages: [expect.objectContaining({ edits: { imageId: "persisted-ai-mask.png" } })],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
	});

	it("keeps the current project open when saving before project switch fails", async () => {
		const base = project({
			projectId: "project-1",
			pages: [page({ imageId: "old-image.webp", textLayers: [] })],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => [textLayer({ id: "local-layer", text: "local edit" })]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValueOnce(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new Error("disk is full"));

		await projectStore.openProject("project-2", editor, { initialPageIndex: 0 });

		expect(api.loadProject).toHaveBeenCalledTimes(1);
		expect(projectStore.project?.projectId).toBe("project-1");
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(projectStore.statusMsg).toBe("งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะบันทึกงานเดิมไม่สำเร็จ (disk is full) กดลองบันทึกอีกครั้งก่อน");
		expect(projectStore.statusMsgCode).toBe("prev_work_present");
	});

	it("keeps the current project open with brush-specific recovery when old brush commit blocks project switch", async () => {
		const base = project({
			projectId: "project-1",
			pages: [page({ imageId: "old-image.webp", textLayers: [] })],
		});
		const editor = {
			hasBrushCommitError: vi.fn(() => true),
			hasPendingBrushCommit: vi.fn(() => false),
			waitForPendingBrushCommit: vi.fn(async () => {
				throw new Error("quota");
			}),
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);

		await projectStore.openProject("project-2", editor, { initialPageIndex: 0 });

		expect(api.loadProject).not.toHaveBeenCalled();
		expect(projectStore.project?.projectId).toBe("project-1");
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะรอยแปรงยังไม่ถูกบันทึก (quota) แก้รอยแปรงก่อนสลับงาน");
		expect(projectStore.statusMsgCode).toBe("prev_work_present");
	});

	it("keeps the current project open when stale save conflict blocks project switch", async () => {
		const base = project({
			projectId: "project-1",
			pages: [page({ imageId: "old-image.webp", textLayers: [] })],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => [textLayer({ id: "local-layer", text: "local edit" })]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValueOnce(project({
			projectId: "project-1",
			name: "Remote changed project",
			pages: [page({ imageId: "old-image.webp", textLayers: [textLayer({ id: "remote-layer", text: "remote" })] })],
		}));

		await projectStore.openProject("project-2", editor, { initialPageIndex: 0 });

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.project?.projectId).toBe("project-1");
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะต้องโหลดงานเดิมใหม่ก่อนสลับงาน");
		expect(projectStore.statusMsgCode).toBe("prev_work_present");
	});

	it("keeps the current project open when backend atomic conflict blocks project switch", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174519";
		const base = project({
			projectId,
			pages: [page({ imageId: "old-image.webp", textLayers: [] })],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => [textLayer({ id: "local-layer", text: "local edit" })]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValueOnce(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new api.ApiError("Project changed remotely", {
			status: 409,
			statusText: "Conflict",
			body: { code: "project_save_conflict", error: "Project changed remotely" },
		}));

		await projectStore.openProject("123e4567-e89b-12d3-a456-426614174520", editor, { initialPageIndex: 0 });

		expect(api.saveProject).toHaveBeenCalledWith(projectId, expect.objectContaining({
			pages: [expect.objectContaining({
				textLayers: [expect.objectContaining({ id: "local-layer", text: "local edit" })],
			})],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(projectStore.project?.projectId).toBe(projectId);
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะต้องโหลดงานเดิมใหม่ก่อนสลับงาน");
		expect(projectStore.statusMsgCode).toBe("prev_work_present");
	});

	it("keeps current project image assets when opening another project fails", async () => {
		const currentProjectId = "123e4567-e89b-12d3-a456-426614174466";
		const nextProjectId = "123e4567-e89b-12d3-a456-426614174467";
		const base = project({
			projectId: currentProjectId,
			pages: [page({ imageId: "old-image.webp", imageName: "old-image.webp" })],
		});
		const currentAsset = {
			assetId: "old-image.webp",
			imageId: "old-image.webp",
			originalName: "old-image.webp",
			mimeType: "image/webp",
			sizeBytes: 2048,
			sha256: "old-hash",
			storageDriver: "local",
			storageKey: "objects/old-image.webp",
			width: 800,
			height: 1200,
			storageStatus: "released",
			moderationStatus: "passed",
			derivativeCount: 0,
			createdAt: "2026-05-20T03:50:00.000Z",
			updatedAt: "2026-05-20T03:50:00.000Z",
		} as const;
		projectStore.__setProjectForTesting(base);
		projectStore.imageAssets = [currentAsset];
		projectStore.imageAssetsProjectId = currentProjectId;
		vi.mocked(api.loadProject).mockRejectedValue(new Error("network down"));

		const opened = await projectStore.openProject(nextProjectId);

		expect(opened).toBe(false);
		expect(projectStore.project?.projectId).toBe(currentProjectId);
		expect(projectStore.imageAssetsProjectId).toBe(currentProjectId);
		expect(projectStore.imageAssets).toEqual([currentAsset]);
		expect(projectStore.statusMsg).toBe(
			"เปิดงานใหม่ไม่สำเร็จ: network down. งานเดิมยังอยู่: Base Project. เช็กการเชื่อมต่อแล้วลองเปิดงานใหม่อีกครั้ง",
		);
	});

	it("gives a retry action when opening the first project fails before any work is loaded", async () => {
		vi.mocked(api.loadProject).mockRejectedValue(new Error("gateway timeout"));

		const opened = await projectStore.openProject("123e4567-e89b-12d3-a456-426614174468");

		expect(opened).toBe(false);
		expect(projectStore.project).toBeNull();
		expect(projectStore.statusMsg).toBe(
			"เปิดงานไม่สำเร็จ: gateway timeout. เช็กการเชื่อมต่อแล้วลองเปิดอีกครั้ง",
		);
	});

	it("opens a project with a missing first image and keeps recovery status after ancillary loaders fail", async () => {
		const nextProjectId = "123e4567-e89b-12d3-a456-426614174517";
		const next = project({
			projectId: nextProjectId,
			pages: [page({
				imageId: "missing-first.webp",
				imageName: "missing-first.webp",
				originalName: "missing-first-source.webp",
			})],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockRejectedValue(new Error("404 missing first image")),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(api.loadProject).mockResolvedValue(next);
		vi.mocked(api.getProjectVersions).mockRejectedValue(new Error("versions offline"));
		vi.mocked(api.listProjects).mockRejectedValue(new Error("recent offline"));

		const opened = await projectStore.openProject(nextProjectId, editor, { initialPageIndex: 0 });

		expect(opened).toBe(true);
		expect(projectStore.project?.projectId).toBe(nextProjectId);
		expect(projectStore.project?.currentPage).toBe(0);
		expect(editor.loadImage).toHaveBeenCalledWith(`/api/project/${nextProjectId}/images/missing-first.webp`);
		expect(projectStore.currentPageAssetError).toMatchObject({
			pageIndex: 0,
			imageId: "missing-first.webp",
			originalName: "missing-first-source.webp",
			message: "404 missing first image",
			kind: "page",
		});
		expect(projectStore.statusMsg).toBe("รูปหน้า 1 หาย");
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("treats asset inventory load failure as unknown instead of ready", async () => {
		const state = project({
			projectId: "11111111-1111-4111-8111-111111111117",
			pages: [page({
				imageId: "inventory-page.webp",
				imageName: "inventory-page.webp",
				originalName: "inventory-page.webp",
			})],
		});
		projectStore.__setProjectForTesting(state);
		vi.mocked(api.listProjectImageAssets).mockRejectedValue(new Error("inventory offline"));

		await projectStore.loadImageAssets();

		const integrity = projectStore.getPageAssetIntegrity(0);
		expect(integrity).toMatchObject({
			status: "unknown",
			label: "Unknown",
			detail: "ตรวจคลังรูปไม่ได้: inventory offline",
		});
		expect(projectStore.statusMsg).toBe("ตรวจคลังรูปไม่สำเร็จ");
	});

	it("treats hydrated project data as clean after opening a backend project", async () => {
		const remoteProject = project({
			tasks: [],
			comments: [],
			reviewDecisions: [],
		});
		const hydratedTask = workflowTask({ id: "task-hydrated", title: "Hydrated task" });
		const hydratedComment = comment({ id: "comment-hydrated", body: "Hydrated comment" });
		const hydratedDecision = reviewDecision({ id: "decision-hydrated", status: "approved" });
		vi.mocked(api.loadProject).mockResolvedValueOnce(remoteProject);
		vi.mocked(api.getProjectWorkflow).mockResolvedValue({
			tasks: [hydratedTask],
			activityLog: [],
		});
		vi.mocked(api.getProjectComments).mockResolvedValue({ comments: [hydratedComment] });
		vi.mocked(api.getProjectReviewDecisions).mockResolvedValue({ decisions: [hydratedDecision] });
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await projectStore.openProject("project-1");
		const cleanOpenedProject = JSON.parse(JSON.stringify(projectStore.project)) as ProjectState;
		vi.mocked(api.loadProject).mockResolvedValueOnce(cleanOpenedProject);
		projectStore.project!.name = "Export history appended";

		await projectStore.saveState();

		expect(api.saveProject).toHaveBeenCalledWith(
			"project-1",
			projectStore.project,
			expect.objectContaining({ baseFingerprint: expect.any(String) }),
		);
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).toBeNull();
	});

	it("saves the first edit without a false conflict when the refetch omits hydrated sub-collections", async () => {
		// Real-world create→open: GET /project/:id returns ONLY server-authoritative
		// fields (no tasks/comments/decisions/workspace messages). The frontend then
		// hydrates those collections into `this.project` via the dedicated endpoints
		// AFTER load. Earlier the conflict guard fingerprinted the whole merged
		// `ProjectState`, so its baseline (with hydrated sub-collections) never matched
		// the bare refetch → a FALSE ProjectSaveConflictError dropped the first edit.
		const serverProject = project({
			projectId: "123e4567-e89b-42d3-a456-426614174900",
			name: "Fresh Chapter",
			pages: [page({ textLayers: [] })],
			// The persisted/refetched shape carries no hydrated sub-collections.
			tasks: undefined,
			activityLog: undefined,
			comments: undefined,
			reviewDecisions: undefined,
			workspaceMessages: undefined,
		});
		const hydratedTask = workflowTask({ id: "task-fresh", title: "Translate page 1" });
		const hydratedComment = comment({ id: "comment-fresh", body: "Lead note" });
		const hydratedDecision = reviewDecision({ id: "decision-fresh", status: "approved" });
		const hydratedMessage = workspaceMessage({ id: "message-fresh", body: "Team note" });
		// Both the openProject hydration call and the conflict-guard refetch see the
		// same bare server shape — exactly what the real backend returns.
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(serverProject));
		vi.mocked(api.getProjectWorkflow).mockResolvedValue({
			tasks: [hydratedTask],
			activityLog: [activityEvent({ id: "activity-fresh" })],
		});
		vi.mocked(api.getProjectComments).mockResolvedValue({ comments: [hydratedComment] });
		vi.mocked(api.getProjectReviewDecisions).mockResolvedValue({ decisions: [hydratedDecision] });
		vi.mocked(api.getWorkspaceFeed).mockResolvedValue({
			items: [],
			messages: [hydratedMessage],
			activityLog: [activityEvent({ id: "activity-feed" })],
		});
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await projectStore.openProject(serverProject.projectId);
		// Sanity: the in-memory project really did merge the hydrated sub-collections
		// that the refetch never returns — the exact shape mismatch behind the bug.
		expect(projectStore.project?.tasks).toEqual([hydratedTask]);
		expect(projectStore.project?.comments).toEqual([hydratedComment]);

		// First real edit on the freshly-opened chapter.
		projectStore.project!.pages[0].textLayers = [textLayer({ id: "first-edit-layer", text: "first edit" })];
		projectStore.markCurrentPageUnsaved();

		await projectStore.saveState();

		expect(api.saveProject).toHaveBeenCalledWith(
			serverProject.projectId,
			expect.objectContaining({
				pages: [expect.objectContaining({
					textLayers: [expect.objectContaining({ id: "first-edit-layer", text: "first edit" })],
				})],
			}),
			expect.objectContaining({ baseFingerprint: expect.any(String) }),
		);
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).toBeNull();
	});

	it("still blocks the first save when a real remote page edit lands, even with hydrated sub-collections", async () => {
		// Same create→open hydration shape as above, but a genuine concurrent remote
		// page edit arrives between baseline and save. The conflict guard must STILL
		// fire: excluding the dedicated-endpoint sub-collections from the fingerprint
		// must not weaken real stale-overwrite protection on page/layer content.
		const serverProject = project({
			projectId: "123e4567-e89b-42d3-a456-426614174901",
			name: "Fresh Chapter With Real Conflict",
			pages: [page({ textLayers: [] })],
			tasks: undefined,
			comments: undefined,
			reviewDecisions: undefined,
			workspaceMessages: undefined,
		});
		vi.mocked(api.getProjectWorkflow).mockResolvedValue({
			tasks: [workflowTask({ id: "task-conflict" })],
			activityLog: [],
		});
		vi.mocked(api.getProjectComments).mockResolvedValue({ comments: [comment({ id: "comment-conflict" })] });
		// openProject hydrates from the bare server shape...
		vi.mocked(api.loadProject).mockResolvedValueOnce(structuredClone(serverProject));
		await projectStore.openProject(serverProject.projectId);

		// Local first edit.
		projectStore.project!.pages[0].textLayers = [textLayer({ id: "local-first-layer", text: "local first edit" })];
		projectStore.markCurrentPageUnsaved();

		// ...but another tab persisted a different page edit before this save. The
		// conflict-guard refetch returns that genuinely-changed page content.
		const remoteAfterOtherTabEdit = project({
			...serverProject,
			pages: [page({ textLayers: [textLayer({ id: "remote-first-layer", text: "remote first edit" })] })],
		});
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(remoteAfterOtherTabEdit));

		await expect(projectStore.saveState()).rejects.toThrow("โหลดใหม่ก่อนบันทึก");

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.saveErrorKind).toBe("conflict");
	});

	it("blocks saving when the remote project changed after this tab loaded it", async () => {
		const base = project();
		projectStore.__setProjectForTesting(base);
		projectStore.project!.name = "Stale local edit";
		vi.mocked(api.loadProject).mockResolvedValue(project({ name: "Remote edit" }));

		await expect(projectStore.saveState()).rejects.toThrow("โหลดใหม่ก่อนบันทึก");

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("โหลดใหม่ก่อนบันทึก");
	});

	it("treats backend atomic save conflicts as reload-before-save conflicts", async () => {
		const base = project({ projectId: "123e4567-e89b-12d3-a456-426614174518" });
		projectStore.__setProjectForTesting(base);
		projectStore.project!.name = "Local edit after atomic race";
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new api.ApiError("Project changed remotely", {
			status: 409,
			statusText: "Conflict",
			body: { code: "project_save_conflict", error: "Project changed remotely" },
		}));

		await expect(projectStore.saveState()).rejects.toThrow("Project changed remotely");

		expect(api.saveProject).toHaveBeenCalledWith(base.projectId, projectStore.project, expect.objectContaining({
			baseFingerprint: expect.any(String),
		}));
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("โหลดใหม่ก่อนบันทึก");
	});

	it("re-reads server state and replays a 428 save when the previous baseline still matches", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174521";
		const base = project({ projectId });
		projectStore.__setProjectForTesting(base);
		projectStore.project!.name = "Local edit after missing baseline";
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(structuredClone(base))
			.mockResolvedValueOnce(structuredClone(base));
		vi.mocked(api.saveProject)
			.mockRejectedValueOnce(new api.ApiError("Missing concurrency baseline header (x-project-base-fingerprint)", {
				status: 428,
				statusText: "Precondition Required",
				code: "project_baseline_required",
				body: { code: "project_baseline_required", error: "Missing concurrency baseline header (x-project-base-fingerprint)" },
			}))
			.mockResolvedValueOnce(undefined);

		await projectStore.saveState();

		expect(api.loadProject).toHaveBeenCalledTimes(2);
		expect(api.saveProject).toHaveBeenCalledTimes(2);
		expect(api.saveProject).toHaveBeenNthCalledWith(2, projectId, expect.objectContaining({
			name: "Local edit after missing baseline",
		}), expect.objectContaining({
			baseFingerprint: expect.any(String),
		}));
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).toBeNull();
		expect(projectStore.statusMsg).toBe("โหลด state ล่าสุดแล้ว บันทึกซ้ำสำเร็จ");
	});

	it("keeps the AI-marker close failure visible after a recovered 428 save (no success overwrite)", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174529";
		const marker = aiReviewMarker({ id: "marker-pending-apply", status: "needs_review" });
		// The marker's result layer is intentionally ABSENT from the page, so the
		// post-save flush fails to close it and reports the failure status.
		const base = project({ projectId, aiReviewMarkers: [marker] });
		projectStore.__setProjectForTesting(base);
		(projectStore as unknown as {
			pendingAiResultApplyMarkers: Map<string, { projectId: string; markerId: string; pageIndex: number }>;
		}).pendingAiResultApplyMarkers.set(`${projectId}::${marker.id}`, {
			projectId,
			markerId: marker.id,
			pageIndex: marker.pageIndex,
		});
		projectStore.project!.name = "Local edit with pending AI close";
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(structuredClone(base))
			.mockResolvedValueOnce(structuredClone(base));
		vi.mocked(api.saveProject)
			.mockRejectedValueOnce(new api.ApiError("Missing concurrency baseline header (x-project-base-fingerprint)", {
				status: 428,
				statusText: "Precondition Required",
				code: "project_baseline_required",
				body: { code: "project_baseline_required", error: "Missing concurrency baseline header (x-project-base-fingerprint)" },
			}))
			.mockResolvedValueOnce(undefined);

		await projectStore.saveState();

		expect(projectStore.saveSyncStatus).toBe("saved");
		// The recovery succeeded, but the user must still see that the AI marker
		// could not be closed — the recovery message must not overwrite it.
		expect(projectStore.statusMsg).toBe("บันทึกเลเยอร์ผล AI แล้ว แต่ปิดรายการผล AI ไม่สำเร็จ: ลองบันทึกอีกครั้ง");
	});

	it("marks a 428 save clean when the re-read shows the attempted payload is already current", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174522";
		const base = project({ projectId });
		const alreadyPersisted = project({ projectId, name: "Payload already on server" });
		projectStore.__setProjectForTesting(base);
		projectStore.project!.name = alreadyPersisted.name;
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(alreadyPersisted));
		vi.mocked(api.saveProject).mockRejectedValueOnce(new api.ApiError("Missing concurrency baseline header (x-project-base-fingerprint)", {
			status: 428,
			statusText: "Precondition Required",
			code: "project_baseline_required",
			body: { code: "project_baseline_required", error: "Missing concurrency baseline header (x-project-base-fingerprint)" },
		}));

		await projectStore.saveState();

		expect(api.loadProject).toHaveBeenCalledTimes(2);
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).toBeNull();
		expect(projectStore.statusMsg).toBe("โหลด state ล่าสุดแล้ว งานนี้ตรงกับเซิร์ฟเวอร์");
	});

	it("keeps 428 in conflict recovery when the re-read shows remote drift", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174523";
		const base = project({ projectId });
		const remoteAfterOtherTabEdit = project({ projectId, name: "Remote edit from another tab" });
		projectStore.__setProjectForTesting(base);
		projectStore.project!.name = "Local edit blocked by a missing baseline";
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(structuredClone(base))
			.mockResolvedValueOnce(structuredClone(remoteAfterOtherTabEdit));
		vi.mocked(api.saveProject).mockRejectedValueOnce(new api.ApiError("Missing concurrency baseline header (x-project-base-fingerprint)", {
			status: 428,
			statusText: "Precondition Required",
			code: "project_baseline_required",
			body: { code: "project_baseline_required", error: "Missing concurrency baseline header (x-project-base-fingerprint)" },
		}));

		await expect(projectStore.saveState()).rejects.toMatchObject({ status: 428 });

		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("โหลดใหม่ก่อนบันทึก");
		expect(projectStore.saveErrorMessage).not.toContain("x-project-base-fingerprint");
	});

	it("keeps 428 in conflict recovery when the recovery re-read fails", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174524";
		const base = project({ projectId });
		projectStore.__setProjectForTesting(base);
		projectStore.project!.name = "Local edit while recovery read is offline";
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(structuredClone(base))
			.mockRejectedValueOnce(new Error("offline"));
		vi.mocked(api.saveProject).mockRejectedValueOnce(new api.ApiError("Missing concurrency baseline header (x-project-base-fingerprint)", {
			status: 428,
			statusText: "Precondition Required",
			code: "project_baseline_required",
			body: { code: "project_baseline_required", error: "Missing concurrency baseline header (x-project-base-fingerprint)" },
		}));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			await expect(projectStore.saveState()).rejects.toMatchObject({ status: 428 });
		} finally {
			warn.mockRestore();
		}

		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("โหลดใหม่ก่อนบันทึก");
		expect(projectStore.saveErrorMessage).not.toContain("offline");
	});

	it("does not treat same-tab AI review updates as remote conflicts while page edits are dirty", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174461";
		const marker = aiReviewMarker({ id: "marker-same-tab", status: "needs_review" });
		const base = project({
			projectId,
			aiReviewMarkers: [marker],
			pages: [page({ textLayers: [] })],
		});
		const updatedMarker = { ...marker, status: "accepted" as const, updatedAt: "2026-05-20T03:30:00.000Z" };
		const remoteAfterMarkerUpdate = project({
			...base,
			aiReviewMarkers: [updatedMarker],
			activityLog: [],
		});
		projectStore.__setProjectForTesting(structuredClone(base));
		projectStore.project!.pages[0].textLayers = [textLayer({ id: "local-dirty-layer", text: "local dirty text" })];
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.updateAiReviewMarker).mockResolvedValue({
			marker: updatedMarker,
			markers: [updatedMarker],
			activityLog: [],
		});
		vi.mocked(api.loadProject).mockResolvedValue(remoteAfterMarkerUpdate);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await projectStore.updateAiReviewMarker("marker-same-tab", { status: "accepted" });
		await projectStore.saveState();

		expect(api.saveProject).toHaveBeenCalledWith(projectId, expect.objectContaining({
			aiReviewMarkers: [expect.objectContaining({ id: "marker-same-tab", status: "accepted" })],
			pages: [expect.objectContaining({
				textLayers: [expect.objectContaining({ id: "local-dirty-layer", text: "local dirty text" })],
			})],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).toBeNull();
	});

	it("keeps real remote page edits blocked after a same-tab AI review update", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174462";
		const marker = aiReviewMarker({ id: "marker-real-conflict", status: "needs_review" });
		const base = project({
			projectId,
			aiReviewMarkers: [marker],
			pages: [page({ textLayers: [] })],
		});
		const updatedMarker = { ...marker, status: "accepted" as const, updatedAt: "2026-05-20T03:31:00.000Z" };
		const remoteAfterOtherTabPageEdit = project({
			...base,
			aiReviewMarkers: [updatedMarker],
			pages: [page({ textLayers: [textLayer({ id: "remote-layer", text: "remote page edit" })] })],
			activityLog: [],
		});
		projectStore.__setProjectForTesting(structuredClone(base));
		projectStore.project!.pages[0].textLayers = [textLayer({ id: "local-layer", text: "local page edit" })];
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.updateAiReviewMarker).mockResolvedValue({
			marker: updatedMarker,
			markers: [updatedMarker],
			activityLog: [],
		});
		vi.mocked(api.loadProject).mockResolvedValue(remoteAfterOtherTabPageEdit);

		await projectStore.updateAiReviewMarker("marker-real-conflict", { status: "accepted" });
		await expect(projectStore.saveState()).rejects.toThrow("โหลดใหม่ก่อนบันทึก");

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.saveErrorKind).toBe("conflict");
	});

	it("createAiReviewMarker applies the result into the OWNING project only — a switch mid-await writes the server marker but no local state into the now-open project (FINDING 2)", async () => {
		// FINDING 2 (round 4): createAiReviewMarker applied result.markers + activity to
		// this.project BEFORE returning, so a post-create guard in the CALLER was too
		// late — B's state got A's marker response during the await. The fix: the wrapper
		// captures the owner (forProjectId) + project ref BEFORE the API await, targets
		// the server write at the owner, and applies local state ONLY when the owner is
		// still the open project afterward (mirrors updateAiReviewMarker's guard).
		const ownerProjectId = "123e4567-e89b-12d3-a456-426614174480";
		const otherProjectId = "123e4567-e89b-12d3-a456-426614174481";
		const createdMarker = aiReviewMarker({ id: "marker-A", status: "processing" });
		const projectA = project({ projectId: ownerProjectId, aiReviewMarkers: [] });
		const projectB = project({ projectId: otherProjectId, aiReviewMarkers: [] });
		projectStore.__setProjectForTesting(structuredClone(projectA));

		// Hold the API open so we can switch to B BEFORE it resolves.
		let resolveCreate!: (value: any) => void;
		vi.mocked(api.createAiReviewMarker).mockReturnValue(
			new Promise((resolve) => {
				resolveCreate = resolve;
			}) as any,
		);

		// Kick off the create under A WITH an explicit forProjectId (as the AI jobs store
		// now threads ownerProjectId), then switch to B mid-await.
		const pending = projectStore.createAiReviewMarker(
			{
				jobId: "job-A",
				pageIndex: 0,
				imageId: "image-1.webp",
				region: { x: 0, y: 0, w: 100, h: 100 },
				tier: "sfx-pro",
				status: "processing",
			},
			{ forProjectId: ownerProjectId },
		);
		await Promise.resolve();

		projectStore.__setProjectForTesting(structuredClone(projectB));
		projectStore.selectAiReviewMarker(null);
		projectStore.statusMsg = "project-B status";

		// Backend accepts A's marker while B is open.
		resolveCreate({
			marker: createdMarker,
			markers: [createdMarker],
			activityLog: [],
		});
		const returned = await pending;

		// The server write TARGETED A's projectId — not the now-open B.
		expect(api.createAiReviewMarker).toHaveBeenCalledTimes(1);
		expect(api.createAiReviewMarker).toHaveBeenCalledWith(
			ownerProjectId,
			expect.objectContaining({ jobId: "job-A" }),
		);
		// The marker is still RETURNED to the caller (so it can be persisted/threaded)...
		expect(returned).toMatchObject({ id: "marker-A" });
		// ...but B's local state was NOT mutated by A's marker response.
		expect(projectStore.project!.projectId).toBe(otherProjectId);
		expect(projectStore.aiReviewMarkers).toEqual([]);
		expect(projectStore.project!.aiReviewMarkers).toEqual([]);
		expect(projectStore.selectedAiReviewMarkerId).toBeNull();
		expect(projectStore.statusMsg).toBe("project-B status");
	});

	it("createAiReviewMarker applies the freshly-created marker into a REOPENED same-id owner — the id gate, not the captured reference, decides the local apply (round 7 FINDING 1)", async () => {
		// Round 7 FINDING 1: the create captured `ownerProjectRef = this.project` (A).
		// If the user switches A→B→A while the create is in flight, the open project is a
		// FRESH A object (≠ the captured ref) even though its id still matches the owner.
		// The old reference guard (this.project !== ownerProjectRef) then SKIPPED the local
		// apply, so the just-accepted marker stayed invisible until a reload. The fix gates
		// the apply on the ID only — a freshly CREATED marker is new server state that
		// postdates any reload, so merging it into a same-id owner is always safe.
		const ownerProjectId = "123e4567-e89b-12d3-a456-426614174490";
		const otherProjectId = "123e4567-e89b-12d3-a456-426614174491";
		const createdMarker = aiReviewMarker({ id: "marker-reopen", status: "processing" });
		const projectA = project({ projectId: ownerProjectId, aiReviewMarkers: [] });
		const projectB = project({ projectId: otherProjectId, aiReviewMarkers: [] });
		projectStore.__setProjectForTesting(structuredClone(projectA));

		// Hold the API open so we can switch A→B→A BEFORE it resolves.
		let resolveCreate!: (value: any) => void;
		vi.mocked(api.createAiReviewMarker).mockReturnValue(
			new Promise((resolve) => {
				resolveCreate = resolve;
			}) as any,
		);

		const pending = projectStore.createAiReviewMarker(
			{
				jobId: "job-reopen",
				pageIndex: 0,
				imageId: "image-1.webp",
				region: { x: 0, y: 0, w: 100, h: 100 },
				tier: "sfx-pro",
				status: "processing",
			},
			{ forProjectId: ownerProjectId },
		);
		await Promise.resolve();

		// Switch away to B, then REOPEN A as a brand-new object (the case that broke the
		// reference guard: same id, different reference).
		projectStore.__setProjectForTesting(structuredClone(projectB));
		projectStore.__setProjectForTesting(structuredClone(projectA));
		projectStore.selectAiReviewMarker(null);

		// Backend accepts A's marker while the REOPENED A is the open project.
		resolveCreate({
			marker: createdMarker,
			markers: [createdMarker],
			activityLog: [],
		});
		const returned = await pending;

		// The server write targeted A's id, and because the CURRENT project is A by id, the
		// marker is applied into the reopened A's local state (no false skip).
		expect(api.createAiReviewMarker).toHaveBeenCalledWith(
			ownerProjectId,
			expect.objectContaining({ jobId: "job-reopen" }),
		);
		expect(returned).toMatchObject({ id: "marker-reopen" });
		expect(projectStore.project!.projectId).toBe(ownerProjectId);
		expect(projectStore.aiReviewMarkers).toEqual([createdMarker]);
		expect(projectStore.project!.aiReviewMarkers).toEqual([createdMarker]);
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-reopen");
	});

	it("createAiReviewMarker applies the result locally when the owner is STILL open (no false skip)", async () => {
		// Control for the guard test: with NO switch, the marker IS applied into the
		// owning project's local state and selected.
		const ownerProjectId = "123e4567-e89b-12d3-a456-426614174482";
		const createdMarker = aiReviewMarker({ id: "marker-stay", status: "processing" });
		projectStore.__setProjectForTesting(project({ projectId: ownerProjectId, aiReviewMarkers: [] }));
		vi.mocked(api.createAiReviewMarker).mockResolvedValue({
			marker: createdMarker,
			markers: [createdMarker],
			activityLog: [],
		});

		const returned = await projectStore.createAiReviewMarker(
			{
				jobId: "job-stay",
				pageIndex: 0,
				imageId: "image-1.webp",
				region: { x: 0, y: 0, w: 100, h: 100 },
				tier: "sfx-pro",
				status: "processing",
			},
			{ forProjectId: ownerProjectId },
		);

		expect(api.createAiReviewMarker).toHaveBeenCalledWith(ownerProjectId, expect.objectContaining({ jobId: "job-stay" }));
		expect(returned).toMatchObject({ id: "marker-stay" });
		expect(projectStore.aiReviewMarkers).toEqual([createdMarker]);
		expect(projectStore.project!.aiReviewMarkers).toEqual([createdMarker]);
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-stay");
	});

	it("createAiReviewMarker writes the server marker but skips the local apply when isContextCurrent is false, even with a matching open project id (round 8 FINDING 1)", async () => {
		// Round 8 FINDING 1: on a SIGN-OUT mid-create the AI store's session state is wiped
		// but the project store may STILL hold the owner's id, so the id-only apply gate
		// would let the dead session's marker/activity/selection apply locally. The AI store
		// threads its captured-generation check in via isContextCurrent; createAiReviewMarker
		// must consult it AFTER the API resolves and skip the local apply when it returns
		// false — while still RETURNING the marker (the server write happened, job charged).
		const ownerProjectId = "123e4567-e89b-12d3-a456-426614174492";
		const createdMarker = aiReviewMarker({ id: "marker-deadsession", status: "processing" });
		// The open project's id STILL matches the owner (sign-out wiped AI state, not the
		// project store) — so only isContextCurrent can stop the local apply.
		projectStore.__setProjectForTesting(project({ projectId: ownerProjectId, aiReviewMarkers: [] }));
		projectStore.selectAiReviewMarker(null);
		projectStore.statusMsg = "dead-session status";
		vi.mocked(api.createAiReviewMarker).mockResolvedValue({
			marker: createdMarker,
			markers: [createdMarker],
			activityLog: [],
		});

		const returned = await projectStore.createAiReviewMarker(
			{
				jobId: "job-dead",
				pageIndex: 0,
				imageId: "image-1.webp",
				region: { x: 0, y: 0, w: 100, h: 100 },
				tier: "sfx-pro",
				status: "processing",
			},
			{ forProjectId: ownerProjectId, isContextCurrent: () => false },
		);

		// The server write WAS made for the owner (accepted+charged, reloadable on reopen)...
		expect(api.createAiReviewMarker).toHaveBeenCalledWith(ownerProjectId, expect.objectContaining({ jobId: "job-dead" }));
		// ...and the marker is still returned to the caller...
		expect(returned).toMatchObject({ id: "marker-deadsession" });
		// ...but the dead session's marker did NOT bleed into local state (id matched, but
		// isContextCurrent gated it out).
		expect(projectStore.aiReviewMarkers).toEqual([]);
		expect(projectStore.project!.aiReviewMarkers).toEqual([]);
		expect(projectStore.selectedAiReviewMarkerId).toBeNull();
		expect(projectStore.statusMsg).toBe("dead-session status");
	});

	it("createAiReviewMarker ALWAYS clears the loading flag when the request settles, even if this.project was REPLACED mid-create (round 10 FINDING 2)", async () => {
		// Round 10 FINDING 2: the finally gated `aiReviewMarkersLoading = false` on
		// `this.project === ownerProjectRef`. A same-id reload / draft-restore / switch mid-
		// create replaces this.project with a DIFFERENT object, so the gate failed and the
		// store-wide loading flag stayed stuck TRUE → the AI panel wedged in loading/readonly.
		// The flag is REQUEST-scoped, so it must clear unconditionally when the request settles;
		// only the STATE apply stays gated on the id/context check.
		const ownerProjectId = "123e4567-e89b-12d3-a456-426614174493";
		const createdMarker = aiReviewMarker({ id: "marker-replace", status: "processing" });
		const projectA = project({ projectId: ownerProjectId, aiReviewMarkers: [] });
		projectStore.__setProjectForTesting(structuredClone(projectA));

		let resolveCreate!: (value: any) => void;
		vi.mocked(api.createAiReviewMarker).mockReturnValue(
			new Promise((resolve) => {
				resolveCreate = resolve;
			}) as any,
		);

		const pending = projectStore.createAiReviewMarker(
			{
				jobId: "job-replace",
				pageIndex: 0,
				imageId: "image-1.webp",
				region: { x: 0, y: 0, w: 100, h: 100 },
				tier: "sfx-pro",
				status: "processing",
			},
			{ forProjectId: ownerProjectId },
		);
		await Promise.resolve();
		// The request is in flight → loading flag is true.
		expect(projectStore.aiReviewMarkersLoading).toBe(true);

		// Replace this.project with a FRESH same-id object (a same-id reload / draft-restore):
		// this.project !== the captured ownerProjectRef, which used to skip the flag reset.
		projectStore.__setProjectForTesting(structuredClone(projectA));

		resolveCreate({
			marker: createdMarker,
			markers: [createdMarker],
			activityLog: [],
		});
		await pending;

		// The loading flag is reset (panel not wedged) regardless of the ref swap. The marker
		// apply still runs because the id (and context) still match the reopened owner.
		expect(projectStore.aiReviewMarkersLoading).toBe(false);
		expect(projectStore.aiReviewMarkers).toEqual([createdMarker]);
	});

	it("createAiReviewMarker keeps the loading flag TRUE until the LAST concurrent create settles (round 10 FINDING 2 — counter)", async () => {
		// Concurrent creates are real: several AI jobs can finish around the same tick, each
		// routing through createMarkerForRunningJob → createAiReviewMarker. The flag is cleared
		// only when the LAST in-flight create settles so an earlier finish can't unwedge the
		// panel while another create is still running.
		const ownerProjectId = "123e4567-e89b-12d3-a456-426614174494";
		const marker1 = aiReviewMarker({ id: "marker-c1", status: "processing" });
		const marker2 = aiReviewMarker({ id: "marker-c2", status: "processing" });
		projectStore.__setProjectForTesting(project({ projectId: ownerProjectId, aiReviewMarkers: [] }));

		let resolve1!: (value: any) => void;
		let resolve2!: (value: any) => void;
		vi.mocked(api.createAiReviewMarker)
			.mockReturnValueOnce(new Promise((r) => { resolve1 = r; }) as any)
			.mockReturnValueOnce(new Promise((r) => { resolve2 = r; }) as any);

		const baseInput = {
			pageIndex: 0,
			imageId: "image-1.webp",
			region: { x: 0, y: 0, w: 100, h: 100 },
			tier: "sfx-pro" as const,
			status: "processing" as const,
		};
		const p1 = projectStore.createAiReviewMarker({ ...baseInput, jobId: "job-c1" }, { forProjectId: ownerProjectId });
		const p2 = projectStore.createAiReviewMarker({ ...baseInput, jobId: "job-c2" }, { forProjectId: ownerProjectId });
		await Promise.resolve();
		expect(projectStore.aiReviewMarkersLoading).toBe(true);

		// First create settles → another is still in flight, so the flag must STAY true.
		resolve1({ marker: marker1, markers: [marker1], activityLog: [] });
		await p1;
		expect(projectStore.aiReviewMarkersLoading).toBe(true);

		// Last create settles → flag finally clears.
		resolve2({ marker: marker2, markers: [marker2], activityLog: [] });
		await p2;
		expect(projectStore.aiReviewMarkersLoading).toBe(false);
	});

	it("does not treat same-tab work updates as remote conflicts while page edits are dirty", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174463";
		const task = workflowTask({ id: "task-same-tab", status: "todo", title: "Clean page 1" });
		const updatedTask = { ...task, status: "done" as const, updatedAt: "2026-05-20T03:32:00.000Z" };
		const base = project({
			projectId,
			tasks: [task],
			pages: [page({ textLayers: [] })],
		});
		const remoteAfterTaskUpdate = project({
			...base,
			tasks: [updatedTask],
			activityLog: [],
			workspaceMessages: [],
		});
		projectStore.__setProjectForTesting(structuredClone(base));
		projectStore.project!.pages[0].textLayers = [textLayer({ id: "local-work-layer", text: "local work edit" })];
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.updateTaskStatus).mockResolvedValue({
			task: updatedTask,
			activityLog: [activityEvent({ id: "task-updated", message: "Task updated" })],
			version: projectVersion({ versionId: "task-version" }),
		});
		vi.mocked(api.loadProject).mockResolvedValue(remoteAfterTaskUpdate);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await projectStore.updateTaskStatus("task-same-tab", "done");
		await projectStore.saveState();

		expect(api.saveProject).toHaveBeenCalledWith(projectId, expect.objectContaining({
			tasks: [expect.objectContaining({ id: "task-same-tab", status: "done" })],
			pages: [expect.objectContaining({
				textLayers: [expect.objectContaining({ id: "local-work-layer", text: "local work edit" })],
			})],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).toBeNull();
	});

	it("does not retry a stale single-page export by exporting the current page", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageId: "image-1.webp" })],
			exportRuns: [{
				id: "export-stale",
				kind: "single-page",
				status: "error",
				filename: "page-5.png",
				pageIndexes: [4],
				pageCount: 1,
				message: "Export failed",
				createdAt: "2026-05-15T10:00:00.000Z",
				completedAt: "2026-05-15T10:00:00.000Z",
			}],
		}));
		const exportPage = vi.spyOn(projectStore, "exportPage").mockResolvedValue(undefined);
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);

		await projectStore.retryExportRun("export-stale", {});

		expect(goToPage).not.toHaveBeenCalled();
		expect(exportPage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("หน้าในประวัติ Export ไม่อยู่ในงานนี้แล้ว");
		exportPage.mockRestore();
		goToPage.mockRestore();
	});

	it("selects a valid single-page export retry target before exporting without an editor", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ imageId: "image-1.webp" }),
				page({ imageId: "image-2.webp" }),
			],
			exportRuns: [{
				id: "export-page-2",
				kind: "single-page",
				status: "error",
				filename: "page-2.png",
				pageIndexes: [1],
				pageCount: 1,
				message: "Export failed",
				createdAt: "2026-05-15T10:00:00.000Z",
				completedAt: "2026-05-15T10:00:00.000Z",
			}],
		}));
		const exportPage = vi.spyOn(projectStore, "exportPage").mockResolvedValue(undefined);

		await projectStore.retryExportRun("export-page-2");

		expect(projectStore.project?.currentPage).toBe(1);
		expect(projectStore.statusMsg).toBe("หน้า 2 / 2");
		expect(exportPage).toHaveBeenCalledTimes(1);
		exportPage.mockRestore();
	});

	it("blocks batch export retries when the live page gate is no longer export ready", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp", textLayers: [textLayer({ id: "layer-1" })] }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp", textLayers: [textLayer({ id: "layer-2" })] }),
			],
			comments: [comment({ pageIndex: 1, layerId: "layer-2" })],
			exportRuns: [{
				id: "export-batch",
				kind: "batch-zip",
				status: "error",
				filename: "chapter.zip",
				pageIndexes: [0, 1],
				pageCount: 2,
				message: "Export failed",
				createdAt: "2026-05-15T10:00:00.000Z",
				completedAt: "2026-05-15T10:00:00.000Z",
			}],
		}));

		await projectStore.retryExportRun("export-batch");

		expect(projectStore.batchExportStatus).toBe("error");
		expect(projectStore.batchExportMessage).toBe("ส่งออกยังไม่พร้อม: 1 หน้าต้องเคลียร์ 2 รายการ");
		expect(projectStore.statusMsg).toBe("ส่งออกยังไม่พร้อม: 1 หน้าต้องเคลียร์ 2 รายการ");
		expect(projectStore.exportRuns).toHaveLength(1);
	});

	it("keeps the editor attached to batch export retry while a brush commit is still pending", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
			exportRuns: [{
				id: "export-brush-pending",
				kind: "batch-zip",
				status: "error",
				filename: "chapter.zip",
				pageIndexes: [0, 1],
				pageCount: 2,
				message: "Export failed",
				createdAt: "2026-05-15T10:00:00.000Z",
				completedAt: "2026-05-15T10:00:00.000Z",
			}],
		}));
		projectStore.saveSyncStatus = "saved";
		const editor = {
			hasPendingBrushCommit: vi.fn(() => true),
		};
		const exportPageBatch = vi.spyOn(projectStore, "exportPageBatch").mockResolvedValue(undefined);

		await projectStore.retryExportRun("export-brush-pending", editor);

		expect(exportPageBatch).toHaveBeenCalledWith([0, 1], editor);
		exportPageBatch.mockRestore();
	});

	it("keeps the export success status when export history persistence fails", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({
				imageId: "image-1.webp",
				imageName: "page-1.webp",
				textLayers: [textLayer()],
			})],
		}));
		vi.mocked(api.loadProject).mockRejectedValue(new Error("Invalid project ID"));

		await projectStore.exportPage();

		expect(projectStore.statusMsg).toBe("Export หน้าเดียวสำเร็จ: page-1");
		expect(projectStore.exportRuns[0]).toMatchObject({
			status: "done",
			filename: "page-1.png",
			pageIndexes: [0],
		});
	});

	it("blocks batch export when Public/Export requires a missing chapter credit", () => {
		projectStore.__setProjectForTesting(project({
			creditPolicy: "required",
			pages: [
				page({ textLayers: [textLayer({ id: "layer-1" })] }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp", textLayers: [textLayer({ id: "layer-2" })] }),
			],
		}));

		const gate = projectStore.getBatchExportGate([0, 1]);

		expect(gate.canExport).toBe(false);
		expect(gate.readyCount).toBe(0);
		expect(gate.holdCount).toBe(2);
		expect(gate.firstHoldPageIndex).toBe(0);
		expect(gate.firstHoldReason).toBe("required credit missing");
		expect(gate.message).toBe("ส่งออกยังไม่พร้อม: เผยแพร่/ส่งออก ต้องมีเครดิตอย่างน้อย 1 รายการในตอนนี้");
	});

	it("allows required Public/Export after the chapter has a credit layer", () => {
		projectStore.__setProjectForTesting(project({
			creditPolicy: "required",
			pages: [
				page({
					textLayers: [
						textLayer({ id: "layer-1" }),
						textLayer({ id: "credit-1", sourceCategory: "credit" }),
					],
				}),
				page({ imageId: "image-2.webp", imageName: "image-2.webp", textLayers: [textLayer({ id: "layer-2" })] }),
			],
		}));

		const gate = projectStore.getBatchExportGate([0, 1]);

		expect(gate.canExport).toBe(true);
		expect(gate.readyPageNumbers).toEqual([1, 2]);
		expect(gate.message).toBe("ส่งออกพร้อมแล้ว: 2 หน้า");
	});

	it("blocks batch export for project-level Team workflow before review and final QC", () => {
		projectStore.__setProjectForTesting(project({
			productionMode: "team",
			pages: [
				page({ textLayers: [textLayer({ id: "layer-team-1" })] }),
			],
		}));

		const gate = projectStore.getBatchExportGate([0]);

		expect(gate.canExport).toBe(false);
		expect(gate.firstHoldPageIndex).toBe(0);
		expect(gate.firstHoldReason).toBe("page review approval not recorded");
		expect(gate.message).toBe("ส่งออกยังไม่พร้อม: 1 หน้าต้องเคลียร์ 1 รายการ");
		// The all-blockers checklist surfaces the review hold for jump-to-page.
		expect(gate.checklist.some((group) => group.type === "review_not_approved")).toBe(true);
	});

	it("allows project-level Team workflow export after review and final QC close", () => {
		projectStore.__setProjectForTesting(project({
			productionMode: "team",
			pages: [
				page({
					textLayers: [textLayer({ id: "layer-team-1" })],
					qcHandoff: {
						status: "ready",
						updatedAt: "2026-05-12T00:00:00.000Z",
						updatedBy: "qc",
					},
				}),
			],
			reviewDecisions: [{
				id: "decision-team-1",
				pageIndex: 0,
				status: "approved",
				body: "ผ่านรีวิว",
				actor: "lead",
				createdAt: "2026-05-12T00:00:00.000Z",
				updatedAt: "2026-05-12T00:00:00.000Z",
			}],
		}));

		const gate = projectStore.getBatchExportGate([0]);

		expect(gate.canExport).toBe(true);
		expect(gate.readyPageNumbers).toEqual([1]);
		expect(gate.message).toBe("ส่งออกพร้อมแล้ว: 1 หน้า");
	});

	it("blocks single-page export while save conflict recovery is unresolved", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageId: "image-1.webp", imageName: "image-1.webp" })],
		}));
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "conflict";
		projectStore.saveErrorMessage = "โปรเจกต์เปลี่ยนจากที่อื่น โหลดใหม่ก่อนบันทึก";
		const editor = {
			exportMergedImageDataUrl: vi.fn(() => "data:image/png;base64,AAAA"),
		};

		await projectStore.exportPage(editor);

		expect(editor.exportMergedImageDataUrl).not.toHaveBeenCalled();
		expect(api.recordExportUsage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toContain("เก็บสำเนากู้คืนก่อน Export");
	});

	it("merges export history into the latest remote project after a save conflict", async () => {
		const projectId = "00000000-0000-4000-8000-000000000001";
		const remoteProject = project({ projectId, name: "Remote edit", exportRuns: [] });
		projectStore.__setProjectForTesting(project({
			projectId,
			name: "Loaded title",
			pages: [page({ imageId: "image-1.webp", imageName: "image-1.webp" })],
			exportRuns: [],
		}));
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(remoteProject)
			.mockResolvedValueOnce(remoteProject);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await projectStore.exportPage();

		// P0-2 (round-3): the export-conflict re-save now carries a CAS base fingerprint
		// (captured from the just-loaded remote state) so a stale full payload can't
		// clobber newer page edits — assert it is passed through.
		expect(api.saveProject).toHaveBeenCalledWith(projectId, expect.objectContaining({
			name: "Remote edit",
			exportRuns: [expect.objectContaining({
				kind: "single-page",
				status: "done",
				filename: "image-1.png",
				pageIndexes: [0],
			})],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(projectStore.statusMsg).toBe("Export หน้าเดียวสำเร็จ: image-1");
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).toBeNull();
	});

	it("merges export history after a backend atomic save conflict", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174521";
		const base = project({
			projectId,
			name: "Loaded title",
			pages: [page({ imageId: "image-1.webp", imageName: "image-1.webp" })],
			exportRuns: [],
		});
		const remoteProject = project({ projectId, name: "Remote edit", exportRuns: [] });
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(structuredClone(base))
			.mockResolvedValueOnce(remoteProject);
		vi.mocked(api.saveProject)
			.mockRejectedValueOnce(new api.ApiError("Project changed remotely", {
				status: 409,
				statusText: "Conflict",
				body: { code: "project_save_conflict", error: "Project changed remotely" },
			}))
			.mockResolvedValueOnce(undefined);

		await projectStore.exportPage();

		expect(api.saveProject).toHaveBeenCalledTimes(2);
		// P0-2 (round-3): the conflict-recovery re-save carries a CAS base fingerprint.
		expect(api.saveProject).toHaveBeenLastCalledWith(projectId, expect.objectContaining({
			name: "Remote edit",
			exportRuns: [expect.objectContaining({
				kind: "single-page",
				status: "done",
				filename: "image-1.png",
				pageIndexes: [0],
			})],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(projectStore.statusMsg).toBe("Export หน้าเดียวสำเร็จ: image-1");
		expect(projectStore.saveSyncStatus).toBe("saved");
		expect(projectStore.saveErrorKind).toBeNull();
	});

	it("does NOT adopt the remote project when an export-run save hits a 428 with unsaved local edits", async () => {
		// codex P1 (round 3): broadening the save-conflict classifier to include the 428
		// project_baseline_required leaked into the REMOTE-REPLACING export merge —
		// recordExportRun's catch would call persistExportRunAfterConflict(), which loads
		// the remote project and ASSIGNS this.project, discarding the unsaved local edits
		// the 428 path is meant to preserve. The classifier is now 409-only, so a 428 in
		// the export flow records the run LOCALLY and leaves a conflict status WITHOUT
		// touching this.project.
		const projectId = "123e4567-e89b-12d3-a456-426614174530";
		const base = project({
			projectId,
			name: "Local edits NOT yet saved",
			pages: [page({ imageId: "image-1.webp", imageName: "image-1.webp" })],
			exportRuns: [],
		});
		// A distinct remote that MUST NEVER be adopted: if the merge ever fires it would
		// replace this.project (and its local name) with this body.
		const remoteThatMustNotBeAdopted = project({
			projectId,
			name: "Remote edit that must NOT be adopted",
			exportRuns: [],
		});
		// A clean remote that is fingerprint-EQUAL to the local state (same name + page),
		// so the saveState() stale guard passes and re-anchors instead of throwing its
		// own conflict — the 428 must come from saveProject(), the path under test.
		const staleGuardRemote = project({
			projectId,
			name: "Local edits NOT yet saved",
			pages: [page({ imageId: "image-1.webp", imageName: "image-1.webp" })],
			exportRuns: [],
		});
		projectStore.__setProjectForTesting(base);
		// Mark the page dirty: the local work the 428 path exists to protect. Adopting
		// the poison remote would silently flip this back to a clean remote snapshot.
		projectStore.markCurrentPageUnsaved();
		// First load = the saveState() stale-guard refetch (remote == local fingerprint,
		// so it passes and re-anchors). Second load = the 428 recovery re-read, which
		// must fail closed when it sees drift; point it at the poison remote so adoption
		// is unmistakable.
		vi.mocked(api.loadProject)
			.mockResolvedValueOnce(staleGuardRemote)
			.mockResolvedValue(remoteThatMustNotBeAdopted);
		vi.mocked(api.saveProject).mockRejectedValue(new api.ApiError("Missing concurrency baseline header (x-project-base-fingerprint)", {
			status: 428,
			statusText: "Precondition Required",
			code: "project_baseline_required",
			body: { code: "project_baseline_required", error: "Missing concurrency baseline header (x-project-base-fingerprint)" },
		}));

		await projectStore.exportPage();

		// EXACTLY ONE save attempt — the 428 did NOT trigger the conflict-merge re-save.
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		// loadProject was consumed by the stale guard and the safe 428 re-read, never by
		// an export merge that would adopt the remote project.
		expect(api.loadProject).toHaveBeenCalledTimes(2);
		// The poison remote was NOT adopted: the local name is intact (a successful merge
		// would have replaced this.project wholesale with "Remote edit that must NOT be
		// adopted" AND flipped saveSyncStatus to "saved" — see the asserts below).
		expect(projectStore.project?.name).toBe("Local edits NOT yet saved");
		// The export run is still recorded locally (it just couldn't be persisted yet).
		expect(projectStore.exportRuns).toEqual([
			expect.objectContaining({ kind: "single-page", status: "done", filename: "image-1.png", pageIndexes: [0] }),
		]);
		// Same recovery-draft UX as a 409: conflict kind + the localized reload status,
		// never the raw "x-project-base-fingerprint" backend string.
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.saveErrorMessage).not.toContain("x-project-base-fingerprint");
	});

	it("keeps artifact persistence failures actionable after export succeeds", () => {
		const error = new Error("Storage ของเวิร์กสเปซเต็ม. ลบไฟล์หรือเพิ่ม storage ก่อนอัปโหลดต่อ.");
		const message = formatExportArtifactPersistenceMessage(
			"Export สำเร็จ 2 หน้า: chapter.zip",
			error,
		);

		expect(formatExportArtifactPersistenceError(error)).toBe(
			"เก็บ ZIP ไม่สำเร็จ: Storage ของเวิร์กสเปซเต็ม. ลบไฟล์หรือเพิ่ม storage ก่อนอัปโหลดต่อ.",
		);
		expect(message).toBe(
			"Export สำเร็จ 2 หน้า: chapter.zip. เก็บ ZIP ไม่สำเร็จ: Storage ของเวิร์กสเปซเต็ม. ลบไฟล์หรือเพิ่ม storage ก่อนอัปโหลดต่อ. ดาวน์โหลดได้ในแท็บนี้; ลบ ZIP ที่เก็บไว้หรือสร้างใหม่หลังคืนพื้นที่",
		);
	});

	it("downgrades missing persisted export artifacts so history stops offering a broken download", async () => {
		const state = project({
			projectId: "11111111-1111-4111-8111-111111111111",
			exportRuns: [{
				id: "export-missing-artifact",
				kind: "batch-zip",
				status: "done",
				filename: "chapter.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 7,
				message: "Exported chapter.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
				artifact: {
					exportId: "export-missing-artifact.zip",
					storageDriver: "local",
					storageKey: "projects/project-1/exports/export-missing-artifact.zip",
					filename: "chapter.zip",
					mimeType: "application/zip",
					sizeBytes: 7,
					createdAt: "2026-05-17T00:00:00.000Z",
				},
			}],
		});
		projectStore.__setProjectForTesting(state);
		vi.mocked(api.loadProject).mockResolvedValue(JSON.parse(JSON.stringify(state)));
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		vi.mocked(api.downloadExportArtifact).mockRejectedValue(new api.ApiError("Export artifact not found", {
			status: 404,
			statusText: "Not Found",
			body: { error: "Export artifact not found" },
		}));

		await projectStore.downloadExportRun("export-missing-artifact");

		const run = projectStore.exportRuns[0];
		expect(run.artifact).toBeUndefined();
		expect(run.artifactError).toBe("ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ: สร้าง Export ใหม่อีกครั้ง");
		expect(projectStore.canDownloadExportRun("export-missing-artifact")).toBe(false);
		expect(projectStore.statusMsg).toBe(
			"ดาวน์โหลด Export ไม่ได้: ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ: สร้าง Export ใหม่อีกครั้ง",
		);
		expect(api.saveProject).toHaveBeenCalledWith(
			"11111111-1111-4111-8111-111111111111",
			expect.objectContaining({
				exportRuns: [expect.objectContaining({
					id: "export-missing-artifact",
					artifact: undefined,
					artifactError: "ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ: สร้าง Export ใหม่อีกครั้ง",
				})],
			}),
			expect.objectContaining({ baseFingerprint: expect.any(String) }),
		);
	});

	it("keeps missing export artifact marker failures visible when the marker cannot be saved", async () => {
		const state = project({
			projectId: "11111111-1111-4111-8111-111111111116",
			exportRuns: [{
				id: "export-missing-artifact-save-fail",
				kind: "batch-zip",
				status: "done",
				filename: "chapter.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 7,
				message: "Exported chapter.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
				artifact: {
					exportId: "export-missing-artifact-save-fail.zip",
					storageDriver: "local",
					storageKey: "projects/project-1/exports/export-missing-artifact-save-fail.zip",
					filename: "chapter.zip",
					mimeType: "application/zip",
					sizeBytes: 7,
					createdAt: "2026-05-17T00:00:00.000Z",
				},
			}],
		});
		projectStore.__setProjectForTesting(state);
		vi.mocked(api.loadProject).mockResolvedValue(JSON.parse(JSON.stringify(state)));
		vi.mocked(api.saveProject).mockRejectedValue(new Error("disk is full"));
		vi.mocked(api.downloadExportArtifact).mockRejectedValue(new api.ApiError("Export artifact not found", {
			status: 404,
			statusText: "Not Found",
			body: { error: "Export artifact not found" },
		}));

		await projectStore.downloadExportRun("export-missing-artifact-save-fail");

		const run = projectStore.exportRuns[0];
		expect(run.artifact).toBeUndefined();
		expect(run.artifactError).toBe("ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ: สร้าง Export ใหม่อีกครั้ง");
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorMessage).toBe("disk is full");
		expect(projectStore.statusMsg).toBe(
			"ดาวน์โหลด Export ไม่ได้: ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ: สร้าง Export ใหม่อีกครั้ง; บันทึกสถานะไฟล์หายไม่สำเร็จ",
		);
	});

	it("does not treat another tab's current page as a content conflict", async () => {
		const base = project();
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(project({ currentPage: 10 }));

		await projectStore.saveState();

		expect(api.saveProject).toHaveBeenCalledWith(
			"project-1",
			projectStore.project,
			expect.objectContaining({ baseFingerprint: expect.any(String) }),
		);
		expect(projectStore.saveSyncStatus).toBe("saved");
	});

	it("does not block page navigation with a stale save check when local content is unchanged", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(project({ name: "Remote edit" }));

		await projectStore.goToPage(1, editor);

		expect(api.loadProject).not.toHaveBeenCalled();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.project?.currentPage).toBe(1);
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-1/images/image-2.webp");
	});

	it("selects a page without an editor so dashboard and focus links are not dead", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		projectStore.__setProjectForTesting(base);

		const opened = await projectStore.goToPage(1, null);

		expect(opened).toBe(true);
		expect(projectStore.project?.currentPage).toBe(1);
		expect(api.loadProject).not.toHaveBeenCalled();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("หน้า 2 / 2");
	});

	it("blocks null-editor page navigation when dirty state cannot be saved", async () => {
		const base = project({
			projectId: "11111111-1111-4111-8111-111111111115",
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp", textLayers: [textLayer({ text: "dirty page 1" })] }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		projectStore.__setProjectForTesting(base);
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new Error("disk is full"));

		const opened = await projectStore.goToPage(1, null);

		expect(opened).toBe(false);
		expect(projectStore.project?.currentPage).toBe(0);
		expect(api.saveProject).toHaveBeenCalledWith(base.projectId, expect.any(Object), expect.objectContaining({
			baseFingerprint: expect.any(String),
		}));
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.statusMsg).toBe("หน้า 2 ยังไม่เปิด: บันทึกไม่สำเร็จ (disk is full) กดลองบันทึกอีกครั้งก่อน");
	});

	it("allows toolbar page stepping without an editor during startup", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		projectStore.__setProjectForTesting(base);

		const moved = await projectStore.nextPage(null);

		expect(moved).toBe(true);
		expect(projectStore.project?.currentPage).toBe(1);
		expect(projectStore.statusMsg).toBe("หน้า 2 / 2");
	});

	it("explains page step boundaries instead of failing silently", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
			currentPage: 0,
		}));

		await expect(projectStore.prevPage(null)).resolves.toBe(false);
		expect(projectStore.statusMsg).toBe("อยู่หน้าแรกแล้ว");

		projectStore.project!.currentPage = 1;
		await expect(projectStore.nextPage(null)).resolves.toBe(false);
		expect(projectStore.statusMsg).toBe("อยู่หน้าสุดท้ายแล้ว");
	});

	it("opens a page with a missing image so it can be relinked", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "missing.webp", imageName: "missing.webp", originalName: "missing-source.webp" }),
			],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockRejectedValue(new Error("404 image missing")),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		const opened = await projectStore.goToPage(1, editor);

		expect(opened).toBe(true);
		expect(projectStore.project?.currentPage).toBe(1);
		expect(projectStore.currentPageAssetError).toMatchObject({
			pageIndex: 1,
			imageId: "missing.webp",
			originalName: "missing-source.webp",
			message: "404 image missing",
		});
		expect(projectStore.statusMsg).toBe("รูปหน้า 2 หาย");
	});

	it("keeps the base page open when an image layer asset is missing", async () => {
		const missingLayer = imageLayer({
			imageId: "missing-overlay.webp",
			imageName: "missing-overlay.webp",
			originalName: "missing-overlay-source.webp",
		});
		const base = project({
			pages: [
				page({
					imageId: "image-1.webp",
					imageName: "image-1.webp",
					imageLayers: [missingLayer],
					textLayers: [textLayer({ id: "text-after-missing-layer" })],
				}),
			],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockRejectedValue(new Error("404 overlay missing")),
		};
		projectStore.__setProjectForTesting(base);

		const opened = await projectStore.loadPage(0, editor);

		expect(opened).toBe(true);
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-1/images/image-1.webp");
		expect(editor.addImageLayer).toHaveBeenCalledWith(missingLayer, "/api/project/project-1/images/missing-overlay.webp");
		expect(editor.addTextLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "text-after-missing-layer" }));
		expect(projectStore.currentPageAssetError).toMatchObject({
			pageIndex: 0,
			imageId: "missing-overlay.webp",
			originalName: "missing-overlay-source.webp",
			message: "404 overlay missing",
			kind: "image-layer",
			layerId: "image-layer-1",
		});
		expect(projectStore.statusMsg).toBe("รูปเสริมหน้า 1 หาย");
	});

	it("loads the edited page image when page edits exist", async () => {
		const base = project({
			pages: [
				page({
					imageId: "base-page.webp",
					imageName: "base-page.webp",
					edits: { imageId: "persisted-ai-mask.png" },
					textLayers: [textLayer({ id: "text-on-edited-page" })],
				}),
			],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		const opened = await projectStore.loadPage(0, editor);

		expect(opened).toBe(true);
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-1/images/persisted-ai-mask.png");
		expect(editor.loadImage).not.toHaveBeenCalledWith("/api/project/project-1/images/base-page.webp");
		expect(editor.addTextLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "text-on-edited-page" }));
	});

	it("relinks a missing image layer asset without replacing the base page image", async () => {
		const missingLayer = imageLayer({
			id: "overlay-layer",
			imageId: "missing-overlay.webp",
			imageName: "missing-overlay.webp",
			originalName: "old-overlay.webp",
			restoreImageId: "missing-overlay.webp",
		});
		const base = project({
			projectId: "123e4567-e89b-42d3-a456-426614174000",
			pages: [
				page({
					imageId: "base-page.webp",
					imageName: "base-page.webp",
					imageLayers: [missingLayer],
				}),
			],
		});
		const editor = {
			loadImage: vi.fn().mockResolvedValue(undefined),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
		};
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-overlay-id"],
			assets: [{
				assetId: "new-overlay-id",
				imageId: "new-overlay-id",
				originalName: "replacement.png",
				mimeType: "image/png",
				sizeBytes: 7,
				sha256: "hash",
				storageDriver: "local",
				storageKey: "objects/replacement.png",
				width: 120,
				height: 80,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: "2026-05-19T00:00:00.000Z",
				updatedAt: "2026-05-19T00:00:00.000Z",
			}],
		});
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		projectStore.__setProjectForTesting(base);
		projectStore.assetLoadErrors = {
			0: {
				pageIndex: 0,
				imageId: "missing-overlay.webp",
				imageName: "missing-overlay.webp",
				originalName: "old-overlay.webp",
				message: "404 overlay",
				kind: "image-layer",
				layerId: "overlay-layer",
			},
		};

		await projectStore.replacePageImageLayerAsset(0, "overlay-layer", new File(["overlay"], "replacement.png", { type: "image/png" }), editor);

		// f31 tags uploads with assetKind so page_set_changed only fires for real
		// page additions/replacements — image-LAYER edits carry their own kind.
		expect(api.uploadImages).toHaveBeenCalledWith("123e4567-e89b-42d3-a456-426614174000", [
			expect.objectContaining({ name: "replacement.png" }),
		], undefined, { assetKind: "image-layer-replacement" });
		expect(projectStore.project?.pages[0].imageId).toBe("base-page.webp");
		expect(projectStore.project?.pages[0].imageLayers?.[0]).toMatchObject({
			id: "overlay-layer",
			imageId: "new-overlay-id",
			imageName: "new-overlay-id",
			originalName: "replacement.png",
			restoreImageId: "new-overlay-id",
		});
		expect(projectStore.currentPageAssetError).toBeNull();
		expect(editor.loadImage).toHaveBeenLastCalledWith("/api/project/123e4567-e89b-42d3-a456-426614174000/images/base-page.webp");
		expect(projectStore.statusMsg).toBe("กู้รูปเสริมหน้า 1 แล้ว");
	});

	it("restores the old image layer when image-layer relink save fails", async () => {
		const oldAsset = {
			assetId: "old-overlay.webp",
			imageId: "old-overlay.webp",
			originalName: "old-overlay.webp",
			mimeType: "image/webp",
			sizeBytes: 3072,
			sha256: "old-overlay-hash",
			storageDriver: "local",
			storageKey: "objects/old-overlay.webp",
			width: 420,
			height: 280,
			storageStatus: "released",
			moderationStatus: "passed",
			derivativeCount: 0,
			createdAt: "2026-05-20T04:55:00.000Z",
			updatedAt: "2026-05-20T04:55:00.000Z",
		} as const;
		const newAsset = {
			...oldAsset,
			assetId: "new-overlay.webp",
			imageId: "new-overlay.webp",
			originalName: "replacement-overlay.webp",
			sha256: "new-overlay-hash",
			storageKey: "objects/new-overlay.webp",
		};
		const oldLayer = imageLayer({
			id: "overlay-layer",
			imageId: "old-overlay.webp",
			imageName: "old-overlay.webp",
			originalName: "old-overlay.webp",
			restoreImageId: "old-overlay.webp",
		});
		const base = project({
			projectId: "123e4567-e89b-42d3-a456-426614174000",
			pages: [
				page({
					imageId: "base-page.webp",
					imageName: "base-page.webp",
					imageLayers: [oldLayer],
				}),
			],
		});
		const editor = {
			loadImage: vi.fn().mockResolvedValue(undefined),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
		};
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-overlay.webp"],
			assets: [newAsset],
		});
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new Error("storage offline"));
		projectStore.__setProjectForTesting(base);
		projectStore.imageAssets = [oldAsset];
		projectStore.imageAssetsProjectId = base.projectId;
		projectStore.assetLoadErrors = {
			0: [{
				pageIndex: 0,
				imageId: "old-overlay.webp",
				imageName: "old-overlay.webp",
				originalName: "old-overlay.webp",
				message: "old overlay still missing",
				kind: "image-layer",
				layerId: "overlay-layer",
			}],
		};

		await projectStore.replacePageImageLayerAsset(0, "overlay-layer", new File(["overlay"], "replacement-overlay.webp", { type: "image/webp" }), editor);

		expect(projectStore.project?.pages[0].imageId).toBe("base-page.webp");
		expect(projectStore.project?.pages[0].imageLayers?.[0]).toMatchObject({
			id: "overlay-layer",
			imageId: "old-overlay.webp",
			imageName: "old-overlay.webp",
			originalName: "old-overlay.webp",
			restoreImageId: "old-overlay.webp",
		});
		expect(projectStore.imageAssetsProjectId).toBe(base.projectId);
		expect(projectStore.imageAssets).toEqual([oldAsset]);
		expect(projectStore.currentPageAssetError).toMatchObject({
			pageIndex: 0,
			imageId: "old-overlay.webp",
			layerId: "overlay-layer",
			message: "old overlay still missing",
		});
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(projectStore.statusMsg).toBe("กู้รูปเสริมไม่สำเร็จ: storage offline");
		expect(editor.loadImage).not.toHaveBeenCalled();
	});

	it("keeps the next missing image-layer issue after relinking one failed layer", async () => {
		const firstLayer = imageLayer({
			id: "overlay-a",
			imageId: "missing-a.webp",
			imageName: "missing-a.webp",
		});
		const secondLayer = imageLayer({
			id: "overlay-b",
			imageId: "missing-b.webp",
			imageName: "missing-b.webp",
			originalName: "second-overlay.webp",
			index: 1,
		});
		const base = project({
			projectId: "123e4567-e89b-42d3-a456-426614174000",
			pages: [
				page({
					imageId: "base-page.webp",
					imageName: "base-page.webp",
					imageLayers: [firstLayer, secondLayer],
				}),
			],
		});
		const editor = {
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn((layer: ImageLayer) => {
				if (layer.id === "overlay-b") return Promise.reject(new Error("404 second overlay"));
				return Promise.resolve(undefined);
			}),
		};
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-overlay-a"],
			assets: [{
				assetId: "new-overlay-a",
				imageId: "new-overlay-a",
				originalName: "replacement-a.png",
				mimeType: "image/png",
				sizeBytes: 7,
				sha256: "hash-a",
				storageDriver: "local",
				storageKey: "objects/replacement-a.png",
				width: 120,
				height: 80,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: "2026-05-19T00:00:00.000Z",
				updatedAt: "2026-05-19T00:00:00.000Z",
			}],
		});
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		projectStore.__setProjectForTesting(base);
		projectStore.assetLoadErrors = {
			0: [
				{
					pageIndex: 0,
					imageId: "missing-a.webp",
					imageName: "missing-a.webp",
					message: "404 first overlay",
					kind: "image-layer",
					layerId: "overlay-a",
				},
				{
					pageIndex: 0,
					imageId: "missing-b.webp",
					imageName: "missing-b.webp",
					originalName: "second-overlay.webp",
					message: "404 second overlay",
					kind: "image-layer",
					layerId: "overlay-b",
					layerName: "Second overlay",
				},
			],
		};

		await projectStore.replacePageImageLayerAsset(0, "overlay-a", new File(["overlay-a"], "replacement-a.png", { type: "image/png" }), editor);

		expect(projectStore.project?.pages[0].imageLayers?.[0].imageId).toBe("new-overlay-a");
		expect(projectStore.currentPageAssetError).toMatchObject({
			imageId: "missing-b.webp",
			layerId: "overlay-b",
			originalName: "second-overlay.webp",
			message: "404 second overlay",
		});
		expect(projectStore.getPageAssetIntegrity(0)).toMatchObject({
			issueKind: "image-layer",
			layerId: "overlay-b",
			detail: "รูปเสริม second-overlay.webp โหลดไม่ได้: 404 second overlay",
		});
	});

	it("keeps missing image recovery state attached to the failed page after navigation", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "missing.webp", imageName: "missing.webp", originalName: "missing-source.webp" }),
			],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn()
				.mockRejectedValueOnce(new Error("404 image missing"))
				.mockResolvedValueOnce(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		await expect(projectStore.goToPage(1, editor)).resolves.toBe(true);
		expect(projectStore.currentPageAssetError?.pageIndex).toBe(1);

		await expect(projectStore.goToPage(0, editor)).resolves.toBe(true);

		expect(projectStore.project?.currentPage).toBe(0);
		expect(projectStore.currentPageAssetError).toBeNull();
		expect(projectStore.getPageAssetIntegrity(1)).toMatchObject({
			status: "failed",
			detail: "404 image missing",
		});
	});

	it("rejects unsupported single-page relink files before upload", async () => {
		const base = project();
		projectStore.__setProjectForTesting(base);

		await projectStore.replacePageImage(0, new File(["x"], "page.avif", { type: "image/avif" }));

		expect(api.uploadImages).not.toHaveBeenCalled();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe(
			"กู้รูปหน้า 1 ไม่สำเร็จ: page.avif ไม่ใช่ PNG, JPG หรือ WebP",
		);
	});

	it("restores the old page image when single-page relink save fails", async () => {
		const oldAsset = {
			assetId: "old-page.webp",
			imageId: "old-page.webp",
			originalName: "old-page.webp",
			mimeType: "image/webp",
			sizeBytes: 2048,
			sha256: "old-page-hash",
			storageDriver: "local",
			storageKey: "objects/old-page.webp",
			width: 800,
			height: 1200,
			storageStatus: "released",
			moderationStatus: "passed",
			derivativeCount: 0,
			createdAt: "2026-05-20T04:25:00.000Z",
			updatedAt: "2026-05-20T04:25:00.000Z",
		} as const;
		const newAsset = {
			...oldAsset,
			assetId: "new-page.webp",
			imageId: "new-page.webp",
			originalName: "new-page.webp",
			sha256: "new-page-hash",
			storageKey: "objects/new-page.webp",
		};
		const base = project({
			projectId: "123e4567-e89b-12d3-a456-426614174475",
			pages: [page({
				imageId: "old-page.webp",
				imageName: "old-page.webp",
				originalName: "old-page.webp",
				edits: { imageId: "edited-old-page.webp" },
			})],
		});
		projectStore.__setProjectForTesting(base);
		projectStore.imageAssets = [oldAsset];
		projectStore.imageAssetsProjectId = base.projectId;
		projectStore.assetLoadErrors = {
			0: [{
				kind: "page",
				pageIndex: 0,
				imageId: "old-page.webp",
				imageName: "old-page.webp",
				originalName: "old-page.webp",
				detail: "old asset still needs recovery",
			}],
		};
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-page.webp"],
			assets: [newAsset],
		});
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new Error("network down"));

		await projectStore.replacePageImage(0, new File(["new"], "new-page.webp", { type: "image/webp" }));

		expect(projectStore.project?.pages[0]).toMatchObject({
			imageId: "old-page.webp",
			imageName: "old-page.webp",
			originalName: "old-page.webp",
			edits: { imageId: "edited-old-page.webp" },
		});
		expect(projectStore.imageAssetsProjectId).toBe(base.projectId);
		expect(projectStore.imageAssets).toEqual([oldAsset]);
		expect(projectStore.currentPageAssetError).toMatchObject({
			pageIndex: 0,
			imageId: "old-page.webp",
			detail: "old asset still needs recovery",
		});
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(projectStore.statusMsg).toBe("กู้รูปไม่สำเร็จ: network down");
	});

	it("explains unsupported bulk relink files before matching filenames", async () => {
		const base = project({
			pages: [page({ originalName: "page-1.png" })],
		});
		projectStore.__setProjectForTesting(base);

		await projectStore.replaceMatchingPageImages([
			new File(["x"], "page-1.avif", { type: "image/avif" }),
			new File(["x"], "vector.svg", { type: "image/svg+xml" }),
		]);

		expect(api.uploadImages).not.toHaveBeenCalled();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe(
			"กู้รูปไม่สำเร็จ: ยังไม่มีไฟล์ PNG, JPG หรือ WebP ที่ใช้ได้; ไฟล์ไม่รองรับ 2 ไฟล์: page-1.avif, vector.svg",
		);
	});

	it("requires confirmation before bulk relink uses ลำดับไฟล์ในโฟลเดอร์ fallback", async () => {
		const base = project({
			pages: [
				page({ imageId: "ocr-a", imageName: "ocr-a.png", originalName: "ocr-a.png" }),
				page({ imageId: "ocr-b", imageName: "ocr-b.png", originalName: "ocr-b.png" }),
			],
		});
		projectStore.__setProjectForTesting(base);

		const preview = projectStore.getMatchingPageImageRelinkPreview([
			new File(["one"], "image-01.webp", { type: "image/webp" }),
			new File(["two"], "image-02.webp", { type: "image/webp" }),
		]);

		expect(preview.requiresOrderConfirmation).toBe(true);
		expect(preview.orderMatchedCount).toBe(2);

		await projectStore.replaceMatchingPageImages([
			new File(["one"], "image-01.webp", { type: "image/webp" }),
			new File(["two"], "image-02.webp", { type: "image/webp" }),
		]);

		expect(api.uploadImages).not.toHaveBeenCalled();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe(
			"กู้รูปต้องยืนยัน: 2 หน้าใช้ลำดับไฟล์จากโฟลเดอร์ ตรวจพรีวิวก่อนแทนรูป",
		);
	});

	it("allows confirmed folder-order fallback for bulk relink", async () => {
		const base = project({
			pages: [
				page({ imageId: "ocr-a", imageName: "ocr-a.png", originalName: "ocr-a.png" }),
				page({ imageId: "ocr-b", imageName: "ocr-b.png", originalName: "ocr-b.png" }),
			],
		});
		const remoteBase = structuredClone(base);
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["uploaded-01.webp", "uploaded-02.webp"],
			assets: [],
		});
		vi.mocked(api.loadProject).mockResolvedValue(remoteBase);
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await projectStore.replaceMatchingPageImages([
			new File(["one"], "image-01.webp", { type: "image/webp" }),
			new File(["two"], "image-02.webp", { type: "image/webp" }),
		], undefined, { allowOrderFallback: true });

		expect(api.uploadImages).toHaveBeenCalled();
		expect(api.saveProject).toHaveBeenCalled();
		expect(projectStore.project?.pages.map((item) => item.imageName)).toEqual([
			"uploaded-01.webp",
			"uploaded-02.webp",
		]);
		expect(projectStore.statusMsg).toBe("กู้รูปแล้ว 2 หน้า (2 ตามลำดับหน้า)");
	});

	it("restores all page images when bulk relink save fails", async () => {
		const oldAssets = [
			{
				assetId: "page-a.webp",
				imageId: "page-a.webp",
				originalName: "page-a.webp",
				mimeType: "image/webp",
				sizeBytes: 1000,
				sha256: "old-a",
				storageDriver: "local",
				storageKey: "objects/page-a.webp",
				width: 800,
				height: 1200,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: "2026-05-20T05:00:00.000Z",
				updatedAt: "2026-05-20T05:00:00.000Z",
			},
			{
				assetId: "page-b.webp",
				imageId: "page-b.webp",
				originalName: "page-b.webp",
				mimeType: "image/webp",
				sizeBytes: 1100,
				sha256: "old-b",
				storageDriver: "local",
				storageKey: "objects/page-b.webp",
				width: 820,
				height: 1180,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: "2026-05-20T05:00:00.000Z",
				updatedAt: "2026-05-20T05:00:00.000Z",
			},
		] as const;
		const base = project({
			projectId: "123e4567-e89b-12d3-a456-426614174516",
			pages: [
				page({
					imageId: "page-a.webp",
					imageName: "page-a.webp",
					originalName: "page-a.webp",
					edits: { imageId: "edited-page-a.webp" },
				}),
				page({
					imageId: "page-b.webp",
					imageName: "page-b.webp",
					originalName: "page-b.webp",
				}),
			],
		});
		projectStore.__setProjectForTesting(base);
		projectStore.imageAssets = [...oldAssets];
		projectStore.imageAssetsProjectId = base.projectId;
		projectStore.assetLoadErrors = {
			0: [{
				kind: "page",
				pageIndex: 0,
				imageId: "page-a.webp",
				imageName: "page-a.webp",
				originalName: "page-a.webp",
				message: "page-a still needs recovery",
			}],
			1: [{
				kind: "page",
				pageIndex: 1,
				imageId: "page-b.webp",
				imageName: "page-b.webp",
				originalName: "page-b.webp",
				message: "page-b still needs recovery",
			}],
		};
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-page-a.webp", "new-page-b.webp"],
			assets: [
				{ ...oldAssets[0], assetId: "new-page-a.webp", imageId: "new-page-a.webp", originalName: "page-a.webp", sha256: "new-a" },
				{ ...oldAssets[1], assetId: "new-page-b.webp", imageId: "new-page-b.webp", originalName: "page-b.webp", sha256: "new-b" },
			],
		});
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new Error("save queue offline"));

		await projectStore.replaceMatchingPageImages([
			new File(["a"], "page-a.webp", { type: "image/webp" }),
			new File(["b"], "page-b.webp", { type: "image/webp" }),
		]);

		expect(projectStore.project?.pages.map((item) => ({
			imageId: item.imageId,
			imageName: item.imageName,
			originalName: item.originalName,
			edits: item.edits,
		}))).toEqual([
			{
				imageId: "page-a.webp",
				imageName: "page-a.webp",
				originalName: "page-a.webp",
				edits: { imageId: "edited-page-a.webp" },
			},
			{
				imageId: "page-b.webp",
				imageName: "page-b.webp",
				originalName: "page-b.webp",
				edits: undefined,
			},
		]);
		expect(projectStore.imageAssetsProjectId).toBe(base.projectId);
		expect(projectStore.imageAssets).toEqual([...oldAssets]);
		expect(projectStore.getPageAssetIntegrity(0)).toMatchObject({
			status: "failed",
			detail: "page-a still needs recovery",
		});
		expect(projectStore.getPageAssetIntegrity(1)).toMatchObject({
			status: "failed",
			detail: "page-b still needs recovery",
		});
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(projectStore.statusMsg).toBe("กู้รูปไม่สำเร็จ: save queue offline");
	});

	it("rejects unsupported project cover uploads before upload", async () => {
		const base = project();
		projectStore.__setProjectForTesting(base);

		await projectStore.setProjectCover("project-1", new File(["x"], "cover.heic", { type: "image/heic" }));

		expect(api.uploadImages).not.toHaveBeenCalled();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe(
			"ตั้งปกไม่สำเร็จ: cover.heic ไม่ใช่ PNG, JPG หรือ WebP",
		);
	});

	it("rejects unsupported reference image layers before upload", async () => {
		const base = project();
		projectStore.__setProjectForTesting(base);

		const layer = await projectStore.addReferenceImageLayer(
			new File(["x"], "reference.svg", { type: "image/svg+xml" }),
			{},
		);

		expect(layer).toBeNull();
		expect(api.uploadImages).not.toHaveBeenCalled();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe(
			"เพิ่มรูปเสริมไม่สำเร็จ: reference.svg ไม่ใช่ PNG, JPG หรือ WebP",
		);
	});

	it("adds reference image layers locally for debug projects without backend upload", async () => {
		vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
			width: 320,
			height: 480,
			close: vi.fn(),
		})));
		const base = project({
			projectId: "flow208-project",
			pages: [page({ imageLayers: [] })],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllImageLayers: vi.fn(() => liveImageLayers),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer, imageUrl: string) => {
				expect(imageUrl.startsWith("data:") || imageUrl.startsWith("blob:")).toBe(true);
				liveImageLayers.push(layer);
				return layer;
			}),
			selectImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		const layer = await projectStore.addReferenceImageLayer(
			new File(["webp"], "p104-overlay.webp", { type: "image/webp" }),
			editor,
		);

		expect(api.uploadImages).not.toHaveBeenCalled();
		expect(layer).toMatchObject({
			originalName: "p104-overlay.webp",
			imageName: expect.stringMatching(/^reference-image-/),
			role: "reference",
		});
		expect(editor.addImageLayerWithHistory).toHaveBeenCalledTimes(1);
		expect(projectStore.project?.pages[0].imageLayers).toHaveLength(1);
		expect(projectStore.statusMsg).toBe("เพิ่มรูปเสริมแล้ว: p104-overlay.webp");
		vi.unstubAllGlobals();
	});

	it("places accepted AI results as editable overlay image layers", async () => {
		const earlierMarker = aiReviewMarker({
			id: "marker-ai-earlier",
			jobId: "job-ai-earlier",
			resultImageId: "result-ai-earlier.webp",
			status: "applied",
			createdAt: "2026-05-14T00:00:00.000Z",
			updatedAt: "2026-05-14T00:00:00.000Z",
		});
		const marker = aiReviewMarker({
			id: "marker-ai-1",
			jobId: "job-ai-1",
			resultImageId: "result-ai-1.webp",
			region: { x: 110, y: 310, w: 280, h: 180 },
			status: "accepted",
			createdAt: "2026-05-14T00:01:00.000Z",
			updatedAt: "2026-05-14T00:01:00.000Z",
		});
		const base = project({
			projectId: "flow208-project",
			aiReviewMarkers: [marker, earlierMarker],
			pages: [page({ imageLayers: [] })],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllImageLayers: vi.fn(() => liveImageLayers),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer, imageUrl: string) => {
				expect(imageUrl).toBe("/api/project/flow208-project/images/result-ai-1.webp");
				liveImageLayers.push(layer);
				return layer;
			}),
			selectImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer("marker-ai-1", editor);

		expect(layer).toEqual(expect.objectContaining({
			id: "ai-result-marker-ai-1",
			imageId: "result-ai-1.webp",
			originalName: "ผล AI 2 (หน้า 1)",
			x: 110,
			y: 310,
			w: 280,
			h: 180,
			role: "overlay",
			visible: true,
			locked: false,
		}));
		expect(editor.addImageLayerWithHistory).toHaveBeenCalledTimes(1);
		expect(projectStore.project?.pages[0].imageLayers).toHaveLength(1);
		expect(projectStore.aiReviewMarkers[0].status).toBe("applied");
			expect(projectStore.statusMsg).toBe("วางผล AI เป็นเลเยอร์แล้ว");
	});

	it("keeps the AI layer in project state if the editor cannot report it yet", async () => {
		const marker = aiReviewMarker({
			id: "marker-ai-editor-not-ready",
			resultImageId: "result-ai-not-ready.webp",
			region: { x: 110, y: 310, w: 280, h: 180 },
			status: "accepted",
		});
		const base = project({
			projectId: "flow208-project",
			aiReviewMarkers: [marker],
			pages: [page({ imageLayers: [] })],
		});
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllImageLayers: vi.fn(() => []),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => layer),
			selectImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer("marker-ai-editor-not-ready", editor);

		expect(layer?.id).toBe("ai-result-marker-ai-editor-not-ready");
		expect(editor.addImageLayerWithHistory).toHaveBeenCalledTimes(1);
		expect(projectStore.project?.pages[0].imageLayers).toEqual([
			expect.objectContaining({ id: "ai-result-marker-ai-editor-not-ready" }),
		]);
		expect(projectStore.aiReviewMarkers[0].status).toBe("applied");
	});

	it("blocks unreviewed AI results from being applied as editable layers", async () => {
		const marker = aiReviewMarker({
			id: "marker-ai-unreviewed",
			resultImageId: "result-ai-unreviewed.webp",
			status: "needs_review",
		});
		const base = project({
			projectId: "flow208-project",
			aiReviewMarkers: [marker],
			pages: [page({ imageLayers: [] })],
		});
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllImageLayers: vi.fn(() => []),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => layer),
			selectImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer("marker-ai-unreviewed", editor);

		expect(layer).toBeNull();
		expect(editor.addImageLayerWithHistory).not.toHaveBeenCalled();
		expect(projectStore.project?.pages[0].imageLayers).toEqual([]);
		expect(projectStore.aiReviewMarkers[0].status).toBe("needs_review");
		expect(projectStore.statusMsg).toBe("ยืนยันผลผ่านก่อนวางเลเยอร์ AI");
	});

	it("places ready AI results as brush layers without clearing review blockers", async () => {
		const marker = aiReviewMarker({
			id: "marker-ai-brush-1",
			resultImageId: "result-ai-brush.webp",
			region: { x: 20, y: 30, w: 240, h: 160 },
			status: "needs_review",
		});
		const base = project({
			projectId: "flow208-project",
			aiReviewMarkers: [marker],
			pages: [page({ imageLayers: [] })],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllImageLayers: vi.fn(() => liveImageLayers),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => {
				liveImageLayers.push(layer);
				return layer;
			}),
			selectImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer("marker-ai-brush-1", editor, {
			markApplied: false,
			statusMessage: "วางผล AI เป็นเลเยอร์แก้แล้ว ยังรอรีวิว",
		});

		expect(layer?.id).toBe("ai-result-marker-ai-brush-1");
		expect(projectStore.project?.pages[0].imageLayers).toHaveLength(1);
		expect(projectStore.aiReviewMarkers[0].status).toBe("needs_review");
		expect(projectStore.project?.aiReviewMarkers?.[0]?.status).toBe("needs_review");
		expect(projectStore.statusMsg).toBe("วางผล AI เป็นเลเยอร์แก้แล้ว ยังรอรีวิว");
	});

	it("can place AI results found only on project marker state", async () => {
		const marker = aiReviewMarker({
			id: "marker-project-only",
			resultImageId: "result-project-only.webp",
			status: "accepted",
		});
		const base = project({
			projectId: "flow208-project",
			aiReviewMarkers: [marker],
			pages: [page({ imageLayers: [] })],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllImageLayers: vi.fn(() => liveImageLayers),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => {
				liveImageLayers.push(layer);
				return layer;
			}),
			selectImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		projectStore.aiReviewMarkers = [];

		const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer("marker-project-only", editor, {
			markApplied: false,
		});

		expect(layer?.id).toBe("ai-result-marker-project-only");
		expect(projectStore.aiReviewMarkers.some((item) => item.id === "marker-project-only")).toBe(true);
		expect(projectStore.aiReviewMarkers[0].status).toBe("accepted");
	});

	it("uses page asset dimensions and result source dimensions when placing AI layers without an editor", async () => {
		const marker = aiReviewMarker({
			id: "marker-ai-long-page",
			imageId: "long-page.webp",
			resultImageId: "result-ai-long-page.webp",
			region: { x: 500, y: 1800, w: 260, h: 220 },
			status: "accepted",
		});
		const base = project({
			projectId: "flow208-project",
			aiReviewMarkers: [marker],
			pages: [page({ imageId: "long-page.webp", imageName: "long-page.webp", imageLayers: [] })],
		});
		projectStore.__setProjectForTesting(base);
		projectStore.imageAssets = [
			imageAsset({
				assetId: "long-page-asset",
				imageId: "long-page.webp",
				originalName: "long-page.webp",
				width: 760,
				height: 2200,
			}),
			imageAsset({
				assetId: "result-ai-long-page-asset",
				imageId: "result-ai-long-page.webp",
				originalName: "result-ai-long-page.webp",
				width: 640,
				height: 360,
			}),
		];
		projectStore.imageAssetsProjectId = base.projectId;

		const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer("marker-ai-long-page", null);

		expect(layer).toEqual(expect.objectContaining({
			id: "ai-result-marker-ai-long-page",
			imageId: "result-ai-long-page.webp",
			x: 500,
			y: 1800,
			w: 260,
			h: 220,
			sourceW: 640,
			sourceH: 360,
		}));
		expect(projectStore.project?.pages[0].imageLayers?.[0]).toEqual(expect.objectContaining({
			id: "ai-result-marker-ai-long-page",
			y: 1800,
			sourceW: 640,
			sourceH: 360,
		}));
		expect(projectStore.aiReviewMarkers[0].status).toBe("applied");
		expect(projectStore.statusMsg).toBe("วางผล AI เป็นเลเยอร์แล้ว");
	});

	it("keeps legacy AI apply editable as an image layer instead of flattening the page background", async () => {
		const base = project({
			projectId: "flow208-project",
			pages: [page({
				edits: { imageId: "previous-flat-edit.webp" },
				imageLayers: [],
			})],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 920,
			imageHeight: 1480,
			getAllImageLayers: vi.fn(() => liveImageLayers),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer, imageUrl: string) => {
				expect(imageUrl).toBe("/api/project/flow208-project/images/result-legacy-ai.webp");
				liveImageLayers.push(layer);
				return layer;
			}),
			selectImageLayer: vi.fn(),
			updateBackgroundImage: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		await projectStore.applyAiResult("result-legacy-ai.webp", editor);

		expect(api.applyAiResultToPage).not.toHaveBeenCalled();
		expect(editor.updateBackgroundImage).not.toHaveBeenCalled();
		expect(editor.addImageLayerWithHistory).toHaveBeenCalledTimes(1);
		expect(projectStore.project?.pages[0].edits).toEqual({ imageId: "previous-flat-edit.webp" });
		expect(projectStore.project?.pages[0].imageLayers?.[0]).toEqual(expect.objectContaining({
			id: expect.stringMatching(/^ai-result-legacy-1-/),
			imageId: "result-legacy-ai.webp",
			imageName: "result-legacy-ai.webp",
			originalName: "ผล AI หน้า 1",
			x: 0,
			y: 0,
			w: 920,
			h: 1480,
			role: "overlay",
			visible: true,
			locked: false,
		}));
		expect(editor.selectImageLayer).toHaveBeenCalledWith(expect.stringMatching(/^ai-result-legacy-1-/));
		expect(projectStore.saveSyncStatus).toBe("unsaved");
			expect(projectStore.statusMsg).toBe("วางผล AI เป็นเลเยอร์หน้า 1 แล้ว");
	});

	it("places legacy AI apply on non-current pages without opening or flattening the canvas", async () => {
		const base = project({
			projectId: "flow208-project",
			currentPage: 0,
			pages: [
				page({ imageLayers: [] }),
				page({ imageId: "page-2.webp", imageName: "page-2.webp", imageLayers: [] }),
			],
		});
		const editor = {
			imageWidth: 800,
			imageHeight: 1200,
			getAllImageLayers: vi.fn(() => []),
			addImageLayerWithHistory: vi.fn(),
			selectImageLayer: vi.fn(),
			updateBackgroundImage: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		await projectStore.applyAiResult("result-page-2.webp", editor, 1);

		expect(api.applyAiResultToPage).not.toHaveBeenCalled();
		expect(editor.updateBackgroundImage).not.toHaveBeenCalled();
		expect(editor.addImageLayerWithHistory).not.toHaveBeenCalled();
		expect(projectStore.project?.pages[1].imageLayers?.[0]).toEqual(expect.objectContaining({
			id: expect.stringMatching(/^ai-result-legacy-2-/),
			imageId: "result-page-2.webp",
			w: 800,
			h: 1200,
		}));
		expect(projectStore.project?.pages[1].edits).toBeUndefined();
			expect(projectStore.statusMsg).toBe("วางผล AI เป็นเลเยอร์หน้า 2 แล้ว");
	});

	it("defers backend AI marker applied status until the result layer is saved", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174447";
		const marker = aiReviewMarker({
			id: "marker-ai-atomic",
			resultImageId: "result-ai-atomic.webp",
			region: { x: 80, y: 120, w: 260, h: 180 },
			status: "accepted",
		});
		const base = project({
			projectId,
			aiReviewMarkers: [marker],
			pages: [page({ imageLayers: [] })],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllImageLayers: vi.fn(() => liveImageLayers),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => {
				liveImageLayers.push(layer);
				return layer;
			}),
			selectImageLayer: vi.fn(),
		};
		const appliedMarker = { ...marker, status: "applied" as const };
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		vi.mocked(api.updateAiReviewMarker).mockResolvedValue({
			marker: appliedMarker,
			markers: [appliedMarker],
			activityLog: [],
		});

		const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer("marker-ai-atomic", editor);

		expect(layer?.id).toBe("ai-result-marker-ai-atomic");
		expect(projectStore.project?.pages[0].imageLayers).toHaveLength(1);
		expect(projectStore.aiReviewMarkers[0].status).toBe("accepted");
		expect(api.updateAiReviewMarker).not.toHaveBeenCalled();
			expect(projectStore.statusMsg).toBe("วางผล AI เป็นเลเยอร์แล้ว บันทึกก่อนปิดรายการผล AI");

		await projectStore.saveState();

		expect(api.saveProject).toHaveBeenCalledWith(projectId, expect.objectContaining({
			pages: [expect.objectContaining({
				imageLayers: [expect.objectContaining({ id: "ai-result-marker-ai-atomic" })],
			})],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(api.updateAiReviewMarker).toHaveBeenCalledWith(projectId, "marker-ai-atomic", { status: "applied" });
		expect(projectStore.aiReviewMarkers[0].status).toBe("applied");
			expect(projectStore.statusMsg).toBe("บันทึกเลเยอร์ผล AI แล้ว และปิดรายการผล AI แล้ว");
	});

	it("keeps AI Review blocked when marker apply fails after saving the result layer", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174448";
		const marker = aiReviewMarker({
			id: "marker-ai-apply-fail",
			resultImageId: "result-ai-fail.webp",
			status: "accepted",
		});
		const base = project({
			projectId,
			aiReviewMarkers: [marker],
			pages: [page({ imageLayers: [] })],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllImageLayers: vi.fn(() => liveImageLayers),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => {
				liveImageLayers.push(layer);
				return layer;
			}),
			selectImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		vi.mocked(api.updateAiReviewMarker).mockRejectedValue(new Error("stale marker"));

		await projectStore.placeAiReviewMarkerResultAsImageLayer("marker-ai-apply-fail", editor);
		await projectStore.saveState();

		expect(api.saveProject).toHaveBeenCalled();
		expect(api.updateAiReviewMarker).toHaveBeenCalledWith(projectId, "marker-ai-apply-fail", { status: "applied" });
		expect(projectStore.project?.pages[0].imageLayers).toHaveLength(1);
		expect(projectStore.aiReviewMarkers[0].status).toBe("accepted");
			expect(projectStore.statusMsg).toBe("บันทึกเลเยอร์ผล AI แล้ว แต่ปิดรายการผล AI ไม่สำเร็จ: ลองบันทึกอีกครั้ง");
	});

	it("keeps pending AI marker close scoped to the original project when switching projects", async () => {
		const projectAId = "123e4567-e89b-12d3-a456-426614174449";
		const projectBId = "123e4567-e89b-12d3-a456-426614174450";
		const markerA = aiReviewMarker({
			id: "shared-marker-id",
			resultImageId: "result-project-a.webp",
			status: "accepted",
		});
		const markerB = aiReviewMarker({
			id: "shared-marker-id",
			resultImageId: "result-project-b.webp",
			status: "accepted",
		});
		const projectA = project({
			projectId: projectAId,
			aiReviewMarkers: [markerA],
			pages: [page({ imageLayers: [] })],
		});
		const projectB = project({
			projectId: projectBId,
			aiReviewMarkers: [markerB],
			pages: [page({
				imageId: "project-b-page.webp",
				imageLayers: [imageLayer({
					id: "ai-result-shared-marker-id",
					imageId: "result-project-b.webp",
				})],
			})],
		});
		const liveImageLayers: ImageLayer[] = [];
		const editor = {
			imageWidth: 1000,
			imageHeight: 1600,
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => liveImageLayers),
			addImageLayerWithHistory: vi.fn(async (layer: ImageLayer) => {
				liveImageLayers.push(layer);
				return layer;
			}),
			selectImageLayer: vi.fn(),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(projectA);
		let remoteProjectA = structuredClone(projectA);
		vi.mocked(api.saveProject).mockImplementation(async (projectId: string, payload: ProjectState) => {
			if (projectId === projectAId) {
				remoteProjectA = JSON.parse(JSON.stringify(payload));
			}
		});
		vi.mocked(api.updateAiReviewMarker).mockRejectedValue(new Error("marker service down"));
		vi.mocked(api.loadProject).mockImplementation(async (projectId: string) => (
			projectId === projectAId ? remoteProjectA : projectB
		));

		await projectStore.placeAiReviewMarkerResultAsImageLayer("shared-marker-id", editor);
		await projectStore.saveState();

		expect(api.updateAiReviewMarker).toHaveBeenCalledWith(projectAId, "shared-marker-id", { status: "applied" });
		expect(projectStore.aiReviewMarkers[0].status).toBe("accepted");

		vi.mocked(api.updateAiReviewMarker).mockClear();
		vi.mocked(api.getAiReviewMarkers).mockResolvedValue({ markers: [markerB] });
		await projectStore.openProject(projectBId, undefined);
		expect(projectStore.project?.projectId).toBe(projectBId);
		vi.mocked(api.loadProject).mockImplementation(async (projectId: string) => (
			projectId === projectAId ? remoteProjectA : JSON.parse(JSON.stringify(projectStore.project))
		));

		await projectStore.saveState();

		expect(api.updateAiReviewMarker).not.toHaveBeenCalledWith(projectBId, "shared-marker-id", { status: "applied" });
		expect(projectStore.project?.aiReviewMarkers?.[0]?.status).toBe("accepted");
	});

	it("ignores stale backend AI marker responses after the active project changes", async () => {
		const projectAId = "123e4567-e89b-12d3-a456-426614174451";
		const projectBId = "123e4567-e89b-12d3-a456-426614174452";
		const markerA = aiReviewMarker({ id: "marker-a", status: "accepted" });
		const markerB = aiReviewMarker({ id: "marker-b", status: "accepted" });
		let resolveUpdate!: (value: any) => void;
		const updatePromise = new Promise<any>((resolve) => {
			resolveUpdate = resolve;
		});
		projectStore.__setProjectForTesting(project({
			projectId: projectAId,
			aiReviewMarkers: [markerA],
		}));
		vi.mocked(api.updateAiReviewMarker).mockReturnValue(updatePromise as any);

		const update = projectStore.updateAiReviewMarker("marker-a", { status: "applied" });
		projectStore.__setProjectForTesting(project({
			projectId: projectBId,
			aiReviewMarkers: [markerB],
		}));
		resolveUpdate({
			marker: { ...markerA, status: "applied" },
			markers: [{ ...markerA, status: "applied" }],
			activityLog: [{ id: "activity-a", type: "ai_marker_updated", message: "stale", actor: "system", createdAt: "2026-05-14T00:00:00.000Z" }],
		});

		await expect(update).resolves.toBeNull();

		expect(projectStore.project?.projectId).toBe(projectBId);
		expect(projectStore.project?.aiReviewMarkers?.[0]).toEqual(markerB);
		expect(projectStore.aiReviewMarkers[0]).toEqual(markerB);
	});

	it("keeps page navigation on the current page and explains save conflicts", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => [{ id: "local-layer", text: "local" }]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		projectStore.project!.pages[0].textLayers = [{ id: "local-layer", text: "local" } as any];
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject).mockResolvedValue(project({ name: "Remote edit" }));

		await projectStore.goToPage(1, editor);

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.project?.currentPage).toBe(0);
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("หน้า 2 ยังไม่เปิด: โหลดใหม่ก่อนเปลี่ยนหน้า");
	});

	it("keeps page navigation on the current page and explains generic save failures", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		const remoteBase = structuredClone(base);
		const editor = {
			getAllTextLayers: vi.fn(() => [{ id: "local-layer", text: "local" }]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		projectStore.project!.pages[0].textLayers = [{ id: "local-layer", text: "local" } as any];
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject).mockResolvedValue(remoteBase);
		vi.mocked(api.saveProject).mockRejectedValue(new Error("disk is full"));

		await projectStore.goToPage(1, editor);

		expect(projectStore.project?.currentPage).toBe(0);
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(projectStore.statusMsg).toBe("หน้า 2 ยังไม่เปิด: บันทึกไม่สำเร็จ (disk is full) กดลองบันทึกอีกครั้งก่อน");
	});

	it("keeps page navigation on the current page with brush-specific recovery when old brush commit is failed", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		const editor = {
			hasBrushCommitError: vi.fn(() => true),
			hasPendingBrushCommit: vi.fn(() => false),
			waitForPendingBrushCommit: vi.fn(async () => {
				throw new Error("quota");
			}),
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		await projectStore.goToPage(1, editor);

		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.project?.currentPage).toBe(0);
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("หน้า 2 ยังไม่เปิด: รอยแปรงยังไม่ถูกบันทึก (quota) แก้รอยแปรงก่อนเปลี่ยนหน้า");
	});

	it("keeps page navigation on the current page after backend atomic save conflicts", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174522";
		const base = project({
			projectId,
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => [{ id: "local-layer", text: "local" }]),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		projectStore.project!.pages[0].textLayers = [{ id: "local-layer", text: "local" } as any];
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new api.ApiError("Project changed remotely", {
			status: 409,
			statusText: "Conflict",
			body: { code: "project_save_conflict", error: "Project changed remotely" },
		}));

		await projectStore.goToPage(1, editor);

		expect(api.saveProject).toHaveBeenCalledWith(projectId, expect.objectContaining({
			pages: [
				expect.objectContaining({
					textLayers: [expect.objectContaining({ id: "local-layer", text: "local" })],
				}),
				expect.any(Object),
			],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(projectStore.project?.currentPage).toBe(0);
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("หน้า 2 ยังไม่เปิด: โหลดใหม่ก่อนเปลี่ยนหน้า");
	});

	it("waits for pending AI-mask background brush commits before page switching", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		});
		const calls: string[] = [];
		let resolveCommit!: () => void;
		const pendingCommit = new Promise<void>((resolve) => {
			resolveCommit = resolve;
		});
		// Mirror the real editor: once the commit resolves nothing is pending, so the
		// performLoadPage drain is a no-op (no second wait). cancelImageToolDeferredReplay
		// is the unconditional P1 wrong-page step that runs before currentPage advances.
		let commitPending = true;
		const editor = {
			hasPendingBrushCommit: vi.fn(() => commitPending),
			cancelImageToolDeferredReplay: vi.fn(),
			waitForPendingBrushCommit: vi.fn(async () => {
				calls.push("wait-start");
				await pendingCommit;
				commitPending = false;
				projectStore.project!.pages[0].edits = { imageId: "persisted-ai-mask.png" };
				calls.push("wait-end");
			}),
			getAllTextLayers: vi.fn(() => {
				calls.push("sync-text");
				return [];
			}),
			getAllImageLayers: vi.fn(() => {
				calls.push("sync-image");
				return [];
			}),
			loadImage: vi.fn(async () => {
				calls.push("load-next");
			}),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);
		projectStore.markCurrentPageUnsaved();
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockImplementation(async (_projectId, payload) => {
			expect(payload.pages[0].edits?.imageId).toBe("persisted-ai-mask.png");
			calls.push("save");
		});

		const switchPromise = projectStore.goToPage(1, editor);
		await Promise.resolve();

		expect(calls).toEqual(["wait-start"]);
		expect(projectStore.project?.currentPage).toBe(0);
		expect(editor.loadImage).not.toHaveBeenCalled();

		resolveCommit();
		await switchPromise;

		expect(calls).toEqual(["wait-start", "wait-end", "sync-text", "sync-image", "save", "load-next"]);
		expect(projectStore.project?.currentPage).toBe(1);
		// P1 wrong-page corruption — navigation MUST cancel any image-tool deferred
		// replay before loading the new page, so a stroke buffered during a settling
		// commit can never replay onto page 2.
		expect(editor.cancelImageToolDeferredReplay).toHaveBeenCalled();
		expect(api.saveProject).toHaveBeenCalledWith("project-1", expect.objectContaining({
			pages: [
				expect.objectContaining({ edits: { imageId: "persisted-ai-mask.png" } }),
				expect.any(Object),
			],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-1/images/image-2.webp");
	});

	it("surfaces the save failure reason instead of a generic failed label", async () => {
		const base = project();
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(project());
		vi.mocked(api.saveProject).mockRejectedValue(new Error("disk is full"));

		await projectStore.saveCurrentPage();

		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(projectStore.statusMsg).toBe("บันทึกไม่สำเร็จ: disk is full");
		expect(projectStore.saveErrorMessage).toBe("disk is full");
	});

	it("stops new multi-image imports when upload ids do not match selected files", async () => {
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		vi.mocked(api.createProject).mockResolvedValue({ projectId: "project-1" });
		vi.mocked(api.uploadImages).mockResolvedValue({ imageIds: ["image-1.webp"], assets: [] });

		await projectStore.loadFiles([
			new File(["one"], "image-01.webp", { type: "image/webp" }),
			new File(["two"], "image-02.webp", { type: "image/webp" }),
		], editor);

		expect(projectStore.project).toBeNull();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("โหลดไฟล์ไม่สำเร็จ: อัปโหลดรูปได้ 1/2 หน้า");
	});

	it("shows friendly oversize guidance (not a raw 413) when create-new upload exceeds the batch cap", async () => {
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		vi.mocked(api.createProject).mockResolvedValue({ projectId: "project-1" });
		vi.mocked(api.uploadImages).mockRejectedValue(new api.ApiError("Upload batch size limit exceeded", {
			status: 413,
			statusText: "Payload Too Large",
			code: "upload_batch_size_exceeded",
		}));

		await projectStore.loadFiles([
			new File(["one"], "image-01.webp", { type: "image/webp" }),
		], editor);

		expect(projectStore.statusMsg).toContain("ไฟล์รวมกันใหญ่เกินไป");
		expect(projectStore.statusMsg).not.toContain("Upload batch size limit exceeded");
	});

	it("shows the storage-full message (not oversize guidance) for a coded storage_quota_exceeded 413 on create", async () => {
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		vi.mocked(api.createProject).mockResolvedValue({ projectId: "project-1" });
		// storage_quota_exceeded is ALSO a 413 but coded — its ApiError.message is the
		// formatted storage-full guidance and must NOT be shadowed by the oversize text.
		vi.mocked(api.uploadImages).mockRejectedValue(new api.ApiError(
			"Storage ของเวิร์กสเปซเต็ม. ลบไฟล์หรือเพิ่ม storage ก่อนอัปโหลดต่อ.",
			{ status: 413, statusText: "Payload Too Large", code: "storage_quota_exceeded" },
		));

		await projectStore.loadFiles([
			new File(["one"], "image-01.webp", { type: "image/webp" }),
		], editor);

		expect(projectStore.statusMsg).toContain("Storage ของเวิร์กสเปซเต็ม");
		expect(projectStore.statusMsg).not.toContain("ไฟล์รวมกันใหญ่เกินไป");
	});

	it("shows friendly oversize guidance (not a raw 413) when fill-existing upload exceeds the cap", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174491";
		const base = project({ projectId, name: "Empty paid chapter", pages: [] });
		const editor = {
			loadImage: vi.fn().mockResolvedValue(undefined),
			clearLayers: vi.fn(),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.uploadImages).mockRejectedValue(new api.ApiError("File big.png exceeds 50MB limit", {
			status: 413,
			statusText: "Payload Too Large",
		}));

		await projectStore.fillEmptyProjectWithPages([
			new File(["one"], "big.png", { type: "image/png" }),
		], editor, { targetLang: "th" });

		expect(projectStore.statusMsg).toContain("ไฟล์รวมกันใหญ่เกินไป");
		expect(projectStore.statusMsg).not.toContain("exceeds 50MB limit");
	});

	it("fills the current zero-page backend project instead of creating a new project", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174490";
		const base = project({
			projectId,
			name: "Empty paid chapter",
			pages: [],
			workspaceMessages: [workspaceMessage({ id: "keep-message" })],
		});
		const uploadedAsset = {
			assetId: "new-page-1.webp",
			imageId: "new-page-1.webp",
			originalName: "page-01.webp",
			mimeType: "image/webp",
			sizeBytes: 1024,
			sha256: "zero-page-fill-hash",
			storageDriver: "local",
			storageKey: "objects/new-page-1.webp",
			width: 800,
			height: 1200,
			storageStatus: "released",
			moderationStatus: "passed",
			derivativeCount: 0,
			createdAt: "2026-05-20T06:00:00.000Z",
			updatedAt: "2026-05-20T06:00:00.000Z",
		} as const;
		const editor = {
			loadImage: vi.fn().mockResolvedValue(undefined),
			clearLayers: vi.fn(),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-page-1.webp"],
			assets: [uploadedAsset],
		});
		vi.mocked(api.saveProject).mockResolvedValue(undefined);

		await projectStore.fillEmptyProjectWithPages([
			new File(["one"], "page-01.webp", { type: "image/webp" }),
		], editor, { targetLang: "th" });

		expect(api.createProject).not.toHaveBeenCalled();
		// The batched upload passes a per-batch byte-progress callback as a 3rd arg
		// and (f31) tags real page uploads with assetKind for page_set_changed.
		expect(api.uploadImages).toHaveBeenCalledWith(
			projectId,
			[expect.objectContaining({ name: "page-01.webp" })],
			expect.any(Function),
			{ assetKind: "page-image" },
		);
		expect(api.saveProject).toHaveBeenCalledWith(projectId, expect.objectContaining({
			projectId,
			name: "Empty paid chapter",
			pages: [expect.objectContaining({
				imageId: "new-page-1.webp",
				originalName: "page-01.webp",
			})],
		}), expect.objectContaining({ baseFingerprint: expect.any(String) }));
		expect(projectStore.project?.projectId).toBe(projectId);
		expect(projectStore.project?.pages).toHaveLength(1);
		expect(editor.loadImage).toHaveBeenCalledWith(`/api/project/${projectId}/images/new-page-1.webp`);
		expect(projectStore.statusMsg).toBe("เพิ่มรูปเข้าโปรเจกต์นี้ 1 หน้าแล้ว");
	});

	it("lets a freshly-created chapter save its first edit without a false conflict", async () => {
		// Repro for the #270-lineage residual: the create flow builds `this.project`
		// locally (no storyId/workspaceId/targetLangs — the server mints/normalizes
		// those), then `saveState()` anchors the baseline fingerprint to that LOCAL
		// guess. The server's authoritative `GET /:id` (used by the conflict guard's
		// refetch) carries the normalized identity fields, so the first edit's
		// `assertNoStaleRemoteOverwrite()` saw remote !== baseline (and !== local) and
		// threw a false ProjectSaveConflictError, dropping the first save until reload.
		const projectId = "123e4567-e89b-12d3-a456-426614174777";
		// What the SERVER persists + returns after create + workflow normalization:
		// storyId minted, workspaceId stamped, targetLang normalized into targetLangs.
		// The page shape mirrors what `loadFilesWithSetup` saves (and the server
		// persists), so the only real divergence is the server-owned identity fields.
		const serverAuthoritative = project({
			projectId,
			name: "ตอนใหม่",
			storyId: "u0tnrt4wx3",
			workspaceId: "ws-authoritative-1",
			targetLang: "th",
			targetLangs: ["th"],
			sourceLang: "ja",
			pages: [page({ imageId: "new-page-1.webp", imageName: "new-page-1.webp", originalName: "page-01.webp", imageLayers: [], pendingAiJobs: [], coverRect: null })],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			clearLayers: vi.fn(),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(api.createProject).mockResolvedValue({ projectId });
		vi.mocked(api.uploadImages).mockResolvedValue({ imageIds: ["new-page-1.webp"], assets: [] });
		// Every refetch (the post-create baseline resync AND the first-edit conflict
		// guard) returns the server-authoritative state with the normalized fields.
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(serverAuthoritative));

		await projectStore.loadFiles([
			new File(["one"], "page-01.webp", { type: "image/webp" }),
		], editor);

		// After create the baseline has adopted the server-owned identity fields.
		expect(projectStore.project?.projectId).toBe(projectId);
		expect(projectStore.project?.storyId).toBe("u0tnrt4wx3");
		expect(projectStore.project?.workspaceId).toBe("ws-authoritative-1");
		expect(projectStore.project?.targetLangs).toEqual(["th"]);

		// First real edit on the brand-new chapter, then the autosave path.
		vi.mocked(api.saveProject).mockClear();
		projectStore.markCurrentPageUnsaved();

		await expect(projectStore.saveState()).resolves.toBeUndefined();
		expect(api.saveProject).toHaveBeenCalledTimes(1);
		expect(projectStore.saveSyncStatus).toBe("saved");
		// No false conflict: the save reached the backend instead of being blocked.
		expect(projectStore.saveErrorKind).toBeNull();
	});

	it("still catches a genuine concurrent remote change after a fresh create resync", async () => {
		// Regression guard: the resync must not blanket-disable conflict detection.
		// A real remote edit (different content) between baseline and save must still
		// throw, preserving the #270 data-loss protection.
		const projectId = "123e4567-e89b-12d3-a456-426614174778";
		const serverAuthoritative = project({
			projectId,
			name: "ตอนใหม่",
			storyId: "story-real-conflict",
			workspaceId: "ws-real-conflict",
			targetLang: "th",
			targetLangs: ["th"],
			pages: [page({ imageId: "new-page-1.webp", imageName: "new-page-1.webp", originalName: "page-01.webp" })],
		});
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			clearLayers: vi.fn(),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(api.createProject).mockResolvedValue({ projectId });
		vi.mocked(api.uploadImages).mockResolvedValue({ imageIds: ["new-page-1.webp"], assets: [] });
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(serverAuthoritative));

		await projectStore.loadFiles([
			new File(["one"], "page-01.webp", { type: "image/webp" }),
		], editor);

		// Now a DIFFERENT client mutates real content remotely (a renamed chapter).
		vi.mocked(api.loadProject).mockResolvedValue(project({
			...structuredClone(serverAuthoritative),
			name: "Renamed by another editor",
		}));
		vi.mocked(api.saveProject).mockClear();
		projectStore.markCurrentPageUnsaved();

		await expect(projectStore.saveState()).rejects.toThrow();
		expect(api.saveProject).not.toHaveBeenCalled();
		expect(projectStore.saveErrorKind).toBe("conflict");
	});

	it("restores a zero-page project if filling it cannot be saved", async () => {
		const projectId = "123e4567-e89b-12d3-a456-426614174491";
		const base = project({
			projectId,
			name: "Empty project to protect",
			pages: [],
			workspaceMessages: [workspaceMessage({ id: "safe-message" })],
		});
		const oldAsset = {
			assetId: "cover-old.webp",
			imageId: "cover-old.webp",
			originalName: "cover-old.webp",
			mimeType: "image/webp",
			sizeBytes: 512,
			sha256: "old-empty-hash",
			storageDriver: "local",
			storageKey: "objects/cover-old.webp",
			width: 600,
			height: 800,
			storageStatus: "released",
			moderationStatus: "passed",
			derivativeCount: 0,
			createdAt: "2026-05-20T06:05:00.000Z",
			updatedAt: "2026-05-20T06:05:00.000Z",
		} as const;
		const newAsset = {
			...oldAsset,
			assetId: "new-page-failed.webp",
			imageId: "new-page-failed.webp",
			originalName: "page-failed.webp",
			sha256: "new-empty-hash",
			storageKey: "objects/new-page-failed.webp",
		};
		const editor = {
			loadImage: vi.fn().mockResolvedValue(undefined),
			clearLayers: vi.fn(),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};
		projectStore.__setProjectForTesting(base);
		projectStore.imageAssets = [oldAsset];
		projectStore.imageAssetsProjectId = projectId;
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-page-failed.webp"],
			assets: [newAsset],
		});
		vi.mocked(api.saveProject).mockRejectedValue(new Error("network down"));

		await projectStore.fillEmptyProjectWithPages([
			new File(["one"], "page-failed.webp", { type: "image/webp" }),
		], editor);

		expect(api.createProject).not.toHaveBeenCalled();
		expect(projectStore.project?.projectId).toBe(projectId);
		expect(projectStore.project?.pages).toEqual([]);
		expect(projectStore.project?.workspaceMessages).toEqual([expect.objectContaining({ id: "safe-message" })]);
		expect(projectStore.imageAssets).toEqual([oldAsset]);
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("เพิ่มรูปเข้าโปรเจกต์นี้ไม่สำเร็จ: network down");
	});

	it("restores existing text layers when layer-document import save fails", async () => {
		const originalLayer = textLayer({ id: "original-layer", text: "original text" });
		const base = project({
			projectId: "123e4567-e89b-12d3-a456-426614174473",
			pages: [page({ imageId: "page-01.webp", imageName: "page-01.webp", textLayers: [originalLayer] })],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new Error("network down"));

		await expect(projectStore.importLayerDocument({
			imageName: "page-01.webp",
			textLayers: [{
				id: "imported-layer",
				text: "imported text",
				x: 12,
				y: 24,
				w: 180,
				h: 50,
			}],
		})).rejects.toThrow("network down");

		expect(projectStore.project?.currentPage).toBe(0);
		expect(projectStore.project?.pages[0].textLayers).toEqual([originalLayer]);
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(projectStore.statusMsg).toBe("ยกเลิกImport: บันทึกงานไม่สำเร็จ (network down)");
	});

	it("restores existing text layers when layer-document import hits backend atomic conflict", async () => {
		const originalLayer = textLayer({ id: "original-layer", text: "original text" });
		const base = project({
			projectId: "123e4567-e89b-12d3-a456-426614174523",
			pages: [page({ imageId: "page-01.webp", imageName: "page-01.webp", textLayers: [originalLayer] })],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(base));
		vi.mocked(api.saveProject).mockRejectedValue(new api.ApiError("Project changed remotely", {
			status: 409,
			statusText: "Conflict",
			body: { code: "project_save_conflict", error: "Project changed remotely" },
		}));

		await expect(projectStore.importLayerDocument({
			imageName: "page-01.webp",
			textLayers: [{
				id: "imported-layer",
				text: "imported text",
				x: 12,
				y: 24,
				w: 180,
				h: 50,
			}],
		})).rejects.toThrow("Project changed remotely");

		expect(projectStore.project?.currentPage).toBe(0);
		expect(projectStore.project?.pages[0].textLayers).toEqual([originalLayer]);
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("conflict");
		expect(projectStore.statusMsg).toBe("ยกเลิกImport: ต้องโหลดงานใหม่ก่อนImport JSON");
	});

	it("keeps the new project visible with retry-save guidance when first save fails after upload", async () => {
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		const uploadedAsset = {
			assetId: "new-page-1.webp",
			imageId: "new-page-1.webp",
			originalName: "page-01.webp",
			mimeType: "image/webp",
			sizeBytes: 1024,
			sha256: "new-project-hash",
			storageDriver: "local",
			storageKey: "objects/new-page-1.webp",
			width: 800,
			height: 1200,
			storageStatus: "released",
			moderationStatus: "passed",
			derivativeCount: 0,
			createdAt: "2026-05-20T04:05:00.000Z",
			updatedAt: "2026-05-20T04:05:00.000Z",
		} as const;
		vi.mocked(api.createProject).mockResolvedValue({ projectId: "project-new-save-fail" });
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-page-1.webp"],
			assets: [uploadedAsset],
		});
		vi.mocked(api.saveProject).mockRejectedValue(new Error("network down"));

		await projectStore.loadFiles([
			new File(["one"], "page-01.webp", { type: "image/webp" }),
		], editor);

		expect(projectStore.project?.projectId).toBe("project-new-save-fail");
		expect(projectStore.project?.pages).toHaveLength(1);
		expect(projectStore.imageAssetsProjectId).toBe("project-new-save-fail");
		expect(projectStore.imageAssets[0]).toEqual(uploadedAsset);
		expect(projectStore.saveSyncStatus).toBe("error");
		expect(projectStore.saveErrorKind).toBe("generic");
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("สร้างงานแล้วแต่บันทึก/โหลดต่อไม่สำเร็จ: network down กดลองบันทึกอีกครั้งก่อนปิดงาน");
	});

	it("restores the old project when creating a new project fails after switching state", async () => {
		const oldProject = project({
			projectId: "123e4567-e89b-12d3-a456-426614174470",
			name: "Old project",
			pages: [page({ imageId: "old-page.webp", imageName: "old-page.webp" })],
		});
		const oldAsset = {
			assetId: "old-page.webp",
			imageId: "old-page.webp",
			originalName: "old-page.webp",
			mimeType: "image/webp",
			sizeBytes: 2048,
			sha256: "old-project-hash",
			storageDriver: "local",
			storageKey: "objects/old-page.webp",
			width: 800,
			height: 1200,
			storageStatus: "released",
			moderationStatus: "passed",
			derivativeCount: 0,
			createdAt: "2026-05-20T04:10:00.000Z",
			updatedAt: "2026-05-20T04:10:00.000Z",
		} as const;
		const newAsset = {
			...oldAsset,
			assetId: "new-page.webp",
			imageId: "new-page.webp",
			originalName: "new-page.webp",
			sha256: "new-project-hash",
			storageKey: "objects/new-page.webp",
		};
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(oldProject);
		projectStore.imageAssets = [oldAsset];
		projectStore.imageAssetsProjectId = oldProject.projectId;
		vi.mocked(api.loadProject).mockResolvedValue(structuredClone(oldProject));
		vi.mocked(api.createProject).mockResolvedValue({ projectId: "project-new-save-fail" });
		vi.mocked(api.uploadImages).mockResolvedValue({
			imageIds: ["new-page.webp"],
			assets: [newAsset],
		});
		vi.mocked(api.saveProject).mockRejectedValue(new Error("network down"));

		await projectStore.loadFiles([
			new File(["new"], "new-page.webp", { type: "image/webp" }),
		], editor);

		expect(projectStore.project?.projectId).toBe(oldProject.projectId);
		expect(projectStore.project?.name).toBe("Old project");
		expect(projectStore.imageAssetsProjectId).toBe(oldProject.projectId);
		expect(projectStore.imageAssets).toEqual([oldAsset]);
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("สร้างงานใหม่ไม่สำเร็จ: network down ยังอยู่ในงานเดิม");
	});

	it("renames the current project and refreshes searchable recent project metadata", async () => {
		const base = project({ name: "Old title" });
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(project({ name: "Old title" }));
		vi.mocked(api.saveProject).mockResolvedValue(undefined);
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [{
				projectId: "project-1",
				name: "New Manga Title",
				createdAt: "2026-05-14T00:00:00.000Z",
				updatedAt: "2026-05-14T00:01:00.000Z",
				targetLang: "th",
				pageCount: 1,
				textLayerCount: 0,
			}],
		});

		const renamed = await projectStore.renameCurrentProject("  New Manga Title  ");

		expect(renamed).toBe(true);
		expect(projectStore.project?.name).toBe("New Manga Title");
		expect(api.saveProject).toHaveBeenCalledWith(
			"project-1",
			projectStore.project,
			expect.objectContaining({ baseFingerprint: expect.any(String) }),
		);
		expect(api.listProjects).toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("เปลี่ยนชื่องานเป็น New Manga Title แล้ว");
	});

	it("turns recent project network failures into backend health guidance", async () => {
		vi.mocked(api.listProjects).mockRejectedValue(new TypeError("Failed to fetch"));

		await projectStore.loadRecentProjects();

		expect(projectStore.recentProjectsError).toContain("/api/health");
		expect(projectStore.recentProjectsError).toContain("ระบบยังไม่พร้อม");
		expect(projectStore.recentProjectsError).not.toContain("Refresh");
		expect(projectStore.statusMsg).toBe("โหลดตอนล่าสุดไม่สำเร็จ");
	});

	it("turns recent project API failures into readiness guidance", async () => {
		vi.mocked(api.listProjects).mockRejectedValue(new api.ApiError("Service unavailable", {
			status: 503,
			statusText: "Service Unavailable",
		}));

		await projectStore.loadRecentProjects();

		expect(projectStore.recentProjectsError).toContain("(503)");
		expect(projectStore.recentProjectsError).toContain("/api/readyz");
		expect(projectStore.recentProjectsError).not.toContain("Recent projects");
		expect(projectStore.statusMsg).toBe("โหลดตอนล่าสุดไม่สำเร็จ");
	});

	it("keeps background recent-project refresh failures silent for local-first library startup", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		projectStore.statusMsg = "คลังงานพร้อมเลือกตอน 100%";
		vi.mocked(api.listProjects).mockRejectedValue(new TypeError("Failed to fetch"));

		await projectStore.loadRecentProjects({ background: true, silentFailure: true });

		expect(consoleError).not.toHaveBeenCalled();
		expect(projectStore.recentProjectsError).toBeNull();
		expect(projectStore.statusMsg).toBe("คลังงานพร้อมเลือกตอน 100%");
		expect(projectStore.recentProjectsLoading).toBe(false);
	});

	it("keeps the current local project in recent projects when backend returns only persisted chapters", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			name: "Moonlit Courier Chapter 104",
			coverImageId: "flow208-page-01",
			coverOriginalName: "moonlit-courier-ch104-p001.png",
			pages: [
				page({ textLayers: [textLayer({ id: "layer-1" })] }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
			tasks: [workflowTask({ id: "task-1", status: "review" })],
			comments: [comment({ id: "comment-1", status: "open" })],
		}));
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [{
				projectId: "persisted-project",
				name: "Flow169 UX Audit Chapter",
				createdAt: "2026-05-14T00:00:00.000Z",
				updatedAt: "2026-05-14T00:10:00.000Z",
				targetLang: "th",
				pageCount: 3,
				textLayerCount: 3,
			}],
		});

		await projectStore.loadRecentProjects();

		expect(projectStore.recentProjects[0]).toMatchObject({
			projectId: "flow208-project",
			name: "Moonlit Courier Chapter 104",
			targetLang: "th",
			pageCount: 2,
			textLayerCount: 1,
			openTaskCount: 1,
			reviewTaskCount: 1,
			openCommentCount: 1,
		});
		expect(projectStore.recentProjects[1]?.projectId).toBe("persisted-project");
	});

	it("ignores a second page switch while the first page is still loading", async () => {
		const base = project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp" }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
				page({ imageId: "image-3.webp", imageName: "image-3.webp" }),
			],
		});
		let finishLoad!: () => void;
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn(() => new Promise<void>((resolve) => {
				finishLoad = resolve;
			})),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		projectStore.__setProjectForTesting(base);

		const firstSwitch = projectStore.goToPage(1, editor);
		const secondSwitch = await projectStore.goToPage(2, editor);

		expect(secondSwitch).toBe(false);
		expect(editor.loadImage).toHaveBeenCalledTimes(1);
		expect(projectStore.statusMsg).toBe("รอโหลดหน้าปัจจุบันให้เสร็จก่อน");
		expect(projectStore.canGoNext).toBe(false);

		finishLoad();
		await expect(firstSwitch).resolves.toBe(true);
		expect(projectStore.project?.currentPage).toBe(1);
	});
});

describe("ProjectStore layer id repair", () => {
	it("renames duplicate current-page layer ids, saves, and reloads the editor", async () => {
		const textLayers: TextLayer[] = [
			{
				id: "shared-text",
				text: "First",
				x: 0,
				y: 0,
				w: 100,
				h: 40,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			},
			{
				id: "shared-text",
				text: "Second",
				x: 0,
				y: 60,
				w: 100,
				h: 40,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 1,
			},
		];
		const imageLayers: ImageLayer[] = [
			{
				id: "shared-image",
				imageId: "asset-1",
				imageName: "asset-1.webp",
				x: 0,
				y: 0,
				w: 100,
				h: 100,
				rotation: 0,
				opacity: 1,
				index: 0,
			},
			{
				id: "shared-image",
				imageId: "asset-2",
				imageName: "asset-2.webp",
				x: 20,
				y: 20,
				w: 100,
				h: 100,
				rotation: 0,
				opacity: 1,
				index: 1,
			},
		];
		const base = project({
			pages: [page({ textLayers, imageLayers })],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(base);
		const editor = {
			getAllTextLayers: vi.fn(() => textLayers),
			getAllImageLayers: vi.fn(() => imageLayers),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};

		const result = await projectStore.repairDuplicateLayerIds(0, editor);
		const repairedPage = projectStore.project!.pages[0];

		expect(result).toMatchObject({ pageIndex: 0, textLayerIds: 1, imageLayerIds: 1, total: 2 });
		expect(repairedPage.textLayers[0].id).toBe("shared-text");
		expect(repairedPage.textLayers[1].id).not.toBe("shared-text");
		expect(new Set(repairedPage.textLayers.map((layer) => layer.id)).size).toBe(2);
		expect(repairedPage.imageLayers?.[0].id).toBe("shared-image");
		expect(repairedPage.imageLayers?.[1].id).not.toBe("shared-image");
		expect(new Set(repairedPage.imageLayers?.map((layer) => layer.id)).size).toBe(2);
		expect(api.saveProject).toHaveBeenCalledWith(
			"project-1",
			projectStore.project,
			expect.objectContaining({ baseFingerprint: expect.any(String) }),
		);
		expect(editor.loadImage).toHaveBeenCalledWith("/api/project/project-1/images/image-1.webp");
		expect(projectStore.statusMsg).toBe("ซ่อม Layer ID ซ้ำ 2 จุด หน้า 1 แล้ว");
	});

	it("syncs current editor layers before repairing duplicate ids on another page", async () => {
		const liveCurrentLayers: TextLayer[] = [
			{
				id: "live-current-text",
				text: "Unsaved current page edit",
				x: 12,
				y: 34,
				w: 150,
				h: 50,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			},
		];
		const targetLayers: TextLayer[] = [
			{
				id: "shared-target",
				text: "Target first",
				x: 0,
				y: 0,
				w: 100,
				h: 40,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			},
			{
				id: "shared-target",
				text: "Target second",
				x: 0,
				y: 60,
				w: 100,
				h: 40,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 1,
			},
		];
		const base = project({
			currentPage: 0,
			pages: [
				page({ textLayers: [] }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp", textLayers: targetLayers }),
			],
		});
		projectStore.__setProjectForTesting(base);
		vi.mocked(api.loadProject).mockResolvedValue(base);
		const editor = {
			getAllTextLayers: vi.fn(() => liveCurrentLayers),
			getAllImageLayers: vi.fn(() => []),
			loadImage: vi.fn().mockResolvedValue(undefined),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn().mockResolvedValue(undefined),
		};

		const result = await projectStore.repairDuplicateLayerIds(1, editor);
		const savedProject = vi.mocked(api.saveProject).mock.calls.at(-1)?.[1] as ProjectState;

		expect(result).toMatchObject({ pageIndex: 1, textLayerIds: 1, imageLayerIds: 0, total: 1 });
		expect(savedProject.pages[0].textLayers).toEqual(liveCurrentLayers);
		expect(savedProject.pages[1].textLayers[0].id).toBe("shared-target");
		expect(savedProject.pages[1].textLayers[1].id).not.toBe("shared-target");
		expect(editor.loadImage).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("ซ่อม Layer ID ซ้ำ 1 จุด หน้า 2 แล้ว");
	});
});
