import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

vi.mock("$app/state", () => ({
	page: { url: new URL("http://localhost/") },
}));
vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
}));

import WorkspaceSidebar from "$lib/components/WorkspaceSidebar.svelte";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";

beforeEach(() => {
	projectStore.project = null;
	projectStore.clearRecentProjects?.();
	workspacesStore.workspaces = [
		{ workspaceId: "ws-suphot", name: "Suphot Studio", planId: "free", memberRole: "owner", memberScope: {} } as any,
		{ workspaceId: "ws-clean", name: "Cleaner House", planId: "team", memberRole: "admin", memberScope: {} } as any,
		{ workspaceId: "ws-thai", name: "บ้านของ สุพจน์", planId: "free", memberRole: "editor", memberScope: { taskTypes: ["translate"] } } as any,
	];
	workspacesStore.currentWorkspaceId = "ws-suphot";
	vi.spyOn(workspacesStore, "syncWithAuth").mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function openSwitcher(): Promise<HTMLButtonElement> {
	const trigger = screen.getAllByRole("button").find((button) => button.getAttribute("aria-haspopup") === "dialog") as HTMLButtonElement | undefined;
	expect(trigger).toBeTruthy();
	await fireEvent.click(trigger!);
	return trigger!;
}

describe("WorkspaceSidebar workspace identity", () => {
	it("shows a deterministic swatch and initials in the current workspace header", () => {
		render(WorkspaceSidebar);

		const trigger = screen.getAllByRole("button").find((button) => button.getAttribute("aria-haspopup") === "dialog");
		const mark = trigger?.querySelector(".ws-switcher-mark") as HTMLElement | null;

		expect(mark).toBeTruthy();
		expect(mark!.textContent?.trim()).toBe("SS");
		expect(mark!.getAttribute("style")).toContain("--workspace-identity-color:");
		expect(mark!.getAttribute("style")).toContain("--color-ws-");
	});

	it("shows a swatch and two-letter initials before every workspace in the switcher", async () => {
		const { container } = render(WorkspaceSidebar);
		await openSwitcher();

		expect(await screen.findByRole("dialog", { name: "ตัวสลับเวิร์กสเปซ" })).toBeTruthy();
		const options = Array.from(container.querySelectorAll(".ws-workspace-option"));

		expect(options).toHaveLength(3);
		expect(options.map((option) => option.querySelector(".ws-workspace-option-mark")?.textContent?.trim())).toEqual([
			"SS",
			"CH",
			"บส",
		]);
		for (const option of options) {
			const mark = option.querySelector(".ws-workspace-option-mark") as HTMLElement | null;
			expect(mark).toBeTruthy();
			expect(mark!.getAttribute("style")).toContain("--workspace-identity-color:");
			expect(mark!.getAttribute("style")).toContain("--color-ws-");
		}
	});
});
