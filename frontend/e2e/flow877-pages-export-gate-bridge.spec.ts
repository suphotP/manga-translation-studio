import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow877-pages-export-gate-bridge";

function usageSummary(projectId = "flow208-project") {
	return {
		workspaceId: projectId,
		projectId,
		planId: "debug",
		enforced: false,
		daily: {
			windowStart: Date.now(),
			windowEnd: Date.now() + 86_400_000,
			aiReservedThb: 0,
			aiCommittedThb: 0,
			uploadBytes: 0,
			exportBytes: 0,
			moderationImages: 0,
			limits: { aiCreditThb: 0, uploadBytes: 0, exportBytes: 0 },
			remaining: { aiCreditThb: null, uploadBytes: null, exportBytes: null },
			percentUsed: { aiCredit: null, uploadBytes: null, exportBytes: null },
		},
		monthly: {
			windowStart: Date.now(),
			windowEnd: Date.now() + 2_592_000_000,
			aiReservedThb: 0,
			aiCommittedThb: 0,
			uploadBytes: 0,
			exportBytes: 0,
			moderationImages: 0,
			limits: { aiCreditThb: 0, uploadBytes: 0, exportBytes: 0 },
			remaining: { aiCreditThb: null, uploadBytes: null, exportBytes: null },
			percentUsed: { aiCredit: null, uploadBytes: null, exportBytes: null },
		},
		eventCount: 1,
	};
}

async function installLocalExportFallbacks(page: Page, imageRequests: string[]) {
	await page.route("**/api/project", async (route) => {
		if (route.request().method() !== "GET") {
			await route.fallback();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ projects: [] }),
		});
	});
	await page.route("**/api/ai/capabilities", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ tiers: [] }),
		});
	});
	await page.route("**/api/images/flow208-project/**", async (route) => {
		imageRequests.push(route.request().url());
		await route.abort("failed");
	});
	await page.route("**/api/usage/flow208-project/export", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ ok: true, eventId: "flow877-export-usage", usage: usageSummary() }),
		});
	});
	await page.route("**/api/project/flow208-project/exports/*/artifact", async (route) => {
		const url = new URL(route.request().url());
		const parts = url.pathname.split("/");
		const runId = decodeURIComponent(parts[parts.length - 2] ?? "flow877-export");
		const now = new Date("2026-05-23T11:30:00.000Z").toISOString();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				artifact: {
					exportId: runId,
					storageDriver: "debug",
					storageKey: `debug/${runId}.zip`,
					filename: "flow877-pages-export.zip",
					mimeType: "application/zip",
					sizeBytes: 4096,
					createdAt: now,
				},
				exportRun: {
					id: runId,
					kind: "batch-zip",
					status: "done",
					targetProfile: "draft-internal",
					filename: "flow877-pages-export.zip",
					pageIndexes: [0, 1],
					pageCount: 2,
					bytes: 4096,
					artifact: {
						exportId: runId,
						storageDriver: "debug",
						storageKey: `debug/${runId}.zip`,
						filename: "flow877-pages-export.zip",
						mimeType: "application/zip",
						sizeBytes: 4096,
						createdAt: now,
					},
					message: "Export สำเร็จ 2 หน้า",
					createdAt: now,
					completedAt: now,
				},
			}),
		});
	});
}

async function openReadyPagesExportGate(page: Page, imageRequests: string[]) {
	await installLocalExportFallbacks(page, imageRequests);
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		await window.__mangaWorkflowDebug!.markChapterExportReady();
		const project = window.__mangaWorkflowDebug!.getProjectState();
		if (!project) throw new Error("Expected seeded project");
		project.tasks.length = 0;
		project.comments.length = 0;
		project.aiReviewMarkers.length = 0;
		project.reviewDecisions.length = 0;
		for (const [index, pageState] of project.pages.entries()) {
			pageState.textLayers = [{
				id: `flow877-ready-text-${index}`,
				text: "พร้อมส่งออก",
				x: 120,
				y: 160,
				w: 620,
				h: 150,
				rotation: 0,
				fontSize: 28,
				alignment: "center",
				index: 0,
				protected: true,
			} as any];
			project.reviewDecisions.push({
				id: `flow877-approved-${index}`,
				pageIndex: index,
				status: "approved",
				body: "พร้อม Export",
				actor: "lead",
				createdAt: "2026-05-23T11:30:00.000Z",
				updatedAt: "2026-05-23T11:30:00.000Z",
			} as any);
		}
		project.tasks.push({
			id: "flow877-page-1-export-task",
			type: "review",
			status: "todo",
			priority: "high",
			pageIndex: 0,
			title: "ตัวค้าง Export หน้า 1",
			assignee: "lead",
			createdAt: "2026-05-23T11:30:00.000Z",
			updatedAt: "2026-05-23T11:30:00.000Z",
		} as any);
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
		window.__mangaWorkflowDebug!.openView("pages");
	});
	await page.getByRole("region", { name: "ส่งออกตอนนี้" }).waitFor({ state: "visible" });
}

async function collectMetrics(page: Page, imageRequests: string[], consoleIssues: string[]) {
	return page.evaluate(({ imageRequests, consoleIssues }) => {
		const visible = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0
				&& rect.height > 0
				&& rect.bottom > 0
				&& rect.right > 0
				&& rect.top < innerHeight
				&& rect.left < innerWidth
				&& style.display !== "none"
				&& style.visibility !== "hidden"
				&& style.opacity !== "0";
		};
		const controls = Array.from(document.querySelectorAll("button, input, select, textarea, summary"))
			.filter(visible)
			.map((control) => {
				const rect = control.getBoundingClientRect();
				return {
					text: control.getAttribute("aria-label") ?? control.textContent?.replace(/\s+/g, " ").trim() ?? control.tagName,
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
		});
		const gate = document.querySelector(".pages-chapter-export-gate");
		const gateRect = gate?.getBoundingClientRect();
		const focusReturn = document.querySelector(".focus-export-return");
		const focusReturnRect = focusReturn?.getBoundingClientRect();
		const state = window.__mangaWorkflowDebug?.getState();
		return {
			path: window.location.pathname,
			gateText: gate?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			gateBox: gateRect ? {
				width: Math.round(gateRect.width),
				height: Math.round(gateRect.height),
				top: Math.round(gateRect.top),
				bottom: Math.round(gateRect.bottom),
			} : null,
			focusReturnText: focusReturn?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			focusReturnBox: focusReturnRect ? {
				width: Math.round(focusReturnRect.width),
				height: Math.round(focusReturnRect.height),
				top: Math.round(focusReturnRect.top),
				bottom: Math.round(focusReturnRect.bottom),
			} : null,
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
			batchExportStatus: state?.batchExportStatus ?? null,
			exportRunCount: state?.exportRunCount ?? null,
			imageRequestCount: imageRequests.length,
			consoleIssues,
		};
	}, { imageRequests, consoleIssues });
}

test.describe("Flow877 Pages export gate bridge", () => {
	test("shows the chapter export blocker on Pages and routes to the exact work to clear", async ({ page }, testInfo: TestInfo) => {
		const imageRequests: string[] = [];
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await openReadyPagesExportGate(page, imageRequests);
		const gate = page.getByRole("region", { name: "ส่งออกตอนนี้" });
		await expect(gate).toContainText("Export ยังไม่พร้อม");
		await expect(gate).toContainText("หน้า 1");
		await expect(gate.getByRole("button", { name: "เช็ก Export" })).toBeVisible();
		await expect(gate.getByRole("button", { name: "เปิดตัวค้าง" })).toBeVisible();
		await expect(gate.getByText("เคลียร์ก่อน Export")).toBeVisible();

		await gate.getByRole("button", { name: "เช็ก Export" }).click();
		await expect(gate).toContainText("Export ยังไม่พร้อม: หน้า 1");

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-pages-export-gate-blocked.png`,
			fullPage: false,
		});

		const before = await collectMetrics(page, imageRequests, consoleIssues);
		expect(before.path).toBe("/");
		expect(before.gateText).toContain("Export ยังไม่พร้อม");
		expect(before.gateBox?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(before.overflowX).toBe(0);
		expect(before.bodyOverflowX).toBe(0);
		expect(before.under40).toEqual([]);
		expect(before.imageRequestCount).toBe(0);
		expect(before.consoleIssues).toEqual([]);

		await gate.getByRole("button", { name: "เปิดตัวค้าง" }).click();
		await expect(page).toHaveURL(/\/projects\/flow208-project\/focus\/[^/]+$/);
		await expect(page.locator(".editor-root.workspace-focus-view")).toBeVisible();
		const focusReturn = page.getByRole("region", { name: "สถานะ Export ของตัวค้าง" });
		await expect(focusReturn).toContainText("ตัวค้าง Export หน้า 1");
		await expect(focusReturn).toContainText("Export ยังไม่พร้อม: หน้า 1");
		await expect(focusReturn.getByRole("button", { name: "เช็ก Export" })).toBeVisible();
		const after = await collectMetrics(page, imageRequests, consoleIssues);

		expect(after.path).toMatch(/\/projects\/flow208-project\/focus\/[^/]+$/);
		expect(after.focusReturnText).toContain("ตัวค้าง Export หน้า 1");
		expect(after.focusReturnBox?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(after.overflowX).toBe(0);
		expect(after.bodyOverflowX).toBe(0);
		expect(after.under40).toEqual([]);
		expect(after.consoleIssues).toEqual([]);
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-pages-export-blocker-focus.png`,
			fullPage: false,
		});

		await focusReturn.getByRole("button", { name: "เช็ก Export" }).click();
		await expect(page).toHaveURL(/\/projects\/flow208-project\/pages$/);
		await expect(page.getByRole("region", { name: "ส่งออกตอนนี้" })).toBeVisible();
		const returned = await collectMetrics(page, imageRequests, consoleIssues);
		expect(returned.path).toBe("/projects/flow208-project/pages");
		expect(returned.gateText).toContain("Export ยังไม่พร้อม");
		expect(returned.overflowX).toBe(0);
		expect(returned.bodyOverflowX).toBe(0);
		expect(returned.under40).toEqual([]);
		expect(returned.consoleIssues).toEqual([]);

		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-metrics.json`, JSON.stringify({ before, after, returned }, null, 2));
	});
});
