import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow853-team-final-qc-save-reopen";
const PROJECT_ID = "123e4567-e89b-42d3-a456-426614185300";

async function mockBackendProjectPersistence(page: Page) {
	let savedProject: any = null;
	const saveRequests: any[] = [];
	const imageRequests: string[] = [];

	await page.route(`**/api/project/${PROJECT_ID}/save`, async (route) => {
		savedProject = await route.request().postDataJSON();
		saveRequests.push(savedProject);
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route(`**/api/project/${PROJECT_ID}/versions`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
	});
	await page.route(`**/api/project/${PROJECT_ID}/workflow`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ tasks: savedProject?.tasks ?? [], activityLog: savedProject?.activityLog ?? [] }),
		});
	});
	await page.route(`**/api/project/${PROJECT_ID}/comments`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ comments: savedProject?.comments ?? [] }) });
	});
	await page.route(`**/api/project/${PROJECT_ID}/review-decisions`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ decisions: savedProject?.reviewDecisions ?? [] }) });
	});
	await page.route(`**/api/project/${PROJECT_ID}/ai-markers`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ markers: savedProject?.aiReviewMarkers ?? [] }) });
	});
	await page.route(`**/api/project/${PROJECT_ID}/workspace-feed`, async (route) => {
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
	await page.route(`**/api/project/${PROJECT_ID}`, async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(savedProject) });
	});
	await page.route("**/api/project", async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
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
	await page.route(`**/api/images/${PROJECT_ID}/**`, async (route) => {
		if (route.request().url().endsWith("/assets")) {
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ assets: [] }) });
			return;
		}
		imageRequests.push(route.request().url());
		await route.abort("failed");
	});

	return {
		setRemoteProject(project: any) {
			savedProject = JSON.parse(JSON.stringify(project));
		},
		get saveRequests() { return saveRequests; },
		get savedProject() { return savedProject; },
		get imageRequests() { return imageRequests; },
	};
}

async function seedFinalQcReadyProject(page: Page, backend: Awaited<ReturnType<typeof mockBackendProjectPersistence>>) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	const project = await page.evaluate(async (projectId) => {
		await window.__mangaWorkflowDebug!.seedProject({ projectId });
		const currentProject = window.__mangaWorkflowDebug!.getProjectState();
		if (!currentProject) throw new Error("Project seed failed");
		const now = "2026-05-23T04:45:00.000Z";
		const pageState = currentProject.pages[0];
		pageState.translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "พร้อมส่งท้าย",
			updatedAt: now,
		}];
		pageState.translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		pageState.cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		pageState.textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "พร้อมส่งท้าย",
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
		pageState.qcHandoff = undefined;
		currentProject.pages = [pageState];
		currentProject.currentPage = 0;
		currentProject.tasks = [];
		currentProject.comments = [];
		currentProject.aiReviewMarkers = [];
		currentProject.reviewDecisions = [{
			id: "flow853-review-approved",
			pageIndex: 0,
			status: "approved",
			body: "หน้าผ่านตรวจแล้ว รอปิด QC ขั้นสุดท้าย",
			actor: "QC",
			createdAt: now,
			updatedAt: now,
		}];
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
		window.__mangaWorkflowDebug!.openView("work");
		return currentProject;
	}, PROJECT_ID);
	backend.setRemoteProject(project);
	const reopened = await page.evaluate(async () => window.__mangaWorkflowDebug!.reopenCurrentProjectFromBackend());
	expect(reopened.opened).toBe(true);
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("work"));
	await page.getByRole("region", { name: "บอร์ดงานตอน" }).waitFor({ state: "visible" });
	await page.getByRole("button", { name: /Team/ }).click();
	await page.getByRole("region", { name: "ทีมผลิตแยกบทบาท" }).waitFor({ state: "visible" });
}

async function collectMetrics(page: Page, backend: Awaited<ReturnType<typeof mockBackendProjectPersistence>>, consoleIssues: string[]) {
	return page.evaluate((backendState) => {
		const project = window.__mangaWorkflowDebug?.getProjectState() ?? null;
		const pageState = project?.pages?.[0] ?? null;
		const body = document.body.innerText;
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"));
		return {
			...backendState,
			saveSyncStatus: window.__mangaWorkflowDebug?.getState().saveSyncStatus ?? null,
			qcHandoff: pageState?.qcHandoff ?? null,
			reviewDecisions: project?.reviewDecisions ?? [],
			tasks: project?.tasks ?? [],
			mainHandoffReady: body.includes("พร้อมส่งกลับโปรเจกต์หลัก"),
			qcClosedCopy: body.includes("QC · QC ปิดครบ") || body.includes("QC · ปิด QC แล้ว"),
			exportAction: body.includes("ไปหน้า Export"),
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
		imageRequests: backend.imageRequests,
		consoleIssues,
	});
}

test.describe("Flow853 team final QC save/reopen truth", () => {
	test("persists final QC close and reopens the team handoff as ready for the main project", async ({ page }, testInfo: TestInfo) => {
		const backend = await mockBackendProjectPersistence(page);
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedFinalQcReadyProject(page, backend);
		const mainHandoff = page.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		await expect(mainHandoff).toContainText("1 จุดก่อนส่งกลับโปรเจกต์หลัก");
		await expect(mainHandoff).toContainText("QC · 1 หน้ารอปิด QC");
		await mainHandoff.getByRole("button", { name: "ไปปิด QC" }).click();
		const qcBench = page.getByRole("region", { name: "QC / เครดิต" });
		await expect(qcBench).toContainText("รอปิด QC");
		await qcBench.getByRole("button", { name: "ปิด QC หน้านี้" }).click();
		await expect(mainHandoff).toContainText("พร้อมส่งกลับโปรเจกต์หลัก");
		await expect(mainHandoff).toContainText("QC · QC ปิดครบ");
		await expect(mainHandoff.getByRole("button", { name: "ไปหน้า Export" })).toBeVisible();

		await expect.poll(() => backend.saveRequests.length).toBe(1);
		expect(backend.saveRequests).toHaveLength(1);
		expect(backend.savedProject?.pages?.[0]?.qcHandoff).toMatchObject({
			status: "ready",
			updatedBy: "qc",
		});

		const reopened = await page.evaluate(async () => window.__mangaWorkflowDebug!.reopenCurrentProjectFromBackend());
		expect(reopened.opened).toBe(true);
		await page.evaluate(() => window.__mangaWorkflowDebug!.openView("work"));
		await page.getByRole("region", { name: "บอร์ดงานตอน" }).waitFor({ state: "visible" });
		await page.getByRole("button", { name: /Team/ }).click();
		const reopenedMainHandoff = page.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		await expect(reopenedMainHandoff).toContainText("พร้อมส่งกลับโปรเจกต์หลัก");
		await expect(reopenedMainHandoff).toContainText("QC · QC ปิดครบ");
		await expect(reopenedMainHandoff.getByRole("button", { name: "ไปหน้า Export" })).toBeVisible();

		const metrics = await collectMetrics(page, backend, consoleIssues);
		expect(metrics.saveRequestCount).toBe(1);
		expect(metrics.imageRequests).toEqual([]);
		expect(metrics.qcHandoff).toMatchObject({
			status: "ready",
			updatedBy: "qc",
		});
		expect(metrics.reviewDecisions).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "flow853-review-approved", status: "approved", pageIndex: 0 }),
		]));
		expect(metrics.tasks).toEqual([]);
		expect(metrics.mainHandoffReady).toBe(true);
		expect(metrics.qcClosedCopy).toBe(true);
		expect(metrics.exportAction).toBe(true);
		expect(metrics.saveSyncStatus).toBe("saved");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-team-final-qc-save-reopen.png`,
			fullPage: true,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
