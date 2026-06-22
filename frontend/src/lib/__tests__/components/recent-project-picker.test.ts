import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import "$lib/i18n";
import RecentProjectPicker from "$lib/components/RecentProjectPicker.svelte";
import type { ProjectSummary } from "$lib/api/client.js";

function project(index: number, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
	return {
		projectId: `project-${index}-abcdef`,
		name: "Updated Name",
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:10:00.000Z",
		targetLang: "th",
		pageCount: 2,
		textLayerCount: index,
		...overrides,
	};
}

describe("RecentProjectPicker", () => {
	it("opens a searchable recent project menu with duplicate-safe metadata", async () => {
		render(RecentProjectPicker, {
			props: {
					projects: [
						project(1, { projectId: "project-alpha-123456", textLayerCount: 1 }),
						project(2, { projectId: "project-beta-654321", textLayerCount: 1 }),
						project(3, { projectId: "project-gamma-333333", name: "Beta Chapter", targetLang: "en" }),
					],
				selectedProjectId: "project-alpha-123456",
				onSelect: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));

			expect(screen.getAllByText("Updated Name").length).toBeGreaterThan(1);
			expect(screen.getByText("รหัส proj3456")).toBeTruthy();
			expect(screen.getByText("รหัส proj4321")).toBeTruthy();
			expect(screen.getByText("Beta Chapter")).toBeTruthy();
		expect(screen.getByText("2 หน้า / 3 เลเยอร์ข้อความ / EN")).toBeTruthy();

		await fireEvent.input(screen.getByRole("searchbox", { name: "ค้นตอนล่าสุด" }), {
			target: { value: "proj4321" },
		});

		expect(screen.queryByText("รหัส proj3456")).toBeNull();
		expect(screen.getByText("รหัส proj4321")).toBeTruthy();
	});

	it("keeps the selected chapter title as the trigger priority instead of letting stats crowd it out", () => {
		render(RecentProjectPicker, {
			props: {
				projects: [
					project(1, {
						projectId: "project-long-selected",
						name: "Flow610 Real Create - ตอน 104 - Real File Smoke",
						targetLang: "en",
						pageCount: 1,
						textLayerCount: 0,
					}),
				],
				selectedProjectId: "project-long-selected",
				onSelect: vi.fn(),
			},
		});

		const trigger = screen.getByRole("button", { name: "เปิดตอนล่าสุด" });
		expect(trigger.classList.contains("has-project")).toBe(true);
		expect(trigger.textContent).toContain("Flow610 Real Create - ตอน 104 - Real File Smoke");
		expect(trigger.getAttribute("title")).toBe("Flow610 Real Create - ตอน 104 - Real File Smoke");
	});

	it("delegates project selection and marks the already selected project as a passive receipt", async () => {
		const onSelect = vi.fn();

		render(RecentProjectPicker, {
			props: {
				projects: [
					project(1, { projectId: "project-alpha-123456" }),
					project(2, { projectId: "project-beta-654321", name: "Beta" }),
				],
				selectedProjectId: "project-alpha-123456",
				onSelect,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));
		expect(screen.getByLabelText("Updated Name เปิดอยู่")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Updated Name/ })).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: /Beta/ }));

		expect(onSelect).toHaveBeenCalledWith("project-beta-654321");
	});

	it("labels zero-page recent projects as setup work", async () => {
		const onSelect = vi.fn();

		render(RecentProjectPicker, {
			props: {
				projects: [
					project(1, { projectId: "project-empty", name: "Empty Draft", pageCount: 0 }),
				],
				onSelect,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));

		expect(screen.getByText("เพิ่มรูปหน้า")).toBeTruthy();
		expect(screen.getByText("ยังไม่มีหน้า / 1 เลเยอร์ข้อความ / TH")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: /Empty Draft/ }));

		expect(onSelect).toHaveBeenCalledWith("project-empty");
	});

	it("still opens while recent projects are loading", async () => {
		render(RecentProjectPicker, {
			props: {
				projects: [],
				loading: true,
				onSelect: vi.fn(),
			},
		});

		const trigger = screen.getByRole("button", { name: "เปิดตอนล่าสุด" });
		expect(trigger.hasAttribute("disabled")).toBe(false);

		await fireEvent.click(trigger);

		expect(screen.getByRole("status").textContent).toContain("กำลังโหลดตอนล่าสุด...");
		const search = screen.getByRole("searchbox", { name: "ค้นตอนล่าสุด" }) as HTMLInputElement;
		expect(search.disabled).toBe(false);
		expect(search.readOnly).toBe(true);
	});

	it("shows a clear empty state and refreshes stale recent data when opened", async () => {
		const onRefresh = vi.fn();

		render(RecentProjectPicker, {
			props: {
				projects: [],
				onSelect: vi.fn(),
				onRefresh,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));

		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(screen.getAllByText("ยังไม่มีตอนล่าสุด").length).toBeGreaterThan(0);
	});

	it("shows recent project load errors with a retry action", async () => {
		const onRefresh = vi.fn();

		render(RecentProjectPicker, {
			props: {
				projects: [],
				error: "โหลดตอนล่าสุดไม่ได้",
				onSelect: vi.fn(),
				onRefresh,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));

		expect(screen.getByRole("status").textContent).toContain("โหลดตอนล่าสุดไม่ได้");

		await fireEvent.click(screen.getByRole("button", { name: "ลองใหม่" }));

		expect(onRefresh).toHaveBeenCalledTimes(2);
	});
});

// The recent-project popover declares role="dialog" but previously had no focus
// trap / focus-restore (only a bespoke Escape). It now uses the shared
// `dialogFocus` action; these tests pin trap + Escape + restore-to-trigger.
describe("RecentProjectPicker focus management", () => {
	// A still-open popover from another test would keep a document-level focus trap
	// active and steal focus during restore, so start each case from a clean DOM.
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	it("moves initial focus into the popover and traps it there", async () => {
		const background = document.createElement("button");
		background.type = "button";
		document.body.append(background);

		render(RecentProjectPicker, {
			props: {
				projects: [project(1, { projectId: "project-alpha-123456" })],
				selectedProjectId: "project-alpha-123456",
				onSelect: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));

		const popover = screen.getByRole("dialog", { name: "ตอนล่าสุด" });
		await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true));

		// Focus pulled to a background control is recovered into the popover.
		background.focus();
		await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true));

		background.remove();
	});

	it("closes on Escape and restores focus to the trigger", async () => {
		render(RecentProjectPicker, {
			props: {
				projects: [project(1, { projectId: "project-alpha-123456" })],
				selectedProjectId: "project-alpha-123456",
				onSelect: vi.fn(),
			},
		});

		const trigger = screen.getByRole("button", { name: "เปิดตอนล่าสุด" });
		// jsdom's click() does not move focus the way a real browser does, so focus
		// the opener explicitly to model the real interaction the action restores to.
		trigger.focus();
		await fireEvent.click(trigger);

		const popover = screen.getByRole("dialog", { name: "ตอนล่าสุด" });
		await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true));

		await fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() => expect(screen.queryByRole("dialog", { name: "ตอนล่าสุด" })).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});
});
