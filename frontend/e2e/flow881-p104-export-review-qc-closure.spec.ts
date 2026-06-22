import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const P104_REAL_IMAGE_PATH = "/Users/work/Documents/Codex/2026-05-16/ssh-suphot-192-168-1-203/p104/image-01.webp";
const PROJECT_ID = "flow208-project";
const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow881-p104-export-review-qc-closure";

function usageSummary() {
	return {
		workspaceId: PROJECT_ID,
		projectId: PROJECT_ID,
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

async function installExportRoutes(page: Page) {
	let savedProject: unknown = null;
	const saveRequests: unknown[] = [];
	const usageRequests: unknown[] = [];
	const artifactRequests: string[] = [];

	await page.route("**/api/project", async (route) => {
		if (route.request().method() !== "GET") {
			await route.fallback();
			return;
		}
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
	});
	await page.route(`**/api/project/${PROJECT_ID}/save`, async (route) => {
		savedProject = await route.request().postDataJSON();
		saveRequests.push(savedProject);
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route(`**/api/project/${PROJECT_ID}`, async (route) => {
		if (route.request().method() !== "GET") {
			await route.fallback();
			return;
		}
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(savedProject ?? { projectId: PROJECT_ID }) });
	});
	await page.route(`**/api/usage/${PROJECT_ID}/export`, async (route) => {
		usageRequests.push(await route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ ok: true, eventId: "flow881-export-usage", usage: usageSummary() }),
		});
	});
	await page.route(`**/api/project/${PROJECT_ID}/exports/*/artifact`, async (route) => {
		artifactRequests.push(route.request().url());
		const segments = new URL(route.request().url()).pathname.split("/");
		const runId = decodeURIComponent(segments[segments.indexOf("exports") + 1] ?? "flow881-export-run");
		const now = new Date("2026-05-23T15:40:00.000Z").toISOString();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				artifact: {
					exportId: runId,
					storageDriver: "debug",
					storageKey: `debug/${runId}.zip`,
					filename: "flow881-p104-export.zip",
					mimeType: "application/zip",
					sizeBytes: 4096,
					createdAt: now,
				},
				exportRun: {
					id: runId,
					kind: "batch-zip",
					status: "done",
					targetProfile: "draft-internal",
					filename: "flow881-p104-export.zip",
					pageIndexes: [0],
					pageCount: 1,
					bytes: 4096,
					artifact: {
						exportId: runId,
						storageDriver: "debug",
						storageKey: `debug/${runId}.zip`,
						filename: "flow881-p104-export.zip",
						mimeType: "application/zip",
						sizeBytes: 4096,
						createdAt: now,
					},
					message: "Export สำเร็จ 1 หน้า",
					createdAt: now,
					completedAt: now,
				},
			}),
		});
	});

	return { saveRequests, usageRequests, artifactRequests };
}

async function seedP104ReviewBlockedPage(page: Page) {
	const imageBuffer = await readFile(P104_REAL_IMAGE_PATH);
	const imageUrl = `data:image/webp;base64,${imageBuffer.toString("base64")}`;
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async (url) => {
		await window.__mangaWorkflowDebug!.seedReviewApprovalBlockedFinalQcPage();
		window.__mangaWorkflowDebug!.setCurrentPageImageForTesting("flow881-p104-page.webp", "p104-image-01.webp", url);
		window.__mangaWorkflowDebug!.openView("pages");
	}, imageUrl);
	await page.getByRole("region", { name: "ส่งออกตอนนี้" }).waitFor({ state: "visible" });
}

async function collectMetrics(page: Page, consoleIssues: string[], routeState: Awaited<ReturnType<typeof installExportRoutes>>) {
	return page.evaluate((routeMetrics) => {
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
			.filter((control) => {
				const rect = control.getBoundingClientRect();
				const style = getComputedStyle(control);
				return rect.width > 0
					&& rect.height > 0
					&& rect.bottom >= 0
					&& rect.top <= window.innerHeight
					&& style.display !== "none"
					&& style.visibility !== "hidden";
			})
			.map((control) => {
				const rect = control.getBoundingClientRect();
				return {
					text: control.getAttribute("aria-label") ?? control.textContent?.trim().replace(/\s+/g, " ") ?? control.tagName,
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		const state = window.__mangaWorkflowDebug!.getState();
		const project = window.__mangaWorkflowDebug!.getProjectState();
		return {
			...routeMetrics,
			path: window.location.pathname,
			statusText: document.body.innerText,
			batchExportStatus: state.batchExportStatus,
			exportRunCount: state.exportRunCount,
			qcHandoff: project?.pages[0]?.qcHandoff ?? null,
			reviewDecisionCount: project?.reviewDecisions?.length ?? 0,
			taskStatuses: project?.tasks?.map((task) => task.status) ?? [],
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
		};
	}, {
		consoleIssues,
		saveRequestCount: routeState.saveRequests.length,
		usageRequestCount: routeState.usageRequests.length,
		artifactRequestCount: routeState.artifactRequests.length,
	});
}

test.describe("Flow881 p104 export blocker closure", () => {
	test("clears a p104 review blocker through Focus, closes final QC, and exports from Pages", async ({ page }, testInfo: TestInfo) => {
		test.skip(!existsSync(P104_REAL_IMAGE_PATH), `p104 real image not found at ${P104_REAL_IMAGE_PATH}`);
		const routeState = await installExportRoutes(page);
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedP104ReviewBlockedPage(page);
		const exportGate = page.getByRole("region", { name: "ส่งออกตอนนี้" });
		await expect(exportGate).toContainText("Export ยังไม่พร้อม");
		await expect(exportGate).toContainText("1 งานเปิด");
		await exportGate.getByRole("button", { name: "เปิดตัวค้าง" }).click();

		await expect(page).toHaveURL(/\/projects\/flow208-project\/focus\/[^/]+$/);
		const reviewRegion = page.getByRole("region", { name: "ผลตรวจของหน้าใน Focus" });
		await expect(reviewRegion).toContainText("ผ่านตรวจหรือส่งกลับแก้");
		await reviewRegion.getByLabel("โน้ตผลตรวจใน Focus").fill("p104 real page checked");
		await reviewRegion.getByRole("button", { name: "ผ่านตรวจหน้า" }).click();
		await expect(page).toHaveURL(/\/projects\/flow208-project\/pages$/);
		await expect(exportGate).toContainText("ยังไม่ปิด QC ขั้นสุดท้าย");
		await exportGate.getByRole("button", { name: "เปิดตัวค้าง" }).click();

		const mainHandoff = page.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		await expect(mainHandoff).toContainText("QC · 1 หน้ารอปิด QC");
		await mainHandoff.getByRole("button", { name: "ไปปิด QC" }).click();
		const qcBench = page.getByRole("region", { name: "QC / เครดิต" });
		await qcBench.getByRole("button", { name: "ปิด QC หน้านี้" }).click();
		await expect(mainHandoff).toContainText("พร้อมส่งกลับโปรเจกต์หลัก");
		await mainHandoff.getByRole("button", { name: "ไปหน้า Export" }).click();

		await expect(page).toHaveURL(/\/projects\/flow208-project\/pages$/);
		await expect(exportGate).toContainText("Export ZIP พร้อม");
		await exportGate.getByRole("button", { name: "Export ZIP" }).click();
		await expect.poll(() => page.evaluate(() => window.__mangaWorkflowDebug!.getState().batchExportStatus)).toBe("done");
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("Export สำเร็จ");

		const metrics = await collectMetrics(page, consoleIssues, routeState);
		expect(metrics.batchExportStatus).toBe("done");
		expect(metrics.exportRunCount).toBe(1);
		expect(metrics.qcHandoff).toMatchObject({ status: "ready" });
		expect(metrics.reviewDecisionCount).toBe(1);
		expect(metrics.taskStatuses).toEqual(["done"]);
		expect(metrics.usageRequestCount).toBe(1);
		expect(metrics.artifactRequestCount).toBe(1);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(metrics.consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-p104-export-done.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
