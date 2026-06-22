import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import "$lib/i18n";
import StorySettingsDialog from "$lib/components/workspace/library/StorySettingsDialog.svelte";
import type { WorkspaceProjectBrowserGroup } from "$lib/project/workspace-dashboard.js";
import * as api from "$lib/api/client";

vi.mock("$lib/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/api/client")>();
	return {
		...actual,
		listStoryAssignments: vi.fn(async () => ({ assignments: [], candidates: [] })),
		upsertStoryAssignment: vi.fn(),
		upsertStoryAssignments: vi.fn(),
		removeStoryAssignment: vi.fn(),
	};
});

function storyGroup(overrides: Partial<WorkspaceProjectBrowserGroup> = {}): WorkspaceProjectBrowserGroup {
	return {
		id: "storyid01-alpha",
		storyId: "storyid01",
		title: "Alpha Story",
		coverProjectId: null,
		chapterCount: 2,
		hiddenChapterCount: 0,
		totalPages: 20,
		totalTextLayers: 40,
		totalTasks: 8,
		openTasks: 4,
		reviewTasks: 1,
		openComments: 0,
		attentionChapterCount: 0,
		activeChapterCount: 2,
		readyChapterCount: 0,
		nextAction: "",
		targetLangs: ["th", "en"],
		languageSummaries: [],
		latestUpdatedAt: "2026-05-14T00:00:00.000Z",
		projects: [],
		chapters: [],
		...overrides,
	};
}

function baseProps() {
	return {
		open: true,
		title: storyGroup(),
		selfDisplayName: "Suphot",
		workspaceName: "Studio",
		deadlineLabel: "ยังไม่ตั้ง",
		canManage: true,
		onRename: vi.fn(async () => {}),
		onDelete: vi.fn(async () => {}),
		onClose: vi.fn(),
	};
}

describe("StorySettingsDialog", () => {
	it("shows the real settings header (not a coming-soon placeholder)", () => {
		render(StorySettingsDialog, { props: baseProps() });
		// The header no longer carries the "เร็วๆ นี้" coming-soon badge on the title row.
		expect(screen.getByText("ตั้งค่าเรื่อง")).toBeTruthy();
		const titleInput = screen.getByLabelText("ชื่อเรื่อง") as HTMLInputElement;
		expect(titleInput.value).toBe("Alpha Story");
		expect(titleInput.readOnly).toBe(false);
	});

	it("keeps dense story settings content scrollable instead of clipping into neighboring cards", async () => {
		vi.mocked(api.listStoryAssignments).mockResolvedValueOnce({
			assignments: [],
			candidates: [{ userId: "u-translator", name: "Translator With A Long Display Name" }],
		});

		const { container } = render(StorySettingsDialog, {
			props: {
				...baseProps(),
				workspaceId: "ws-1",
				title: storyGroup({
					title: "Alpha Story With A Very Long Name That Must Not Force The Dialog Wider",
					targetLangs: ["th", "en", "id", "ms"],
				}),
				deadlineLabel: "ยังไม่ตั้ง - รอ producer กำหนด sprint และวันส่งงานของทุกภาษา",
			},
		});

		const grid = container.querySelector<HTMLElement>(".story-settings-grid");
		expect(grid).not.toBeNull();
		expect(grid?.className).toContain("grid-cols-1");
		expect(grid?.className).toContain("min-[1120px]:grid-cols-2");
		expect(grid?.className).not.toContain("min-[761px]:grid-cols-2");
		expect(grid?.className).toContain("auto-rows-max");
		expect(grid?.className).toContain("items-start");
		expect(grid?.className).toContain("overflow-y-auto");
		expect(grid?.className).toContain("overflow-x-hidden");

		const cards = Array.from(container.querySelectorAll<HTMLElement>("article"));
		expect(cards).toHaveLength(4);
		for (const card of cards) {
			expect(card.className).toContain("min-h-0");
			expect(card.className).toContain("min-w-0");
			expect(card.className).not.toContain("min-h-[178px]");
		}

		await waitFor(() => expect(screen.getByLabelText("สมาชิก")).toBeTruthy());
		const assignmentForm = screen.getByRole("button", { name: "มอบหมายทุกตอน" }).closest("div");
		expect(assignmentForm?.className).toContain("grid-cols-1");
		expect(assignmentForm?.className).toContain("min-[520px]:grid-cols-[minmax(0,1fr)_minmax(112px,auto)_auto]");
	});

	it("disables save until the title actually changes, then calls onRename with the new title", async () => {
		const props = baseProps();
		render(StorySettingsDialog, { props });

		const saveBtn = screen.getByRole("button", { name: "บันทึกชื่อเรื่อง" }) as HTMLButtonElement;
		expect(saveBtn.disabled).toBe(true);

		const titleInput = screen.getByLabelText("ชื่อเรื่อง") as HTMLInputElement;
		await fireEvent.input(titleInput, { target: { value: "Renamed Story" } });
		expect(saveBtn.disabled).toBe(false);

		await fireEvent.click(saveBtn);
		await waitFor(() => expect(props.onRename).toHaveBeenCalledWith("Renamed Story"));
	});

	it("does not call onRename for a whitespace-only title", async () => {
		const props = baseProps();
		render(StorySettingsDialog, { props });
		const titleInput = screen.getByLabelText("ชื่อเรื่อง") as HTMLInputElement;
		await fireEvent.input(titleInput, { target: { value: "   " } });
		const saveBtn = screen.getByRole("button", { name: "บันทึกชื่อเรื่อง" }) as HTMLButtonElement;
		expect(saveBtn.disabled).toBe(true);
		expect(props.onRename).not.toHaveBeenCalled();
	});

	it("requires typing the exact story title before delete is enabled, then calls onDelete", async () => {
		const props = baseProps();
		render(StorySettingsDialog, { props });

		await fireEvent.click(screen.getByRole("button", { name: "ลบเรื่องนี้" }));
		const confirmInput = screen.getByLabelText("พิมพ์ชื่อเรื่องเพื่อยืนยันการลบ") as HTMLInputElement;
		const deleteBtn = screen.getByRole("button", { name: "ลบถาวร" }) as HTMLButtonElement;
		expect(deleteBtn.disabled).toBe(true);

		// Wrong text keeps it locked.
		await fireEvent.input(confirmInput, { target: { value: "wrong" } });
		expect(deleteBtn.disabled).toBe(true);

		// Exact title unlocks the irreversible action.
		await fireEvent.input(confirmInput, { target: { value: "Alpha Story" } });
		expect(deleteBtn.disabled).toBe(false);

		await fireEvent.click(deleteBtn);
		await waitFor(() => expect(props.onDelete).toHaveBeenCalledTimes(1));
	});

	it("hides rename + delete controls when the user cannot manage projects", () => {
		render(StorySettingsDialog, { props: { ...baseProps(), canManage: false } });
		expect(screen.queryByRole("button", { name: "บันทึกชื่อเรื่อง" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ลบเรื่องนี้" })).toBeNull();
		const titleInput = screen.getByLabelText("ชื่อเรื่อง") as HTMLInputElement;
		expect(titleInput.readOnly).toBe(true);
		expect(screen.getByText("ต้องมีสิทธิ์จัดการโปรเจกต์จึงจะลบเรื่องได้")).toBeTruthy();
	});

	it("surfaces a rename failure message and does not close", async () => {
		const props = baseProps();
		props.onRename = vi.fn(async () => {
			throw new Error("บันทึกชื่อเรื่องไม่สำเร็จ");
		});
		render(StorySettingsDialog, { props });
		const titleInput = screen.getByLabelText("ชื่อเรื่อง") as HTMLInputElement;
		await fireEvent.input(titleInput, { target: { value: "Renamed Story" } });
		await fireEvent.click(screen.getByRole("button", { name: "บันทึกชื่อเรื่อง" }));
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("บันทึกชื่อเรื่องไม่สำเร็จ"));
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it("lists series-duty assignments and assigns a member through the picker", async () => {
		const listMock = vi.mocked(api.listStoryAssignments);
		listMock.mockResolvedValueOnce({
			assignments: [
				{ workspaceId: "ws-1", storyId: "storyid01", userId: "u-clean", role: "cleaner", createdAt: "", updatedAt: "", displayName: "Clean Person" },
			],
			candidates: [
				{ userId: "u-clean", name: "Clean Person" },
				{ userId: "u-new", name: "New Member", email: "new@example.com" },
			],
		});
		const upsertMock = vi.mocked(api.upsertStoryAssignments);
		upsertMock.mockResolvedValueOnce({
			assignments: [{ workspaceId: "ws-1", storyId: "storyid01", userId: "u-new", role: "qc", createdAt: "", updatedAt: "", displayName: "New Member" }],
			changedCount: 1,
		});

		render(StorySettingsDialog, { props: { ...baseProps(), workspaceId: "ws-1" } });
		// Existing assignment renders with its duty.
		await waitFor(() => expect(screen.getByText("Clean Person")).toBeTruthy());
		expect(listMock).toHaveBeenCalledWith("ws-1", "storyid01");

		// The add-picker offers ONLY the not-yet-assigned member.
		const memberSelect = screen.getByLabelText("สมาชิก") as HTMLSelectElement;
		expect(Array.from(memberSelect.options).map((option) => option.value)).toEqual(["", "u-new"]);

		await fireEvent.change(memberSelect, { target: { value: "u-new" } });
		const roleSelect = screen.getByLabelText("หน้าที่") as HTMLSelectElement;
		await fireEvent.change(roleSelect, { target: { value: "qc" } });
		expect(screen.getByText("ขอบเขตแบบรวม · ทุกตอน (2 ตอน)")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "มอบหมายทุกตอน" }));
		await waitFor(() => expect(upsertMock).toHaveBeenCalledWith("ws-1", {
			storyIds: ["storyid01"],
			userId: "u-new",
			role: "qc",
			storyTitle: "Alpha Story",
		}));
		await waitFor(() => expect(screen.getByText("New Member")).toBeTruthy());
		expect(screen.getByText("มอบหมายแล้ว · ใช้กับทุกตอน (2 ตอน)")).toBeTruthy();
	});

	it("removes a member's series duty", async () => {
		vi.mocked(api.listStoryAssignments).mockResolvedValueOnce({
			assignments: [
				{ workspaceId: "ws-1", storyId: "storyid01", userId: "u-clean", role: "cleaner", createdAt: "", updatedAt: "", displayName: "Clean Person" },
			],
			candidates: [{ userId: "u-clean", name: "Clean Person" }],
		});
		const removeMock = vi.mocked(api.removeStoryAssignment);
		removeMock.mockResolvedValueOnce({ ok: true, removed: true });

		render(StorySettingsDialog, { props: { ...baseProps(), workspaceId: "ws-1" } });
		await waitFor(() => expect(screen.getByText("Clean Person")).toBeTruthy());
		await fireEvent.click(screen.getByRole("button", { name: "ลบหน้าที่ของ Clean Person" }));
		await waitFor(() => expect(removeMock).toHaveBeenCalledWith("ws-1", "storyid01", "u-clean"));
		// The roster row is gone (no remove control) and the member returns to the
		// add-picker as an assignable candidate.
		await waitFor(() => expect(screen.queryByRole("button", { name: "ลบหน้าที่ของ Clean Person" })).toBeNull());
		const memberSelect = screen.getByLabelText("สมาชิก") as HTMLSelectElement;
		expect(Array.from(memberSelect.options).map((option) => option.value)).toContain("u-clean");
	});

	it("multi-duty: a member's held duties render as active chips; toggling one off removes by role", async () => {
		vi.mocked(api.listStoryAssignments).mockResolvedValueOnce({
			assignments: [
				{ workspaceId: "ws-1", storyId: "storyid01", userId: "u-multi", role: "translator", createdAt: "", updatedAt: "", displayName: "Multi Person" },
				{ workspaceId: "ws-1", storyId: "storyid01", userId: "u-multi", role: "typesetter", createdAt: "", updatedAt: "", displayName: "Multi Person" },
			],
			candidates: [{ userId: "u-multi", name: "Multi Person" }],
		});
		const removeMock = vi.mocked(api.removeStoryAssignment);
		removeMock.mockResolvedValueOnce({ ok: true, removed: true });
		const upsertMock = vi.mocked(api.upsertStoryAssignments);

		render(StorySettingsDialog, { props: { ...baseProps(), workspaceId: "ws-1" } });
		await waitFor(() => expect(screen.getByText("Multi Person")).toBeTruthy());

		// Both held duties are pressed chips; the unheld ones are not.
		const translatorChip = screen.getByRole("button", { name: "นักแปล", pressed: true });
		const cleanerChip = screen.getByRole("button", { name: "คนคลีน", pressed: false });
		expect(translatorChip).toBeTruthy();
		expect(cleanerChip).toBeTruthy();

		// Toggling an ACTIVE duty off removes exactly that role.
		await fireEvent.click(translatorChip);
		await waitFor(() => expect(removeMock).toHaveBeenCalledWith("ws-1", "storyid01", "u-multi", "translator"));

		// Toggling an INACTIVE duty on upserts that role (multi-duty: the other stays).
		upsertMock.mockResolvedValueOnce({ assignments: [{ workspaceId: "ws-1", storyId: "storyid01", userId: "u-multi", role: "cleaner", createdAt: "", updatedAt: "" }], changedCount: 1 });
		await fireEvent.click(screen.getByRole("button", { name: "คนคลีน", pressed: false }));
		await waitFor(() => expect(upsertMock).toHaveBeenCalledWith("ws-1", expect.objectContaining({ userId: "u-multi", role: "cleaner" })));
	});

	it("story-manage rights alone (no candidates from server) do NOT unlock duty controls", async () => {
		// An editor can rename/delete stories (canManage) but lacks manage_members:
		// the server omits `candidates`, so dropdowns/remove/add must not render —
		// they would all 403.
		vi.mocked(api.listStoryAssignments).mockResolvedValueOnce({
			assignments: [
				{ workspaceId: "ws-1", storyId: "storyid01", userId: "u-clean", role: "cleaner", createdAt: "", updatedAt: "", displayName: "Clean Person" },
			],
		});
		render(StorySettingsDialog, { props: { ...baseProps(), workspaceId: "ws-1", canManage: true } });
		await waitFor(() => expect(screen.getByText("Clean Person")).toBeTruthy());
		expect(screen.queryByLabelText("สมาชิก")).toBeNull();
		expect(screen.queryByRole("button", { name: "ลบหน้าที่ของ Clean Person" })).toBeNull();
		expect(screen.queryByLabelText("เปลี่ยนหน้าที่ของ Clean Person")).toBeNull();
	});

	it("read-only members see assignments without manage controls", async () => {
		vi.mocked(api.listStoryAssignments).mockResolvedValueOnce({
			assignments: [
				{ workspaceId: "ws-1", storyId: "storyid01", userId: "u-clean", role: "cleaner", createdAt: "", updatedAt: "", displayName: "Clean Person" },
			],
		});
		render(StorySettingsDialog, { props: { ...baseProps(), workspaceId: "ws-1", canManage: false } });
		await waitFor(() => expect(screen.getByText("Clean Person")).toBeTruthy());
		// Role rendered as a static label; no picker, no remove button.
		expect(screen.queryByLabelText("สมาชิก")).toBeNull();
		expect(screen.queryByRole("button", { name: "ลบหน้าที่ของ Clean Person" })).toBeNull();
	});
});
