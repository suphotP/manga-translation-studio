// First-run sidebar P1s:
//  4) A FAILED create-workspace must surface an inline error AND keep the popover
//     open + preserve the typed name (was silently swallowed).
//  5) The Library subnav must NOT show DISABLED dead "Open story"/"Open chapter"
//     buttons on first run — it shows an actionable empty state that routes to the
//     Library overview instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

// $app modules are not available under vitest; provide light stand-ins.
vi.mock("$app/state", () => ({
	page: { url: new URL("http://localhost/") },
}));
vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
}));

import WorkspaceSidebar from "$lib/components/WorkspaceSidebar.svelte";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";

beforeEach(() => {
	// First-run posture: no open project, no stories/chapters, one workspace so the
	// switcher renders, and stable polling no-ops.
	projectStore.project = null;
	projectStore.clearRecentProjects?.();
	workspacesStore.workspaces = [
		{ workspaceId: "ws-1", name: "My Workspace", planId: "free", memberRole: "owner", memberScope: {} } as any,
	];
	workspacesStore.currentWorkspaceId = "ws-1";
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function openSwitcher(): Promise<void> {
	// The switcher trigger is the first button with aria-haspopup="dialog".
	const triggers = screen.getAllByRole("button");
	const trigger = triggers.find((b) => b.getAttribute("aria-haspopup") === "dialog");
	expect(trigger).toBeTruthy();
	await fireEvent.click(trigger!);
}

describe("WorkspaceSidebar first-run", () => {
	it("surfaces an inline error and preserves the name when create-workspace fails", async () => {
		vi.spyOn(workspacesStore, "create").mockRejectedValue(new Error("Email verification required"));

		render(WorkspaceSidebar);
		await openSwitcher();

		// Default locale is Thai; the labels resolve to the Thai i18n strings.
		const input = (await screen.findByLabelText("ชื่อเวิร์กสเปซใหม่")) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "Brand New WS" } });
		await fireEvent.click(screen.getByText("สร้าง"));

		// Inline alert is shown with the failure reason…
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Email verification required");
		// …the popover stays open (input still present) and the typed name is preserved.
		const stillThere = screen.getByLabelText("ชื่อเวิร์กสเปซใหม่") as HTMLInputElement;
		expect(stillThere.value).toBe("Brand New WS");
	});

	it("clears the inline error when the user edits the name to retry", async () => {
		vi.spyOn(workspacesStore, "create").mockRejectedValue(new Error("Offline"));

		render(WorkspaceSidebar);
		await openSwitcher();

		const input = (await screen.findByLabelText("ชื่อเวิร์กสเปซใหม่")) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "Retry WS" } });
		await fireEvent.click(screen.getByText("สร้าง"));
		await screen.findByRole("alert");

		await fireEvent.input(input, { target: { value: "Retry WS!" } });
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("shows an actionable Library empty state instead of disabled dead controls on first run", async () => {
		const openLibrary = vi.spyOn(editorUiStore, "openLibrary");

		render(WorkspaceSidebar);

		// Expand the Library subnav disclosure (default locale is Thai; aria-labels are
		// the resolved Thai strings).
		await fireEvent.click(screen.getByRole("button", { name: "คลังการ์ตูน" }));

		// No story/chapter selected → the actionable empty-state buttons are present and
		// ENABLED (not disabled dead controls), and clicking routes to the Library.
		const browseStories = await screen.findByRole("button", { name: "ดูเรื่องทั้งหมดในคลังการ์ตูน" });
		expect((browseStories as HTMLButtonElement).disabled).toBe(false);
		const browseChapters = screen.getByRole("button", { name: "ดูตอนทั้งหมดในคลังการ์ตูน" });
		expect((browseChapters as HTMLButtonElement).disabled).toBe(false);

		// The old disabled "Open story"/"Open chapter" dead buttons are gone on first run.
		expect(screen.queryByRole("button", { name: "เรื่องที่เปิดในคลังการ์ตูน" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ตอนที่เปิดในคลังการ์ตูน" })).toBeNull();

		await fireEvent.click(browseStories);
		expect(openLibrary).toHaveBeenCalled();
	});
});
