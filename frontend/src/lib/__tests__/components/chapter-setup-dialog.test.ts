import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ChapterSetupDialog from "$lib/components/ChapterSetupDialog.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import type { Page, ProjectState } from "$lib/types.js";
import { ApiError, type WorkspaceRecord } from "$lib/api/client.ts";
import * as api from "$lib/api/client.ts";
import { ImageUploadBatchError } from "$lib/project/upload-batches.ts";

const now = "2026-05-20T00:00:00.000Z";

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		originalName: "page-1.webp",
		textLayers: [],
		imageLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Setup Chapter",
		createdAt: now,
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

function choosePageImage(container: HTMLElement): void {
	const input = container.querySelector<HTMLInputElement>("#chapter-setup-pages");
	if (!input) throw new Error("Missing page file input");
	fireEvent.change(input, {
		target: { files: [new File(["page"], "page-1.webp", { type: "image/webp" })] },
	});
}

function choosePageImages(container: HTMLElement, files: File[]): void {
	const input = container.querySelector<HTMLInputElement>("#chapter-setup-pages");
	if (!input) throw new Error("Missing page file input");
	fireEvent.change(input, { target: { files } });
}

async function fillTitle(name = "Moonlit Courier"): Promise<void> {
	await fireEvent.input(screen.getByLabelText("ชื่อเรื่อง"), { target: { value: name } });
}

// The target/source language fields are now searchable LanguagePicker comboboxes
// (a trigger button that opens a listbox of language options), not <select>s.
async function pickLanguage(triggerId: string, code: string): Promise<void> {
	const trigger = document.querySelector<HTMLButtonElement>(`#${triggerId}`);
	if (!trigger) throw new Error(`Missing language picker #${triggerId}`);
	await fireEvent.click(trigger);
	const search = await screen.findByRole("combobox");
	await fireEvent.input(search, { target: { value: code } });
	const option = await screen.findByRole("option", {
		name: new RegExp(code, "i"),
	});
	await fireEvent.click(option);
}

/** The currently selected code shown on a LanguagePicker trigger. */
function selectedLanguageCode(triggerId: string): string {
	const code = document.querySelector(`#${triggerId} .lang-picker-code`);
	return (code?.textContent ?? "").trim().toLowerCase();
}

async function continueToChapterStep(name = "Moonlit Courier"): Promise<void> {
	await fillTitle(name);
	await fireEvent.click(
		screen.queryByRole("button", { name: "ต่อไป: ตั้งตอน" })
			?? screen.getByRole("button", { name: "ต่อไป: อัปโหลดรูปหน้า" }),
	);
}

function installImagePreviewUrlStubs(): void {
	Object.defineProperty(URL, "createObjectURL", {
		configurable: true,
		value: vi.fn((file: Blob) => `blob:${(file as File).name}`),
	});
	Object.defineProperty(URL, "revokeObjectURL", {
		configurable: true,
		value: vi.fn(),
	});
}

beforeEach(() => {
	installImagePreviewUrlStubs();
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.editor = {
		loadImage: vi.fn().mockResolvedValue(undefined),
		addTextLayer: vi.fn(),
		addImageLayer: vi.fn().mockResolvedValue(undefined),
	};
	window.history.replaceState({}, "", "/library");
	vi.restoreAllMocks();
});

describe("ChapterSetupDialog", () => {
	it("requires a manga title before creating a new chapter", async () => {
		editorUiStore.openChapterSetup();
		const loadFilesWithSetup = vi.spyOn(projectStore, "loadFilesWithSetup");
		render(ChapterSetupDialog);

		await fireEvent.click(screen.getByRole("button", { name: "ต่อไป: ตั้งตอน" }));

		const titleInput = screen.getByLabelText("ชื่อเรื่อง");
		const titleError = screen.getByText("กรอกชื่อเรื่องก่อนสร้างตอน เพื่อให้คลังงานและรายการล่าสุดไม่เป็นตอนลอยๆ");
		expect(titleError).toBeTruthy();
		expect(titleInput.getAttribute("aria-invalid")).toBe("true");
		expect(titleInput.getAttribute("aria-describedby")).toBe("chapter-setup-title-error");
		await waitFor(() => expect(document.activeElement).toBe(titleInput));
		expect(loadFilesWithSetup).not.toHaveBeenCalled();
	});

	it("uses short empty file states that fit the setup dialog", () => {
		editorUiStore.openChapterSetup();
		render(ChapterSetupDialog);

		expect(screen.getByText("ยังไม่มีปก")).toBeTruthy();
		expect(screen.queryByText("ลากรูปภาพหน้าตอนมาวางที่นี่")).toBeNull();
		expect(screen.queryByText("ยังไม่มีรูปหน้า")).toBeNull();
		expect(screen.getByText("เรื่องหนึ่งเรื่องสามารถมีหลายตอนและหลายภาษาได้ ภายหลังจะเพิ่มตอนจากเรื่องนี้โดยไม่ต้องตั้งใหม่")).toBeTruthy();
		expect(screen.queryByText("ยังไม่ได้เลือกรูปปก")).toBeNull();
	});

	it("keeps background controls inert and blocks outside clicks while open", async () => {
		const backgroundAction = vi.fn();
		const backgroundButton = document.createElement("button");
		backgroundButton.type = "button";
		backgroundButton.textContent = "เปิดหน้าอื่น";
		backgroundButton.addEventListener("click", backgroundAction);
		document.body.append(backgroundButton);
		editorUiStore.openChapterSetup();
		render(ChapterSetupDialog);

		const dialog = screen.getByRole("dialog", { name: "ตั้งค่าตอนใหม่" });
		await waitFor(() => expect(backgroundButton.inert).toBe(true));
		expect(backgroundButton.getAttribute("aria-hidden")).toBe("true");
		await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("ชื่อเรื่อง")));

		backgroundButton.focus();
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
		await fireEvent.click(backgroundButton);

		expect(backgroundAction).not.toHaveBeenCalled();
		backgroundButton.remove();
	});

	it("cycles keyboard focus inside the setup owner and restores opener focus on cancel", async () => {
		const launcher = document.createElement("button");
		launcher.type = "button";
		launcher.textContent = "สร้างตอนใหม่";
		document.body.append(launcher);
		launcher.focus();
		editorUiStore.openChapterSetup();
		render(ChapterSetupDialog);

		const titleInput = screen.getByLabelText("ชื่อเรื่อง");
		const continueButton = screen.getByRole("button", { name: "ต่อไป: ตั้งตอน" });
		await waitFor(() => expect(document.activeElement).toBe(titleInput));
		expect(launcher.inert).toBe(true);

		continueButton.focus();
		await fireEvent.keyDown(document, { key: "Tab" });
		expect(document.activeElement).toBe(titleInput);
		await fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(continueButton);

		await fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));

		await waitFor(() => expect(editorUiStore.chapterSetupOpen).toBe(false));
		await waitFor(() => expect(launcher.inert).toBe(false));
		await waitFor(() => expect(document.activeElement).toBe(launcher));
		launcher.remove();
	});

	it("closes from Escape without leaving the background inert", async () => {
		const launcher = document.createElement("button");
		launcher.type = "button";
		launcher.textContent = "เพิ่มตอน";
		document.body.append(launcher);
		launcher.focus();
		editorUiStore.openChapterSetup();
		render(ChapterSetupDialog);

		await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("ชื่อเรื่อง")));
		expect(launcher.inert).toBe(true);

		await fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() => expect(editorUiStore.chapterSetupOpen).toBe(false));
		await waitFor(() => expect(launcher.inert).toBe(false));
		await waitFor(() => expect(document.activeElement).toBe(launcher));
		launcher.remove();
	});

	it("splits story setup from chapter setup before creating", async () => {
		editorUiStore.openChapterSetup();
		render(ChapterSetupDialog);

		expect(screen.getByText("ตั้งชื่อเรื่องก่อนสร้างตอน")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เลือกรูปหน้า" })).toBeNull();

		await continueToChapterStep("Moonlit Courier");

		expect(screen.getByText("สร้างตอนของเรื่องนี้")).toBeTruthy();
		expect(screen.getByLabelText("เรื่องที่กำลังสร้างตอน")).toBeTruthy();
		expect(screen.getByText("Moonlit Courier")).toBeTruthy();
		expect(screen.getAllByText("ยังไม่มีรูปหน้า").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("ลากรูปภาพหน้าตอนมาวางที่นี่")).toBeTruthy();
		expect(screen.getByText("เลือกได้หลายรูป ระบบเรียงหน้าให้อัตโนมัติตามชื่อไฟล์")).toBeTruthy();
		expect(screen.getAllByText("รอเลือกรูปหน้า").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("ยังไม่ได้เลือกรูปหน้า")).toBeNull();
		expect(screen.queryByText("ใช้รูปหน้าแรก")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "แก้เรื่อง" }));
		expect(screen.getByText("ตั้งชื่อเรื่องก่อนสร้างตอน")).toBeTruthy();
		expect((screen.getByLabelText("ชื่อเรื่อง") as HTMLInputElement).value).toBe("Moonlit Courier");
	});

	it("keeps the sticky footer honest about required setup fields", async () => {
		editorUiStore.openChapterSetup();
		const { container } = render(ChapterSetupDialog);

		expect(screen.getByRole("status").textContent).toBe("1 (จำเป็น): ชื่อเรื่อง");

		await continueToChapterStep("Moonlit Courier");

		expect(screen.getByRole("status").textContent).toBe("1 (จำเป็น): รูปหน้าของตอน");

		choosePageImage(container);

		expect(screen.queryByRole("status")).toBeNull();
	});

	it("makes the page-upload next action explicit for clean-start import intent", async () => {
		editorUiStore.openChapterSetup({
			mode: "create",
			completionView: "import-review",
		});
		render(ChapterSetupDialog);

		expect(screen.getByText("ตั้งชื่อเรื่อง แล้วอัปโหลดรูปหน้า")).toBeTruthy();
		expect(screen.getByText("2 อัปโหลดรูปหน้า")).toBeTruthy();
		const uploadPromise = screen.getByRole("region", { name: "ขั้นถัดไปอัปโหลดรูปหน้า" });
		expect(uploadPromise.textContent).toContain("อัปโหลดรูปหน้าตอนก่อน Import ข้อความ");
		expect(uploadPromise.textContent).toContain("Import / Review");
		expect(screen.getByRole("button", { name: "ต่อไป: อัปโหลดรูปหน้า" })).toBeTruthy();
		expect(screen.queryByText("ลากรูปภาพหน้าตอนมาวางที่นี่")).toBeNull();

		await continueToChapterStep("Moonlit Courier");

		expect(screen.getByText("สร้างตอนของเรื่องนี้")).toBeTruthy();
		expect(screen.getByText("ลากรูปภาพหน้าตอนมาวางที่นี่")).toBeTruthy();
		await waitFor(() => expect(document.activeElement).toBe(document.querySelector("#chapter-setup-pages")));
	});

	it("clears a canceled create/import draft before the next first-run setup", async () => {
		editorUiStore.openChapterSetup();
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImages(container, [
			new File(["old-a"], "old-01.webp", { type: "image/webp" }),
			new File(["old-b"], "old-02.webp", { type: "image/webp" }),
		]);
		await fireEvent.input(container.querySelector("#chapter-setup-number")!, { target: { value: "88" } });
		await fireEvent.input(container.querySelector("#chapter-setup-name")!, { target: { value: "Old Draft" } });
		await pickLanguage("chapter-setup-target-lang", "ja");
		expect(screen.getByText("2 รูปที่เลือกแล้ว")).toBeTruthy();
		expect(screen.getByAltText("หน้า 1: old-01.webp")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
		editorUiStore.openChapterSetup();

		await waitFor(() => expect(screen.getByText("ตั้งชื่อเรื่องก่อนสร้างตอน")).toBeTruthy());
		expect((screen.getByLabelText("ชื่อเรื่อง") as HTMLInputElement).value).toBe("");
		expect(screen.queryByText("2 รูปที่เลือกแล้ว")).toBeNull();
		expect(screen.queryByText("Moonlit Courier - ตอน 88 - Old Draft")).toBeNull();
		expect(screen.queryByAltText("หน้า 1: old-01.webp")).toBeNull();

		await continueToChapterStep("Fresh Story");
		expect((container.querySelector("#chapter-setup-number") as HTMLInputElement).value).toBe("1");
		expect((container.querySelector("#chapter-setup-name") as HTMLInputElement).value).toBe("");
		expect(selectedLanguageCode("chapter-setup-target-lang")).toBe("th");
		expect(screen.getAllByText("ยังไม่มีรูปหน้า").length).toBeGreaterThanOrEqual(1);
	});

	it("resets selected-title setup when adding a chapter from another Library story", async () => {
		editorUiStore.openChapterSetup({
			mode: "add-chapter-to-title",
			titleKey: "moonlit-courier",
			titleName: "Moonlit Courier",
			targetLang: "en",
		});
		const { container } = render(ChapterSetupDialog);

		choosePageImages(container, [
			new File(["old"], "moonlit-12.webp", { type: "image/webp" }),
		]);
		await fireEvent.input(container.querySelector("#chapter-setup-number")!, { target: { value: "12" } });
		expect(screen.getByText("Moonlit Courier - ตอน 12")).toBeTruthy();
		expect(screen.getByText("1 รูปที่เลือกแล้ว")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
		editorUiStore.openChapterSetup({
			mode: "add-chapter-to-title",
			titleKey: "storm-lantern",
			titleName: "Storm Lantern",
			targetLang: "ko",
		});

		await waitFor(() => expect(screen.getByText("เพิ่มตอนของ Storm Lantern")).toBeTruthy());
		expect(screen.queryByText("Moonlit Courier")).toBeNull();
		expect(screen.queryByText("1 รูปที่เลือกแล้ว")).toBeNull();
		expect((container.querySelector("#chapter-setup-number") as HTMLInputElement).value).toBe("1");
		expect(selectedLanguageCode("chapter-setup-target-lang")).toBe("ko");
		expect(screen.getByLabelText("เรื่องที่กำลังสร้างตอน").textContent).toContain("Storm Lantern");
	});

	it("restores selected-title context after canceling and reopening the same Library story", async () => {
		const sameStoryContext = {
			mode: "add-chapter-to-title" as const,
			titleKey: "moonlit-courier",
			titleName: "Moonlit Courier",
			targetLang: "en",
		};
		editorUiStore.openChapterSetup(sameStoryContext);
		const { container } = render(ChapterSetupDialog);

		await fireEvent.input(container.querySelector("#chapter-setup-number")!, { target: { value: "22" } });
		await fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
		editorUiStore.openChapterSetup(sameStoryContext);

		await waitFor(() => expect(screen.getByText("เพิ่มตอนของ Moonlit Courier")).toBeTruthy());
		expect((container.querySelector("#chapter-setup-number") as HTMLInputElement).value).toBe("1");
		expect(selectedLanguageCode("chapter-setup-target-lang")).toBe("en");
		expect(screen.getByLabelText("เรื่องที่กำลังสร้างตอน").textContent).toContain("Moonlit Courier");
	});

	it("adds a chapter to the selected library title without asking for the story again", async () => {
		editorUiStore.openChapterSetup({
			mode: "add-chapter-to-title",
			titleKey: "moonlit-courier",
			titleName: "Moonlit Courier",
			targetLang: "en",
		});
		const loadFilesWithSetup = vi.spyOn(projectStore, "loadFilesWithSetup").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "created-chapter",
				name: "Moonlit Courier - ตอน 12",
				targetLang: "en",
				pages: [page()],
			}));
		});
		const { container } = render(ChapterSetupDialog);

		expect(screen.getByText("เพิ่มตอนในเรื่องนี้")).toBeTruthy();
		expect(screen.getByText("เพิ่มตอนของ Moonlit Courier")).toBeTruthy();
		expect(screen.queryByLabelText("ชื่อเรื่อง")).toBeNull();
		expect(screen.getByLabelText("เรื่องที่กำลังสร้างตอน").textContent).toContain("Moonlit Courier");
		expect(screen.queryByRole("button", { name: "แก้เรื่อง" })).toBeNull();
		expect(selectedLanguageCode("chapter-setup-target-lang")).toBe("en");

		choosePageImage(container);
		await fireEvent.input(container.querySelector("#chapter-setup-number")!, { target: { value: "12" } });
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		expect(loadFilesWithSetup).toHaveBeenCalledWith(
			[expect.objectContaining({ name: "page-1.webp" })],
			editorStore.editor,
			expect.objectContaining({
				projectName: "Moonlit Courier - ตอน 12",
				targetLang: "en",
				storyId: "moonlit-courier",
				storyTitle: "Moonlit Courier",
				chapterNumber: "12",
				chapterLabel: "ตอน 12",
			}),
		);
		expect(editorUiStore.chapterSetupOpen).toBe(false);
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.workspaceEditorEntry).toMatchObject({
			source: "library",
			projectId: "created-chapter",
			titleKey: "moonlit-courier",
			title: "Moonlit Courier",
			chapterLabel: "ตอน 12",
			language: "en",
			reason: "สร้างตอนในเรื่องนี้",
		});
	});

	it("does not show setup recovery from an older project save error before create is attempted", () => {
		projectStore.__setProjectForTesting(project({
			projectId: "open-project",
			name: "Open Chapter",
		}));
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "generic";
		projectStore.statusMsg = "บันทึกงานเดิมไม่สำเร็จ: disk full";
		editorUiStore.openChapterSetup();

		render(ChapterSetupDialog);

		expect(screen.queryByRole("alert", { name: "สร้างตอนยังไม่ปลอดภัย" })).toBeNull();
		expect(screen.queryByText("สร้างตอนยังไม่บันทึกปลอดภัย")).toBeNull();
		expect(screen.queryByText("บันทึกงานเดิมไม่สำเร็จ: disk full")).toBeNull();
	});

	it("shows the ordered multi-page import contract before creating", async () => {
		editorUiStore.openChapterSetup();
		const loadFilesWithSetup = vi.spyOn(projectStore, "loadFilesWithSetup").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "created-chapter",
				name: "Moonlit Courier - ตอน 104",
				pages: [page()],
			}));
		});
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImages(container, [
			new File(["unsupported"], "notes.json", { type: "application/json" }),
			new File(["page"], "image-10.webp", { type: "image/webp" }),
			new File(["page"], "image-02.webp", { type: "image/webp" }),
			new File(["page"], "image-1.webp", { type: "image/webp" }),
		]);

		expect(screen.getByText("3 รูปที่เลือกแล้ว")).toBeTruthy();
		expect(screen.getByText("จะสร้างหน้า 1-3 ตามชื่อไฟล์: image-1.webp → image-10.webp")).toBeTruthy();
		expect(screen.getByText("ไฟล์ไม่รองรับ 1 ไฟล์: notes.json")).toBeTruthy();
		expect(screen.getByRole("region", { name: "ตัวอย่างรูปหน้าก่อนสร้างตอน" })).toBeTruthy();
		expect(screen.getByAltText("หน้า 1: image-1.webp")).toBeTruthy();
		expect(screen.getByAltText("หน้า 2: image-02.webp")).toBeTruthy();
		expect(screen.getByAltText("หน้า 3: image-10.webp")).toBeTruthy();

		await fireEvent.input(container.querySelector("#chapter-setup-number")!, { target: { value: "104" } });
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		expect(loadFilesWithSetup).toHaveBeenCalledWith(
			[
				expect.objectContaining({ name: "image-1.webp" }),
				expect.objectContaining({ name: "image-02.webp" }),
				expect.objectContaining({ name: "image-10.webp" }),
			],
			editorStore.editor,
			expect.objectContaining({
				projectName: "Moonlit Courier - ตอน 104",
				storyTitle: "Moonlit Courier",
				chapterNumber: "104",
				chapterLabel: "ตอน 104",
			}),
		);
		expect(editorUiStore.workspaceEditorEntry).toMatchObject({
			source: "library",
			projectId: "created-chapter",
			titleKey: "moonlit-courier",
			title: "Moonlit Courier",
			chapterLabel: "ตอน 104",
			language: "th",
			reason: "สร้างตอนใหม่",
		});
	});

	it("opens Import Review after creating from a clean-start import intent", async () => {
		editorUiStore.openChapterSetup({
			mode: "create",
			completionView: "import-review",
		});
		vi.spyOn(projectStore, "loadFilesWithSetup").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "created-import-chapter",
				name: "Moonlit Courier - ตอน 1",
				pages: [page()],
			}));
		});
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและไป Import / Review" }));

		expect(editorUiStore.chapterSetupOpen).toBe(false);
		expect(editorUiStore.workspaceView).toBe("import");
		expect(editorUiStore.workspaceEditorEntry).toBeNull();
		await waitFor(() => expect(window.location.pathname).toBe("/projects/created-import-chapter/import"));
	});

	it("owns the missing page-image error at the page picker", async () => {
		editorUiStore.openChapterSetup();
		const loadFilesWithSetup = vi.spyOn(projectStore, "loadFilesWithSetup");
		render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));
		const pagePicker = screen.getByText("เลือกรูปหน้า").closest(".file-field");
		const pageInput = pagePicker?.querySelector<HTMLInputElement>("#chapter-setup-pages");
		expect(screen.getByText("เลือกไฟล์รูปหน้าก่อนสร้างตอน")).toBeTruthy();
		expect(pageInput?.getAttribute("aria-invalid")).toBe("true");
		expect(pageInput?.getAttribute("aria-describedby")).toBe("chapter-setup-pages-error");
		await waitFor(() => expect(document.activeElement).toBe(pageInput));
		expect(loadFilesWithSetup).not.toHaveBeenCalled();
	});

	it("shows friendly oversize guidance when create-new upload throws a 413 ApiError", async () => {
		editorUiStore.openChapterSetup();
		vi.spyOn(projectStore, "loadFilesWithSetup").mockRejectedValue(
			new ApiError("Upload batch size limit exceeded", {
				status: 413,
				statusText: "Payload Too Large",
				code: "upload_batch_size_exceeded",
			}),
		);
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		await waitFor(() => {
			const err = container.querySelector(".setup-error")?.textContent ?? "";
			expect(err).toContain("ไฟล์รวมกันใหญ่เกินไป");
			expect(err).not.toContain("Upload batch size limit exceeded");
		});
	});

	it("shows the storage-full message (not oversize guidance) for a coded storage_quota_exceeded 413", async () => {
		editorUiStore.openChapterSetup();
		// In production the ApiError.message is already the formatted Thai storage
		// message; the dialog's friendlyUploadError falls through to error.message
		// because isUploadTooLargeError must EXCLUDE this coded 413.
		vi.spyOn(projectStore, "loadFilesWithSetup").mockRejectedValue(
			new ApiError("Storage ของเวิร์กสเปซเต็ม. ลบไฟล์หรือเพิ่ม storage ก่อนอัปโหลดต่อ.", {
				status: 413,
				statusText: "Payload Too Large",
				code: "storage_quota_exceeded",
			}),
		);
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		await waitFor(() => {
			const err = container.querySelector(".setup-error")?.textContent ?? "";
			expect(err).toContain("Storage ของเวิร์กสเปซเต็ม");
			expect(err).not.toContain("ไฟล์รวมกันใหญ่เกินไป");
		});
	});

	it("shows friendly oversize guidance when fill-existing upload throws a raw per-file 413", async () => {
		// A zero-page current project routes submit through fillEmptyProjectWithPages.
		projectStore.__setProjectForTesting(project({ projectId: "fill-1", pages: [] }));
		editorUiStore.openChapterSetup({ mode: "fill-existing-zero-page", projectId: "fill-1" });
		vi.spyOn(projectStore, "fillEmptyProjectWithPages").mockRejectedValue(
			new ApiError("File big.png exceeds 50MB limit", {
				status: 413,
				statusText: "Payload Too Large",
			}),
		);
		const { container } = render(ChapterSetupDialog);

		choosePageImage(container);
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มรูปและเปิดหน้า 1" }));

		await waitFor(() => {
			const err = container.querySelector(".setup-error")?.textContent ?? "";
			expect(err).toContain("ไฟล์รวมกันใหญ่เกินไป");
			expect(err).not.toContain("exceeds 50MB limit");
		});
	});

	it("keeps chapter number in the created project name when a custom chapter name is filled", async () => {
		editorUiStore.openChapterSetup();
		const loadFilesWithSetup = vi.spyOn(projectStore, "loadFilesWithSetup").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "created-chapter",
				name: "Moonlit Courier - ตอน 104 - Side Story",
			}));
		});
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		await fireEvent.input(container.querySelector("#chapter-setup-number")!, { target: { value: "104" } });
		await fireEvent.input(container.querySelector("#chapter-setup-name")!, { target: { value: "Side Story" } });

		expect(screen.getByText("Moonlit Courier - ตอน 104 - Side Story")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		expect(loadFilesWithSetup).toHaveBeenCalledWith(
			[expect.objectContaining({ name: "page-1.webp" })],
			editorStore.editor,
			expect.objectContaining({ projectName: "Moonlit Courier - ตอน 104 - Side Story" }),
		);
	});

	it("uses canonical target language codes when creating a chapter", async () => {
		editorUiStore.openChapterSetup();
		const loadFilesWithSetup = vi.spyOn(projectStore, "loadFilesWithSetup").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "created-ja-chapter",
				name: "Moonlit Courier - ตอน 12",
				targetLang: "ja",
			}));
		});
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		await fireEvent.input(container.querySelector("#chapter-setup-number")!, { target: { value: "12" } });
		// The searchable picker offers the common comic languages (incl. ja) and
		// flows the picked canonical code through to the setup metadata.
		await pickLanguage("chapter-setup-target-lang", "ja");
		expect(selectedLanguageCode("chapter-setup-target-lang")).toBe("ja");
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		expect(loadFilesWithSetup).toHaveBeenCalledWith(
			[expect.objectContaining({ name: "page-1.webp" })],
			editorStore.editor,
			expect.objectContaining({ targetLang: "ja" }),
		);
	});

	it("defaults reading direction to ltr (webtoon option removed) and flows source language to setup", async () => {
		editorUiStore.openChapterSetup();
		const loadFilesWithSetup = vi.spyOn(projectStore, "loadFilesWithSetup").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "created-chapter",
				name: "Moonlit Courier - ตอน 1",
				pages: [page()],
			}));
		});
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		// LTR (มันฮวา) is the active default before any user pick.
		const ltrOption = screen.getByRole("radio", { name: /ซ้ายไปขวา/ });
		expect(ltrOption.getAttribute("aria-checked")).toBe("true");
		// The webtoon/vertical continuous-strip option was removed from the picker.
		expect(screen.queryByRole("radio", { name: /เลื่อนแนวตั้ง/ })).toBeNull();
		// Source language is freely selectable, not hardcoded to ja.
		await pickLanguage("chapter-setup-source-lang", "ko");
		expect(selectedLanguageCode("chapter-setup-source-lang")).toBe("ko");
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		expect(loadFilesWithSetup).toHaveBeenCalledWith(
			[expect.objectContaining({ name: "page-1.webp" })],
			editorStore.editor,
			expect.objectContaining({ sourceLang: "ko", readingDirection: "ltr" }),
		);
	});

	it("blocks creating a chapter when more than 1000 page images are selected", async () => {
		editorUiStore.openChapterSetup();
		const loadFilesWithSetup = vi.spyOn(projectStore, "loadFilesWithSetup");
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		const tooMany = Array.from({ length: 1001 }, (_unused, index) =>
			new File(["p"], `page-${String(index + 1).padStart(4, "0")}.webp`, { type: "image/webp" }));
		choosePageImages(container, tooMany);

		expect(screen.getByRole("status").textContent).toContain("รูปหน้าของตอน");

		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		expect(screen.getByText(/เลือกรูปหน้าได้สูงสุด 1,000 หน้า/)).toBeTruthy();
		expect(loadFilesWithSetup).not.toHaveBeenCalled();
	});

	it("keeps page picking and reorder controls honest after selecting images", async () => {
		editorUiStore.openChapterSetup();
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImages(container, [
			new File(["page-a"], "page-a.webp", { type: "image/webp" }),
			new File(["page-b"], "page-b.webp", { type: "image/webp" }),
		]);

		expect(screen.queryByRole("button", { name: "เลือกรูปหน้า" })).toBeNull();
		expect(screen.getByText("เลือกรูปหน้า")).toBeTruthy();
		const moveLeftButtons = screen.getAllByRole("button", { name: "เลื่อนขึ้น" });
		const moveRightButtons = screen.getAllByRole("button", { name: "เลื่อนลง" });
		expect(moveLeftButtons).toHaveLength(1);
		expect(moveRightButtons).toHaveLength(1);
		expect(moveLeftButtons[0].hasAttribute("disabled")).toBe(false);
		expect(moveRightButtons[0].hasAttribute("disabled")).toBe(false);
		expect(container.querySelectorAll("button[disabled]")).toHaveLength(0);
	});

	it("fills the currently opened zero-page project instead of starting a new chapter", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "existing-empty",
			name: "Existing Empty Chapter",
			pages: [],
		}));
		editorUiStore.openChapterSetup({
			mode: "fill-existing-zero-page",
			projectId: "existing-empty",
			titleKey: "existing-title",
		});
		const fillExisting = vi.spyOn(projectStore, "fillEmptyProjectWithPages").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "existing-empty",
				name: "Existing Empty Chapter",
				storyId: "existing-title",
				storyTitle: "Existing Title",
				chapterLabel: "ตอน 1",
				pages: [page({ imageId: "filled-page.webp", imageName: "filled-page.webp" })],
			}));
			projectStore.statusMsg = "เพิ่มรูปเข้าโปรเจกต์นี้ 1 หน้าแล้ว";
		});
		const createNew = vi.spyOn(projectStore, "loadFilesWithSetup");

		const { container } = render(ChapterSetupDialog);
		choosePageImage(container);

		expect(screen.getByText("เติมรูปเข้าโปรเจกต์นี้")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มรูปและเปิดหน้า 1" }));

		expect(fillExisting).toHaveBeenCalledWith(
			[expect.objectContaining({ name: "page-1.webp" })],
			editorStore.editor,
			expect.objectContaining({ targetLang: "th" }),
		);
		expect(createNew).not.toHaveBeenCalled();
		expect(editorUiStore.chapterSetupOpen).toBe(false);
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.workspaceEditorEntry).toMatchObject({
			source: "library",
			projectId: "existing-empty",
			titleKey: "existing-title",
			title: "Existing Title",
			chapterLabel: "ตอน 1",
			language: "th",
			reason: "เพิ่มรูปหน้าแล้ว",
		});
		await waitFor(() => expect(window.location.pathname).toBe("/projects/existing-empty/pages/1/editor"));
	});

	it("retries a failed zero-page fill save before opening the editor", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "existing-empty",
			name: "Existing Empty Chapter",
			pages: [],
		}));
		editorUiStore.openChapterSetup({
			mode: "fill-existing-zero-page",
			projectId: "existing-empty",
			titleKey: "existing-title",
		});
		vi.spyOn(projectStore, "fillEmptyProjectWithPages").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "existing-empty",
				name: "Existing Empty Chapter",
				pages: [page({ imageId: "filled-page.webp", imageName: "filled-page.webp" })],
			}));
			projectStore.saveSyncStatus = "error";
			projectStore.saveErrorKind = "generic";
			projectStore.statusMsg = "เพิ่มรูปแล้วแต่บันทึกไม่สำเร็จ: disk full";
		});
		vi.spyOn(projectStore, "saveCurrentPage").mockImplementation(async () => {
			projectStore.saveSyncStatus = "saved";
			projectStore.saveErrorKind = null;
			projectStore.statusMsg = "บันทึกหน้า 1 แล้ว";
		});
		const loadPage = vi.spyOn(projectStore, "loadPage").mockResolvedValue(true);

		const { container } = render(ChapterSetupDialog);
		choosePageImage(container);

		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มรูปและเปิดหน้า 1" }));

		expect(screen.getByRole("alert", { name: "สร้างตอนยังไม่ปลอดภัย" })).toBeTruthy();
		expect(screen.getByText("เพิ่มรูปแล้วแต่บันทึกไม่สำเร็จ: disk full")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ลองบันทึกอีกครั้ง" }));

		expect(projectStore.saveCurrentPage).toHaveBeenCalledWith(editorStore.editor);
		expect(loadPage).toHaveBeenCalledWith(0, editorStore.editor);
		expect(editorUiStore.chapterSetupOpen).toBe(false);
		expect(editorUiStore.workspaceView).toBe("editor");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/existing-empty/pages/1/editor"));
	});

	it("keeps setup open with a recovery card when initial project save fails", async () => {
		editorUiStore.openChapterSetup();
		vi.spyOn(projectStore, "loadFilesWithSetup").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "partial-project",
				name: "Half Saved Chapter",
			}));
			projectStore.saveSyncStatus = "error";
			projectStore.saveErrorKind = "generic";
			projectStore.statusMsg = "สร้างงานแล้วแต่บันทึก/โหลดต่อไม่สำเร็จ: disk full กดลองบันทึกอีกครั้งก่อนปิดงาน";
		});

		const { container } = render(ChapterSetupDialog);
		await continueToChapterStep();
		choosePageImage(container);

		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(editorUiStore.workspaceView).not.toBe("editor");
		expect(screen.getByRole("alert", { name: "สร้างตอนยังไม่ปลอดภัย" })).toBeTruthy();
		expect(screen.getByText("สร้างตอนยังไม่บันทึกปลอดภัย")).toBeTruthy();
		expect(screen.getByText(/disk full/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "ลองบันทึกอีกครั้ง" })).toBeTruthy();
		expect(window.location.pathname).toBe("/library");
	});

	it("retries a partial setup save before opening the editor", async () => {
		editorUiStore.openChapterSetup();
		vi.spyOn(projectStore, "loadFilesWithSetup").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "partial-project",
				name: "Half Saved Chapter",
			}));
			projectStore.saveSyncStatus = "error";
			projectStore.saveErrorKind = "generic";
			projectStore.statusMsg = "สร้างงานแล้วแต่บันทึก/โหลดต่อไม่สำเร็จ: disk full กดลองบันทึกอีกครั้งก่อนปิดงาน";
		});
		vi.spyOn(projectStore, "saveCurrentPage").mockImplementation(async () => {
			projectStore.saveSyncStatus = "saved";
			projectStore.saveErrorKind = null;
			projectStore.statusMsg = "บันทึกหน้า 1 แล้ว";
		});
		const loadPage = vi.spyOn(projectStore, "loadPage").mockResolvedValue(true);

		const { container } = render(ChapterSetupDialog);
		await continueToChapterStep();
		choosePageImage(container);

		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));
		await fireEvent.click(screen.getByRole("button", { name: "ลองบันทึกอีกครั้ง" }));

		expect(projectStore.saveCurrentPage).toHaveBeenCalledWith(editorStore.editor);
		expect(loadPage).toHaveBeenCalledWith(0, editorStore.editor);
		expect(editorUiStore.chapterSetupOpen).toBe(false);
		expect(editorUiStore.workspaceView).toBe("editor");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/partial-project/pages/1/editor"));
	});

	it("names the exact failed page span when a batch upload fails", async () => {
		editorUiStore.openChapterSetup();
		vi.spyOn(projectStore, "loadFilesWithSetup").mockRejectedValue(
			new ImageUploadBatchError(3, 4, new Error("เซิร์ฟเวอร์มีปัญหา")),
		);
		const { container } = render(ChapterSetupDialog);

		await continueToChapterStep("Moonlit Courier");
		choosePageImages(container, [
			new File(["p"], "page-1.webp", { type: "image/webp" }),
			new File(["p"], "page-2.webp", { type: "image/webp" }),
		]);
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		await waitFor(() => {
			const err = container.querySelector(".setup-error")?.textContent ?? "";
			expect(err).toContain("หน้า 3–4");
			expect(err).toContain("เซิร์ฟเวอร์มีปัญหา");
			expect(err).toContain("ลองอีกครั้ง");
		});
	});
});

// ── First-run workspace-scope guard (P1: create-guard bypass) ───────────────
// Adversarial re-review found the top-utility-bar Create button (and any other
// `openChapterSetup()` entry point) could bypass the dashboard CTA's gate and let
// the dialog submit an UNSCOPED create. The guard now lives at TWO robust points:
//   1. `openChapterSetup` defaults `requireScopedCreate: true` for `mode: "create"`,
//      so EVERY create entry point (top bar, command palette, library) carries it.
//   2. The dialog threads that flag + the live workspace id into the store create,
//      and the store ABORTS the create (no `api.createProject`) when no workspace
//      resolves — exactly the dashboard CTA's contract, now uniform across entries.
function seedResolvedWorkspace(workspaceId = "ws-live"): void {
	const record = {
		workspaceId,
		name: "Live Workspace",
		planId: "free",
		storageIncludedBytes: 0,
		storageExtraBytes: 0,
		createdAt: now,
		updatedAt: now,
		memberRole: "owner",
		memberScope: {},
	} as WorkspaceRecord;
	workspacesStore.workspaces = [record];
	workspacesStore.currentWorkspaceId = workspaceId;
	workspacesStore.status = "ready";
}

function clearResolvedWorkspace(): void {
	workspacesStore.workspaces = [];
	workspacesStore.currentWorkspaceId = null;
	workspacesStore.status = "idle";
	// The store guard also falls back to the persisted current-workspace id; clear it
	// so "no workspace resolved" is truly true for the bypass test.
	try {
		localStorage.removeItem("manga-editor.currentWorkspaceId");
	} catch {
		/* localStorage unavailable in this env — nothing to clear */
	}
}

describe("ChapterSetupDialog first-run scope guard", () => {
	it("defaults requireScopedCreate ON for a create opened from a non-dashboard entry (top utility bar)", () => {
		// Simulate the top-utility-bar Create button: a bare openChapterSetup() with no
		// explicit flag. The store must still receive the scope requirement.
		editorUiStore.openChapterSetup();
		expect(editorUiStore.chapterSetupContext.mode).toBe("create");
		expect(editorUiStore.chapterSetupContext.requireScopedCreate).toBe(true);
	});

	it("leaves requireScopedCreate OFF when filling an existing (already-scoped) project", () => {
		editorUiStore.openChapterSetup({ mode: "fill-existing-zero-page", projectId: "fill-1" });
		expect(editorUiStore.chapterSetupContext.requireScopedCreate).toBeFalsy();
	});

	it("threads requireScopedCreate + the live workspace id into the create call", async () => {
		seedResolvedWorkspace("ws-live");
		editorUiStore.openChapterSetup();
		const loadFilesWithSetup = vi
			.spyOn(projectStore, "loadFilesWithSetup")
			.mockResolvedValue(undefined);

		const { container } = render(ChapterSetupDialog);
		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		await waitFor(() => expect(loadFilesWithSetup).toHaveBeenCalledTimes(1));
		const setup = loadFilesWithSetup.mock.calls[0][2];
		expect(setup?.requireScopedCreate).toBe(true);
		expect(setup?.workspaceId).toBe("ws-live");

		clearResolvedWorkspace();
	});

	it("BLOCKS an unscoped create from a non-dashboard entry: the real store guard aborts before api.createProject", async () => {
		// No workspace resolved (the orphan-prone first-run window). The dialog must NOT
		// be able to mint an unscoped project: with requireScopedCreate threaded + no
		// resolvable workspace id, the REAL store guard aborts before any API call.
		clearResolvedWorkspace();
		const createProject = vi
			.spyOn(api, "createProject")
			.mockResolvedValue({ projectId: "should-not-be-created" });

		editorUiStore.openChapterSetup();
		const { container } = render(ChapterSetupDialog);
		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		// The guard fired: no project was created and the editor never opened.
		await waitFor(() => expect(projectStore.statusMsg).toContain("กำลังตั้งค่าเวิร์กสเปซ"));
		expect(createProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).not.toBe("editor");

		createProject.mockRestore();
	});

	it("ALLOWS a normal create once a workspace IS resolved (guard does not false-block)", async () => {
		// A resolved workspace means the threaded scope requirement is satisfied: the
		// create proceeds (loadFilesWithSetup invoked) rather than being aborted. The
		// store-level guard (project-first-run-scope-guard.test.ts) owns the real
		// createProject ALLOW path; here we only assert the dialog does not pre-block.
		seedResolvedWorkspace("ws-live");
		const loadFilesWithSetup = vi
			.spyOn(projectStore, "loadFilesWithSetup")
			.mockResolvedValue(undefined);

		editorUiStore.openChapterSetup();
		const { container } = render(ChapterSetupDialog);
		await continueToChapterStep("Moonlit Courier");
		choosePageImage(container);
		await fireEvent.click(screen.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }));

		await waitFor(() => expect(loadFilesWithSetup).toHaveBeenCalledTimes(1));
		const setup = loadFilesWithSetup.mock.calls[0][2];
		expect(setup?.requireScopedCreate).toBe(true);
		expect(setup?.workspaceId).toBe("ws-live");

		clearResolvedWorkspace();
	});
});
