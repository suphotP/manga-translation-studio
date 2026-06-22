import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import * as api from "$lib/api/client.ts";
// Register locale dictionaries so the panel's `$_(...)` hint keys resolve to real
// strings (test-setup forces the active locale to Thai).
import "$lib/i18n";
import AiModeContainer from "$lib/components/AiModeContainer.svelte";
import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiTier, Page, ProjectState } from "$lib/types.js";

const now = "2026-05-12T12:34:00.000Z";

const labels = {
	aiTranslation: "AI แปล SFX",
	language: "ภาษาเป้าหมาย",
	sfx: "SFX",
	generate: "สร้างผล AI",
	customPrompt: "คำสั่งเสริม",
	customPromptPlaceholder: "บอก AI เพิ่มเติม...",
};

vi.mock("$lib/api/client.ts", () => ({
	getAiCapabilities: vi.fn(),
	// authStore (imported transitively) registers a refresh handler at load.
	setAuthRefreshHandler: vi.fn(),
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

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "AI mode test",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

function resetStores(): void {
	vi.restoreAllMocks();
	aiJobsStore.__resetForTesting();
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.currentTool = "brush";
	editorStore.selectedLayer = null;
	editorStore.selectedImageLayer = null;
	editorStore.textLayers = [];
	editorStore.editor = {
		setBrushSize: vi.fn(),
		setBrushHardness: vi.fn(),
		setBrushOpacity: vi.fn(),
		setBrushMode: vi.fn(),
		clearEraserMask: vi.fn(),
		setBrushEnabled: vi.fn(),
		hasAiMaskBrushTarget: vi.fn(() => true),
		// A selected canvas region — handleGenerate's upfront guard requires a crop
		// at/above config.minCropSize before it proceeds to generateCover.
		getCoverCrop: vi.fn(() => ({ x: 0, y: 0, w: 200, h: 200 })),
	};
	editorStore.hasImage = true;
	editorStore.refreshBrushTarget();
}

beforeEach(() => {
	resetStores();
	vi.mocked(api.getAiCapabilities).mockResolvedValue({
		tiers: [
			{ id: "sfx-pro", label: "SFX Pro", provider: "python-worker", available: true, reason: null, detail: "SFX Pro ready via python-worker." },
			{ id: "clean-pro", label: "Clean Pro", provider: "gemini-3.1-flash-image-preview", available: true, reason: null, detail: "Clean Pro ready." },
			{ id: "budget-clean", label: "Budget Clean", provider: "gemini-2.5-flash-image", available: true, reason: null, detail: "Budget Clean ready." },
		],
	});
});

describe("AiModeContainer", () => {
	it.each([
		{
			tier: "sfx-pro" as AiTier,
			reason: "sfx_provider_unavailable",
			detail: "python-worker SFX provider is offline.",
			expected: "SFX Pro ยังใช้ไม่ได้: เปิด python-worker หรือ provider สำรองก่อน",
			rawLeak: "provider is offline",
		},
		{
			tier: "sfx-pro" as AiTier,
			reason: "sfx_worker_unreachable",
			detail: "SFX Pro is not available: Worker unreachable.",
			expected: "SFX Pro ยังใช้ไม่ได้: worker ยังไม่ตอบ",
			expectedRecovery: "เปิด แบ็กเอนด์ worker ที่:8001 หรือสลับไป provider สำรองก่อนรัน SFX.",
			rawLeak: "Worker unreachable",
		},
		{
			tier: "sfx-pro" as AiTier,
			reason: "sfx_worker_no_available_accounts",
			detail: "SFX Pro is not available: Worker has no available SFX accounts.",
			expected: "SFX Pro ยังใช้ไม่ได้: worker ไม่มีบัญชีพร้อมใช้",
			expectedRecovery: "เพิ่มหรือรีเฟรชบัญชี worker ที่พร้อมใช้งาน หรือสลับไป provider สำรองก่อนรัน SFX.",
			rawLeak: "no available SFX accounts",
		},
		{
			tier: "clean-pro" as AiTier,
			reason: "provider_disabled",
			detail: "Provider gemini-3.1-flash-image-preview is disabled by kill switch.",
			expected: "Clean Pro ถูกปิดชั่วคราวจากระบบควบคุม provider",
			rawLeak: "disabled by kill switch",
		},
		{
			tier: "budget-clean" as AiTier,
			reason: "adapter_pending",
			detail: "Adapter implementation pending.",
			expected: "Budget Clean ยังไม่มี adapter ที่พร้อมใช้งาน",
			rawLeak: "Adapter implementation pending",
		},
		{
			// First-run: no OpenAI image key configured. Must show an explicit setup-recovery
			// message + a pointer to the BYO/provider settings, NOT generic "provider ยังไม่พร้อม".
			tier: "clean-pro" as AiTier,
			reason: "openai_images_not_configured",
			detail: "Clean Pro requires OpenAI image generation to be enabled with an API key.",
			expected: "Clean Pro ยังใช้ไม่ได้: ยังไม่ได้ตั้งค่า OpenAI image API key",
			expectedRecovery: "ยังไม่ได้ตั้งค่า OpenAI image API key — เพิ่มคีย์ที่ Settings → Billing → BYO API key (/settings/billing) แล้วลองใหม่.",
			rawLeak: "requires OpenAI image generation",
		},
		])("keeps unavailable $reason provider status product-facing", async ({ tier, reason, detail, expected, expectedRecovery, rawLeak }) => {
		projectStore.__setProjectForTesting(project());
		editorStore.currentTool = "select";
		editorStore.refreshBrushTarget();
		aiJobsStore.setAiTier(tier);
		vi.mocked(api.getAiCapabilities).mockResolvedValue({
			tiers: [
				{
					id: "sfx-pro",
					label: "SFX Pro",
					provider: "python-worker",
					available: false,
					reason: tier === "sfx-pro" ? reason : "sfx_provider_unavailable",
					detail: tier === "sfx-pro" ? detail : "python-worker SFX provider is offline.",
				},
				{
					id: "clean-pro",
					label: "Clean Pro",
					provider: "gemini-3.1-flash-image-preview",
					available: false,
					reason: tier === "clean-pro" ? reason : "provider_disabled",
					detail: tier === "clean-pro" ? detail : "Provider gemini-3.1-flash-image-preview is disabled by kill switch.",
				},
				{
					id: "budget-clean",
					label: "Budget Clean",
					provider: "gemini-2.5-flash-image",
					available: false,
					reason: tier === "budget-clean" ? reason : "adapter_pending",
					detail: tier === "budget-clean" ? detail : "Adapter implementation pending.",
				},
			],
		});
		const { container } = render(AiModeContainer, { props: { labels } });

			expect(await screen.findAllByText(expected)).not.toHaveLength(0);
			if (expectedRecovery) {
				expect(screen.getAllByText(expectedRecovery).length).toBeGreaterThanOrEqual(1);
			}

		const optionText = Array.from(container.querySelectorAll("#ai-tier-select option"))
			.map((option) => option.textContent)
			.join(" ");
		expect(optionText).toContain("SFX Pro - ยังใช้ไม่ได้");
		expect(optionText).toContain("Clean Pro - ยังใช้ไม่ได้");
		expect(optionText).toContain("Budget Clean - ยังใช้ไม่ได้");
		expect(container.textContent).not.toContain(rawLeak);
	});

	it("marks scoped capability failures unavailable instead of falling back to enabled defaults", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.setTargetLang("th");
		aiJobsStore.setAiTier("clean-pro");
		vi.mocked(api.getAiCapabilities).mockRejectedValue(new Error("Forbidden"));

		const { container } = render(AiModeContainer, { props: { labels } });
		await waitFor(() => expect(screen.getByText("ต้องตั้งค่า")).toBeTruthy());
		await fireEvent.click(screen.getByRole("button", { name: /AI Clean พับอยู่/ }));

		await waitFor(() => {
			const optionText = Array.from(container.querySelectorAll("#ai-tier-select option"))
				.map((option) => option.textContent)
				.join(" ");
			expect(optionText).toContain("SFX Pro - ยังใช้ไม่ได้");
			expect(optionText).toContain("Clean Pro - ยังใช้ไม่ได้");
			expect(optionText).toContain("Budget Clean - ยังใช้ไม่ได้");
		});
		expect(container.textContent).toContain("Clean Pro ยังใช้ไม่ได้: ตรวจสิทธิ์หรือขอบเขตงานก่อน");
		expect(container.textContent).toContain("บัญชีนี้อาจไม่มีสิทธิ์รัน AI ในงานหรือภาษานี้");
	});

	it("uses the opened project's target language for scoped capabilities", async () => {
		const getAiCapabilities = vi.mocked(api.getAiCapabilities);
		projectStore.setTargetLang("en");
		projectStore.__setProjectForTesting(project({ projectId: "project-ja", targetLang: "ja" }));

		render(AiModeContainer, { props: { labels } });

		await waitFor(() => expect(getAiCapabilities).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-ja", lang: "ja" })));
		expect(projectStore.targetLang).toBe("ja");
	});

	it("refreshes tier capabilities when the active project or language changes", async () => {
		const getAiCapabilities = vi.mocked(api.getAiCapabilities);
		projectStore.__setProjectForTesting(project({ projectId: "project-1", targetLang: "th" }));
		projectStore.setTargetLang("th");

		render(AiModeContainer, { props: { labels } });

		await waitFor(() => expect(getAiCapabilities).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", lang: "th" })));
		projectStore.setTargetLang("ja");
		await waitFor(() => expect(getAiCapabilities).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", lang: "ja" })));
		projectStore.__setProjectForTesting(project({ projectId: "project-2", targetLang: "ja" }));
		await waitFor(() => expect(getAiCapabilities).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-2", lang: "ja" })));
	});

	it("owns tier, language, prompt, generation, and brush orchestration", async () => {
		projectStore.__setProjectForTesting(project());
		const generateCover = vi.spyOn(aiJobsStore, "generateCover").mockResolvedValue(undefined);
		const setTool = vi.spyOn(editorStore, "setTool").mockImplementation(() => {});
		const { container } = render(AiModeContainer, { props: { labels } });
		await waitFor(() => expect(api.getAiCapabilities).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", lang: "th" })));
		await fireEvent.click(screen.getByRole("button", { name: /AI แปล SFX พับอยู่/ }));

		await fireEvent.change(container.querySelector("#ai-language-select")!, {
			target: { value: "en" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "สลับ SFX" }));
		await fireEvent.change(container.querySelector("#ai-tier-select")!, {
			target: { value: "clean-pro" },
		});
		await fireEvent.input(container.querySelector("#ai-custom-prompt")!, {
			target: { value: "Clean only the balloon" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "ล้างพื้นที่" }));

		expect(screen.queryByRole("button", { name: "กู้คืนผล AI" })).toBeNull();
		expect((screen.getByRole("button", { name: "คืนผล AI เต็ม" }) as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.input(container.querySelector("#brush-size")!, {
			target: { value: "48" },
		});
		await fireEvent.input(container.querySelector("#brush-hardness")!, {
			target: { value: "70" },
		});
		await fireEvent.input(container.querySelector("#brush-opacity")!, {
			target: { value: "60" },
		});
		await fireEvent.click(screen.getByText("เครื่องมือโหมดเก่า"));
		await fireEvent.click(screen.getByRole("button", { name: "คืนผล AI เต็ม" }));

		expect(projectStore.targetLang).toBe("en");
		expect(aiJobsStore.aiTier).toBe("clean-pro");
		expect(aiJobsStore.sfxToggle).toBe(false);
		expect(generateCover).toHaveBeenCalledWith(editorStore.editor, "Clean only the balloon");
		expect(setTool).toHaveBeenCalledWith("select");
		expect(aiJobsStore.isGenerating).toBe(false);
		expect(editorStore.editor.setBrushSize).toHaveBeenCalledWith(48);
		expect(editorStore.editor.setBrushHardness).toHaveBeenCalledWith(70);
		expect(editorStore.editor.setBrushOpacity).toHaveBeenCalledWith(60);
		expect(editorStore.editor.setBrushMode).not.toHaveBeenCalledWith("restore");
		expect(editorStore.editor.clearEraserMask).toHaveBeenCalledTimes(1);
	});

	it("shows the region hint and skips the run when no canvas region is selected", async () => {
		projectStore.__setProjectForTesting(project());
		// No region: getCoverCrop returns null, so the run must not reach generateCover.
		editorStore.editor.getCoverCrop = vi.fn(() => null);
		const generateCover = vi.spyOn(aiJobsStore, "generateCover").mockResolvedValue(undefined);
		render(AiModeContainer, { props: { labels } });
		await waitFor(() => expect(api.getAiCapabilities).toHaveBeenCalled());
		// Expand the (collapsed) AI section so the run button is visible.
		await fireEvent.click(screen.getByRole("button", { name: /AI แปล SFX พับอยู่/ }));

		// The hint is not shown until the user actually attempts a run.
		expect(screen.queryByText("เลือกพื้นที่บนภาพก่อน")).toBeNull();

		// Default tier is sfx-pro, so the run button uses the generate label.
		await fireEvent.click(screen.getByRole("button", { name: labels.generate }));

		// No region → generateCover never fires, and a clear inline hint appears.
		expect(generateCover).not.toHaveBeenCalled();
		expect(screen.getByText("เลือกพื้นที่บนภาพก่อน")).toBeTruthy();
	});

	it("switches restore mode only when an image layer is selected", async () => {
		projectStore.__setProjectForTesting(project());
		editorStore.selectedImageLayer = {
			id: "image-layer-1",
			name: "Cleaned result",
			imageId: "result.png",
			imageName: "result.png",
			restoreImageId: "result-original.png",
			x: 100,
			y: 120,
			w: 320,
			h: 180,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "overlay",
		};
		editorStore.refreshBrushTarget();
		render(AiModeContainer, { props: { labels } });

		await fireEvent.click(screen.getByRole("button", { name: "คืนรอยปัด" }));

		expect(editorStore.editor.setBrushMode).toHaveBeenCalledWith("restore");
		expect(screen.getByRole("button", { name: "คืนรอยปัด" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("hides selected image restore mode until a restore source exists", () => {
		projectStore.__setProjectForTesting(project());
		editorStore.selectedImageLayer = {
			id: "image-layer-no-restore",
			name: "Clean target without restore",
			imageId: "target.png",
			imageName: "target.png",
			x: 100,
			y: 120,
			w: 320,
			h: 180,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "overlay",
		};
		editorStore.refreshBrushTarget();
		render(AiModeContainer, { props: { labels } });

		expect(screen.getByRole("button", { name: "ลบจากเลเยอร์" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "คืนรอยปัด" })).toBeNull();
		expect(screen.getByText("กู้คืนจะเปิดหลังจากเลเยอร์นี้มีรอยแปรงหรือต้นฉบับให้คืน")).toBeTruthy();
	});

	it("opens Layers in brush-pick mode and keeps selected brush target in Layers after choosing a layer", async () => {
		projectStore.__setProjectForTesting(project());
		editorStore.currentTool = "brush";
		editorStore.editor.hasAiMaskBrushTarget = vi.fn(() => false);
		editorStore.refreshBrushTarget();
		render(AiModeContainer, { props: { labels } });

		await fireEvent.click(screen.getAllByRole("button", { name: "เปิดแผงเลเยอร์" })[0]);
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.brushLayerPickIntent).toBe(true);

		editorUiStore.focusImageInspector("credit-layer-1");

		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.brushLayerPickIntent).toBe(false);
	});

	it("gates the quality selector to the plan's allowedAiQualities and snaps a locked selection down", async () => {
		projectStore.__setProjectForTesting(project());
		editorStore.currentTool = "select";
		editorStore.refreshBrushTarget();
		// Start on High, but the workspace is on a Free plan that only allows Low.
		aiJobsStore.setAiQuality("high");
		vi.mocked(api.getAiCapabilities).mockResolvedValue({
			planScoped: true,
			plan: { scope: "project", projectId: "project-1", id: "free", name: "Free", allowedAiQualities: ["low"] },
			tiers: [
				{ id: "sfx-pro", label: "SFX Pro", provider: "python-worker", quality: "low", available: true, reason: null, detail: "ready" },
				{ id: "clean-pro", label: "Clean Pro", provider: "gemini", quality: "medium", available: true, reason: null, detail: "ready" },
				{ id: "budget-clean", label: "Budget Clean", provider: "gemini", quality: "low", available: true, reason: null, detail: "ready" },
			],
		});
		const { container } = render(AiModeContainer, { props: { labels } });

		// The AI section is expanded by default in select mode, so the quality
		// group renders without opening it.
		const group = await waitFor(() => {
			const node = container.querySelector('[aria-labelledby="ai-quality-select"]');
			expect(node).toBeTruthy();
			return node!;
		});
		// Selection snapped from high down to the only allowed quality (low).
		await waitFor(() => expect(aiJobsStore.aiQuality).toBe("low"));

		const mediumBtn = Array.from(group.querySelectorAll("button")).find((b) => b.textContent?.includes("กลาง")) as HTMLButtonElement;
		const highBtn = Array.from(group.querySelectorAll("button")).find((b) => b.textContent?.includes("สูง")) as HTMLButtonElement;
		expect(mediumBtn.disabled).toBe(true);
		expect(highBtn.disabled).toBe(true);

		// Clicking a locked quality keeps the allowed selection.
		await fireEvent.click(highBtn);
		expect(aiJobsStore.aiQuality).toBe("low");
	});

	it("uses shared AI submitting state for busy UI", () => {
		projectStore.__setProjectForTesting(project());
		aiJobsStore.setAiTier("clean-pro");
		aiJobsStore.setGenerating(true);
		editorStore.currentTool = "select";
		editorStore.refreshBrushTarget();

		render(AiModeContainer, { props: { labels } });

		expect(screen.getByRole("status", { name: /กำลังล้าง/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /กำลังล้าง/ })).toBeNull();
	});
});
