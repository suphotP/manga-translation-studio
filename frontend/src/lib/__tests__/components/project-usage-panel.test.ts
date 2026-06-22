import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
// Register the locale dictionaries (addMessages + init) so ProjectUsagePanel's $_(...) keys
// resolve to real strings instead of the raw key. test-setup.ts forces the active locale to th.
import "$lib/i18n";
import ProjectUsagePanel from "$lib/components/ProjectUsagePanel.svelte";

const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function queueUsageResponses(usageOverrides: Record<string, unknown> = {}): void {
	mockFetch
		.mockResolvedValueOnce(jsonResponse({
			usage: {
				workspaceId: "proj-1",
				projectId: "proj-1",
				planId: "prototype",
				enforced: true,
				daily: {
					periodKey: "2026-05-13",
					aiCapturedThb: 0,
					aiActiveReservedThb: 0,
					aiCommittedThb: 0,
					uploadBytes: 70,
					exportBytes: 0,
					moderationImages: 0,
					limits: { aiCreditThb: 0, uploadBytes: 0, exportBytes: 0 },
					remaining: { aiCreditThb: null, uploadBytes: null, exportBytes: null },
					percentUsed: { aiCredit: null, uploadBytes: null, exportBytes: null },
				},
				monthly: {
					periodKey: "2026-05",
					aiCapturedThb: 1.7,
					aiActiveReservedThb: 0,
					aiCommittedThb: 0.18,
					uploadBytes: 70,
					exportBytes: 512,
					moderationImages: 0,
					limits: { aiCreditThb: 2.88, uploadBytes: 1024, exportBytes: 2048 },
					remaining: { aiCreditThb: 2.70, uploadBytes: 954, exportBytes: 1536 },
					percentUsed: { aiCredit: 6.25, uploadBytes: 6.8, exportBytes: 25 },
				},
				eventCount: 3,
				...usageOverrides,
			},
		}))
		.mockResolvedValueOnce(jsonResponse({
			storageQuota: {
				projectId: "proj-1",
				workspaceId: "proj-1",
				enforced: true,
				usedBytes: 678,
				originalBytes: 70,
				derivativeBytes: 96,
				exportArtifactBytes: 512,
				pendingBytes: 0,
				includedBytes: 1073741824,
				extraBytes: 0,
				limitBytes: 1073741824,
				remainingBytes: 1073741146,
				percentUsed: 0.1,
				assetCount: 1,
				derivativeCount: 2,
				exportArtifactCount: 1,
			},
		}))
		.mockResolvedValueOnce(jsonResponse({
			egress: {
				projectId: "proj-1",
				windowMs: 3600000,
				windowStart: 0,
				windowEnd: 3600000,
				totalRequests: 4,
				totalBytes: 96,
				limitBytes: 0,
				enforced: false,
				remainingBytes: 0,
				byPurpose: [{ purpose: "thumbnail", requests: 4, bytes: 96 }],
				byAsset: [{ imageId: "img1.png", requests: 4, bytes: 96 }],
			},
		}));
}

describe("ProjectUsagePanel", () => {
	beforeEach(() => {
		globalThis.fetch = mockFetch;
		mockFetch.mockReset();
		queueUsageResponses();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("loads and renders workspace usage, storage, and egress summaries", async () => {
		render(ProjectUsagePanel, {
			props: {
				projectId: "proj-1",
				projectOpen: true,
			},
		});

		await waitFor(() => {
			expect(screen.getByText("เหลือ 1024 MB / 1.0 GB")).toBeTruthy();
		});

		expect(screen.getByText("การใช้งานเวิร์กสเปซ")).toBeTruthy();
		expect(screen.getByRole("region", { name: "สรุปการใช้งานที่ต้องดู" })).toBeTruthy();
		expect(screen.getByText("การใช้งานยังปกติ")).toBeTruthy();
		expect(screen.getByText("prototype")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
		expect(screen.getByText("ใช้ไป 0.1% / ต้นฉบับ 70 B / ไฟล์สร้างแล้ว 96 B / Export 512 B")).toBeTruthy();
		expect(screen.getByText("1 ZIP ที่เก็บไว้ ลบได้จากประวัติ Export เพื่อคืนพื้นที่")).toBeTruthy();
		// AI usage shows CREDITS, not baht: 0.18฿→2, 2.88฿→32 credits (1 credit = 0.09฿, post-rebase #586).
		expect(screen.getByText("เหลือ 30 / 32 เครดิต")).toBeTruthy();
		expect(screen.getByText("96 B / ไม่จำกัด")).toBeTruthy();
		expect(screen.getByText("4 ครั้ง / ดูสถานะ / รูปย่อ: 96 B / 4 ครั้ง")).toBeTruthy();
		expect(mockFetch.mock.calls[0][0]).toContain("/usage/proj-1");
		expect(mockFetch.mock.calls[1][0]).toContain("/images/proj-1/storage-usage");
		expect(mockFetch.mock.calls[2][0]).toContain("/images/proj-1/egress-usage");
	});

	it("renders the capped event count with a '+' when eventCountCapped is set", async () => {
		// When the server caps the all-time event count (eventCountCapped: true), the
		// displayed value is a floor, so the panel must render "100000+" rather than an
		// exact-looking "100000".
		mockFetch.mockReset();
		queueUsageResponses({ eventCount: 100000, eventCountCapped: true });

		render(ProjectUsagePanel, {
			props: {
				projectId: "proj-1",
				projectOpen: true,
			},
		});

		await waitFor(() => {
			expect(screen.getByText("เหลือ 1024 MB / 1.0 GB")).toBeTruthy();
		});
		expect(screen.getByText("100000+")).toBeTruthy();
		expect(screen.queryByText("100000")).toBeNull();
	});

	it("refreshes usage on demand", async () => {
		render(ProjectUsagePanel, {
			props: {
				projectId: "proj-1",
				projectOpen: true,
			},
		});

		await waitFor(() => {
			expect(screen.getByText("เหลือ 1024 MB / 1.0 GB")).toBeTruthy();
		});
		queueUsageResponses();

		await fireEvent.click(screen.getByRole("button", { name: "โหลดใหม่" }));

		await waitFor(() => {
			expect(mockFetch).toHaveBeenCalledTimes(6);
		});
	});

	it("uses a passive refresh receipt before a project is open", () => {
		render(ProjectUsagePanel, {
			props: {
				projectId: null,
				projectOpen: false,
			},
		});

		expect(screen.queryByRole("button", { name: "โหลดใหม่" })).toBeNull();
		expect(screen.getByText("เปิดงานก่อนโหลด")).toBeTruthy();
	});

	it("offers an export-history cleanup path only when stored ZIPs use quota", async () => {
		const onReviewStoredExports = vi.fn();
		render(ProjectUsagePanel, {
			props: {
				projectId: "proj-1",
				projectOpen: true,
				onReviewStoredExports,
			},
		});

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "ดู ZIP ที่เก็บไว้" })).toBeTruthy();
		});

		await fireEvent.click(screen.getByRole("button", { name: "ดู ZIP ที่เก็บไว้" }));
		expect(onReviewStoredExports).toHaveBeenCalledTimes(1);

		window.dispatchEvent(new CustomEvent("manga:storage-quota-updated", {
			detail: {
				projectId: "proj-1",
				storageQuota: {
					projectId: "proj-1",
					workspaceId: "proj-1",
					enforced: true,
					usedBytes: 166,
					originalBytes: 70,
					derivativeBytes: 96,
					exportArtifactBytes: 0,
					pendingBytes: 0,
					includedBytes: 1073741824,
					extraBytes: 0,
					limitBytes: 1073741824,
					remainingBytes: 1073741658,
					percentUsed: 0.02,
					assetCount: 1,
					derivativeCount: 2,
					exportArtifactCount: 0,
				},
			},
		}));

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "ดู ZIP ที่เก็บไว้" })).toBeNull();
		});
	});

	it("updates storage quota when export artifact cleanup broadcasts a new summary", async () => {
		render(ProjectUsagePanel, {
			props: {
				projectId: "proj-1",
				projectOpen: true,
			},
		});

		await waitFor(() => {
			expect(screen.getByText("เหลือ 1024 MB / 1.0 GB")).toBeTruthy();
		});

		// First broadcast a HEAVY-usage summary so the remaining headline crosses a
		// formatBytes bucket (1024 MB → 512 MB). Because the headline now shows
		// `remainingBytes`, a near-full before/after pair would round to the same
		// string and the re-render assertion would pass trivially — this distinct
		// bucket proves the panel actually re-renders on the broadcast event.
		window.dispatchEvent(new CustomEvent("manga:storage-quota-updated", {
			detail: {
				projectId: "proj-1",
				storageQuota: {
					projectId: "proj-1",
					workspaceId: "proj-1",
					enforced: true,
					usedBytes: 536870912,
					originalBytes: 70,
					derivativeBytes: 96,
					exportArtifactBytes: 536870746,
					pendingBytes: 0,
					includedBytes: 1073741824,
					extraBytes: 0,
					limitBytes: 1073741824,
					remainingBytes: 536870912,
					percentUsed: 50,
					assetCount: 1,
					derivativeCount: 2,
					exportArtifactCount: 1,
				},
			},
		}));

		await waitFor(() => {
			expect(screen.getByText("เหลือ 512 MB / 1.0 GB")).toBeTruthy();
		});

		// Now the export-artifact cleanup frees that space: remaining climbs back to
		// the full bucket and the Export line drops to 0 B.
		window.dispatchEvent(new CustomEvent("manga:storage-quota-updated", {
			detail: {
				projectId: "proj-1",
				storageQuota: {
					projectId: "proj-1",
					workspaceId: "proj-1",
					enforced: true,
					usedBytes: 166,
					originalBytes: 70,
					derivativeBytes: 96,
					exportArtifactBytes: 0,
					pendingBytes: 0,
					includedBytes: 1073741824,
					extraBytes: 0,
					limitBytes: 1073741824,
					remainingBytes: 1073741658,
					percentUsed: 0.02,
					assetCount: 1,
					derivativeCount: 2,
					exportArtifactCount: 0,
				},
			},
		}));

		await waitFor(() => {
			expect(screen.getByText("เหลือ 1024 MB / 1.0 GB")).toBeTruthy();
		});
		expect(screen.getByText("ใช้ไป 0.0% / ต้นฉบับ 70 B / ไฟล์สร้างแล้ว 96 B / Export 0 B")).toBeTruthy();
	});

	it("does not retry failed auto-loads in a tight loop", async () => {
		mockFetch.mockReset();
		mockFetch.mockRejectedValue(new Error("network down"));

		render(ProjectUsagePanel, {
			props: {
				projectId: "proj-1",
				projectOpen: true,
			},
		});

		await waitFor(() => {
			expect(screen.getByText("โหลด usage ของเวิร์กสเปซไม่สำเร็จ: ตรวจ /api/readyz แล้วลองใหม่")).toBeTruthy();
		});
		expect(screen.queryByText("network down")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(mockFetch).toHaveBeenCalledTimes(3);
	});
});
