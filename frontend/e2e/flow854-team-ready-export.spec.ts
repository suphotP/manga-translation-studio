import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow854-team-ready-export";
const PROJECT_ID_BASE = "123e4567-e89b-42d3-a456-426614185400";
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

function usageSummary(projectId: string) {
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

async function mockBackendProjectPersistence(page: Page, projectId: string) {
	let savedProject: any = null;
	const saveRequests: any[] = [];
	const imageRequests: string[] = [];
	const usageRequests: any[] = [];
	let artifactDownloadCount = 0;
	let artifactAvailable = true;

	await page.route(`**/api/project/${projectId}/save`, async (route) => {
		savedProject = await route.request().postDataJSON();
		saveRequests.push(savedProject);
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route(`**/api/project/${projectId}/versions`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
	});
	await page.route(`**/api/project/${projectId}/workflow`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ tasks: savedProject?.tasks ?? [], activityLog: savedProject?.activityLog ?? [] }),
		});
	});
	await page.route(`**/api/project/${projectId}/comments`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ comments: savedProject?.comments ?? [] }) });
	});
	await page.route(`**/api/project/${projectId}/review-decisions`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ decisions: savedProject?.reviewDecisions ?? [] }) });
	});
	await page.route(`**/api/project/${projectId}/ai-markers`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ markers: savedProject?.aiReviewMarkers ?? [] }) });
	});
	await page.route(`**/api/project/${projectId}/workspace-feed`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				items: [],
				messages: savedProject?.workspaceMessages ?? [],
				activityLog: savedProject?.activityLog ?? [],
			}),
		});
	});
	await page.route(`**/api/project/${projectId}`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(savedProject) });
	});
	await page.route("**/api/project", async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
	});
	await page.route(`**/api/usage/${projectId}/export`, async (route) => {
		usageRequests.push(await route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ ok: true, eventId: "flow854-export-usage", usage: usageSummary(projectId) }),
		});
	});
	await page.route(`**/api/project/${projectId}/exports/*/artifact`, async (route) => {
		const method = route.request().method();
		const segments = new URL(route.request().url()).pathname.split("/");
		const runId = decodeURIComponent(segments[segments.indexOf("exports") + 1] ?? "flow854-export-run");
		if (method === "GET") {
			artifactDownloadCount += 1;
			if (!artifactAvailable) {
				await route.fulfill({
					status: 404,
					contentType: "application/json",
					body: JSON.stringify({ error: "Export artifact not found" }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/zip",
				headers: {
					"Content-Disposition": "attachment; filename=\"chapter_export.zip\"",
				},
				body: Buffer.from("flow854-zip"),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				artifact: {
					exportId: runId,
					storageDriver: "memory",
					storageKey: `flow854/${runId}.zip`,
					filename: "chapter_export.zip",
					mimeType: "application/zip",
					sizeBytes: 256,
					createdAt: "2026-05-23T04:55:00.000Z",
				},
			}),
		});
	});
	await page.route("**/api/ai/capabilities", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				tiers: [
					{ id: "sfx-pro", label: "SFX Pro", available: true },
					{ id: "clean-pro", label: "Clean Pro", available: true },
					{ id: "budget-clean", label: "Budget Clean", available: true },
				],
			}),
		});
	});
	await page.route(`**/api/images/${projectId}/**`, async (route) => {
		if (route.request().url().endsWith("/assets")) {
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ assets: [] }) });
			return;
		}
		imageRequests.push(route.request().url());
		await route.fulfill({
			status: 200,
			contentType: "image/png",
			headers: { "Access-Control-Allow-Origin": "*" },
			body: TINY_PNG,
		});
	});

	return {
		setRemoteProject(project: any) {
			savedProject = JSON.parse(JSON.stringify(project));
		},
		setArtifactAvailable(value: boolean) {
			artifactAvailable = value;
		},
		get savedProject() { return savedProject; },
		get saveRequests() { return saveRequests; },
		get usageRequests() { return usageRequests; },
		get imageRequests() { return imageRequests; },
		get artifactDownloadCount() { return artifactDownloadCount; },
	};
}

async function seedTeamReadyProject(page: Page, backend: Awaited<ReturnType<typeof mockBackendProjectPersistence>>, projectId: string) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	const project = await page.evaluate(async (projectId) => {
		await window.__mangaWorkflowDebug!.seedProject({ projectId });
		const currentProject = window.__mangaWorkflowDebug!.getProjectState();
		if (!currentProject) throw new Error("Project seed failed");
		const now = "2026-05-23T04:55:00.000Z";
		const pageState = currentProject.pages[0];
		pageState.translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "พร้อมส่งออก",
			updatedAt: now,
		}];
		pageState.translationHandoff = { status: "translated", updatedAt: now, updatedBy: "translator" };
		pageState.cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		pageState.qcHandoff = { status: "ready", updatedAt: now, updatedBy: "qc" };
		pageState.textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "พร้อมส่งออก",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
			opacity: 1,
			visible: true,
			locked: false,
		}];
		currentProject.pages = [pageState];
		currentProject.currentPage = 0;
		currentProject.tasks = [];
		currentProject.comments = [];
		currentProject.aiReviewMarkers = [];
		currentProject.reviewDecisions = [{
			id: "flow854-review-approved",
			pageIndex: 0,
			status: "approved",
			body: "หน้าพร้อม Export หลังทีมปิด QC",
			actor: "QC",
			createdAt: now,
			updatedAt: now,
		}];
		currentProject.creditPolicy = "optional";
		currentProject.exportRuns = [];
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
		return currentProject;
	}, projectId);
	backend.setRemoteProject(project);
	const reopened = await page.evaluate(async () => window.__mangaWorkflowDebug!.reopenCurrentProjectFromBackend());
	expect(reopened.opened).toBe(true);
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("work"));
	await page.getByRole("region", { name: "บอร์ดงานตอน" }).waitFor({ state: "visible" });
	await page.getByRole("button", { name: /Team/ }).click();
	await page.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" }).waitFor({ state: "visible" });
}

async function collectMetrics(page: Page, backend: Awaited<ReturnType<typeof mockBackendProjectPersistence>>, consoleIssues: string[]) {
	return page.evaluate((backendState) => {
		const body = document.body.innerText;
		const state = window.__mangaWorkflowDebug?.getState();
		const project = window.__mangaWorkflowDebug?.getProjectState();
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"));
		return {
			...backendState,
			batchExportStatus: state?.batchExportStatus ?? null,
			batchExportMessage: state?.batchExportMessage ?? "",
			exportRunCount: state?.exportRunCount ?? 0,
			exportRuns: project?.exportRuns ?? [],
			exportDoneCopy: body.includes("Export สำเร็จ"),
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			under40: controls
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
				})
				.filter((item) => item.width < 40 || item.height < 40),
		};
	}, {
		saveRequestCount: backend.saveRequests.length,
		savedExportRuns: backend.savedProject?.exportRuns ?? [],
		usageRequests: backend.usageRequests,
		imageRequestCount: backend.imageRequests.length,
		artifactDownloadCount: backend.artifactDownloadCount,
		consoleIssues,
	});
}

test.describe("Flow854 team-ready export truth", () => {
	test("exports a backend-reopened Team-ready chapter from the main handoff path", async ({ page }, testInfo: TestInfo) => {
		const projectId = `${PROJECT_ID_BASE}-${testInfo.project.name}`;
		const backend = await mockBackendProjectPersistence(page, projectId);
		const consoleIssues: string[] = [];
		let expectingMissingArtifact404 = false;
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			if (expectingMissingArtifact404 && message.text().includes("Failed to load resource") && message.text().includes("404")) {
				return;
			}
			consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedTeamReadyProject(page, backend, projectId);
		const mainHandoff = page.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		if (await mainHandoff.getByRole("button", { name: "ไปปิด QC" }).count()) {
			await mainHandoff.getByRole("button", { name: "ไปปิด QC" }).click();
			const qcBench = page.getByRole("region", { name: "QC / เครดิต" });
			await expect(qcBench).toContainText("รอปิด QC");
			await qcBench.getByRole("button", { name: "ปิด QC หน้านี้" }).click();
		}
		await expect(mainHandoff).toContainText("พร้อมส่งกลับโปรเจกต์หลัก");
		await expect(mainHandoff).toContainText("QC · QC ปิดครบ");
		await mainHandoff.getByRole("button", { name: "ไปหน้า Export" }).click();
		await page.getByRole("region", { name: "หน้าในงาน" }).waitFor({ state: "visible" });
		await expect(page.getByRole("region", { name: "หน้าในงาน" })).toContainText("หน้าพร้อม Export");
		const exportGate = page.getByRole("region", { name: "ส่งออกตอนนี้" });
		await expect(exportGate).toContainText("Export ZIP พร้อม");
		await exportGate.getByRole("button", { name: "Export ZIP" }).click();
		await expect.poll(() => page.evaluate(() => window.__mangaWorkflowDebug!.getState().batchExportStatus)).toBe("done");
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("Export สำเร็จ");

		const metrics = await collectMetrics(page, backend, consoleIssues);
		expect(metrics.batchExportStatus).toBe("done");
		expect(metrics.exportRunCount).toBe(1);
		expect(metrics.exportRuns).toEqual(expect.arrayContaining([
			expect.objectContaining({
				kind: "batch-zip",
				status: "done",
				pageIndexes: [0],
				artifact: expect.objectContaining({ storageKey: expect.stringContaining("/export-") }),
			}),
		]));
		expect(metrics.savedExportRuns).toEqual(expect.arrayContaining([
			expect.objectContaining({
				kind: "batch-zip",
				status: "done",
				pageIndexes: [0],
				artifact: expect.objectContaining({ filename: "chapter_export.zip" }),
			}),
		]));
		expect(metrics.usageRequests).toHaveLength(1);
		expect(metrics.usageRequests[0]).toMatchObject({
			pageIndexes: [0],
			pageCount: 1,
			exportKind: "batch-zip",
		});
		expect(metrics.saveRequestCount).toBeGreaterThanOrEqual(1);
		expect(metrics.imageRequestCount).toBeGreaterThanOrEqual(0);
		expect(metrics.exportDoneCopy).toBe(true);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await page.goto(`/projects/${projectId}`);
		await page.waitForFunction((id) => window.__mangaWorkflowDebug?.getProjectState()?.projectId === id, projectId);
		await page.evaluate(() => window.__mangaWorkflowDebug!.openView("pages"));
		const reopenedHistory = page.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		await expect(reopenedHistory).toContainText("เก็บ ZIP แล้ว / นับใน storage");
		if (!await reopenedHistory.evaluate((node) => (node as HTMLDetailsElement).open)) {
			await reopenedHistory.locator("summary").click();
		}
		await expect(reopenedHistory.getByRole("button", { name: "ดาวน์โหลด" })).toBeVisible();
		await reopenedHistory.getByRole("button", { name: "ดาวน์โหลด" }).click();
		await expect.poll(() => backend.artifactDownloadCount).toBe(1);
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("ดาวน์โหลด chapter_export.zip แล้ว");

		backend.setArtifactAvailable(false);
		await page.goto(`/projects/${projectId}`);
		await page.waitForFunction((id) => window.__mangaWorkflowDebug?.getProjectState()?.projectId === id, projectId);
		await page.evaluate(() => window.__mangaWorkflowDebug!.openView("pages"));
		const missingArtifactHistory = page.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		if (!await missingArtifactHistory.evaluate((node) => (node as HTMLDetailsElement).open)) {
			await missingArtifactHistory.locator("summary").click();
		}
		await expect(missingArtifactHistory.getByRole("button", { name: "ดาวน์โหลด" })).toBeVisible();
		expectingMissingArtifact404 = true;
		await missingArtifactHistory.getByRole("button", { name: "ดาวน์โหลด" }).click();
		await expect.poll(() => backend.artifactDownloadCount).toBe(2);
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ");
		await expect(missingArtifactHistory).toContainText("ดาวน์โหลดยังไม่พร้อม");
		await expect(missingArtifactHistory).toContainText("ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ");
		expectingMissingArtifact404 = false;
		expect(consoleIssues).toEqual([]);
		const missingArtifactSaved = backend.savedProject?.exportRuns?.[0]?.artifact === undefined
			&& Boolean(backend.savedProject?.exportRuns?.[0]?.artifactError);

		backend.setArtifactAvailable(true);
		await expect.poll(() => missingArtifactHistory.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(true);
		await expect(missingArtifactHistory.getByRole("button", { name: "ทำ ZIP ใหม่" }).first()).toBeVisible();
		await missingArtifactHistory.getByRole("button", { name: "ทำ ZIP ใหม่" }).first().click();
		await expect.poll(() => page.evaluate(() => window.__mangaWorkflowDebug!.getState().batchExportStatus)).toBe("done");
		await expect(missingArtifactHistory).toContainText("เก็บ ZIP แล้ว / นับใน storage");
		expect(backend.savedProject?.exportRuns?.[0]?.artifact).toEqual(expect.objectContaining({
			filename: "chapter_export.zip",
		}));
		const finalMetrics = {
			...metrics,
			finalArtifactDownloadCount: backend.artifactDownloadCount,
			missingArtifactSaved,
			retryRebuiltArtifactSaved: Boolean(backend.savedProject?.exportRuns?.[0]?.artifact),
			finalUsageRequestCount: backend.usageRequests.length,
			finalConsoleIssues: consoleIssues,
			reopenedStoredArtifactCopy: await missingArtifactHistory.textContent(),
		};

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-team-ready-export.png`,
			fullPage: true,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify(finalMetrics, null, 2),
		);
	});
});
