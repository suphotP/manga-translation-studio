import type { ComponentProps } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import "$lib/i18n";
import AiModePanel from "$lib/components/AiModePanel.svelte";
import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
import type { BrushTargetState } from "$lib/stores/editor.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, AiTier, Page, ProjectState } from "$lib/types.js";

const now = "2026-05-20T00:00:00.000Z";

const aiMaskBrushTarget: BrushTargetState = {
	kind: "ai-mask",
	label: "ผล AI เก่า",
	labelCode: "aiMaskLegacy",
	title: "",
	titleCode: "flattenedLegacy",
	detail: "เส้นแปรงซ่อนเฉพาะผล AI ที่วางทับภาพฐานเดิม; การคืนผลเต็มจะเขียนภาพหน้าแก้ไขใหม่ ไม่ใช่การย้อนกลับไปต้นฉบับ.",
	scope: "แก้ผล AI ที่แบนบนหน้า",
	impact: "มีผลตอนบันทึกและ Export เป็นภาพหน้าแก้ไข",
	eraseLabelCode: "aiMaskHide",
	restoreLabelCode: "aiMaskRestore",
	restoreHint: "โหมดเก่าเดิมยังไม่รองรับกู้คืนด้วยแปรง ใช้คืนผล AI เต็มเมื่อต้องการเขียนผล AI ทั้งภาพลงหน้า",
	canBrush: true,
	canRestore: false,
	canClearMask: true,
	tone: "ready",
};

const selectedImageBrushTarget: BrushTargetState = {
	kind: "image-layer",
	label: "เลเยอร์รูปแก้ไข",
	labelCode: "imageLayer",
	title: "Cleaned AI result",
	titleCode: null,
	detail: "เส้นแปรงจะลบเฉพาะเนื้อภาพของเลเยอร์นี้และเผยภาพต้นฉบับข้างใต้.",
	scope: "แก้เฉพาะเลเยอร์นี้",
	impact: "มีผลตอนบันทึกและ Export",
	eraseLabelCode: "layerErase",
	restoreLabelCode: "layerRestore",
	restoreHint: "กู้คืนจากต้นฉบับของเลเยอร์ก่อนถูกแปรง.",
	canBrush: true,
	canRestore: true,
	canClearMask: false,
	tone: "ready",
};

type AiModePanelProps = ComponentProps<typeof AiModePanel>;

function baseProps(overrides: Partial<AiModePanelProps> = {}): AiModePanelProps {
	return {
		labels: {
			aiTranslation: "AI แปล SFX",
			language: "ภาษาเป้าหมาย",
			sfx: "SFX",
			generate: "สร้างผล AI",
			customPrompt: "คำสั่งเสริม",
			customPromptPlaceholder: "บอก AI เพิ่มเติม...",
		},
		projectOpen: true,
		languages: { en: "English", th: "Thai" },
		targetLang: "th",
		aiTier: "sfx-pro" as AiTier,
		aiTierOptions: [
			{ id: "sfx-pro" as AiTier, name: "SFX Pro", detail: "รีดรอว์ SFX หนัก" },
			{ id: "clean-pro" as AiTier, name: "Clean Pro", detail: "คลีนละเอียด" },
			{ id: "budget-clean" as AiTier, name: "Budget Clean", detail: "คลีนเร็ว" },
		],
		sfxEnabled: true,
		isGenerating: false,
		customPrompt: "",
		currentTool: "select",
		brushTarget: aiMaskBrushTarget,
		brushSize: 30,
		brushHardness: 50,
		brushOpacity: 100,
		brushMode: "erase",
		aiQuality: "medium",
		allowedAiQualities: ["low", "medium", "high"],
		planName: "Studio",
		onTargetLangChange: vi.fn(),
		onAiTierChange: vi.fn(),
		onAiQualityChange: vi.fn(),
		onToggleSfx: vi.fn(),
		onGenerate: vi.fn(),
		onCustomPromptChange: vi.fn(),
		onBrushSizeChange: vi.fn(),
		onBrushHardnessChange: vi.fn(),
		onBrushOpacityChange: vi.fn(),
		onBrushModeChange: vi.fn(),
		onClearBrushMask: vi.fn(),
		onSelectBrush: vi.fn(),
		onAddImageLayer: vi.fn(),
		onUseAiResultLayer: vi.fn(),
		onOpenLayers: vi.fn(),
		...overrides,
	};
}

function marker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "ai-marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 20, y: 30, w: 180, h: 120 },
		status: "needs_review",
		tier: "sfx-pro",
		resultImageId: "result-1.webp",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

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

function project(markers: AiReviewMarker[], overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "AI mode marker test",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: markers,
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		...overrides,
	};
}

beforeEach(() => {
	aiJobsStore.__resetForTesting();
	projectStore.__resetForTesting();
});

describe("AiModePanel", () => {
	it("starts AI controls with a focused run card before setup fields", () => {
		const { container } = render(AiModePanel, { props: baseProps() });

		const focusCard = screen.getByRole("region", { name: "โฟกัสงาน AI" });
		expect(within(focusCard).getByText("พร้อม")).toBeTruthy();
		expect(within(focusCard).getByText("AI Cover + ล้าง SFX")).toBeTruthy();
		expect(within(focusCard).getByRole("button", { name: "สร้างผล AI" })).toBeTruthy();

		const aiBody = container.querySelector("#ai-mode-controls")!;
		const languageField = container.querySelector("#ai-language-select")!.closest("div")!;
		expect(Array.from(aiBody.children).indexOf(focusCard)).toBeLessThan(Array.from(aiBody.children).indexOf(languageField));
	});

	it("promotes existing page AI results before provider setup when review work exists", async () => {
		projectStore.__setProjectForTesting(project([
			marker(),
			marker({ id: "ai-marker-2", jobId: "job-2", status: "accepted" }),
			marker({ id: "ai-marker-3", jobId: "job-3", status: "applied" }),
		]));
		const props = baseProps({
			aiTierOptions: [
				{
					id: "sfx-pro" as AiTier,
					name: "SFX Pro",
					detail: "รีดรอว์ SFX หนัก",
					available: false,
					availabilityReason: "worker_no_account",
					recoveryReason: "worker_no_account",
				},
			],
		});
		const { container } = render(AiModePanel, { props });

		const resultsHeader = screen.getByRole("button", { name: /ผล AI บนหน้านี้ เปิดอยู่/ });
		const setupHeader = screen.getByRole("button", { name: /AI แปล SFX พับอยู่/ });
		expect(resultsHeader.textContent).toContain("หน้านี้ 3 ผล");
		expect(resultsHeader.textContent).toContain("1 รอรีวิว");
		expect(resultsHeader.textContent).toContain("1 รอวาง");
		expect(screen.getByRole("region", { name: "คิวรีวิวผล AI" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "ผล AI ที่เลือก" })).toBeTruthy();
		expect(screen.getAllByText("AI 1").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("เพิ่มหรือรีเฟรชบัญชี worker ที่พร้อมใช้งาน หรือสลับไป provider สำรองก่อนรัน SFX.")).toBeNull();

		await fireEvent.click(setupHeader);
		expect(screen.getAllByText("บัญชีไม่พร้อม").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("เพิ่มหรือรีเฟรชบัญชี worker ที่พร้อมใช้งาน หรือสลับไป provider สำรองก่อนรัน SFX.").length).toBeGreaterThanOrEqual(1);

		const body = container;
		expect(Array.from(body.querySelectorAll(".panel-section")).indexOf(resultsHeader.closest(".panel-section")!)).toBeLessThan(
			Array.from(body.querySelectorAll(".panel-section")).indexOf(setupHeader.closest(".panel-section")!)
		);
	});

	it("keeps the AI queue collapsed while idle", () => {
		render(AiModePanel, { props: baseProps() });

		expect(screen.getByRole("button", { name: "คิว AI พับอยู่: คิวว่าง" })).toBeTruthy();
		expect(screen.getByText("ว่าง")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "โฟกัสคิว AI" })).toBeNull();
	});

	it("keeps resolved AI queue debt compact while AI Review owns decisions", async () => {
		projectStore.__setProjectForTesting(project([
			marker(),
			marker({
				id: "ai-marker-2",
				jobId: "job-2",
				status: "failed",
				tier: "clean-pro",
				region: { x: 110, y: 310, w: 280, h: 180 },
				error: "ระบบภาพตอบกลับไม่สำเร็จ",
			}),
		]));
		aiJobsStore.queue = [
			{
				id: "job-failed",
				projectId: "project-1",
				imageId: "image-1",
				crop: { x: 110, y: 310, w: 280, h: 180 },
				lang: "th",
				prompt: "Clean failed region",
				thumbnail: "",
				status: "error",
				stage: "failed",
				progress: 100,
				error: "ระบบภาพตอบกลับไม่สำเร็จ",
				tier: "clean-pro",
				pageIndex: 1,
				createdAt: 2,
			},
		] as any;
		render(AiModePanel, { props: baseProps() });

		const queueHeader = screen.getByRole("button", { name: "คิว AI พับอยู่: 1 ต้องดู" });
		expect(queueHeader).toBeTruthy();
		expect(screen.queryByRole("region", { name: "โฟกัสคิว AI" })).toBeNull();
		expect(screen.getByRole("region", { name: "ผล AI ที่เลือก" })).toBeTruthy();

		await fireEvent.click(queueHeader);
		const queueFocus = screen.getByRole("region", { name: "โฟกัสคิว AI" });
		expect(within(queueFocus).getByText("ต้องดู")).toBeTruthy();
		expect(within(queueFocus).getByText("ระบบภาพตอบกลับไม่สำเร็จ")).toBeTruthy();
	});

	it("renders SFX controls, brush controls, and delegates actions", async () => {
		const props = baseProps({ currentTool: "brush" });
		const { container } = render(AiModePanel, { props });
		await fireEvent.click(screen.getByRole("button", { name: /AI แปล SFX พับอยู่/ }));

		expect(screen.getByText("AI แปล SFX")).toBeTruthy();
		expect(screen.getByRole("button", { name: "สลับ SFX" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "สร้างผล AI" })).toBeTruthy();

		await fireEvent.change(container.querySelector("#ai-language-select")!, {
			target: { value: "en" },
		});
		await fireEvent.change(container.querySelector("#ai-tier-select")!, {
			target: { value: "budget-clean" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "สลับ SFX" }));
		await fireEvent.input(container.querySelector("#ai-custom-prompt")!, {
			target: { value: "Clean only the balloon" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "สร้างผล AI" }));

			expect(screen.getByRole("region", { name: "เป้าหมายแปรง" })).toBeTruthy();
			expect(screen.getAllByText("โหมดเก่าที่แบนบนหน้า").length).toBeGreaterThan(0);
			expect(screen.queryByRole("button", { name: "กู้คืนผล AI" })).toBeNull();
			expect(screen.getByText("กู้คืนด้วยแปรงยังไม่พร้อม")).toBeTruthy();
			expect(document.querySelectorAll(".brush-mode-toggle button:disabled")).toHaveLength(0);
			await fireEvent.click(screen.getByRole("button", { name: "ซ่อนผล AI" }));
		await fireEvent.click(screen.getByRole("button", { name: /นุ่ม/ }));
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

		expect(props.onTargetLangChange).toHaveBeenCalledWith("en");
		expect(props.onAiTierChange).toHaveBeenCalledWith("budget-clean");
		expect(props.onToggleSfx).toHaveBeenCalledTimes(1);
		expect(props.onCustomPromptChange).toHaveBeenCalledWith("Clean only the balloon");
		expect(props.onGenerate).toHaveBeenCalledTimes(1);
		expect(props.onBrushModeChange).toHaveBeenCalledWith("erase");
		expect(props.onBrushSizeChange).toHaveBeenCalledWith(42);
		expect(props.onBrushHardnessChange).toHaveBeenCalledWith(35);
		expect(props.onBrushOpacityChange).toHaveBeenCalledWith(70);
		expect(props.onBrushSizeChange).toHaveBeenCalledWith(48);
		expect(props.onBrushHardnessChange).toHaveBeenCalledWith(70);
		expect(props.onBrushOpacityChange).toHaveBeenCalledWith(60);
		expect(props.onClearBrushMask).toHaveBeenCalledTimes(1);
	});

	it("shows an actionable fail-closed brush commit warning when upload persistence fails", async () => {
		const props = baseProps({
			currentTool: "brush",
			brushCommitError: "quota",
		});
		render(AiModePanel, {
			props,
		});

		const alert = screen.getByRole("alert", { name: "บันทึกรอยแปรงไม่สำเร็จ" });
		expect(alert.textContent).toContain("กันบันทึกและ Export ไว้ก่อน");
		expect(alert.textContent).toContain("รอยแปรงยังไม่ถูกบันทึก");
		expect(alert.textContent).toContain("quota");
		expect(alert.textContent).toContain("เจ้าของรอยแปรง: ผล AI ทั้งภาพ");
		expect(alert.textContent).toContain("ถ้ายังต้องใช้โหมดเก่า ให้ปัดซ้ำ");
		expect(alert.textContent).toContain("หลังสำเร็จค่อยบันทึกหรือ Export อีกครั้ง");

		await fireEvent.click(within(alert).getByRole("button", { name: "กลับไปแปรงเดิม" }));
		await fireEvent.click(within(alert).getByRole("button", { name: "ดูเลเยอร์เป้าหมาย" }));
		await fireEvent.click(within(alert).getByRole("button", { name: "คืนผล AI เต็ม" }));

		expect(props.onSelectBrush).toHaveBeenCalledTimes(1);
		expect(props.onOpenLayers).toHaveBeenCalledTimes(1);
		expect(props.onClearBrushMask).toHaveBeenCalledTimes(1);
	});

	it("keeps selected image brush recovery scoped to the selected layer without legacy restore action", () => {
		render(AiModePanel, {
			props: baseProps({
				currentTool: "brush",
				brushTarget: selectedImageBrushTarget,
				brushCommitError: "quota",
			}),
		});

		const alert = screen.getByRole("alert", { name: "บันทึกรอยแปรงไม่สำเร็จ" });
		expect(alert.textContent).toContain("เจ้าของรอยแปรง: เลเยอร์รูปที่เลือก");
		expect(alert.textContent).toContain("กลับไปเลเยอร์เดิมแล้วปัดซ้ำจุดเล็กๆ");
		expect(within(alert).queryByRole("button", { name: "คืนผล AI เต็ม" })).toBeNull();
	});

	it("uses passive brush target guidance instead of disabled project actions", async () => {
		render(AiModePanel, {
			props: baseProps({
				projectOpen: false,
				currentTool: "brush",
				readyAiResultLabel: "ผล AI หน้า 1 พร้อมวางเป็นเลเยอร์แก้",
				brushTarget: {
					kind: "unavailable",
					label: "ยังไม่เลือกเลเยอร์",
					labelCode: "pickTarget",
					title: "",
					titleCode: "pickTarget",
					detail: "เลือกเลเยอร์รูปหรือผล AI เพื่อใช้แปรง ภาพฐานจะไม่ถูกแก้",
					scope: "ภาพฐานล็อกไว้",
					impact: "ยังไม่แตะงานบนหน้า",
					eraseLabelCode: "layerErase",
					restoreLabelCode: "layerRestore",
					restoreHint: "เลือกเลเยอร์รูปที่มีต้นฉบับก่อนใช้โหมดกู้คืน",
					canBrush: false,
					canRestore: false,
					canClearMask: false,
					tone: "blocked",
				} satisfies BrushTargetState,
			}),
		});

		expect(screen.getByText("เปิดตอนจากคลังก่อนเพิ่มเลเยอร์แก้ที่บันทึกได้")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "วางเลเยอร์ AI" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เพิ่มรูปแก้" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เปิดแผงเลเยอร์" })).toBeNull();
		expect(document.querySelectorAll(".brush-command-actions button:disabled")).toHaveLength(0);
	});

	it("uses passive brush recovery layer guidance when no project is open", async () => {
		render(AiModePanel, {
			props: baseProps({
				projectOpen: false,
				currentTool: "brush",
				brushCommitError: "quota",
			}),
		});

		const alert = screen.getByRole("alert", { name: "บันทึกรอยแปรงไม่สำเร็จ" });
		expect(within(alert).getByText("เปิดตอนก่อนดูเลเยอร์เป้าหมาย")).toBeTruthy();
		expect(within(alert).queryByRole("button", { name: "ดูเลเยอร์เป้าหมาย" })).toBeNull();
		expect(alert.querySelectorAll("button:disabled")).toHaveLength(0);
	});

	it("shows clean mode and protects unavailable actions", async () => {
		render(AiModePanel, {
			props: baseProps({
				projectOpen: false,
				aiTier: "budget-clean",
				currentTool: "select",
			}),
		});

		expect(screen.getByText("AI Clean")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "สลับ SFX" })).toBeNull();
		expect(screen.getByText("SFX เฉพาะ SFX Pro")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ล้างพื้นที่" })).toBeNull();
		expect(screen.getByText("เปิดงานก่อนรัน AI")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: /แปรงคลีน/ }));
		expect(screen.getByText("เปิดแปรงก่อนเริ่มลบ")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เปิดแปรง" }));
		expect(screen.getByText("เพิ่มรูปแก้/ผล AI เป็นเลเยอร์ก่อน แล้วแปรงจะลบเฉพาะเลเยอร์นั้น ไม่แตะภาพฐาน.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดแปรง" })).toBeTruthy();
	});

	it("blocks brush controls when no editable target is available", () => {
		render(AiModePanel, {
			props: baseProps({
				currentTool: "brush",
				brushTarget: {
					kind: "unavailable",
					label: "ยังไม่เลือกเลเยอร์",
					labelCode: "pickTarget",
					title: "",
					titleCode: "pickTarget",
					detail: "เลือกเลเยอร์รูปหรือผล AI เพื่อใช้แปรง ภาพฐานจะไม่ถูกแก้",
					scope: "ภาพฐานล็อกไว้",
					impact: "ยังไม่แตะงานบนหน้า",
					eraseLabelCode: "layerErase",
					restoreLabelCode: "layerRestore",
					restoreHint: "เลือกเลเยอร์รูปที่มีต้นฉบับก่อนใช้โหมดกู้คืน",
					canBrush: false,
					canRestore: false,
					canClearMask: false,
					tone: "blocked",
				} satisfies BrushTargetState,
			}),
		});

		const target = screen.getByRole("region", { name: "เป้าหมายแปรง" });
		expect(within(target).getByText("ยังไม่เลือกเลเยอร์")).toBeTruthy();
		expect(within(target).getByText("เลือกเลเยอร์รูปหรือผล AI")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ลบจากเลเยอร์" })).toBeNull();
		expect(screen.queryByRole("button", { name: "คืนรอยปัด" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ขอบคม 18px / 90%" })).toBeNull();
		expect(screen.getAllByRole("button", { name: "เพิ่มรูปแก้" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "เปิดแผงเลเยอร์" })).toHaveLength(1);
		expect(within(target).queryByRole("button", { name: "เพิ่มรูปแก้" })).toBeNull();
		expect(within(target).queryByRole("button", { name: "เปิดแผงเลเยอร์" })).toBeNull();
		expect(screen.queryByRole("button", { name: "คืนผล AI เต็ม" })).toBeNull();
	});

	it("offers a ready AI result as a brush layer from the no-target state", async () => {
		const props = baseProps({
			currentTool: "brush",
			readyAiResultLabel: "ผล AI หน้า 1 พร้อมวางเป็นเลเยอร์แก้",
			brushTarget: {
				kind: "unavailable",
				label: "ยังไม่เลือกเลเยอร์",
				labelCode: "pickTarget",
				title: "",
				titleCode: "pickTarget",
				detail: "เลือกเลเยอร์รูปหรือผล AI เพื่อใช้แปรง ภาพฐานจะไม่ถูกแก้",
				scope: "ภาพฐานล็อกไว้",
				impact: "ยังไม่แตะงานบนหน้า",
				eraseLabelCode: "layerErase",
				restoreLabelCode: "layerRestore",
				restoreHint: "เลือกเลเยอร์รูปที่มีต้นฉบับก่อนใช้โหมดกู้คืน",
				canBrush: false,
				canRestore: false,
				canClearMask: false,
				tone: "blocked",
			} satisfies BrushTargetState,
		});
		render(AiModePanel, { props });

		expect(screen.getAllByRole("button", { name: "วางเลเยอร์ AI" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "เพิ่มรูปแก้" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "เปิดแผงเลเยอร์" })).toHaveLength(1);
		expect(screen.getByText("ผล AI หน้า 1 พร้อมวางเป็นเลเยอร์แก้")).toBeTruthy();
		await fireEvent.click(screen.getAllByRole("button", { name: "วางเลเยอร์ AI" })[0]);
		expect(props.onUseAiResultLayer).toHaveBeenCalledTimes(1);
	});

	it("shows the selected image layer as the brush target", async () => {
		const props = baseProps({
			currentTool: "brush",
			brushTarget: selectedImageBrushTarget,
			brushMode: "restore",
		});
		render(AiModePanel, {
			props,
		});

		const target = screen.getByRole("region", { name: "เป้าหมายแปรง" });
		expect(within(target).getByText("เลเยอร์รูปแก้ไข")).toBeTruthy();
		expect(within(target).getByText("Cleaned AI result")).toBeTruthy();
		expect(within(target).getByText("กู้คืนจากต้นฉบับของเลเยอร์ก่อนถูกแปรง.")).toBeTruthy();
		const restoreButton = screen.getByRole("button", { name: "คืนรอยปัด" }) as HTMLButtonElement;
		expect(restoreButton.disabled).toBe(false);
		expect(restoreButton.getAttribute("aria-pressed")).toBe("true");
		await fireEvent.click(restoreButton);
		expect(props.onBrushModeChange).toHaveBeenCalledWith("restore");
		expect(screen.queryByRole("button", { name: "คืนผล AI เต็ม" })).toBeNull();
		expect(screen.getByText("มีผลตอนบันทึกและ Export. การลบจะสร้างภาพใหม่ให้เลเยอร์นี้ ไม่แก้ไฟล์ต้นฉบับหรือเลเยอร์อื่นที่ใช้รูปเดียวกัน.")).toBeTruthy();
	});

	it("shows the correct busy label while a clean job is running", () => {
		render(AiModePanel, {
			props: baseProps({
				aiTier: "clean-pro",
				isGenerating: true,
				currentTool: "select",
			}),
		});

		expect(screen.getByRole("status", { name: /กำลังล้าง/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /กำลังล้าง/ })).toBeNull();
	});

		it("lets unavailable provider modes be selected for recovery guidance before submit", () => {
			const props = baseProps({
				aiTier: "clean-pro",
				currentTool: "select",
			aiTierOptions: [
				{ id: "sfx-pro" as AiTier, name: "SFX Pro", detail: "รีดรอว์ SFX หนัก", available: true, provider: "python-worker", availabilityReason: "ready" },
				{
					id: "clean-pro" as AiTier,
					name: "Clean Pro",
					detail: "คลีนละเอียด",
					available: false,
					availabilityReason: "openrouter_key",
				},
			],
		});
		const { container } = render(AiModePanel, { props });

		const cleanOption = container.querySelector('option[value="clean-pro"]') as HTMLOptionElement;
		expect(cleanOption.disabled).toBe(false);
			expect(screen.getAllByText("Clean Pro ยังใช้ไม่ได้: ตั้งค่า OpenRouter API key ก่อน")).toHaveLength(2);
			expect(screen.queryByRole("button", { name: "ล้างพื้นที่" })).toBeNull();
			expect(screen.getByText("ตั้งค่าโหมดนี้ก่อนรัน")).toBeTruthy();
		});

		it("shows an actionable worker recovery card and disables SFX toggle when SFX worker is down", () => {
			const props = baseProps({
				aiTier: "sfx-pro",
				sfxEnabled: true,
				currentTool: "select",
				aiTierOptions: [
					{
						id: "sfx-pro" as AiTier,
						name: "SFX Pro",
						detail: "รีดรอว์ SFX หนัก",
						available: false,
						availabilityReason: "worker_unreachable",
						recoveryReason: "worker_unreachable",
					},
				],
			});
			render(AiModePanel, { props });

			expect(screen.getAllByText("worker ไม่ตอบ").length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText("ทางแก้ถัดไป")).toBeTruthy();
			expect(screen.getAllByText("เปิด แบ็กเอนด์ worker ที่:8001 หรือสลับไป provider สำรองก่อนรัน SFX.").length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByRole("button", { name: "สลับ SFX" })).toBeNull();
			expect(screen.getByText("SFX ยังไม่พร้อม")).toBeTruthy();
			expect(screen.queryByRole("button", { name: "สร้างผล AI" })).toBeNull();
			expect(screen.getByText("ตั้งค่าโหมดนี้ก่อนรัน")).toBeTruthy();
		});

		it("shows a distinct blocked state when SFX worker has no ready account", () => {
			const props = baseProps({
				aiTier: "sfx-pro",
				sfxEnabled: true,
				currentTool: "select",
				aiTierOptions: [
					{
						id: "sfx-pro" as AiTier,
						name: "SFX Pro",
						detail: "รีดรอว์ SFX หนัก",
						available: false,
						availabilityReason: "worker_no_account",
						recoveryReason: "worker_no_account",
					},
				],
			});
			render(AiModePanel, { props });

			expect(screen.getAllByText("บัญชีไม่พร้อม").length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText("เพิ่มหรือรีเฟรชบัญชี worker ที่พร้อมใช้งาน หรือสลับไป provider สำรองก่อนรัน SFX.").length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByRole("button", { name: "สลับ SFX" })).toBeNull();
			expect(screen.getByText("SFX ยังไม่พร้อม")).toBeTruthy();
			expect(screen.queryByRole("button", { name: "สร้างผล AI" })).toBeNull();
			expect(screen.getByText("ตั้งค่าโหมดนี้ก่อนรัน")).toBeTruthy();
		});

	it("summarizes failed queue jobs before dense job cards", () => {
		aiJobsStore.queue = [
			{
				id: "job-processing",
				projectId: "project-1",
				imageId: "image-1",
				crop: { x: 0, y: 0, w: 420, h: 240 },
				lang: "th",
				prompt: "Translate SFX",
				thumbnail: "",
				status: "processing",
				stage: "processing",
				progress: 60,
				tier: "sfx-pro",
				pageIndex: 2,
				createdAt: 1,
			},
			{
				id: "job-failed",
				projectId: "project-1",
				imageId: "image-1",
				crop: { x: 0, y: 0, w: 300, h: 180 },
				lang: "th",
				prompt: "Translate SFX",
				thumbnail: "",
				status: "error",
				stage: "failed",
				progress: 80,
				error: "Worker returned no result image",
				tier: "sfx-pro",
				pageIndex: 4,
				createdAt: 2,
			},
		];
		const { container } = render(AiModePanel, { props: baseProps() });

		expect(screen.getByRole("button", { name: "คิว AI เปิดอยู่: 1 กำลังรัน / 1 ต้องดู" })).toBeTruthy();
		const queueFocus = screen.getByRole("region", { name: "โฟกัสคิว AI" });
		expect(within(queueFocus).getByText("ต้องดู")).toBeTruthy();
		expect(within(queueFocus).getByText("หน้า 5 / 300x180 / ต้องแก้")).toBeTruthy();
		expect(within(queueFocus).getByText("Worker returned no result image")).toBeTruthy();
		expect(within(queueFocus).getByText("1/2 กำลังรัน")).toBeTruthy();

		const batchBody = container.querySelector("#ai-batch-queue-body")!;
		const firstJobCard = container.querySelector(".job-card")!;
		expect(Array.from(batchBody.children).indexOf(queueFocus)).toBeLessThan(Array.from(batchBody.children).indexOf(firstJobCard));
	});

	it("summarizes cancelled queue jobs separately from failures", () => {
		aiJobsStore.queue = [
			{
				id: "job-cancelled",
				projectId: "project-1",
				imageId: "image-1",
				crop: { x: 0, y: 0, w: 300, h: 180 },
				lang: "th",
				prompt: "Translate SFX",
				thumbnail: "",
				status: "cancelled",
				stage: "cancelled",
				progress: 30,
				error: "Cancelled before processing",
				tier: "sfx-pro",
				pageIndex: 4,
				createdAt: 2,
			},
		] as any;
		render(AiModePanel, { props: baseProps() });

		expect(screen.getByRole("button", { name: "คิว AI เปิดอยู่: 1 ต้องดู" })).toBeTruthy();
		const queueFocus = screen.getByRole("region", { name: "โฟกัสคิว AI" });
		expect(within(queueFocus).getByText("ยกเลิกแล้ว")).toBeTruthy();
		expect(within(queueFocus).getByText("หน้า 5 / 300x180 / ยกเลิกแล้ว")).toBeTruthy();
		expect(within(queueFocus).getByText("Cancelled before processing")).toBeTruthy();
		expect(within(queueFocus).getByText("1 ยกเลิก")).toBeTruthy();
	});

	it("keeps the completed queue clear action at the touch target floor", () => {
		aiJobsStore.queue = [
			{
				id: "job-completed",
				projectId: "project-1",
				imageId: "image-1",
				crop: { x: 0, y: 0, w: 300, h: 180 },
				lang: "th",
				prompt: "Translate SFX",
				thumbnail: "",
				status: "done",
				stage: "done",
				progress: 100,
				resultImageId: "result-1",
				tier: "sfx-pro",
				pageIndex: 0,
				createdAt: 1,
			},
		] as any;
		render(AiModePanel, { props: baseProps() });

		const clearButton = screen.getByRole("button", { name: "ล้างรายการเสร็จ" });
		expect(clearButton).toBeTruthy();
		expect((clearButton as HTMLButtonElement).style.minHeight).toBe("40px");
	});

	it("hides AI queue reorder controls when a pending job cannot move that direction", () => {
		aiJobsStore.queue = [
			{
				id: "job-pending-a",
				projectId: "project-1",
				imageId: "image-1",
				crop: { x: 0, y: 0, w: 120, h: 80 },
				lang: "th",
				prompt: "First",
				thumbnail: "",
				status: "pending",
				stage: "uploading",
				progress: 0,
				tier: "sfx-pro",
				pageIndex: 0,
				createdAt: 1,
			},
			{
				id: "job-pending-b",
				projectId: "project-1",
				imageId: "image-1",
				crop: { x: 0, y: 0, w: 160, h: 90 },
				lang: "th",
				prompt: "Second",
				thumbnail: "",
				status: "pending",
				stage: "uploading",
				progress: 0,
				tier: "sfx-pro",
				pageIndex: 0,
				createdAt: 2,
			},
		] as any;
		const { container } = render(AiModePanel, { props: baseProps() });

		expect(screen.getByRole("button", { name: "คิว AI เปิดอยู่: 2 รอคิว / 0 เสร็จ" })).toBeTruthy();
		expect(container.querySelectorAll(".job-actions button:disabled")).toHaveLength(0);
		expect(screen.getAllByRole("button", { name: "ขยับงานขึ้น" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "ขยับงานลง" })).toHaveLength(1);
	});

	it("renders a Low/Medium/High quality selector with credit costs and a credit icon (no baht)", () => {
		const { container } = render(AiModePanel, { props: baseProps() });

		const group = container.querySelector('[aria-labelledby="ai-quality-select"]')!;
		expect(group).toBeTruthy();
		const buttons = group.querySelectorAll(".ai-quality-btn");
		expect(buttons).toHaveLength(3);

		// Thai + English labels for ต่ำ/กลาง/สูง.
		expect(within(group as HTMLElement).getByText("ต่ำ")).toBeTruthy();
		expect(within(group as HTMLElement).getByText("กลาง")).toBeTruthy();
		expect(within(group as HTMLElement).getByText("สูง")).toBeTruthy();

		// Credit costs 1 / 9 / 36 are shown via CreditAmount (which renders the coin
		// glyph). The cost is in CREDITS — there must be no baht sign anywhere.
		expect(within(group as HTMLElement).getAllByText("1").length).toBeGreaterThanOrEqual(1);
		expect(within(group as HTMLElement).getAllByText("9").length).toBeGreaterThanOrEqual(1);
		expect(within(group as HTMLElement).getAllByText("36").length).toBeGreaterThanOrEqual(1);
		expect(group.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3);
		expect(group.textContent).not.toContain("฿");

		// Medium is the active selection by default.
		const mediumBtn = within(group as HTMLElement).getByText("กลาง").closest("button")!;
		expect(mediumBtn.getAttribute("aria-pressed")).toBe("true");
		expect(mediumBtn.classList.contains("active")).toBe(true);
	});

	it("sends the chosen quality through onAiQualityChange when a quality is picked", async () => {
		const props = baseProps();
		const { container } = render(AiModePanel, { props });

		const group = container.querySelector('[aria-labelledby="ai-quality-select"]')!;
		const highBtn = within(group as HTMLElement).getByText("สูง").closest("button")!;
		await fireEvent.click(highBtn);

		expect(props.onAiQualityChange).toHaveBeenCalledWith("high");
	});

	it("locks qualities not in the workspace plan with an upsell hint (Free plan)", async () => {
		const props = baseProps({
			aiQuality: "low",
			allowedAiQualities: ["low"],
			planName: "Free",
		});
		const { container } = render(AiModePanel, { props });

		const group = container.querySelector('[aria-labelledby="ai-quality-select"]')!;
		const lowBtn = within(group as HTMLElement).getByText("ต่ำ").closest("button")! as HTMLButtonElement;
		const mediumBtn = within(group as HTMLElement).getByText("กลาง").closest("button")! as HTMLButtonElement;
		const highBtn = within(group as HTMLElement).getByText("สูง").closest("button")! as HTMLButtonElement;

		expect(lowBtn.disabled).toBe(false);
		expect(mediumBtn.disabled).toBe(true);
		expect(highBtn.disabled).toBe(true);
		expect(mediumBtn.classList.contains("locked")).toBe(true);
		expect(highBtn.classList.contains("locked")).toBe(true);

		// Clicking a locked quality must not emit a change.
		await fireEvent.click(mediumBtn);
		expect(props.onAiQualityChange).not.toHaveBeenCalled();

		// Upsell hint names the plan.
		expect(screen.getByText(/อัปเกรดเพื่อใช้คุณภาพสูงขึ้น/)).toBeTruthy();
		expect(container.textContent).toContain("Free");
	});
});
