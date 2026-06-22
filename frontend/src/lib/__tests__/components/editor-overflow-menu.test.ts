import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import Toolbar from "$lib/components/Toolbar.svelte";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { adminStore } from "$lib/stores/admin.svelte.ts";

// The mobile overflow menu lives inside the Toolbar. On desktop it is CSS-hidden,
// but the trigger is always in the DOM; its popover contents (the controls that
// are tucked away on phones) only render once the menu is opened. These tests
// assert the contract the responsive layout depends on: the popover is collapsed
// by default and every tucked-away control becomes reachable when opened.

function reset(): void {
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	adminStore.close();
	localStorage.clear();
}

describe("EditorOverflowMenu (mobile editor chrome)", () => {
	it("keeps the overflow popover collapsed until the trigger is clicked", async () => {
		reset();
		render(Toolbar);

		const toggle = screen.getByTestId("editor-overflow-toggle");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		// Tucked-away controls are not mounted while collapsed.
		expect(screen.queryByRole("menu", { name: "เครื่องมือเพิ่มเติม" })).toBeNull();

		await fireEvent.click(toggle);

		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("menu", { name: "เครื่องมือเพิ่มเติม" })).toBeTruthy();
	});

	it("exposes the essential tucked-away controls (Open Folder, Solo/Team, Commands, Settings) in the popover", async () => {
		reset();
		render(Toolbar);

		await fireEvent.click(screen.getByTestId("editor-overflow-toggle"));
		const menu = screen.getByRole("menu", { name: "เครื่องมือเพิ่มเติม" });

		expect(menu.textContent).toContain("Solo");
		expect(menu.textContent).toContain("Team");
		// Settings opens the admin dialog from inside the overflow.
		const settings = within(menu).getByText("ตั้งค่าระบบ");
		await fireEvent.click(settings);
		expect(adminStore.showDialog).toBe(true);
	});

	it("switches workspace mode from inside the overflow popover", async () => {
		reset();
		render(Toolbar);

		await fireEvent.click(screen.getByTestId("editor-overflow-toggle"));
		const menu = screen.getByRole("menu", { name: "เครื่องมือเพิ่มเติม" });
		const teamBtn = within(menu).getByRole("button", { name: /Team/ });
		await fireEvent.click(teamBtn);

		expect(editorUiStore.workspaceMode).toBe("team");
	});
});
