import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow848-local-ai-layer-batch-export";

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

async function mockExportSideEffects(page: Page, imageRequests: string[]) {
	await page.route("**/api/images/flow208-project/**", async (route) => {
		imageRequests.push(route.request().url());
		await route.abort("failed");
	});
	await page.route("**/api/usage/flow208-project/export", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				ok: true,
				eventId: "flow848-export-usage",
				usage: usageSummary(),
			}),
		});
	});
	await page.route("**/api/project/flow208-project/exports/*/artifact", async (route) => {
		const url = new URL(route.request().url());
		const parts = url.pathname.split("/");
		const runId = decodeURIComponent(parts[parts.length - 2] ?? "flow848-export");
		const now = new Date("2026-05-23T03:48:00.000Z").toISOString();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				artifact: {
					exportId: runId,
					storageDriver: "debug",
					storageKey: `debug/${runId}.zip`,
					filename: "flow848-local-ai-layer-export.zip",
					mimeType: "application/zip",
					sizeBytes: 4096,
					createdAt: now,
				},
				exportRun: {
					id: runId,
					kind: "batch-zip",
					status: "done",
					targetProfile: "public",
					filename: "flow848-local-ai-layer-export.zip",
					pageIndexes: [0, 1],
					pageCount: 2,
					bytes: 4096,
					artifact: {
						exportId: runId,
						storageDriver: "debug",
						storageKey: `debug/${runId}.zip`,
						filename: "flow848-local-ai-layer-export.zip",
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

async function seedAcceptedAiLayer(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		await window.__mangaWorkflowDebug!.markAcceptedAiResultUnplaced();
		window.__mangaWorkflowDebug!.openView("focus");
	});
	const focusSignal = page.getByRole("region", { name: "สัญญาณตรวจ AI ที่กำลังแก้" });
	await expect(focusSignal).toContainText("ผ่านตรวจ รอวางเลเยอร์");
	await focusSignal.getByRole("button", { name: "วางเลเยอร์ AI" }).click();
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await expect.poll(() => page.evaluate(() => (
		window.__mangaWorkflowDebug?.getProjectState()?.pages[0]?.imageLayers?.some((layer: any) => layer.id === "ai-result-flow208-ai-marker-p1") ?? false
	))).toBe(true);
}

async function collectMetrics(page: Page, imageRequests: string[]) {
	return page.evaluate((requests) => {
		const project = window.__mangaWorkflowDebug?.getProjectState() ?? null;
		const state = window.__mangaWorkflowDebug?.getState() ?? null;
		const layer = project?.pages[0]?.imageLayers?.find((item: any) => item.id === "ai-result-flow208-ai-marker-p1") ?? null;
		const latestExportRun = project?.exportRuns?.[0] ?? null;
		const doneExportRun = project?.exportRuns?.find((run: any) => run.status === "done") ?? null;
		const imageLayerIds = project?.pages?.[0]?.imageLayers?.map((layer: any) => layer.id) ?? [];
		const controls = Array.from(document.querySelectorAll("button, input, select, textarea"));
		return {
			exportFilename: doneExportRun?.filename ?? latestExportRun?.filename ?? null,
			latestExportRun,
			doneExportRun,
			imageLayerIds,
			imageRequests: requests,
			batchExportStatus: state?.batchExportStatus ?? null,
			exportRunCount: state?.exportRunCount ?? null,
			layer,
			statusText: document.querySelector("[role='status'][aria-label='สถานะตัวแก้หน้า']")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			under40: controls
				.filter((control) => {
					const rect = control.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
				})
				.map((control) => {
					const rect = control.getBoundingClientRect();
					return {
						text: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName,
						width: Math.round(rect.width),
						height: Math.round(rect.height),
					};
				})
				.filter((item) => item.width < 40 || item.height < 40),
		};
	}, imageRequests);
}

test.describe("Flow848 local AI layer batch export", () => {
	test("exports placed AI result layers from local project image URLs without falling back to image API", async ({ page }, testInfo: TestInfo) => {
		const imageRequests: string[] = [];
		const consoleIssues: string[] = [];
		const ignoredStartupIssues: string[] = [];
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			const issue = `${message.type()}: ${message.text()}`;
			if (issue.includes("Failed to load resource") || issue.includes("[ProjectStore] loadRecentProjects error")) {
				ignoredStartupIssues.push(issue);
				return;
			}
			consoleIssues.push(issue);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await mockExportSideEffects(page, imageRequests);
		await seedAcceptedAiLayer(page);
		await page.waitForFunction(() => Boolean(
			window.__mangaWorkflowDebug?.markChapterExportReady
			&& window.__mangaWorkflowDebug?.exportReadyChapterBatch
			&& window.__mangaEditorDebug,
		));

		const exported = await page.evaluate(async () => {
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			await window.__mangaWorkflowDebug!.markChapterExportReady();
			return window.__mangaWorkflowDebug!.exportReadyChapterBatch();
		});
		const metrics = await collectMetrics(page, imageRequests);

		expect({ exported, metrics }).toMatchObject({
			exported: {
			pageCount: 2,
			exportReadyCount: 2,
			batchExportStatus: "done",
			},
		});
		expect(imageRequests).toEqual([]);
		expect(consoleIssues).toEqual([]);

		expect(metrics.batchExportStatus).toBe("done");
		expect(metrics.exportRunCount).toBeGreaterThanOrEqual(2);
		expect(metrics.exportFilename).toMatch(/\.zip$/);
		expect(metrics.imageLayerIds.filter((id: string) => id === "ai-result-flow208-ai-marker-p1")).toHaveLength(1);
		expect(metrics.layer).toMatchObject({
			id: "ai-result-flow208-ai-marker-p1",
			imageId: "flow208-ai-result-p1",
			sourceW: 900,
			sourceH: 1350,
		});
		expect(metrics.statusText).toContain("Export สำเร็จ 2 หน้า");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-local-ai-layer-batch-export.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues, ignoredStartupIssues }, null, 2),
		);
	});
});
