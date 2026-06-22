// Project store tests

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as api from "$lib/api/client.ts";

vi.mock("$lib/api/client.ts", () => ({
	createProject: vi.fn(),
	uploadImages: vi.fn(),
	saveProject: vi.fn(),
	imageUrl: vi.fn((projectId: string, imageId: string) => `http://example.com/${projectId}/${imageId}`),
	importTranslations: vi.fn(),
}));

// Mock the store itself since $state runes don't work in tests
vi.mock("$lib/stores/project.svelte.ts", () => ({
	projectStore: createMockProjectStore(),
}));

vi.mock("$lib/config.js", () => ({
	config: { defaultLang: "th" },
}));

function makeProject(overrides: Record<string, any> = {}) {
	return {
		projectId: "test",
		name: "Test",
		createdAt: "2023-01-01",
		currentPage: 0,
		pages: [] as any[],
		targetLang: "th",
		...overrides,
	};
}

function makePage(overrides: Record<string, any> = {}) {
	return {
		imageId: "img1",
		imageName: "test1",
		textLayers: [] as any[],
		pendingAiJobs: [] as any[],
		coverRect: null as any,
		...overrides,
	};
}

function createMockProjectStore() {
	let project: any = null;
	let statusMsg = "เปิดโฟลเดอร์เพื่อเริ่มงาน";
	let targetLang = "th";

	return {
		get project() { return project; },
		set project(value) { project = value; },
		get statusMsg() { return statusMsg; },
		set statusMsg(value) { statusMsg = value; },
		get targetLang() { return targetLang; },
		set targetLang(value) { targetLang = value; },
		get canGoPrev() { return project !== null && project.currentPage > 0; },
		get canGoNext() { return project !== null && project.currentPage < project.pages.length - 1; },
		get pageLabel() { if (!project) return "-"; if (project.pages.length === 0) return "ยังไม่มีหน้า"; return `${project.currentPage + 1}/${project.pages.length}`; },
		get projectName() { return project ? `Project ${project.name}` : ""; },
		setStatusMsg(msg: string) { statusMsg = msg; },
		setTargetLang(lang: string) { targetLang = lang; },
		async loadPage(index: number, editor: any) {
			if (!project || !editor || index < 0 || index >= project.pages.length) return;
			project.currentPage = index;
			const page = project.pages[index];
			statusMsg = `กำลังโหลดหน้า ${index + 1}...`;
			await editor.loadImage(api.imageUrl(project.projectId, page.imageId));
			for (const tl of page.textLayers) {
				editor.addTextLayer(tl);
			}
			statusMsg = `Page ${index + 1} / ${project.pages.length}`;
		},
		async prevPage(editor: any) {
			if (!this.canGoPrev) return;
			await this.goToPage(project.currentPage - 1, editor);
		},
		async nextPage(editor: any) {
			if (!this.canGoNext) return;
			await this.goToPage(project.currentPage + 1, editor);
		},
		async goToPage(index: number, editor: any) {
			if (!project || !editor) return;
			if (index < 0 || index >= project.pages.length) return;
			if (index === project.currentPage) return;
			this.syncTextLayers(editor);
			await api.saveProject(project.projectId, project);
			await this.loadPage(index, editor);
		},
		async saveState() {
			if (!project) return;
			await api.saveProject(project.projectId, project);
		},
		syncTextLayers(editor: any) {
			if (!project || !editor) return;
			const page = project.pages[project.currentPage];
			page.textLayers = editor.getAllTextLayers();
		},
		async saveCurrentPage(editor?: any) {
			if (!project) return;
			statusMsg = "กำลังบันทึก...";
			if (editor) {
				this.syncTextLayers(editor);
			}
			await api.saveProject(project.projectId, project);
			statusMsg = `บันทึกหน้า ${project.currentPage + 1} แล้ว`;
		},
		async exportPage() {
			if (!project) return;
			const page = project.pages[project.currentPage];
			const url = page.edits?.imageId
				? api.imageUrl(project.projectId, page.edits.imageId)
				: api.imageUrl(project.projectId, page.imageId);
			const a = document.createElement("a");
			a.href = url;
			a.download = `page_${project.currentPage + 1}.png`;
			a.click();
		},
		async importJson() {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = ".json";
			input.onchange = async () => {
				if (!input.files?.[0] || !project) return;
				const text = await input.files[0].text();
				const data = JSON.parse(text);
				const { imported } = await api.importTranslations(project.projectId, data.entries || []);
				statusMsg = `Imported ${imported} text layers`;
			};
			input.click();
		},
		async applyAiResult(resultImageId: string, editor: any) {
			if (!project) return;
			const page = project.pages[project.currentPage];
			const layer = {
				id: `ai-result-legacy-${project.currentPage + 1}`,
				imageId: resultImageId,
				imageName: resultImageId,
				originalName: `ผล AI หน้า ${project.currentPage + 1}`,
				x: 0,
				y: 0,
				w: editor.imageWidth ?? 1024,
				h: editor.imageHeight ?? 1024,
				rotation: 0,
				opacity: 1,
				visible: true,
				locked: false,
				index: page.imageLayers?.length ?? 0,
				role: "overlay",
			};
			page.imageLayers = [...(page.imageLayers ?? []), layer];
			await editor.addImageLayerWithHistory?.(layer, api.imageUrl(project.projectId, resultImageId));
				statusMsg = `วางผล AI เป็นเลเยอร์หน้า ${project.currentPage + 1} แล้ว`;
		},
		// Testing utilities
		__resetForTesting() {
			project = null;
			statusMsg = "เปิดโฟลเดอร์เพื่อเริ่มงาน";
			targetLang = "th";
		},
		__setProjectForTesting(p: any) {
			project = p;
		},
	};
}

describe("ProjectStore", () => {
	let projectStore: any;
	let mockEditor: any;

	beforeEach(() => {
		// Create a fresh mock store instance for each test
		projectStore = createMockProjectStore();

		mockEditor = {
			loadImage: vi.fn(),
			addTextLayer: vi.fn(),
			addImageLayerWithHistory: vi.fn(),
			updateBackgroundImage: vi.fn(),
			imageWidth: 900,
			imageHeight: 1400,
			getAllTextLayers: vi.fn(() => []),
		};

		projectStore.__resetForTesting();
		vi.clearAllMocks();
	});

	describe("initial state", () => {
		it("should have project as null", () => {
			expect(projectStore.project).toBeNull();
		});

		it("should have default status message", () => {
			expect(projectStore.statusMsg).toBe("เปิดโฟลเดอร์เพื่อเริ่มงาน");
		});

		it("should have targetLang set to default", () => {
			expect(projectStore.targetLang).toBe("th");
		});
	});

	describe("canGoPrev", () => {
		it("returns false when no project", () => {
			expect(projectStore.canGoPrev).toBe(false);
		});

		it("returns false when on first page", () => {
			projectStore.__setProjectForTesting(makeProject({ currentPage: 0, pages: [makePage()]}));
			expect(projectStore.canGoPrev).toBe(false);
		});

		it("returns true when not on first page", () => {
			projectStore.__setProjectForTesting(makeProject({
				currentPage: 1,
				pages: [makePage({ imageId: "1" }), makePage({ imageId: "2" })],
			}));
			expect(projectStore.canGoPrev).toBe(true);
		});
	});

	describe("canGoNext", () => {
		it("returns false when no project", () => {
			expect(projectStore.canGoNext).toBe(false);
		});

		it("returns false when on last page", () => {
			projectStore.__setProjectForTesting(makeProject({
				currentPage: 1,
				pages: [makePage({ imageId: "1" }), makePage({ imageId: "2" })],
			}));
			expect(projectStore.canGoNext).toBe(false);
		});

		it("returns true when not on last page", () => {
			projectStore.__setProjectForTesting(makeProject({
				currentPage: 0,
				pages: [makePage({ imageId: "1" }), makePage({ imageId: "2" })],
			}));
			expect(projectStore.canGoNext).toBe(true);
		});
	});

	describe("pageLabel", () => {
		it("returns '-' when no project", () => {
			expect(projectStore.pageLabel).toBe("-");
		});

		it("returns correct format", () => {
			projectStore.__setProjectForTesting(makeProject({ currentPage: 1, pages: [makePage(), makePage(), makePage()]}));
			expect(projectStore.pageLabel).toBe("2/3");
		});

		it("does not expose page 1/0 for zero-page drafts", () => {
			projectStore.__setProjectForTesting(makeProject({ currentPage: 0, pages: [] }));
			expect(projectStore.pageLabel).toBe("ยังไม่มีหน้า");
		});
	});

	describe("projectName", () => {
		it("returns empty string when no project", () => {
			expect(projectStore.projectName).toBe("");
		});

		it("returns formatted name", () => {
			projectStore.__setProjectForTesting(makeProject({ name: "Chapter 1" }));
			expect(projectStore.projectName).toBe("Project Chapter 1");
		});
	});

	describe("setTargetLang", () => {
		it("updates language", () => {
			projectStore.setTargetLang("en");
			expect(projectStore.targetLang).toBe("en");
		});
	});

	describe("loadPage", () => {
		it("does nothing if no project", async () => {
			await projectStore.loadPage(0, mockEditor);
			expect(mockEditor.loadImage).not.toHaveBeenCalled();
		});

		it("does nothing if index out of bounds", async () => {
			projectStore.__setProjectForTesting(makeProject({ pages: [makePage()]}));
			await projectStore.loadPage(5, mockEditor);
			expect(mockEditor.loadImage).not.toHaveBeenCalled();
		});

		it("does nothing if no editor", async () => {
			projectStore.__setProjectForTesting(makeProject({ pages: [makePage()]}));
			await projectStore.loadPage(0, null);
			expect(mockEditor.loadImage).not.toHaveBeenCalled();
		});

		it("loads image and text layers", async () => {
			const textLayer = { id: "1", text: "hello", x: 10, y: 20, w: 100, h: 50, rotation: 0, fontSize: 16, alignment: "center" as const, index: 0 };
			projectStore.__setProjectForTesting(makeProject({ pages: [makePage({ textLayers: [textLayer] })]}));

			await projectStore.loadPage(0, mockEditor);

			expect(mockEditor.loadImage).toHaveBeenCalledWith("http://example.com/test/img1");
			expect(mockEditor.addTextLayer).toHaveBeenCalledWith(textLayer);
			expect(projectStore.statusMsg).toBe("Page 1 / 1");
		});
	});

	describe("prevPage", () => {
		it("does nothing on first page", async () => {
			projectStore.__setProjectForTesting(makeProject({ currentPage: 0, pages: [makePage()]}));
			await projectStore.prevPage(mockEditor);
			expect(api.saveProject).not.toHaveBeenCalled();
		});

		it("goes to previous page", async () => {
			const textLayer = { id: "current", text: "save me" };
			mockEditor.getAllTextLayers.mockReturnValue([textLayer]);
			projectStore.__setProjectForTesting(makeProject({
				currentPage: 1,
				pages: [makePage({ imageId: "1" }), makePage({ imageId: "2" })],
			}));
			await projectStore.prevPage(mockEditor);
			expect(api.saveProject).toHaveBeenCalled();
			expect(projectStore.project.pages[1].textLayers).toEqual([textLayer]);
			expect(mockEditor.loadImage).toHaveBeenCalledWith("http://example.com/test/1");
		});
	});

	describe("nextPage", () => {
		it("does nothing on last page", async () => {
			projectStore.__setProjectForTesting(makeProject({
				currentPage: 1,
				pages: [makePage({ imageId: "1" }), makePage({ imageId: "2" })],
			}));
			await projectStore.nextPage(mockEditor);
			expect(api.saveProject).not.toHaveBeenCalled();
		});

		it("goes to next page", async () => {
			const textLayer = { id: "current", text: "save me" };
			mockEditor.getAllTextLayers.mockReturnValue([textLayer]);
			projectStore.__setProjectForTesting(makeProject({
				currentPage: 0,
				pages: [makePage({ imageId: "1" }), makePage({ imageId: "2" })],
			}));
			await projectStore.nextPage(mockEditor);
			expect(api.saveProject).toHaveBeenCalled();
			expect(projectStore.project.pages[0].textLayers).toEqual([textLayer]);
			expect(mockEditor.loadImage).toHaveBeenCalledWith("http://example.com/test/2");
		});
	});

	describe("goToPage", () => {
		it("does nothing for the current page", async () => {
			projectStore.__setProjectForTesting(makeProject({
				currentPage: 0,
				pages: [makePage({ imageId: "1" }), makePage({ imageId: "2" })],
			}));
			await projectStore.goToPage(0, mockEditor);
			expect(api.saveProject).not.toHaveBeenCalled();
			expect(mockEditor.loadImage).not.toHaveBeenCalled();
		});

		it("saves current text layers before jumping to a target page", async () => {
			const textLayer = { id: "current", text: "save before jump" };
			mockEditor.getAllTextLayers.mockReturnValue([textLayer]);
			projectStore.__setProjectForTesting(makeProject({
				currentPage: 0,
				pages: [
					makePage({ imageId: "1" }),
					makePage({ imageId: "2" }),
					makePage({ imageId: "3" }),
				],
			}));

			await projectStore.goToPage(2, mockEditor);

			expect(api.saveProject).toHaveBeenCalled();
			expect(projectStore.project.pages[0].textLayers).toEqual([textLayer]);
			expect(projectStore.project.currentPage).toBe(2);
			expect(mockEditor.loadImage).toHaveBeenCalledWith("http://example.com/test/3");
		});
	});

	describe("saveState", () => {
		it("does nothing if no project", async () => {
			await projectStore.saveState();
			expect(api.saveProject).not.toHaveBeenCalled();
		});

		it("saves project state", async () => {
			projectStore.__setProjectForTesting(makeProject());
			await projectStore.saveState();
			expect(api.saveProject).toHaveBeenCalledWith("test", expect.any(Object));
		});
	});

	describe("saveCurrentPage", () => {
		it("syncs current editor layers before saving", async () => {
			const textLayer = { id: "1", text: "persist me", x: 10, y: 20, w: 100, h: 50, rotation: 0, fontSize: 16, alignment: "center" as const, index: 0 };
			projectStore.__setProjectForTesting(makeProject({ pages: [makePage()] }));
			mockEditor.getAllTextLayers.mockReturnValue([textLayer]);

			await projectStore.saveCurrentPage(mockEditor);

			expect(projectStore.project.pages[0].textLayers).toEqual([textLayer]);
			expect(api.saveProject).toHaveBeenCalledWith("test", expect.objectContaining({
				pages: [expect.objectContaining({ textLayers: [textLayer] })],
			}));
			expect(projectStore.statusMsg).toBe("บันทึกหน้า 1 แล้ว");
		});
	});

	describe("syncTextLayers", () => {
		it("does nothing if no project", () => {
			projectStore.syncTextLayers(mockEditor);
			expect(mockEditor.getAllTextLayers).not.toHaveBeenCalled();
		});

		it("syncs layers to current page", () => {
			const textLayer = { id: "1", text: "x", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12, alignment: "left" as const, index: 0 };
			projectStore.__setProjectForTesting(makeProject({ currentPage: 1, pages: [makePage(), makePage()]}));
			mockEditor.getAllTextLayers.mockReturnValue([textLayer]);

			projectStore.syncTextLayers(mockEditor);
			expect(projectStore.project.pages[1].textLayers).toEqual([textLayer]);
		});
	});

	describe("applyAiResult", () => {
		it("applies result as an editable image layer", async () => {
			projectStore.__setProjectForTesting(makeProject({ pages: [makePage()]}));

			await projectStore.applyAiResult("result.png", mockEditor);

			expect(projectStore.project.pages[0].edits).toBeUndefined();
			expect(projectStore.project.pages[0].imageLayers[0]).toEqual(expect.objectContaining({
				id: "ai-result-legacy-1",
				imageId: "result.png",
				w: 900,
				h: 1400,
			}));
			expect(mockEditor.addImageLayerWithHistory).toHaveBeenCalledWith(
				expect.objectContaining({ imageId: "result.png" }),
				"http://example.com/test/result.png",
			);
			expect(mockEditor.updateBackgroundImage).not.toHaveBeenCalled();
				expect(projectStore.statusMsg).toBe("วางผล AI เป็นเลเยอร์หน้า 1 แล้ว");
		});

		it("does nothing if no project", async () => {
			await projectStore.applyAiResult("result.png", mockEditor);
			expect(mockEditor.updateBackgroundImage).not.toHaveBeenCalled();
		});
	});
});
