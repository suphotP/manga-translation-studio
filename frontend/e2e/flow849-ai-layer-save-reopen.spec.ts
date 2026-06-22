import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow849-ai-layer-save-reopen";
const PROJECT_ID = "123e4567-e89b-42d3-a456-426614184900";

async function mockBackendProjectPersistence(page: Page) {
	let savedProject: any = null;
	const saveRequests: any[] = [];
	const markerPatchRequests: any[] = [];
	const imageRequests: string[] = [];

	await page.route(`**/api/project/${PROJECT_ID}/save`, async (route) => {
		savedProject = await route.request().postDataJSON();
		saveRequests.push(savedProject);
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route(`**/api/project/${PROJECT_ID}/ai-markers/*`, async (route) => {
		const markerId = decodeURIComponent(route.request().url().split("/").pop() ?? "");
		const update = await route.request().postDataJSON();
		markerPatchRequests.push({ markerId, update });
		const markers = (savedProject?.aiReviewMarkers ?? []).map((marker: any) => (
			marker.id === markerId ? { ...marker, ...update, updatedAt: "2026-05-23T04:05:00.000Z" } : marker
		));
		savedProject = { ...savedProject, aiReviewMarkers: markers };
		const marker = markers.find((item: any) => item.id === markerId);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ marker, markers, activityLog: savedProject?.activityLog ?? [] }),
		});
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
		get markerPatchRequests() { return markerPatchRequests; },
		get imageRequests() { return imageRequests; },
	};
}

async function seedAndPlaceAiLayer(page: Page, backend: Awaited<ReturnType<typeof mockBackendProjectPersistence>>) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(
		window.__mangaWorkflowDebug?.seedProject
			&& window.__mangaWorkflowDebug?.getProjectState
			&& window.__mangaWorkflowDebug?.markAcceptedAiResultUnplaced
			&& window.__mangaEditorDebug?.getState,
	));
	const acceptedUnplacedProject = await page.evaluate(async (projectId) => {
		await window.__mangaWorkflowDebug!.seedProject({ projectId });
		await window.__mangaWorkflowDebug!.markAcceptedAiResultUnplaced();
		const project = window.__mangaWorkflowDebug!.getProjectState();
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
		window.__mangaWorkflowDebug!.openView("focus");
		return project;
	}, PROJECT_ID);
	backend.setRemoteProject(acceptedUnplacedProject);
	const focusSignal = page.getByRole("region", { name: "สัญญาณตรวจ AI ที่กำลังแก้" });
	await expect(focusSignal).toContainText("ผ่านตรวจ รอวางเลเยอร์");
	await focusSignal.getByRole("button", { name: "วางเลเยอร์ AI" }).click();
	await expect.poll(() => page.evaluate(() => ({
		hasWorkflowDebug: Boolean(window.__mangaWorkflowDebug?.saveState),
		hasEditorDebug: Boolean(window.__mangaEditorDebug),
		path: window.location.pathname,
	}))).toMatchObject({
		hasWorkflowDebug: true,
		hasEditorDebug: true,
	});
	await expect.poll(() => page.evaluate(() => (
		window.__mangaWorkflowDebug?.getProjectState()?.pages[0]?.imageLayers?.some((layer: any) => layer.id === "ai-result-flow208-ai-marker-p1") ?? false
	))).toBe(true);
	const placedProject = await page.evaluate(() => {
		const project = window.__mangaWorkflowDebug!.getProjectState();
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
		return project;
	});
	backend.setRemoteProject(placedProject);
}

async function collectMetrics(page: Page, backend: Awaited<ReturnType<typeof mockBackendProjectPersistence>>) {
	return page.evaluate((backendState) => {
		const project = window.__mangaWorkflowDebug?.getProjectState() ?? null;
		const editorState = window.__mangaEditorDebug?.getState() ?? null;
		const layer = project?.pages[0]?.imageLayers?.find((item: any) => item.id === "ai-result-flow208-ai-marker-p1") ?? null;
		const marker = project?.aiReviewMarkers?.find((item: any) => item.id === "flow208-ai-marker-p1") ?? null;
		const imageLayerIds = project?.pages[0]?.imageLayers?.map((item: any) => item.id) ?? [];
		const controls = Array.from(document.querySelectorAll("button, input, select, textarea"));
		return {
			...backendState,
			activeLayerId: editorState?.activeLayerId ?? null,
			editorLayerIds: editorState?.imageLayers?.map((item: any) => item.id) ?? [],
			imageLayerIds,
			layer,
			markerStatus: marker?.status ?? null,
			saveSyncStatus: window.__mangaWorkflowDebug?.getState().saveSyncStatus ?? null,
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
	}, {
		saveRequestCount: backend.saveRequests.length,
		markerPatchRequests: backend.markerPatchRequests,
		imageRequests: backend.imageRequests,
	});
}

test.describe("Flow849 AI layer save/reopen truth", () => {
	test("persists placed AI result layers and reopens them without stale marker state or duplicate layers", async ({ page }, testInfo: TestInfo) => {
		const backend = await mockBackendProjectPersistence(page);
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedAndPlaceAiLayer(page, backend);
		await page.evaluate(async () => window.__mangaWorkflowDebug!.saveState());
		expect(backend.saveRequests).toHaveLength(1);
		expect(backend.markerPatchRequests).toEqual([{ markerId: "flow208-ai-marker-p1", update: { status: "applied" } }]);

		const reopened = await page.evaluate(async () => window.__mangaWorkflowDebug!.reopenCurrentProjectFromBackend());
		expect(reopened.opened).toBe(true);
		await page.waitForFunction(() => Boolean(window.__mangaEditorDebug?.getState().imageLayers?.some((layer: any) => layer.id === "ai-result-flow208-ai-marker-p1")));
		await page.evaluate(() => window.__mangaEditorDebug!.selectImageLayer("ai-result-flow208-ai-marker-p1"));
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("ai-result-flow208-ai-marker-p1");

		const metrics = await collectMetrics(page, backend);
		expect(metrics.saveRequestCount).toBe(1);
		expect(metrics.markerPatchRequests).toEqual([{ markerId: "flow208-ai-marker-p1", update: { status: "applied" } }]);
		expect(metrics.imageRequests).toEqual([]);
		expect(metrics.imageLayerIds.filter((id: string) => id === "ai-result-flow208-ai-marker-p1")).toHaveLength(1);
		expect(metrics.editorLayerIds.filter((id: string) => id === "ai-result-flow208-ai-marker-p1")).toHaveLength(1);
		expect(metrics.activeLayerId).toBe("ai-result-flow208-ai-marker-p1");
		expect(metrics.markerStatus).toBe("applied");
		expect(metrics.layer).toMatchObject({
			id: "ai-result-flow208-ai-marker-p1",
			imageId: "flow208-ai-result-p1",
			sourceW: 900,
			sourceH: 1350,
			x: 110,
			y: 310,
			w: 280,
			h: 180,
		});
		expect(metrics.saveSyncStatus).toBe("saved");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-ai-layer-save-reopen.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues }, null, 2),
		);
	});
});
