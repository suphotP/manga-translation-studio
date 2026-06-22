import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import "$lib/i18n";
import CanvasArea from "$lib/components/CanvasArea.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ProjectState } from "$lib/types.js";

function project(): ProjectState {
	return {
		projectId: "project-page-set",
		workspaceId: "workspace-1",
		name: "Realtime chapter",
		createdAt: "2026-06-12T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [
			{
				imageId: "page-1.webp",
				imageName: "page-1.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
	};
}

// The Fabric edit surface used to be a bare <canvas> with no accessible name.
// These assertions lock in the a11y wrapper: a labelled group, a description, an
// aria-live status region, and a canvas with an accessible name + fallback text.
describe("CanvasArea accessibility", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		projectStore.__resetForTesting();
		editorUiStore.__resetForTesting();
		editorStore.editor = null;
	});

	it("labels the canvas edit surface and exposes a description + live status", () => {
		render(CanvasArea, { canvasRef: undefined });

		// Labelled wrapper group naming the edit surface.
		const group = screen.getByRole("group", { name: "พื้นที่แก้ไขหน้า manga" });
		expect(group.getAttribute("aria-describedby")).toBe("canvas-a11y-desc");
		expect(document.getElementById("canvas-a11y-desc")?.textContent?.trim().length).toBeGreaterThan(0);

		// The canvas itself carries an accessible name via aria-label, plus fallback
		// text for non-visual / no-Fabric contexts.
		const canvas = group.querySelector("canvas");
		expect(canvas).toBeTruthy();
		expect(canvas?.getAttribute("aria-label")).toBe("พื้นที่แก้ไขหน้า manga");
		expect(canvas?.textContent?.trim().length).toBeGreaterThan(0);

		// A polite live region announces page/tool/selection status.
		const status = screen.getByRole("status");
		expect(status.getAttribute("aria-live")).toBe("polite");
		expect(status.textContent?.trim().length).toBeGreaterThan(0);
	});

	it("offers a focusable keyboard path into the layer inspector", () => {
		render(CanvasArea, { canvasRef: undefined });
		const link = screen.getByRole("button", {
			name: "เปิดแผงเลเยอร์เพื่อจัดการเลเยอร์ด้วยคีย์บอร์ด",
		});
		expect(link).toBeTruthy();
	});

	it("reloads the project with a recovery copy from the page-set changed banner", async () => {
		editorUiStore.setWorkspaceView("editor");
		projectStore.__setProjectForTesting(project());
		projectStore.pageSetChangedNotice = {
			projectId: "project-page-set",
			changedBy: "user-other",
			pageCount: 2,
			receivedAt: Date.now(),
		};
		editorStore.editor = { marker: "editor" } as any;
		const reload = vi.spyOn(projectStore, "reloadProjectAfterConflict").mockResolvedValue(true);

		render(CanvasArea, { canvasRef: undefined });
		expect(screen.getByText("มีคนแก้ไขชุดหน้าของตอนนี้ — รีเฟรชเพื่อดูล่าสุด")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "รีเฟรช" }));

		await waitFor(() => {
			expect(reload).toHaveBeenCalledWith(editorStore.editor, { createRecoveryCopy: true });
			expect(projectStore.pageSetChangedNotice).toBeNull();
		});
	});
});
