import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
// Register the locale dictionaries (addMessages + init) so ProjectVersionsPanel's $_(...) keys
// resolve to real strings instead of the raw key. test-setup.ts forces the active locale to th.
import "$lib/i18n";
import ProjectVersionsPanel from "$lib/components/ProjectVersionsPanel.svelte";
import type { ProjectVersion, ProjectVersionDetail } from "$lib/api/client.js";

function projectVersion(overrides: Partial<ProjectVersion> = {}): ProjectVersion {
	return {
		versionId: "version-1",
		projectId: "project-1",
		name: "Snapshot 1",
		source: "save",
		createdAt: "2026-05-12T12:34:00.000Z",
		pageCount: 2,
		textLayerCount: 3,
		...overrides,
	};
}

function versionDetail(overrides: Partial<ProjectVersionDetail> = {}): ProjectVersionDetail {
	return {
		version: projectVersion(),
		diff: {
			current: {
				name: "Current",
				pageCount: 2,
				textLayerCount: 3,
				pages: [],
			},
			snapshot: {
				name: "Snapshot",
				pageCount: 1,
				textLayerCount: 1,
				pages: [],
			},
			pageDelta: 1,
			textLayerDelta: 2,
			changedPageCount: 1,
			changedPages: [
				{
					pageIndex: 0,
					label: "p1",
					currentTextLayerCount: 3,
					snapshotTextLayerCount: 1,
				},
			],
		},
		reviews: [
			{
				id: "review-1",
				versionId: "version-1",
				status: "open",
				body: "Check this snapshot",
				requester: "lead",
				mentions: ["lead"],
				createdAt: "2026-05-12T12:34:00.000Z",
				updatedAt: "2026-05-12T12:34:00.000Z",
			},
		],
		...overrides,
	};
}

describe("ProjectVersionsPanel", () => {
	it("renders versions, detail, review state, and delegates actions", async () => {
		const onRefresh = vi.fn();
		const onSaveVersion = vi.fn();
		const onViewVersion = vi.fn();
		const onRestoreVersion = vi.fn();
		const onReviewNoteChange = vi.fn();
		const onRequestReview = vi.fn();
		const onDecideReview = vi.fn();
		const version = projectVersion();

		render(ProjectVersionsPanel, {
			props: {
				projectOpen: true,
				versionsLoading: false,
				versionDetailLoading: false,
				versionReviewLoading: false,
				versions: [version],
				versionDetail: versionDetail(),
				reviewNote: "Ready",
				formatSource: () => "บันทึก",
				formatDate: () => "12:34",
				formatDelta: (value) => (value > 0 ? `+${value}` : `${value}`),
				onRefresh,
				onSaveVersion,
				onViewVersion,
				onRestoreVersion,
				onReviewNoteChange,
				onRequestReview,
				onDecideReview,
			},
		});

		expect(screen.getByText("1 จุดบันทึก")).toBeTruthy();
		expect(screen.getByRole("region", { name: "เวอร์ชันที่เลือก" })).toBeTruthy();
		expect(screen.getByText("จุดบันทึกที่เลือก")).toBeTruthy();
		expect(screen.getAllByText("บันทึก").length).toBeGreaterThan(0);
		expect(screen.getByText("เปลี่ยนแปลง: +1 หน้า / +2 เลเยอร์ข้อความ, 1 หน้ามีการเปลี่ยน")).toBeTruthy();
		expect(screen.getByText("หน้า 1: 3 -> 1")).toBeTruthy();
		expect(screen.getByText("@lead")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "โหลดใหม่" }));
		await fireEvent.click(screen.getByRole("button", { name: "รายละเอียด" }));
		await fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
		await fireEvent.input(screen.getByLabelText("โน้ตรีวิวเวอร์ชัน"), {
			target: { value: "Approve this" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "ขอส่งตรวจ" }));
		await fireEvent.click(screen.getByRole("button", { name: "อนุมัติ" }));
		await fireEvent.click(screen.getByRole("button", { name: "ส่งกลับแก้" }));

		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(onViewVersion).toHaveBeenCalledWith(version.versionId);
		expect(onRestoreVersion).toHaveBeenCalledWith(version.versionId);
		expect(onReviewNoteChange).toHaveBeenCalledWith("Approve this");
		expect(onRequestReview).toHaveBeenCalledTimes(1);
		expect(onDecideReview).toHaveBeenCalledWith("approved");
		expect(onDecideReview).toHaveBeenCalledWith("changes_requested");
	});

	it("focuses the latest version before detail is opened", async () => {
		const onViewVersion = vi.fn();
		const onRestoreVersion = vi.fn();
		const latestVersion = projectVersion({
			versionId: "version-latest",
			source: "import",
			pageCount: 5,
			textLayerCount: 9,
			createdAt: "2026-05-12T13:00:00.000Z",
		});
		const olderVersion = projectVersion({ versionId: "version-older" });

		render(ProjectVersionsPanel, {
			props: {
				projectOpen: true,
				versionsLoading: false,
				versionDetailLoading: false,
				versionReviewLoading: false,
				versions: [latestVersion, olderVersion],
				versionDetail: null,
				reviewNote: "",
				formatSource: (source) => source === "import" ? "Import" : "บันทึก",
				formatDate: () => "13:00",
				formatDelta: (value) => `${value}`,
				onRefresh: vi.fn(),
				onSaveVersion: vi.fn(),
				onViewVersion,
				onRestoreVersion,
				onReviewNoteChange: vi.fn(),
				onRequestReview: vi.fn(),
				onDecideReview: vi.fn(),
			},
		});

		const focusedVersion = screen.getByRole("region", { name: "เวอร์ชันที่เลือก" });
		expect(focusedVersion).toBeTruthy();
		expect(within(focusedVersion).getByText("จุดบันทึกล่าสุด")).toBeTruthy();
		expect(within(focusedVersion).getByText(/เปิดรายละเอียดก่อนส่งตรวจ/)).toBeTruthy();
		expect(within(focusedVersion).getByText("5")).toBeTruthy();
		expect(within(focusedVersion).getByText("9")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดรายละเอียดเวอร์ชันที่เลือก" }));
		await fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับไปเวอร์ชันที่เลือก" }));

		expect(onViewVersion).toHaveBeenCalledWith(latestVersion.versionId);
		expect(onRestoreVersion).toHaveBeenCalledWith(latestVersion.versionId);
	});

	it("renders closed and empty states", () => {
		const baseProps = {
			versionsLoading: false,
			versionDetailLoading: false,
			versionReviewLoading: false,
			versions: [],
			versionDetail: null,
			reviewNote: "",
			formatSource: (value: ProjectVersion["source"]) => value,
			formatDate: (value: string) => value,
			formatDelta: (value: number) => `${value}`,
			onRefresh: vi.fn(),
			onSaveVersion: vi.fn(),
			onViewVersion: vi.fn(),
			onRestoreVersion: vi.fn(),
			onReviewNoteChange: vi.fn(),
			onRequestReview: vi.fn(),
			onDecideReview: vi.fn(),
		};

		const { unmount } = render(ProjectVersionsPanel, {
			props: {
				...baseProps,
				projectOpen: false,
			},
		});
		expect(screen.getByText("เปิดงานก่อนดูประวัติเวอร์ชัน.")).toBeTruthy();
		unmount();

		render(ProjectVersionsPanel, {
			props: {
				...baseProps,
				projectOpen: true,
			},
		});
		expect(screen.getByText("บันทึกหรือ Import JSON เพื่อสร้างจุดบันทึกแรก.")).toBeTruthy();
	});

	it("creates a named version and shows its label + author", async () => {
		const onSaveVersion = vi.fn();
		const namedVersion = projectVersion({
			versionId: "version-named",
			source: "manual",
			label: "Before QC pass",
			author: "lead@example.com",
			createdAt: "2026-05-12T14:00:00.000Z",
		});

		render(ProjectVersionsPanel, {
			props: {
				projectOpen: true,
				versionsLoading: false,
				versionDetailLoading: false,
				versionReviewLoading: false,
				versions: [namedVersion],
				versionDetail: null,
				reviewNote: "",
				formatSource: (source) => (source === "manual" ? "เวอร์ชันตั้งชื่อ" : "บันทึก"),
				formatDate: () => "14:00",
				formatDelta: (value) => `${value}`,
				onRefresh: vi.fn(),
				onSaveVersion,
				onViewVersion: vi.fn(),
				onRestoreVersion: vi.fn(),
				onReviewNoteChange: vi.fn(),
				onRequestReview: vi.fn(),
				onDecideReview: vi.fn(),
			},
		});

		// Label and author are surfaced for the named snapshot.
		expect(screen.getAllByText("Before QC pass").length).toBeGreaterThan(0);
		expect(screen.getAllByText(/lead@example.com/).length).toBeGreaterThan(0);
		expect(screen.getByText("ตั้งชื่อ")).toBeTruthy();

		// The save button is disabled until a label is typed, then delegates.
		const saveButton = screen.getByRole("button", { name: "บันทึกเวอร์ชันแบบตั้งชื่อ" });
		expect((saveButton as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.input(screen.getByLabelText("ชื่อเวอร์ชัน"), {
			target: { value: "After QC pass" },
		});
		expect((saveButton as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.click(saveButton);
		expect(onSaveVersion).toHaveBeenCalledWith("After QC pass");
	});

	it("clears the label only after a successful save, keeping it on failure", async () => {
		// onSaveVersion returns true on success, false when nothing was saved
		// (network/auth/conflict). The input must survive a failure so the user can
		// retry without retyping.
		const onSaveVersion = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

		render(ProjectVersionsPanel, {
			props: {
				projectOpen: true,
				versionsLoading: false,
				versionDetailLoading: false,
				versionReviewLoading: false,
				versions: [],
				versionDetail: null,
				reviewNote: "",
				formatSource: () => "เวอร์ชันตั้งชื่อ",
				formatDate: () => "14:00",
				formatDelta: (value: number) => `${value}`,
				onRefresh: vi.fn(),
				onSaveVersion,
				onViewVersion: vi.fn(),
				onRestoreVersion: vi.fn(),
				onReviewNoteChange: vi.fn(),
				onRequestReview: vi.fn(),
				onDecideReview: vi.fn(),
			},
		});

		const input = screen.getByLabelText("ชื่อเวอร์ชัน") as HTMLInputElement;
		const saveButton = screen.getByRole("button", { name: "บันทึกเวอร์ชันแบบตั้งชื่อ" });

		// First attempt fails -> label is preserved for retry.
		await fireEvent.input(input, { target: { value: "Before QC" } });
		await fireEvent.click(saveButton);
		expect(onSaveVersion).toHaveBeenCalledWith("Before QC");
		expect(input.value).toBe("Before QC");

		// Retry succeeds -> input is cleared.
		await fireEvent.click(saveButton);
		expect(input.value).toBe("");
	});

	it("uses passive receipts for unavailable version actions", () => {
		render(ProjectVersionsPanel, {
			props: {
				projectOpen: true,
				versionsLoading: false,
				versionDetailLoading: false,
				versionReviewLoading: false,
				versions: [projectVersion()],
				versionDetail: versionDetail({ reviews: [] }),
				reviewNote: "",
				formatSource: () => "บันทึก",
				formatDate: () => "12:34",
				formatDelta: (value) => `${value}`,
				onRefresh: vi.fn(),
				onSaveVersion: vi.fn(),
				onViewVersion: vi.fn(),
				onRestoreVersion: vi.fn(),
				onReviewNoteChange: vi.fn(),
				onRequestReview: vi.fn(),
				onDecideReview: vi.fn(),
			},
		});

		const focusedVersion = screen.getByRole("region", { name: "เวอร์ชันที่เลือก" });
		expect(within(focusedVersion).queryByRole("button", { name: "เปิดรายละเอียดเวอร์ชันที่เลือก" })).toBeNull();
		expect(within(focusedVersion).getByText("เปิดอยู่")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "อนุมัติ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ส่งกลับแก้" })).toBeNull();
		expect(screen.getAllByText("ไม่มีคำขอเปิด").length).toBe(2);
	});
});
