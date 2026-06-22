import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import "$lib/i18n";
import WorkspaceTopUtilityBar from "$lib/components/WorkspaceTopUtilityBar.svelte";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { usageStore } from "$lib/stores/usage.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import { notificationsStore } from "$lib/stores/notifications.svelte.ts";

function resetStores(): void {
	editorUiStore.__resetForTesting();
	projectStore.__resetForTesting();
	usageStore.reset();
	workspacesStore.__resetForTesting();
	notificationsStore.reset();
}

beforeEach(() => {
	resetStores();
});

describe("WorkspaceTopUtilityBar help surface", () => {
	it("opens current-page help from the small topbar question button with dialog aria", async () => {
		editorUiStore.openDashboard();
		render(WorkspaceTopUtilityBar);

		const trigger = screen.getByRole("button", { name: "แดชบอร์ด help" });
		expect(trigger.textContent?.trim()).toBe("?");
		expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.getAttribute("aria-controls")).toBeNull();

		await fireEvent.click(trigger);

		const dialog = screen.getByRole("dialog", { name: "แดชบอร์ด" });
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
		expect(dialog.getAttribute("aria-describedby")).toBe("workspace-help-description-dashboard");
		expect(dialog.textContent).toContain("เริ่มจากตรงนี้เพื่อดูงานสำคัญ สุขภาพโปรเจกต์ และตอนถัดไปที่ควรเปิด");
		expect(dialog.textContent).toContain("ดูการ์ด Today เพื่อหาเรื่อง ตอน หรืองานที่สำคัญที่สุดตอนนี้");
		expect(dialog.textContent).toContain("เปิดคลังงานเมื่ออยากเปลี่ยนเรื่อง ตอน หรือภาษาเป้าหมาย");
	});

	it("closes the help popover with Escape, outside click, and the close button", async () => {
		editorUiStore.openDashboard();
		render(WorkspaceTopUtilityBar);

		const trigger = screen.getByRole("button", { name: "แดชบอร์ด help" });
		await fireEvent.click(trigger);
		expect(screen.getByRole("dialog", { name: "แดชบอร์ด" })).toBeTruthy();

		await fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "แดชบอร์ด" })).toBeNull());
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(trigger);

		await fireEvent.click(trigger);
		expect(screen.getByRole("dialog", { name: "แดชบอร์ด" })).toBeTruthy();
		await fireEvent.click(document.body);
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "แดชบอร์ด" })).toBeNull());

		await fireEvent.click(trigger);
		await fireEvent.click(screen.getByRole("button", { name: "Close แดชบอร์ด help" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "แดชบอร์ด" })).toBeNull());
	});

	it("updates the help topic when the current workspace view changes and hides unknown views", async () => {
		editorUiStore.openDashboard();
		render(WorkspaceTopUtilityBar);

		editorUiStore.openReports();
		await tick();

		const reportsTrigger = screen.getByRole("button", { name: "รายงาน help" });
		await fireEvent.click(reportsTrigger);
		const reportsDialog = screen.getByRole("dialog", { name: "รายงาน" });
		expect(reportsDialog.textContent).toContain("ดูสุขภาพ workspace การใช้งาน ความคืบหน้า และแนวโน้มการผลิต");

		editorUiStore.setWorkspaceView("pages");
		await tick();

		expect(screen.queryByRole("dialog", { name: "รายงาน" })).toBeNull();
		expect(screen.queryByRole("button", { name: /help$/ })).toBeNull();
	});
});
