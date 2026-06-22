import { editorStore } from "$lib/stores/editor.svelte.ts";
import { normalizeExportRuns } from "$lib/project/export-runs.js";
import { formatAiJobProviderFailure } from "$lib/project/ai-job-copy.js";
import { summarizePageBatch, summarizePageWork } from "$lib/project/page-work-summary.js";
import { aiJobsStore, type BatchJob } from "$lib/stores/ai-jobs.svelte.ts";
import { editorUiStore, type WorkspaceEditorEntryContext, type WorkspaceView } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type {
	AiReviewMarker,
	AiReviewMarkerStatus,
	CreditApplyScope,
	ImageLayer,
	Page,
	ProjectComment,
	ProjectState,
	PageReviewDecision,
	TextLayer,
	WorkflowTask,
} from "$lib/types.js";
import type { ProjectImageAssetSummary, ProjectSummary, ProjectVersion, ProjectVersionDetail } from "$lib/api/client.js";

type SeedOptions = {
	missingSecondPage?: boolean;
	projectId?: string;
};

const WORKSPACE_DEBUG_PROJECT_ID = "flow208-project";
const WORKSPACE_DEBUG_TITLE_KEY = "flow208-prototype-journey";
const DEMO_PROJECT_NAME = "Moonlit Courier ตอน 104";
const DEMO_PAGE_ONE_NAME = "moonlit-courier-ch104-p001.png";
const DEMO_PAGE_TWO_NAME = "moonlit-courier-ch104-p002.png";
const DEMO_AI_RESULT_NAME = "moonlit-courier-ch104-clean-p001.png";
const DEMO_EXPORT_NAME = "moonlit-courier-ch104-review.zip";
const DEMO_PAGE_LABELS = ["Moonlit Courier หน้า 1", "Moonlit Courier หน้า 2"];
const DEMO_AI_RESULT_LABEL = "Clean pass P01";

type WorkflowDebugState = {
	projectId: string | null;
	pageIndex: number | null;
	pageCount: number;
	textLayerCounts: number[];
	taskCount: number;
	openCommentCount: number;
	reviewDecisionCount: number;
	aiReviewMarkerCount: number;
	versionCount: number;
	exportRunCount: number;
	exportReadyCount: number;
	attentionCount: number;
	batchExportStatus: string;
	saveSyncStatus: string;
	saveErrorKind: string | null;
	statusMsg: string;
	assetStatus: string | null;
};

type CreditTextTestingOptions = {
	presetId?: string;
	offset?: number;
	scope?: CreditApplyScope;
	repeatEveryPx?: number;
};

type CreditImageTestingOptions = CreditTextTestingOptions & {
	maxWidth?: number;
};

function createDebugImageDataUrl(label: string, fill = "#f8f5ef"): string {
	const canvas = document.createElement("canvas");
	canvas.width = 900;
	canvas.height = 1350;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1350" viewBox="0 0 900 1350"><rect width="900" height="1350" fill="${fill}"/><rect x="72" y="76" width="756" height="1198" rx="18" fill="#f8fafc" stroke="#111827" stroke-width="10"/><rect x="118" y="130" width="664" height="360" fill="#d9dee8" stroke="#111827" stroke-width="6"/><rect x="118" y="532" width="310" height="560" fill="#eef2f7" stroke="#111827" stroke-width="6"/><rect x="472" y="532" width="310" height="560" fill="#dce4ef" stroke="#111827" stroke-width="6"/><text x="126" y="1220" fill="#111827" font-family="Arial" font-size="42">${label}</text></svg>`;
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	}
	const panel = (x: number, y: number, w: number, h: number, bg: string) => {
		ctx.fillStyle = bg;
		ctx.fillRect(x, y, w, h);
		ctx.strokeStyle = "#10131a";
		ctx.lineWidth = 7;
		ctx.strokeRect(x, y, w, h);
	};
	const bubble = (x: number, y: number, w: number, h: number, text: string) => {
		ctx.fillStyle = "rgba(255,255,255,0.94)";
		ctx.strokeStyle = "#111827";
		ctx.lineWidth = 5;
		ctx.beginPath();
		ctx.roundRect(x, y, w, h, 34);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = "#111827";
		ctx.font = "30px Arial";
		ctx.textAlign = "center";
		const words = text.split(" ");
		const lines = words.length > 4
			? [`${words.slice(0, 4).join(" ")}`, words.slice(4).join(" ")]
			: [text];
		if (text.trim()) {
			for (const [index, line] of lines.entries()) {
				ctx.fillText(line, x + w / 2, y + 48 + index * 36);
			}
		}
		ctx.textAlign = "left";
	};
	ctx.fillStyle = "#1f222b";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = fill;
	ctx.fillRect(54, 54, 792, 1242);
	ctx.strokeStyle = "#111827";
	ctx.lineWidth = 10;
	ctx.strokeRect(54, 54, 792, 1242);

	panel(96, 96, 708, 342, "#d8dde8");
	const gradient = ctx.createLinearGradient(96, 96, 804, 438);
	gradient.addColorStop(0, "rgba(255,255,255,0.55)");
	gradient.addColorStop(0.55, "rgba(98,112,142,0.22)");
	gradient.addColorStop(1, "rgba(20,24,34,0.34)");
	ctx.fillStyle = gradient;
	ctx.fillRect(96, 96, 708, 342);
	ctx.strokeStyle = "rgba(17,24,39,0.45)";
	ctx.lineWidth = 3;
	for (let x = 110; x < 790; x += 34) {
		ctx.beginPath();
		ctx.moveTo(x, 98);
		ctx.lineTo(x - 90, 438);
		ctx.stroke();
	}
	bubble(470, 148, 264, 110, "");

	panel(96, 474, 330, 560, "#eef1f5");
	ctx.fillStyle = "#c6cedb";
	ctx.beginPath();
	ctx.arc(262, 680, 110, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = "#909bac";
	ctx.fillRect(190, 780, 150, 190);
	ctx.strokeStyle = "#111827";
	ctx.lineWidth = 6;
	ctx.strokeRect(190, 780, 150, 190);
	bubble(138, 520, 230, 118, "");

	panel(474, 474, 330, 560, label.includes("Clean") ? "#d8e8f6" : "#dfe5ed");
	ctx.save();
	ctx.translate(640, 720);
	ctx.rotate(-0.22);
	ctx.fillStyle = "rgba(255,255,255,0.9)";
	ctx.fillRect(-142, -60, 284, 132);
	ctx.strokeStyle = "#172033";
	ctx.lineWidth = 5;
	ctx.strokeRect(-142, -60, 284, 132);
	ctx.fillStyle = "#111827";
	ctx.font = "30px Arial";
	ctx.fillText("NEW MAIL", -108, -16);
	ctx.font = "24px Arial";
	ctx.fillText("Meet me at gate 7.", -108, 26);
	ctx.restore();
	ctx.strokeStyle = "rgba(17,24,39,0.16)";
	ctx.lineWidth = 4;
	for (let i = 0; i < 18; i += 1) {
		ctx.beginPath();
		ctx.moveTo(636, 754);
		ctx.lineTo(520 + Math.cos(i) * 210, 650 + i * 18);
		ctx.stroke();
	}

	panel(96, 1078, 708, 160, "#f7f8fb");
	ctx.fillStyle = "#111827";
	ctx.font = "36px Arial";
	ctx.fillText(label, 126, 1162);
	ctx.font = "24px Arial";
	ctx.fillStyle = "#4b5563";
	ctx.fillText("หน้าต้นฉบับ", 126, 1204);
	return canvas.toDataURL("image/png");
}

export function canSeedWorkspaceDebugProject(projectId?: string | null): boolean {
	return projectId === WORKSPACE_DEBUG_PROJECT_ID
		&& (import.meta.env.DEV || import.meta.env.MODE === "test" || import.meta.env.VITE_E2E === "1");
}

export function workspaceDebugProjectIdForTitle(titleKey?: string | null): string | null {
	if (titleKey !== WORKSPACE_DEBUG_TITLE_KEY) return null;
	return WORKSPACE_DEBUG_PROJECT_ID;
}

function nowIso(offsetMs = 0): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

function pageLayer(id: string, text: string, x: number, y: number, index = 0, w = 300, h = 96, fontSize = 38): TextLayer {
	return {
		id,
		text,
		x,
		y,
		w,
		h,
		rotation: 0,
		fontSize,
		fontFamily: "Arial",
		fill: "#111111",
		stroke: "#ffffff",
		strokeWidth: 3,
		alignment: "center",
		sourceProvider: "json-import",
		sourceCategory: "dialogue",
		confidence: 0.91,
		visible: true,
		locked: false,
		index,
	};
}

function asset(id: string, originalName: string): ProjectImageAssetSummary {
	return {
		assetId: id,
		imageId: id,
		originalName,
		mimeType: "image/png",
		sizeBytes: 24_000,
		sha256: `${id}-sha`,
		storageDriver: "debug",
		storageKey: `debug/${id}`,
		width: 900,
		height: 1350,
		storageStatus: "released",
		moderationStatus: "passed",
		derivativeCount: 0,
		createdAt: nowIso(-60_000),
		updatedAt: nowIso(-30_000),
	};
}

function keepLastImageLayerById(layers: Page["imageLayers"]): Page["imageLayers"] {
	if (!layers?.length) return layers;
	const order: string[] = [];
	const byId = new Map<string, NonNullable<Page["imageLayers"]>[number]>();
	for (const layer of layers) {
		if (!layer.id) continue;
		if (!byId.has(layer.id)) order.push(layer.id);
		byId.set(layer.id, layer);
	}
	return order.map((id) => byId.get(id)).filter((layer): layer is NonNullable<Page["imageLayers"]>[number] => Boolean(layer));
}

function seedProject(options: SeedOptions = {}): ProjectState {
	const createdAt = nowIso(-120_000);
	const pageTwoImageId = options.missingSecondPage ? "missing-page-02" : "flow208-page-02";
	const task: WorkflowTask = {
		id: "flow208-review-p1",
		type: "review",
		status: "review",
		priority: "urgent",
		pageIndex: 0,
		pageImageId: "flow208-page-01",
		title: "ตรวจทานข้อความImportหน้าแรกสุด",
		assignee: "solo",
		createdAt,
		updatedAt: nowIso(-50_000),
	};
	const comment: ProjectComment = {
		id: "flow208-comment-p1",
		pageIndex: 0,
		layerId: "flow208-imported-p1",
		body: "ปรับบับเบิลข้อความบนมือถือให้แน่นขึ้นก่อน Export สุดท้าย",
		author: "reviewer",
		status: "open",
		createdAt,
		updatedAt: nowIso(-45_000),
	};
	const reviewDecision: PageReviewDecision = {
		id: "flow208-review-decision-p1",
		pageIndex: 0,
		status: "changes_requested",
		body: "ปรับบรรทัดข้อความบนมือถือ แล้วส่งกลับให้ตรวจหน้าอีกครั้ง",
		actor: "lead",
		createdAt,
		updatedAt: nowIso(-40_000),
	};
	const marker: AiReviewMarker = {
		id: "flow208-ai-marker-p1",
		jobId: "flow208-ai-job-p1",
		pageIndex: 0,
		imageId: "flow208-page-01",
		region: { x: 110, y: 310, w: 280, h: 180 },
		status: "needs_review",
		tier: "clean-pro",
		providerHint: "studio-clean-provider",
		resultImageId: "flow208-ai-result-p1",
		assignee: "solo",
		createdAt,
		updatedAt: nowIso(-35_000),
	};
	return {
		projectId: options.projectId ?? WORKSPACE_DEBUG_PROJECT_ID,
		name: DEMO_PROJECT_NAME,
		createdAt,
		coverImageId: "flow208-page-01",
		coverOriginalName: DEMO_PAGE_ONE_NAME,
		currentPage: 0,
		targetLang: "th",
		pages: [
			{
				imageId: "flow208-page-01",
				imageName: DEMO_PAGE_ONE_NAME,
				originalName: DEMO_PAGE_ONE_NAME,
				textLayers: [pageLayer("flow208-imported-p1", "ข้อความมาถึงแล้ว", 140, 532, 0, 230, 118, 30)],
				pendingAiJobs: [],
				coverRect: null,
			},
			{
				imageId: pageTwoImageId,
				imageName: DEMO_PAGE_TWO_NAME,
				originalName: DEMO_PAGE_TWO_NAME,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
		tasks: [task],
		comments: [comment],
		reviewDecisions: [reviewDecision],
		aiReviewMarkers: [marker],
		activityLog: [
			{
				id: "flow208-activity-import",
				type: "import_json",
				message: "Import OCR draft หน้า 1",
				actor: "studio",
				pageIndex: 0,
				createdAt,
			},
			{
				id: "flow208-activity-review",
				type: "review_decision_added",
				message: "ส่งกลับแก้ หน้า 1",
				actor: "lead",
				pageIndex: 0,
				createdAt: nowIso(-40_000),
			},
		],
		workspaceMessages: [],
		versionReviewRequests: [
			{
				id: "flow208-version-review",
				versionId: "flow208-version-1",
				status: "open",
				body: "รีวิวข้อความ Importก่อน Export",
				requester: "lead",
				reviewer: "solo",
				createdAt,
				updatedAt: nowIso(-20_000),
			},
		],
		exportRuns: [
			{
				id: "flow208-export-blocked",
				kind: "batch-zip",
				status: "error",
				filename: DEMO_EXPORT_NAME,
				pageIndexes: [0, 1],
				pageCount: 2,
				message: "Export ถูกบล็อก: ยังมี Review หรือรูปต้องกู้คืน",
				error: "review_not_clear",
				createdAt,
				completedAt: nowIso(-10_000),
			},
		],
	};
}

function debugProjectSummary(project: ProjectState): ProjectSummary {
	const textLayerCount = project.pages.reduce((total, page) => total + page.textLayers.length, 0);
	const openTasks = project.tasks.filter((task) => task.status !== "done").length;
	const reviewTasks = project.tasks.filter((task) => task.status === "review").length;
	const openComments = project.comments.filter((comment) => comment.status !== "resolved").length;
	return {
		projectId: project.projectId,
		name: project.name,
		createdAt: project.createdAt,
		updatedAt: nowIso(-5_000),
		coverImageId: project.coverImageId,
		coverOriginalName: project.coverOriginalName,
		targetLang: project.targetLang,
		pageCount: project.pages.length,
		textLayerCount,
		taskCount: project.tasks.length,
		openTaskCount: openTasks,
		reviewTaskCount: reviewTasks,
		commentCount: project.comments.length,
		openCommentCount: openComments,
	};
}

function seedDebugRecentProject(project: ProjectState): void {
	const summary = debugProjectSummary(project);
	projectStore.recentProjects = [
		summary,
		...projectStore.recentProjects.filter((item) => item.projectId !== project.projectId),
	];
}

function seedDuplicateRecentProjects(): WorkflowDebugState & { duplicateIds: string[] } {
	const baseSummary: Omit<ProjectSummary, "projectId" | "updatedAt"> = {
		name: "Moonlit Courier ตอน 104",
		createdAt: nowIso(-90_000),
		targetLang: "th",
		pageCount: 2,
		textLayerCount: 0,
		taskCount: 1,
		openTaskCount: 1,
		reviewTaskCount: 1,
		commentCount: 0,
		openCommentCount: 0,
	};
	const duplicateA: ProjectSummary = {
		...baseSummary,
		projectId: "flow526-duplicate-alpha-123456",
		updatedAt: nowIso(-20_000),
	};
	const duplicateB: ProjectSummary = {
		...baseSummary,
		projectId: "flow526-duplicate-beta-654321",
		updatedAt: nowIso(-40_000),
	};
	const distinct: ProjectSummary = {
		...baseSummary,
		projectId: "flow526-distinct-gamma-333333",
		name: "Glass Harbor ตอน 12",
		updatedAt: nowIso(-60_000),
	};
	const duplicateIds = [duplicateA.projectId, duplicateB.projectId];
	const duplicateSet = new Set([...duplicateIds, distinct.projectId]);
	projectStore.recentProjects = [
		duplicateA,
		duplicateB,
		distinct,
		...projectStore.recentProjects.filter((item) => !duplicateSet.has(item.projectId)),
	];
	projectStore.recentProjectsLoading = false;
	projectStore.recentProjectsError = null;
	return {
		...getWorkflowDebugState(),
		duplicateIds,
	};
}

function markRecentProjectsError(kind: "network" | "api" | "generic" = "network"): WorkflowDebugState {
	projectStore.recentProjects = [];
	projectStore.recentProjectsLoading = false;
	projectStore.recentProjectsError = kind === "api"
		? "โหลดตอนล่าสุดไม่ได้ (503) เช็ก /api/readyz แล้วลองใหม่"
		: kind === "generic"
			? "โหลดตอนล่าสุดไม่ได้ - เช็ก backend แล้วลองรีเฟรชอีกครั้ง"
			: "API ไม่พร้อม - เช็ก backend/proxy ที่ /api/health แล้วลองรีเฟรชอีกครั้ง";
	projectStore.setStatusMsg("โหลดตอนล่าสุดไม่สำเร็จ");
	return getWorkflowDebugState();
}

function seedVersions(): { versions: ProjectVersion[]; detail: ProjectVersionDetail } {
	const version: ProjectVersion = {
		versionId: "flow208-version-1",
		projectId: WORKSPACE_DEBUG_PROJECT_ID,
		name: "Typeset review checkpoint",
		source: "import-json",
		createdAt: nowIso(-60_000),
		pageCount: 2,
		textLayerCount: 1,
		stateHash: "flow208-hash",
	};
	return {
		versions: [version],
		detail: {
			version,
			diff: {
				current: {
					name: DEMO_PROJECT_NAME,
					pageCount: 2,
					textLayerCount: 1,
					pages: [
						{ pageIndex: 0, imageId: "flow208-page-01", imageName: DEMO_PAGE_ONE_NAME, originalName: DEMO_PAGE_ONE_NAME, textLayerCount: 1 },
						{ pageIndex: 1, imageId: "flow208-page-02", imageName: DEMO_PAGE_TWO_NAME, originalName: DEMO_PAGE_TWO_NAME, textLayerCount: 0 },
					],
				},
				snapshot: {
					name: DEMO_PROJECT_NAME,
					pageCount: 2,
					textLayerCount: 1,
					pages: [
						{ pageIndex: 0, imageId: "flow208-page-01", imageName: DEMO_PAGE_ONE_NAME, originalName: DEMO_PAGE_ONE_NAME, textLayerCount: 1 },
						{ pageIndex: 1, imageId: "flow208-page-02", imageName: DEMO_PAGE_TWO_NAME, originalName: DEMO_PAGE_TWO_NAME, textLayerCount: 0 },
					],
				},
				pageDelta: 0,
				textLayerDelta: 0,
				changedPages: [],
				changedPageCount: 0,
			},
			reviews: [
				{
					id: "flow208-version-review",
					versionId: "flow208-version-1",
					status: "open",
					body: "รีวิวข้อความ Importก่อน Export",
					requester: "lead",
					reviewer: "solo",
					createdAt: nowIso(-60_000),
					updatedAt: nowIso(-20_000),
				},
			],
		},
	};
}

async function loadDebugPage(pageIndex: number): Promise<WorkflowDebugState> {
	const project = projectStore.project;
	const editor = editorStore.editor;
	if (!project || !editor) throw new Error("Seed a workflow project before opening a debug page");
	const page = project.pages[pageIndex];
	if (!page) throw new Error(`Debug page ${pageIndex + 1} is missing`);
	project.currentPage = pageIndex;
	projectStore.clearAssetLoadError(pageIndex);
	editorUiStore.openEditor();
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	const previousLoadingState = (projectStore as any).isLoadingPage;
	(projectStore as any).isLoadingPage = true;
	try {
		await editor.loadImage(createDebugImageDataUrl(DEMO_PAGE_LABELS[pageIndex] ?? `Moonlit Courier P${pageIndex + 1}`, pageIndex === 0 ? "#f8f5ef" : "#f1f7f4"));
		for (const imageLayer of page.imageLayers ?? []) {
			await editor.addImageLayer?.(imageLayer, projectStore.getImageUrl(imageLayer.imageId));
		}
		for (const layer of page.textLayers) {
			editor.addTextLayer(layer);
		}
	} finally {
		(projectStore as any).isLoadingPage = previousLoadingState;
	}
	editorStore.refreshTextLayers();
	editorStore.refreshImageLayers();
	projectStore.setStatusMsg(`หน้า ${pageIndex + 1} / ${project.pages.length}`);
	return getWorkflowDebugState();
}

export async function seedWorkspaceDebugProjectForRoute(
	projectId: string,
	options: { pageIndex?: number } = {},
): Promise<boolean> {
	if (!canSeedWorkspaceDebugProject(projectId)) return false;

	const project = seedProject();
	const pageIndex = Math.max(0, Math.min(options.pageIndex ?? project.currentPage, project.pages.length - 1));
	project.currentPage = pageIndex;
	projectStore.__resetForTesting();
	projectStore.__setProjectForTesting(project);
	seedDebugRecentProject(project);
	installAssetsForProject(project, {});
	const { versions, detail } = seedVersions();
	projectStore.versions = versions;
	projectStore.versionDetail = detail;
	projectStore.setStatusMsg(`เปิด Moonlit Courier หน้า ${pageIndex + 1} แล้ว`);
	return true;
}

export async function loadWorkspaceDebugRoutePage(pageIndex?: number): Promise<boolean> {
	const project = projectStore.project;
	if (!project || !canSeedWorkspaceDebugProject(project.projectId)) return false;
	const boundedPageIndex = Math.max(0, Math.min(pageIndex ?? project.currentPage, project.pages.length - 1));
	await loadDebugPage(boundedPageIndex);
	return true;
}

function installAssetsForProject(project: ProjectState, options: SeedOptions): void {
	const assets = [
		asset("flow208-page-01", DEMO_PAGE_ONE_NAME),
		asset("flow208-ai-result-p1", DEMO_AI_RESULT_NAME),
	];
	projectStore.localImageUrls = {
		...projectStore.localImageUrls,
		"flow208-page-01": createDebugImageDataUrl(DEMO_PAGE_LABELS[0], "#f8f5ef"),
		"flow208-ai-result-p1": createDebugImageDataUrl(DEMO_AI_RESULT_LABEL, "#e7f1ff"),
	};
	if (!options.missingSecondPage) {
		assets.push(asset("flow208-page-02", DEMO_PAGE_TWO_NAME));
		projectStore.localImageUrls = {
			...projectStore.localImageUrls,
			"flow208-page-02": createDebugImageDataUrl(DEMO_PAGE_LABELS[1], "#f1f7f4"),
		};
	}
	(projectStore as any).setImageAssets?.(assets, project.projectId);
}

function ensureReadyTextLayers(project: ProjectState): void {
	for (const [pageIndex, page] of project.pages.entries()) {
		page.textLayers = [
			pageIndex === 0
				? pageLayer("flow213-ready-p1", "ตรายังส่องแสงอยู่", 470, 170, 0)
				: pageLayer("flow213-ready-p2", "เจอกันที่ประตู 7", 480, 690, 0),
		];
	}
}

function getWorkflowDebugState(): WorkflowDebugState {
	const project = projectStore.project;
	const summaries = project?.pages.map((page, pageIndex) => summarizePageWork({
		page,
		pageIndex,
		assetIntegrity: projectStore.getPageAssetIntegrity(pageIndex),
		tasks: projectStore.tasks,
		comments: projectStore.comments,
		aiReviewMarkers: projectStore.aiReviewMarkers,
		reviewDecisions: projectStore.reviewDecisions,
		productionMode: project.productionMode ?? "solo",
	})) ?? [];
	const batchSummary = summarizePageBatch(summaries);
	return {
		projectId: project?.projectId ?? null,
		pageIndex: project?.currentPage ?? null,
		pageCount: project?.pages.length ?? 0,
		textLayerCounts: project?.pages.map((page) => page.textLayers.length) ?? [],
		taskCount: projectStore.tasks.length,
		openCommentCount: projectStore.comments.filter((comment) => comment.status === "open").length,
		reviewDecisionCount: projectStore.reviewDecisions.length,
		aiReviewMarkerCount: projectStore.aiReviewMarkers.length,
		versionCount: projectStore.versions.length,
		exportRunCount: projectStore.exportRuns.length,
		exportReadyCount: batchSummary.exportReadyCount,
		attentionCount: batchSummary.attentionCount,
		batchExportStatus: projectStore.batchExportStatus,
		saveSyncStatus: projectStore.saveSyncStatus,
		saveErrorKind: projectStore.saveErrorKind,
		statusMsg: projectStore.statusMsg,
		assetStatus: projectStore.currentPageAssetIntegrity?.status ?? null,
	};
}

async function markChapterExportReady(): Promise<WorkflowDebugState> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before marking it export ready");
	const updatedAt = nowIso();
	ensureReadyTextLayers(project);
	project.tasks = (project.tasks ?? []).map((task) => ({ ...task, status: "done", updatedAt }));
	project.comments = (project.comments ?? []).map((comment) => ({ ...comment, status: "resolved", updatedAt }));
	project.aiReviewMarkers = (project.aiReviewMarkers ?? []).map((marker) => ({
		...marker,
		status: marker.resultImageId ? "applied" : "rejected",
		updatedAt,
	}));
	const approvedDecisions = project.pages.map((_, pageIndex) => ({
		id: `flow213-export-ready-${pageIndex}`,
		pageIndex,
		status: "approved" as const,
		body: "พร้อม Export",
		actor: "lead",
		createdAt: updatedAt,
		updatedAt,
	}));
	project.reviewDecisions = [
		...(project.reviewDecisions ?? []).filter((decision) => decision.status === "approved"),
		...approvedDecisions,
	];
	projectStore.tasks = project.tasks;
	projectStore.comments = project.comments;
	projectStore.aiReviewMarkers = project.aiReviewMarkers;
	projectStore.reviewDecisions = project.reviewDecisions;
	await loadDebugPage(project.currentPage);
	project.pages[project.currentPage].imageLayers = keepLastImageLayerById(project.pages[project.currentPage].imageLayers);
	for (const marker of project.aiReviewMarkers) {
		if (marker.status !== "applied" || !marker.resultImageId) continue;
		const page = project.pages[marker.pageIndex];
		if (!page) continue;
		const layerId = `ai-result-${marker.id}`;
		if (page.imageLayers?.some((layer) => layer.id === layerId)) continue;
		const layer = {
			id: layerId,
			name: `ผล AI หน้า ${marker.pageIndex + 1}`,
			imageId: marker.resultImageId,
			imageName: `${marker.resultImageId}.png`,
			x: marker.region.x,
			y: marker.region.y,
			w: marker.region.w,
			h: marker.region.h,
			rotation: 0,
			opacity: 1,
			index: page.imageLayers?.length ?? 0,
			role: "overlay" as const,
		};
		page.imageLayers = [
			...(page.imageLayers ?? []),
			layer,
		];
		if (marker.pageIndex === project.currentPage) {
			await editorStore.addImageLayer(layer, createDebugImageDataUrl(DEMO_AI_RESULT_LABEL, "#e7f1ff"));
		}
	}
	for (const page of project.pages) {
		page.imageLayers = keepLastImageLayerById(page.imageLayers);
	}
	ensureReadyTextLayers(project);
	const editor = editorStore.editor;
	const currentPage = project.pages[project.currentPage];
	if (editor && currentPage) {
		const existingEditorLayerIds = new Set(editorStore.textLayers.map((layer) => layer.id));
		for (const layer of currentPage.textLayers) {
			if (existingEditorLayerIds.has(layer.id)) continue;
			editor.addTextLayer(layer);
			existingEditorLayerIds.add(layer.id);
		}
		editorStore.refreshTextLayers();
	}
	projectStore.setStatusMsg("ตอนพร้อม Export แล้ว");
	return getWorkflowDebugState();
}

async function seedFinalQcPendingPage(): Promise<WorkflowDebugState> {
	const updatedAt = nowIso();
	const project = seedProject({ projectId: "flow707-final-qc-pending" });
	const page = project.pages[0];
	page.translationScriptSlots = [{
		id: "dialogue-1",
		label: "คำพูด 1",
		x: 18,
		y: 28,
		category: "dialogue",
		translatedText: "พร้อมส่งท้าย",
		updatedAt,
	}];
	page.translationHandoff = {
		status: "translated",
		updatedAt,
		updatedBy: "translator",
	};
	page.cleaningHandoff = {
		status: "clean_ready",
		updatedAt,
		updatedBy: "cleaner",
		typesetRecheckStatus: "verified",
		typesetRecheckUpdatedAt: updatedAt,
		typesetRecheckUpdatedBy: "qc",
	};
	page.textLayers = [{
		id: "typeset-dialogue-1",
		name: "คำพูด 1",
		text: "พร้อมส่งท้าย",
		sourceCategory: "dialogue",
		sourceProvider: "translation-slot:dialogue-1",
		x: 20,
		y: 30,
		w: 240,
		h: 80,
		rotation: 0,
		fontSize: 28,
		alignment: "center",
		index: 0,
	}];
	page.qcHandoff = undefined;
	project.pages = [page];
	project.currentPage = 0;
	project.tasks = [];
	project.comments = [];
	project.aiReviewMarkers = [];
	project.reviewDecisions = [];
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	projectStore.__setProjectForTesting(project);
	installAssetsForProject(project, {});
	await loadDebugPage(0);
	projectStore.__markCurrentPageCleanForTesting();
	editorUiStore.setWorkspaceMode("team");
	editorUiStore.openWorkBoard();
	return getWorkflowDebugState();
}

async function seedApprovedReviewPendingFinalQc(): Promise<WorkflowDebugState> {
	const state = await seedFinalQcPendingPage();
	const project = projectStore.project;
	if (!project) return state;
	const updatedAt = nowIso();
	project.projectId = WORKSPACE_DEBUG_PROJECT_ID;
	const reviewTask: WorkflowTask = {
		id: "flow710-review-task",
		type: "review",
		status: "review",
		priority: "normal",
		pageIndex: 0,
		title: "Review page before final QC",
		createdAt: updatedAt,
		updatedAt,
	};
	const decision: PageReviewDecision = {
		id: "flow710-review-approved",
		pageIndex: 0,
		status: "approved",
		body: "หน้าผ่านรีวิวแล้ว รอปิด QC ขั้นสุดท้าย",
		actor: "QC",
		createdAt: updatedAt,
		updatedAt,
	};
	project.tasks = [reviewTask];
	project.reviewDecisions = [decision];
	projectStore.tasks = [...project.tasks];
	projectStore.reviewDecisions = [...project.reviewDecisions];
	projectStore.selectWorkflowTask(reviewTask.id);
	editorUiStore.setWorkspaceMode("team");
	editorUiStore.openWorkBoard();
	projectStore.setStatusMsg("หน้า review ผ่านแล้ว รอปิด QC ขั้นสุดท้าย");
	return getWorkflowDebugState();
}

async function seedReviewApprovalBlockedFinalQcPage(): Promise<WorkflowDebugState> {
	const state = await seedFinalQcPendingPage();
	const project = projectStore.project;
	if (!project) return state;
	const updatedAt = nowIso();
	project.projectId = WORKSPACE_DEBUG_PROJECT_ID;
	const reviewTask: WorkflowTask = {
		id: "flow881-review-task",
		type: "review",
		status: "review",
		priority: "urgent",
		pageIndex: 0,
		title: "Review p104 page before export",
		createdAt: updatedAt,
		updatedAt,
	};
	project.tasks = [reviewTask];
	project.reviewDecisions = [];
	project.exportRuns = [];
	projectStore.__setProjectForTesting(project);
	projectStore.tasks = [...project.tasks];
	projectStore.reviewDecisions = [];
	projectStore.selectWorkflowTask(reviewTask.id);
	editorUiStore.setWorkspaceMode("team");
	projectStore.setStatusMsg("หน้า p104 รอ Focus review ก่อน Export");
	return getWorkflowDebugState();
}

async function markAcceptedAiResultUnplaced(): Promise<WorkflowDebugState & { markerId: string | null }> {
	await markChapterExportReady();
	const project = projectStore.project;
	const marker = projectStore.aiReviewMarkers.find((item) => item.resultImageId);
	if (!project || !marker) return { ...getWorkflowDebugState(), markerId: null };
	marker.status = "accepted";
	marker.updatedAt = nowIso();
	const layerId = `ai-result-${marker.id}`;
	const page = project.pages[marker.pageIndex];
	if (page) {
		page.imageLayers = (page.imageLayers ?? []).filter((layer) => layer.id !== layerId);
	}
	if (marker.pageIndex === project.currentPage) {
		editorStore.editor?.removeImageLayer?.(layerId);
		editorStore.refreshImageLayers();
	}
	project.aiReviewMarkers = [...projectStore.aiReviewMarkers];
	projectStore.aiReviewMarkers = project.aiReviewMarkers;
	projectStore.selectAiReviewMarker(marker.id);
	projectStore.setStatusMsg("ตอนพร้อม Export แล้ว");
	return { ...getWorkflowDebugState(), markerId: marker.id };
}

async function seedSamePageAiResultVariants(): Promise<WorkflowDebugState & { markerIds: string[] }> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before seeding same-page AI results");
	await loadDebugPage(0);
	const page = project.pages[0];
	if (!page) throw new Error("Seeded project page 1 is missing");

	const updatedAt = nowIso();
	const imageId = page.imageId;
	const markers: AiReviewMarker[] = [
		{
			id: "flow564-ai-review",
			jobId: "flow564-ai-job-review",
			pageIndex: 0,
			imageId,
			region: { x: 110, y: 310, w: 220, h: 145 },
			status: "needs_review",
			tier: "clean-pro",
			resultImageId: "flow564-ai-result-review",
			assignee: "solo",
			createdAt: nowIso(-4_000),
			updatedAt,
		},
		{
			id: "flow564-ai-accepted",
			jobId: "flow564-ai-job-accepted",
			pageIndex: 0,
			imageId,
			region: { x: 360, y: 285, w: 210, h: 130 },
			status: "accepted",
			tier: "sfx-pro",
			resultImageId: "flow564-ai-result-accepted",
			assignee: "solo",
			createdAt: nowIso(-3_000),
			updatedAt,
		},
		{
			id: "flow564-ai-applied",
			jobId: "flow564-ai-job-applied",
			pageIndex: 0,
			imageId,
			region: { x: 515, y: 650, w: 250, h: 160 },
			status: "applied",
			tier: "clean-pro",
			resultImageId: "flow564-ai-result-applied",
			assignee: "solo",
			createdAt: nowIso(-2_000),
			updatedAt,
		},
	];
	const appliedLayer: ImageLayer = {
		id: "ai-result-flow564-ai-applied",
		name: "ผล AI ที่วางแล้ว",
		imageId: "flow564-ai-result-applied",
		imageName: "flow564-ai-result-applied.png",
		x: markers[2].region.x,
		y: markers[2].region.y,
		w: markers[2].region.w,
		h: markers[2].region.h,
		rotation: 0,
		opacity: 0.86,
		index: page.imageLayers?.length ?? 0,
		role: "overlay",
	};

	for (const marker of markers) {
		if (marker.resultImageId) {
			projectStore.registerLocalImageUrl(
				marker.resultImageId,
				createDebugImageDataUrl(`AI ${marker.id.replace("flow564-ai-", "").toUpperCase()}`, "#e8f4ff"),
			);
		}
	}
	page.imageLayers = [
		...(page.imageLayers ?? []).filter((layer) => !layer.id.startsWith("ai-result-flow564-")),
		appliedLayer,
	];
	project.aiReviewMarkers = markers;
	projectStore.aiReviewMarkers = markers;
	projectStore.selectAiReviewMarker(markers[2].id);
	await loadDebugPage(0);
	editorUiStore.openEditor();
	editorUiStore.setRightPanelMode("ai");
	projectStore.setStatusMsg("เตรียมผล AI หลายรายการบนหน้าเดียวแล้ว");
	return { ...getWorkflowDebugState(), markerIds: markers.map((marker) => marker.id) };
}

async function seedCrossPageAppliedAiResult(): Promise<WorkflowDebugState & { markerId: string }> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before seeding cross-page AI result");
	await loadDebugPage(0);
	const page = project.pages[1];
	if (!page) throw new Error("Seeded project page 2 is missing");

	const updatedAt = nowIso();
	const marker: AiReviewMarker = {
		id: "flow959-cross-page-applied",
		jobId: "flow959-ai-job-cross-page",
		pageIndex: 1,
		imageId: page.imageId,
		region: { x: 120, y: 320, w: 240, h: 150 },
		status: "applied",
		tier: "clean-pro",
		resultImageId: "flow959-ai-result-page-2",
		assignee: "solo",
		createdAt: nowIso(-3_000),
		updatedAt,
	};
	const appliedLayer: ImageLayer = {
		id: `ai-result-${marker.id}`,
		name: "ผล AI หน้า 2",
		imageId: marker.resultImageId,
		imageName: "flow959-ai-result-page-2.png",
		x: marker.region.x,
		y: marker.region.y,
		w: marker.region.w,
		h: marker.region.h,
		rotation: 0,
		opacity: 0.9,
		index: page.imageLayers?.length ?? 0,
		role: "overlay",
	};

	projectStore.registerLocalImageUrl(marker.resultImageId, createDebugImageDataUrl("AI P2 APPLIED", "#e6f3ff"));
	page.imageLayers = [
		...(page.imageLayers ?? []).filter((layer) => layer.id !== appliedLayer.id),
		appliedLayer,
	];
	project.aiReviewMarkers = [marker];
	projectStore.aiReviewMarkers = project.aiReviewMarkers;
	projectStore.selectAiReviewMarker(marker.id);
	await loadDebugPage(0);
	projectStore.__markCurrentPageCleanForTesting();
	editorUiStore.openEditor();
	editorUiStore.setRightPanelMode("work");
	projectStore.setStatusMsg("เตรียมผล AI ข้ามหน้าเพื่อพิสูจน์การเปิดเลเยอร์แล้ว");
	return { ...getWorkflowDebugState(), markerId: marker.id };
}

async function seedAiRailOverflowVariants(): Promise<WorkflowDebugState & { markerIds: string[] }> {
	await seedSamePageAiResultVariants();
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before seeding AI rail overflow");
	const page = project.pages[0];
	if (!page) throw new Error("Seeded project page 1 is missing");
	const imageId = page.imageId;
	const existing = project.aiReviewMarkers ?? [];
	const extraMarkers: AiReviewMarker[] = Array.from({ length: 6 }, (_, index) => {
		const markerIndex = index + 4;
		const status: AiReviewMarkerStatus = index % 3 === 0 ? "needs_review" : index % 3 === 1 ? "retry_requested" : "failed";
		return {
			id: `flow568-ai-overflow-${markerIndex}`,
			jobId: `flow568-ai-overflow-job-${markerIndex}`,
			pageIndex: 0,
			imageId,
			region: {
				x: 80 + index * 90,
				y: 170 + (index % 2) * 95,
				w: 128,
				h: 74,
			},
			status,
			tier: index % 2 === 0 ? "clean-pro" : "sfx-pro",
			resultImageId: `flow568-ai-overflow-result-${markerIndex}`,
			assignee: "solo",
			createdAt: nowIso(-(8_000 + index * 1_000)),
			updatedAt: nowIso(-(1_000 + index)),
		};
	});
	for (const marker of extraMarkers) {
		if (marker.resultImageId) {
			projectStore.registerLocalImageUrl(
				marker.resultImageId,
				createDebugImageDataUrl(`AI ${marker.id.replace("flow568-ai-overflow-", "")}`, "#fff7df"),
			);
		}
	}
	const markers = [...existing, ...extraMarkers];
	project.aiReviewMarkers = markers;
	projectStore.aiReviewMarkers = markers;
	projectStore.selectAiReviewMarker("flow564-ai-applied");
	editorUiStore.openEditor();
	editorUiStore.setRightPanelMode("ai");
	projectStore.setStatusMsg("เตรียมรายการ AI เกิน rail แล้ว");
	return { ...getWorkflowDebugState(), markerIds: markers.map((marker) => marker.id) };
}

async function exportReadyChapterBatch(): Promise<WorkflowDebugState> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before exporting it");
	await markChapterExportReady();
	await projectStore.exportPageBatch(project.pages.map((_, pageIndex) => pageIndex));
	return getWorkflowDebugState();
}

async function exportCurrentChapterBatchForTesting(): Promise<WorkflowDebugState> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before exporting it");
	await projectStore.exportPageBatch(project.pages.map((_, pageIndex) => pageIndex));
	return getWorkflowDebugState();
}

function addCurrentPageCreditTextForTesting(
	text = "Credit QA",
	options: CreditTextTestingOptions = {},
): WorkflowDebugState & { creditLayerId: string | null } {
	const project = projectStore.project;
	const editor = editorStore.editor;
	if (!project || !editor) throw new Error("Seed and open a workflow project before adding credit");
	const layer = projectStore.addCreditTextLayer(editor, {
		presetId: options.presetId ?? "credit-bottom-center",
		text,
		offset: options.offset ?? 48,
		scope: options.scope ?? "current",
		repeatEveryPx: options.repeatEveryPx ?? 0,
	});
	return { ...getWorkflowDebugState(), creditLayerId: layer?.id ?? null };
}

async function imageDataUrlToFileForTesting(imageUrl: string, filename: string): Promise<File> {
	const response = await fetch(imageUrl);
	if (!response.ok) throw new Error(`Cannot read test image ${filename}`);
	const blob = await response.blob();
	return new File([blob], filename, { type: blob.type || "image/png" });
}

async function addCurrentPageCreditImageForTesting(
	imageUrl: string,
	filename = "credit-proof.png",
	options: CreditImageTestingOptions = {},
): Promise<WorkflowDebugState & { creditLayerIds: string[] }> {
	const project = projectStore.project;
	const editor = editorStore.editor;
	if (!project || !editor) throw new Error("Seed and open a workflow project before adding image credit");
	const file = await imageDataUrlToFileForTesting(imageUrl, filename);
	const layers = await projectStore.addCreditImageLayer(file, editor, {
		presetId: options.presetId ?? "credit-right-bottom",
		maxWidth: options.maxWidth ?? 160,
		repeatEveryPx: options.repeatEveryPx ?? 0,
		scope: options.scope ?? "current",
	});
	return { ...getWorkflowDebugState(), creditLayerIds: layers.map((layer) => layer.id) };
}

function setCurrentPageTextLayersForTesting(layers: TextLayer[]): WorkflowDebugState & { textLayerIds: string[] } {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before setting text layers");
	const page = project.pages[project.currentPage];
	if (!page) throw new Error("Open a page before setting text layers");
	page.textLayers = layers.map((layer, index) => ({
		...layer,
		index: layer.index ?? index,
		zIndex: layer.zIndex ?? index,
		visible: layer.visible ?? true,
		locked: layer.locked ?? false,
	}));
	projectStore.markCurrentPageUnsaved();
	return { ...getWorkflowDebugState(), textLayerIds: page.textLayers.map((layer) => layer.id) };
}

async function refreshLocalProjectSurfaces(): Promise<WorkflowDebugState> {
	if (!projectStore.project) throw new Error("Seed a workflow project before refreshing local surfaces");
	await projectStore.loadComments();
	await projectStore.loadAiReviewMarkers();
	await projectStore.loadReviewDecisions();
	await projectStore.loadWorkspaceHub();
	await projectStore.loadVersions();
	const versionId = projectStore.versionDetail?.version.versionId ?? projectStore.versions[0]?.versionId;
	if (versionId) {
		await projectStore.loadVersionDetail(versionId);
	}
	return getWorkflowDebugState();
}

async function exerciseLocalProjectActions(): Promise<WorkflowDebugState> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before exercising local actions");
	const task = projectStore.tasks[0];
	if (task) {
		await projectStore.updateTaskStatus(task.id, "review");
		await projectStore.updateTaskPriority(task.id, "urgent");
		await projectStore.updateTaskAssignee(task.id, "solo");
	}
	const addedComment = await projectStore.addPageComment("Browser proof local comment");
	if (addedComment) {
		await projectStore.resolveComment(addedComment.id);
	}
	await projectStore.createReviewDecision("approved", "Browser proof local review decision");
	await projectStore.addWorkspaceMessage("Browser proof local handoff note");
	const marker = projectStore.aiReviewMarkers[0];
	if (marker) {
		await projectStore.updateAiReviewMarker(marker.id, { status: "accepted", assignee: "solo" });
		await projectStore.createAiReviewMarkerComment(marker.id, "Browser proof โน้ตแก้ผล AI");
		await projectStore.linkAiReviewMarkerReviewTask(marker.id, "solo");
	}
	return getWorkflowDebugState();
}

async function exerciseProjectStatusCopy(): Promise<WorkflowDebugState & { statuses: string[] }> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before exercising project status copy");
	const statuses: string[] = [];

	await projectStore.renameCurrentProject("Flow357 Status Copy");
	statuses.push(projectStore.statusMsg);

	const firstPage = projectStore.project?.pages[0];
	if (firstPage) {
		firstPage.textLayers = [
			pageLayer("flow357-duplicate-layer", "Flow357 duplicate A", 160, 420, 0),
			pageLayer("flow357-duplicate-layer", "Flow357 duplicate B", 210, 520, 1),
		];
		await projectStore.repairDuplicateLayerIds(0);
		statuses.push(projectStore.statusMsg);
	}

	await projectStore.reorderPage(0, 1);
	statuses.push(projectStore.statusMsg);

	return {
		...getWorkflowDebugState(),
		statuses,
	};
}

function markAssetRecoveryError(pageIndex = projectStore.project?.currentPage ?? 0): WorkflowDebugState {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before marking an asset recovery error");
	const boundedPageIndex = Math.max(0, Math.min(pageIndex, project.pages.length - 1));
	const page = project.pages[boundedPageIndex];
	project.currentPage = boundedPageIndex;
	editorUiStore.openEditor();
	(projectStore as any).setPageAssetLoadError?.({
		pageIndex: boundedPageIndex,
		imageId: page.imageId,
		imageName: page.imageName,
		originalName: page.originalName,
		message: "โหลดรูปหน้านี้ไม่สำเร็จ",
	});
	projectStore.setStatusMsg(`รูปหน้า ${boundedPageIndex + 1} หาย`);
	return getWorkflowDebugState();
}

function markImageLayerAssetRecoveryError(pageIndex = projectStore.project?.currentPage ?? 0, issueCount = 1): WorkflowDebugState {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before marking an image-layer recovery error");
	const boundedPageIndex = Math.max(0, Math.min(pageIndex, project.pages.length - 1));
	const page = project.pages[boundedPageIndex];
	const count = Math.max(1, Math.min(4, Math.round(issueCount || 1)));
	const layers: ImageLayer[] = Array.from({ length: count }, (_, index) => ({
		id: `debug-missing-image-layer-${index + 1}`,
		name: index === 0 ? "Logo overlay" : `Credit overlay ${index + 1}`,
		imageId: `missing-overlay-debug-${index + 1}.webp`,
		imageName: `missing-overlay-debug-${index + 1}.webp`,
		originalName: `missing-overlay-debug-${index + 1}.webp`,
		x: 120,
		y: 160 + index * 48,
		w: 320,
		h: 140,
		rotation: 0,
		opacity: 1,
		visible: true,
		locked: false,
		index: (page.imageLayers?.length ?? 0) + index,
		role: index === 0 ? "overlay" : "credit",
	}));
	page.imageLayers = [
		...(page.imageLayers ?? []).filter((item) => !item.id.startsWith("debug-missing-image-layer")),
		...layers,
	];
	project.currentPage = boundedPageIndex;
	editorUiStore.openEditor();
	for (const layer of layers) {
		(projectStore as any).setPageAssetLoadError?.({
			pageIndex: boundedPageIndex,
			imageId: layer.imageId,
			imageName: layer.imageName,
			originalName: layer.originalName,
			message: "โหลดรูปเสริมไม่สำเร็จ",
			kind: "image-layer",
			layerId: layer.id,
			layerName: layer.name,
		});
	}
	projectStore.setStatusMsg(`รูปเสริมหน้า ${boundedPageIndex + 1} หาย`);
	return getWorkflowDebugState();
}

async function exerciseProjectSwitchSaveFailure(currentId: string, nextId: string): Promise<WorkflowDebugState> {
	const project: ProjectState = {
		projectId: currentId,
		name: "Current Dirty Chapter",
		createdAt: "2026-05-19T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [{
			imageId: "current-image.webp",
			imageName: "current-image.webp",
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		}],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
	};
	projectStore.__setProjectForTesting(project);
	projectStore.project!.pages[0].textLayers = [{
		id: "debug-switch-local-layer",
		text: "local edit before switching",
		x: 10,
		y: 20,
		w: 160,
		h: 48,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
	}];
	projectStore.markCurrentPageUnsaved();
	editorUiStore.openDashboard();
	await projectStore.openProject(nextId);
	return getWorkflowDebugState();
}

async function exerciseAiResultCompletionFocusRetention(): Promise<WorkflowDebugState & { selectedMarkerId: string | null; completedMarkerId: string }> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before checking AI completion focus");
	const activeMarker: AiReviewMarker = {
		id: "flow403-active-ai-marker",
		jobId: "flow403-active-job",
		pageIndex: project.currentPage,
		imageId: project.pages[project.currentPage]?.imageId ?? "image-1.webp",
		region: { x: 120, y: 220, w: 240, h: 120 },
		status: "needs_review",
		tier: "clean-pro",
		resultImageId: "active-result.webp",
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	const completedMarker: AiReviewMarker = {
		id: "flow403-completed-ai-marker",
		jobId: "flow403-completed-job",
		pageIndex: project.currentPage,
		imageId: project.pages[project.currentPage]?.imageId ?? "image-1.webp",
		region: { x: 420, y: 360, w: 260, h: 140 },
		status: "running",
		tier: "sfx-pro",
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	projectStore.aiReviewMarkers = [activeMarker, completedMarker, ...projectStore.aiReviewMarkers.filter((marker) =>
		!marker.id.startsWith("flow403-")
	)];
	projectStore.registerLocalImageUrl("flow403-result.webp", createDebugImageDataUrl("Clean pass retained", "#e7f1ff"));
	project.aiReviewMarkers = projectStore.aiReviewMarkers;
	projectStore.selectAiReviewMarker(activeMarker.id);
	editorUiStore.openEditor();
	editorUiStore.setRightPanelMode("work");
	await projectStore.updateAiReviewMarker(completedMarker.id, {
		status: "needs_review",
		resultImageId: "flow403-result.webp",
	}, { select: false });
	return {
		...getWorkflowDebugState(),
		selectedMarkerId: projectStore.selectedAiReviewMarkerId,
		completedMarkerId: completedMarker.id,
	};
}

function addArtifactFailedExportRun(): WorkflowDebugState {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before adding an artifact-failed export");
	const now = nowIso();
	const pageIndexes = project.pages.map((_, pageIndex) => pageIndex);
	const filename = "flow235-artifact-failed.zip";
	project.exportRuns = normalizeExportRuns([{
		id: `flow235-artifact-failed-${Date.now()}`,
		kind: "batch-zip",
		status: "done",
		filename,
		pageIndexes,
		pageCount: pageIndexes.length,
		bytes: 2048,
		message: `Export สำเร็จ ${pageIndexes.length} หน้า: ${filename}`,
		artifactError: "เก็บ ZIP ไม่สำเร็จ: Workspace storage is full.",
		createdAt: now,
		completedAt: now,
	}, ...(project.exportRuns ?? [])]);
	projectStore.setStatusMsg("Export สำเร็จ แต่เก็บ ZIP ไม่สำเร็จ");
	return getWorkflowDebugState();
}

function addImageFailedExportRun(): WorkflowDebugState {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before adding an image-failed export");
	const now = nowIso();
	const pageIndexes = project.pages.map((_, pageIndex) => pageIndex);
	project.exportRuns = normalizeExportRuns([{
		id: `flow528-image-failed-${Date.now()}`,
		kind: "batch-zip",
		status: "error",
		filename: "flow528-image-failed.zip",
		pageIndexes,
		pageCount: pageIndexes.length,
		error: "fabric: Error loading http://127.0.0.1:5173/api/images/flow528/page-02.png",
		failedPageIndex: Math.min(1, Math.max(0, pageIndexes.length - 1)),
		failedPageNumber: Math.min(2, Math.max(1, pageIndexes.length)),
		createdAt: now,
		completedAt: now,
	}, ...(project.exportRuns ?? [])]);
	projectStore.setStatusMsg("Export ไม่สำเร็จ: โหลดรูปสำหรับ Export ไม่สำเร็จ; Relink รูปหรือรีเฟรชหน้าแล้วลองใหม่");
	return getWorkflowDebugState();
}

function markImportRefreshFailure(message = "network down"): WorkflowDebugState {
	projectStore.setStatusMsg(`Import JSON แล้ว แต่เปิดตอนที่อัปเดตไม่สำเร็จ (${message})`);
	return getWorkflowDebugState();
}

function markAiProviderFailure(): WorkflowDebugState {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before marking an AI provider failure");
	const pageIndex = project.currentPage;
	const page = project.pages[pageIndex];
	if (!page) throw new Error("Current debug page is missing");

	const updatedAt = nowIso();
	const message = formatAiJobProviderFailure("image cleanup provider returned 503");
	const jobId = `flow304-provider-failed-${Date.now()}`;
	const markerId = `${jobId}-marker`;
	const crop = { x: 110, y: 310, w: 280, h: 180 };
	const failedJob: BatchJob = {
		id: jobId,
		projectId: project.projectId,
		imageId: page.imageId,
		crop,
		lang: project.targetLang,
		prompt: "Provider failure proof",
		thumbnail: "",
		status: "error",
		stage: "failed",
		progress: 100,
		error: message,
		tier: "clean-pro",
		remoteJobId: `${jobId}-remote`,
		markerId,
		pageIndex,
		createdAt: Date.now(),
	};
	const marker: AiReviewMarker = {
		id: markerId,
		jobId,
		pageIndex,
		imageId: page.imageId,
		region: crop,
		status: "failed",
		tier: "clean-pro",
		providerHint: "studio-clean-provider",
		prompt: "Provider failure proof",
		error: message,
		assignee: "solo",
		createdAt: updatedAt,
		updatedAt,
	};

	aiJobsStore.queue = [failedJob, ...aiJobsStore.queue.filter((job) => job.id !== jobId)];
	project.aiReviewMarkers = [marker, ...(project.aiReviewMarkers ?? []).filter((item) => item.id !== marker.id)];
	projectStore.aiReviewMarkers = project.aiReviewMarkers;
	const focusMarker = project.aiReviewMarkers.find((item) =>
		item.id !== marker.id
		&& item.status !== "failed"
		&& Boolean(item.resultImageId)
	) ?? marker;
	projectStore.selectAiReviewMarker(focusMarker.id);
	projectStore.setStatusMsg(message);
	return getWorkflowDebugState();
}

function markChapterSetupSaveFailure(
	message = "สร้างงานแล้วแต่บันทึก/โหลดต่อไม่สำเร็จ: disk full กดลองบันทึกอีกครั้งก่อนปิดงาน",
): WorkflowDebugState {
	const project = seedProject({ projectId: "flow523-partial-setup" });
	project.name = "Flow523 Setup Failure";
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	projectStore.__setProjectForTesting(project);
	installAssetsForProject(project, {});
	projectStore.saveSyncStatus = "error";
	projectStore.saveErrorKind = "generic";
	projectStore.saveErrorMessage = message;
	projectStore.setStatusMsg(message);
	editorUiStore.openChapterSetup();
	return getWorkflowDebugState();
}

async function markAiRerunStaleImage(): Promise<WorkflowDebugState & { accepted: boolean }> {
	const project = projectStore.project;
	if (!project) throw new Error("Seed a workflow project before checking stale AI result rerun");
	const marker = projectStore.aiReviewMarkers[0];
	if (!marker) throw new Error("Seed an AI Review result before checking stale rerun");
	const accepted = await aiJobsStore.rerunAiReviewMarker(
		{
			...marker,
			imageId: `stale-${marker.imageId || project.pages[marker.pageIndex]?.imageId || "image"}`,
		},
		editorStore.editor,
	);
	return {
		...getWorkflowDebugState(),
		accepted,
	};
}

export function installWorkspaceDebug(): void {
	if (typeof window === "undefined") return;
	if (!import.meta.env.DEV && import.meta.env.VITE_E2E !== "1") return;

	window.__mangaWorkflowDebug = {
		seedProject: async (options: SeedOptions = {}) => {
			const project = seedProject(options);
			projectStore.__resetForTesting();
			editorUiStore.__resetForTesting();
			projectStore.__setProjectForTesting(project);
			installAssetsForProject(project, options);
			const { versions, detail } = seedVersions();
			projectStore.versions = versions;
			projectStore.versionDetail = detail;
			await loadDebugPage(project.currentPage);
			projectStore.__markCurrentPageCleanForTesting();
			return getWorkflowDebugState();
		},
		openPage: loadDebugPage,
		// PR #264 worker-race browser proof — navigate through the REAL projectStore
		// goToPage() path (waitForEditorBrushCommit + cancelImageToolDeferredReplay +
		// performLoadPage), unlike openPage() which calls editor.loadImage directly and
		// bypasses the nav-safety gate. Lets the spec assert nav WAITS for an in-flight
		// heal worker solve and never advances the page mid-solve. Returns the goToPage
		// boolean result so the spec can confirm the switch eventually happened.
		goToPageThroughStore: async (index: number) => {
			const editor = editorStore.editor;
			if (!editor) throw new Error("Seed a workflow project + editor before navigating");
			// The debug seed path (loadDebugPage) can leave isLoadingPage set; clear it so
			// the busy guard doesn't short-circuit this proof's real-nav call. This does not
			// touch the brush-commit gate (the thing under test) — it only mirrors the clean
			// post-load state the real app reaches after a page finishes loading.
			(projectStore as any).isLoadingPage = false;
			return projectStore.goToPage(index, editor);
		},
		addImportedDraftToCurrentPage: async () => {
			const project = projectStore.project;
			const editor = editorStore.editor;
			if (!project || !editor) throw new Error("Seed a workflow project before importing a draft");
			const page = project.pages[project.currentPage];
			const layer = pageLayer(`flow208-imported-${project.currentPage + 1}-${page.textLayers.length + 1}`, "The courier badge is glowing.", 220, 560, page.textLayers.length);
			page.textLayers = [...page.textLayers, layer];
			editor.addTextLayer(layer);
			editorStore.refreshTextLayers();
			projectStore.setStatusMsg(`Import ข้อความ 1 กล่อง หน้า ${project.currentPage + 1} แล้ว`);
			return getWorkflowDebugState();
		},
		markAiResultAccepted: () => {
			const marker = projectStore.aiReviewMarkers[0];
			if (marker) {
				marker.status = "accepted";
				marker.updatedAt = nowIso();
				projectStore.project!.aiReviewMarkers = [...projectStore.aiReviewMarkers];
				projectStore.selectAiReviewMarker(marker.id);
				projectStore.setStatusMsg("ยืนยันผล AI ผ่านแล้ว");
			}
			return getWorkflowDebugState();
		},
		clearAiReviewMarkerSelection: () => {
			projectStore.selectAiReviewMarker(null);
			return getWorkflowDebugState();
		},
		clearAiReviewMarkersForTesting: () => {
			if (projectStore.project) projectStore.project.aiReviewMarkers = [];
			projectStore.aiReviewMarkers = [];
			projectStore.selectAiReviewMarker(null);
			return getWorkflowDebugState();
		},
		addApprovedReviewDecision: () => {
			const project = projectStore.project;
			if (!project) throw new Error("Seed a workflow project before adding a review decision");
			const decision: PageReviewDecision = {
				id: `flow208-review-approved-${project.currentPage}`,
				pageIndex: project.currentPage,
				status: "approved",
				body: "หน้าตัวอย่างผ่าน Review แล้ว",
				actor: "lead",
				createdAt: nowIso(),
				updatedAt: nowIso(),
			};
			projectStore.reviewDecisions = [...projectStore.reviewDecisions, decision];
			project.reviewDecisions = projectStore.reviewDecisions;
			projectStore.selectReviewDecision(decision.id);
			projectStore.setStatusMsg(`ผ่านรีวิวหน้า ${project.currentPage + 1} แล้ว`);
			return getWorkflowDebugState();
		},
		setCurrentPageImageForTesting: (imageId: string, imageName: string, imageUrl: string) => {
			const project = projectStore.project;
			if (!project) throw new Error("Seed a workflow project before setting a page image");
			const page = project.pages[project.currentPage];
			if (!page) throw new Error("Open a page before setting a page image");
			page.imageId = imageId;
			page.imageName = imageName;
			page.originalName = imageName;
			project.coverImageId = imageId;
			project.coverOriginalName = imageName;
			projectStore.registerLocalImageUrl(imageId, imageUrl);
			projectStore.setStatusMsg(`ใช้รูปจริง ${imageName} แล้ว`);
			return getWorkflowDebugState();
		},
		markChapterExportReady,
		seedFinalQcPendingPage,
		seedApprovedReviewPendingFinalQc,
		seedReviewApprovalBlockedFinalQcPage,
		markAcceptedAiResultUnplaced,
		seedSamePageAiResultVariants,
		seedCrossPageAppliedAiResult,
		seedAiRailOverflowVariants,
		refreshLocalProjectSurfaces,
		exerciseLocalProjectActions,
		exerciseProjectStatusCopy,
		markAssetRecoveryError,
		markImageLayerAssetRecoveryError,
		exerciseProjectSwitchSaveFailure,
		exerciseAiResultCompletionFocusRetention,
		exportReadyChapterBatch,
		exportCurrentChapterBatchForTesting,
		addCurrentPageCreditTextForTesting,
		addCurrentPageCreditImageForTesting,
		setCurrentPageTextLayersForTesting,
		addArtifactFailedExportRun,
		addImageFailedExportRun,
		markImportRefreshFailure,
		markAiProviderFailure,
		markChapterSetupSaveFailure,
		markAiRerunStaleImage,
		seedDuplicateRecentProjects,
		markRecentProjectsError,
		markSaveConflict: () => {
			if (!projectStore.project) throw new Error("Seed a workflow project before marking a save conflict");
			projectStore.saveSyncStatus = "error";
			projectStore.saveErrorKind = "conflict";
			projectStore.saveErrorMessage = "งานถูกแก้จากที่อื่น";
			projectStore.setStatusMsg("โหลดใหม่ก่อน Save");
			return getWorkflowDebugState();
		},
		saveState: async () => {
			await projectStore.saveState();
			return getWorkflowDebugState();
		},
		markCurrentProjectClean: () => {
			projectStore.__markCurrentPageCleanForTesting();
			return getWorkflowDebugState();
		},
		reopenCurrentProjectFromBackend: async () => {
			const projectId = projectStore.project?.projectId;
			if (!projectId) throw new Error("Seed a workflow project before reopening it");
			const opened = await projectStore.openProject(projectId, editorStore.editor);
			return { ...getWorkflowDebugState(), opened };
		},
		// QA: open a REAL backend project by id through the live load path (used by
		// the editor-tools persistence proof to exercise upload + getImageUrl).
		openRealProject: async (projectId: string) => {
			const opened = await projectStore.openProject(projectId, editorStore.editor);
			return { ...getWorkflowDebugState(), opened };
		},
		getProjectState: () => projectStore.project,
		// QA: resolve the current page's effective image URL through the same
		// getImageUrl() the canvas loader uses. Lets the editor-tools persistence
		// proof assert the cached URL is durable (data:/server), never a revoked
		// blob:, after a tool commit + navigate-away-and-back.
		getCurrentPageImageUrl: () => {
			const project = projectStore.project;
			if (!project) return null;
			const page = project.pages[project.currentPage];
			if (!page) return null;
			const imageId = page.edits?.imageId || page.imageId;
			return projectStore.getImageUrl(imageId);
		},
		openView: (view: WorkspaceView) => {
			editorUiStore.setWorkspaceView(view);
			return getWorkflowDebugState();
		},
		openLibraryEntryEditor: (context?: Partial<WorkspaceEditorEntryContext>) => {
			const project = projectStore.project;
			const projectId = context?.projectId ?? project?.projectId ?? WORKSPACE_DEBUG_PROJECT_ID;
			editorUiStore.openEditor({
				source: "library",
				projectId,
				titleKey: context?.titleKey ?? WORKSPACE_DEBUG_TITLE_KEY,
				title: context?.title ?? project?.name ?? DEMO_PROJECT_NAME,
				chapterLabel: context?.chapterLabel ?? "ตอน 104",
				language: context?.language ?? "TH",
				reason: context?.reason ?? "แก้เลเยอร์จาก Library",
			});
			return getWorkflowDebugState();
		},
		getState: getWorkflowDebugState,
	};
}

export function uninstallWorkspaceDebug(): void {
	if (typeof window === "undefined") return;
	delete window.__mangaWorkflowDebug;
}

declare global {
	interface Window {
		__mangaWorkflowDebug?: {
			seedProject: (options?: SeedOptions) => Promise<WorkflowDebugState>;
			openPage: (pageIndex: number) => Promise<WorkflowDebugState>;
			goToPageThroughStore: (index: number) => Promise<boolean>;
			addImportedDraftToCurrentPage: () => Promise<WorkflowDebugState>;
			markAiResultAccepted: () => WorkflowDebugState;
			clearAiReviewMarkerSelection: () => WorkflowDebugState;
			clearAiReviewMarkersForTesting: () => WorkflowDebugState;
			addApprovedReviewDecision: () => WorkflowDebugState;
			setCurrentPageImageForTesting: (imageId: string, imageName: string, imageUrl: string) => WorkflowDebugState;
			markChapterExportReady: () => Promise<WorkflowDebugState>;
			seedFinalQcPendingPage: () => Promise<WorkflowDebugState>;
			seedApprovedReviewPendingFinalQc: () => Promise<WorkflowDebugState>;
			seedReviewApprovalBlockedFinalQcPage: () => Promise<WorkflowDebugState>;
			markAcceptedAiResultUnplaced: () => Promise<WorkflowDebugState & { markerId: string | null }>;
			seedSamePageAiResultVariants: () => Promise<WorkflowDebugState & { markerIds: string[] }>;
			seedCrossPageAppliedAiResult: () => Promise<WorkflowDebugState & { markerId: string }>;
			seedAiRailOverflowVariants: () => Promise<WorkflowDebugState & { markerIds: string[] }>;
			refreshLocalProjectSurfaces: () => Promise<WorkflowDebugState>;
			exerciseLocalProjectActions: () => Promise<WorkflowDebugState>;
			exerciseProjectStatusCopy: () => Promise<WorkflowDebugState & { statuses: string[] }>;
			markAssetRecoveryError: (pageIndex?: number) => WorkflowDebugState;
			markImageLayerAssetRecoveryError: (pageIndex?: number, issueCount?: number) => WorkflowDebugState;
			exerciseProjectSwitchSaveFailure: (currentId: string, nextId: string) => Promise<WorkflowDebugState>;
			exerciseAiResultCompletionFocusRetention: () => Promise<WorkflowDebugState & { selectedMarkerId: string | null; completedMarkerId: string }>;
			exportReadyChapterBatch: () => Promise<WorkflowDebugState>;
			exportCurrentChapterBatchForTesting: () => Promise<WorkflowDebugState>;
			addCurrentPageCreditTextForTesting: (text?: string, options?: CreditTextTestingOptions) => WorkflowDebugState & { creditLayerId: string | null };
			addCurrentPageCreditImageForTesting: (imageUrl: string, filename?: string, options?: CreditImageTestingOptions) => Promise<WorkflowDebugState & { creditLayerIds: string[] }>;
			setCurrentPageTextLayersForTesting: (layers: TextLayer[]) => WorkflowDebugState & { textLayerIds: string[] };
			addArtifactFailedExportRun: () => WorkflowDebugState;
			addImageFailedExportRun: () => WorkflowDebugState;
			markImportRefreshFailure: (message?: string) => WorkflowDebugState;
			markAiProviderFailure: () => WorkflowDebugState;
			markChapterSetupSaveFailure: (message?: string) => WorkflowDebugState;
			markAiRerunStaleImage: () => Promise<WorkflowDebugState & { accepted: boolean }>;
			seedDuplicateRecentProjects: () => WorkflowDebugState & { duplicateIds: string[] };
			markRecentProjectsError: (kind?: "network" | "api" | "generic") => WorkflowDebugState;
			markSaveConflict: () => WorkflowDebugState;
			saveState: () => Promise<WorkflowDebugState>;
			markCurrentProjectClean: () => WorkflowDebugState;
			reopenCurrentProjectFromBackend: () => Promise<WorkflowDebugState & { opened: boolean }>;
			openRealProject: (projectId: string) => Promise<WorkflowDebugState & { opened: boolean }>;
			getProjectState: () => ProjectState | null;
			getCurrentPageImageUrl: () => string | null;
			openView: (view: WorkspaceView) => WorkflowDebugState;
			openLibraryEntryEditor: (context?: Partial<WorkspaceEditorEntryContext>) => WorkflowDebugState;
			getState: () => WorkflowDebugState;
		};
	}
}
