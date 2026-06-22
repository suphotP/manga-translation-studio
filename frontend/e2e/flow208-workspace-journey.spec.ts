import { expect, test, type Page } from "@playwright/test";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

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

async function mockExportEndpoints(page: Page, options: { usageFails?: boolean; usageFailCount?: number } = {}) {
	let usageAttempts = 0;
	await page.route("**/api/images/flow208-project/**", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "image/png",
			headers: { "Access-Control-Allow-Origin": "*" },
			body: TINY_PNG,
		});
	});
	await page.route("**/api/usage/flow208-project/export", async (route) => {
		usageAttempts += 1;
		const shouldFailUsage = options.usageFails || usageAttempts <= (options.usageFailCount ?? 0);
		if (shouldFailUsage) {
			await route.fulfill({
				status: 429,
				contentType: "application/json",
				body: JSON.stringify({
					error: "Workspace usage quota exceeded",
					code: "usage_quota_exceeded",
					quotaClass: "export",
				}),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				ok: true,
				eventId: "flow216-export-usage",
				usage: usageSummary(),
			}),
		});
	});
}

async function waitForWorkflowDebug(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaEditorDebug && window.__mangaWorkflowDebug));
}

async function seedWorkflowProject(page: Page, options: { missingSecondPage?: boolean } = {}) {
	await waitForWorkflowDebug(page);
	return page.evaluate((input) => window.__mangaWorkflowDebug!.seedProject(input), options);
}

async function imagePointToClient(page: Page, point: { x: number; y: number }) {
	return page.evaluate((input) => window.__mangaEditorDebug!.imagePointToClient(input), point);
}

async function openWorkspaceView(page: Page, view: "dashboard" | "library" | "pages" | "work" | "import" | "editor" | "focus") {
	await page.evaluate((target) => window.__mangaWorkflowDebug!.openView(target), view);
	if (view !== "editor") {
		await expect(page.locator(`.editor-root.workspace-${view}-view`)).toBeVisible();
	}
}

function editorStatus(page: Page) {
	return page.getByRole("status", { name: "สถานะตัวแก้หน้า" });
}

test.describe("Flow208 prototype workspace journeys", () => {
	test.describe.configure({ mode: "serial" });

	test("walks one chapter through canvas text placement, import draft, review, AI marker, and version surfaces", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Prototype workflow journey is covered on desktop/tablet; mobile editor IA is a separate surface.");

		const seeded = await seedWorkflowProject(page);
		expect(seeded).toMatchObject({
			pageIndex: 0,
			pageCount: 2,
			taskCount: 1,
			openCommentCount: 1,
			reviewDecisionCount: 1,
			aiReviewMarkerCount: 1,
			versionCount: 1,
			assetStatus: "ready",
		});

		await expect(editorStatus(page)).toContainText("หน้า 1 / 2");
		await expect(editorStatus(page)).toContainText("งาน Moonlit Courier ตอน 104");

		await page.keyboard.press("t");
		await expect(editorStatus(page)).toContainText("คลิกบนรูปเพื่อวางข้อความ");
		const textPoint = await imagePointToClient(page, { x: 520, y: 640 });
		await page.mouse.click(textPoint.x, textPoint.y);
		await expect(page.locator("#text-layer-text")).toBeFocused();
		await page.locator("#text-layer-text").fill("Courier clicked text");

		let editorState = await page.evaluate(() => window.__mangaEditorDebug!.getState());
		expect(editorState.textLayers.some((layer: any) => layer.text === "Courier clicked text")).toBe(true);

		const imported = await page.evaluate(() => window.__mangaWorkflowDebug!.addImportedDraftToCurrentPage());
		expect(imported.textLayerCounts[0]).toBe(3);
		await expect(editorStatus(page)).toContainText("นำเข้าข้อความ 1 กล่อง หน้า 1 แล้ว");

		await openWorkspaceView(page, "pages");
		await expect(page.getByText("หน้าในตอน", { exact: true })).toBeVisible();

		await openWorkspaceView(page, "work");
		await expect(page.getByText("งานตอนนี้", { exact: true })).toBeVisible();

		await openWorkspaceView(page, "focus");
		await expect(page.getByText("Focus", { exact: true }).first()).toBeVisible();

		const accepted = await page.evaluate(() => window.__mangaWorkflowDebug!.markAiResultAccepted());
		expect(accepted.aiReviewMarkerCount).toBe(1);
		await expect(editorStatus(page)).toContainText("ยืนยันผล AI ผ่านแล้ว");

		const approved = await page.evaluate(() => window.__mangaWorkflowDebug!.addApprovedReviewDecision());
		expect(approved.reviewDecisionCount).toBe(2);
		await expect(editorStatus(page)).toContainText("ผ่านตรวจหน้า 1 แล้ว");

		await openWorkspaceView(page, "editor");
		await page.getByRole("button", { name: "วางเลเยอร์ AI" }).first().click();
		await expect(editorStatus(page)).toContainText("วางผล AI เป็นเลเยอร์แล้ว");

		const finalWorkflowState = await page.evaluate(() => window.__mangaWorkflowDebug!.getState());
		expect(finalWorkflowState.versionCount).toBe(1);
		expect(finalWorkflowState.textLayerCounts[0]).toBe(3);

		editorState = await page.evaluate(() => window.__mangaEditorDebug!.getState());
		expect(editorState.imageLayers.some((layer: any) => (
			layer.id === "ai-result-flow208-ai-marker-p1"
			&& layer.imageId === "flow208-ai-result-p1"
			&& layer.role === "overlay"
			&& layer.visible !== false
		))).toBe(true);
		expect(editorState.image.bounds.width).toBeGreaterThan(300);
		expect(editorState.canvas.upper?.width).toBeGreaterThan(300);
	});

	test("keeps a broken page openable while shared page integrity marks it for recovery", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Broken-page recovery journey is covered on desktop/tablet; mobile proof comes in the recovery UX flow.");

		await seedWorkflowProject(page, { missingSecondPage: true });
		const opened = await page.evaluate(() => window.__mangaWorkflowDebug!.openPage(1));

		expect(opened).toMatchObject({
			pageIndex: 1,
			pageCount: 2,
			assetStatus: "missing",
		});
		await expect(editorStatus(page)).toContainText("หน้า 2 / 2");

		await openWorkspaceView(page, "pages");
		const recovery = page.getByRole("region", { name: "กู้รูปบน Pages" });
		await expect(recovery).toBeVisible();
		await expect(recovery.getByRole("button", { name: "Relink รูปหน้า 2" })).toBeVisible();

		await openWorkspaceView(page, "import");
		await expect(page.getByRole("button", { name: "Relink รูป" })).toBeVisible();
		await expect(page.getByText("รูปหาย", { exact: true })).toBeVisible();
		await expect(page.getByText("Missing", { exact: true })).toHaveCount(0);
	});

	test("moves the prototype chapter from blockers to export-ready", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Export-readiness prototype proof is covered on desktop/tablet.");

		await seedWorkflowProject(page);
		const ready = await page.evaluate(() => window.__mangaWorkflowDebug!.markChapterExportReady());

		expect(ready).toMatchObject({
			pageCount: 2,
			exportReadyCount: 2,
			attentionCount: 0,
			openCommentCount: 0,
			assetStatus: "ready",
		});

		await openWorkspaceView(page, "pages");
		await expect(page.getByText("หน้าพร้อม Export")).toBeVisible();
		await expect(page.getByText(/2\s*พร้อม Export/i)).toBeVisible();
		await expect(page.getByText("ตอนพร้อม Export แล้ว")).toBeVisible();
	});

	test("exports a ready prototype chapter and records export history", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Batch export artifact proof is covered on desktop/tablet.");

		await mockExportEndpoints(page);
		await seedWorkflowProject(page);
		const exported = await page.evaluate(() => window.__mangaWorkflowDebug!.exportReadyChapterBatch());

		expect(exported).toMatchObject({
			pageCount: 2,
			exportReadyCount: 2,
			attentionCount: 0,
			batchExportStatus: "done",
		});
		expect(exported.exportRunCount).toBeGreaterThanOrEqual(2);
		await expect(editorStatus(page)).toContainText("Export สำเร็จ 2 หน้า");

		await openWorkspaceView(page, "pages");
		const history = page.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		await expect(history).toBeVisible();
		await expect(history.getByText("เสร็จแล้ว").first()).toBeVisible();
		await expect(history.getByText(/\.zip/).first()).toBeVisible();
		await expect(history.getByRole("button", { name: "ดาวน์โหลด" }).first()).toBeEnabled();
		await expect(history.getByRole("button", { name: "สร้างใหม่" }).first()).toBeEnabled();
	});

	test("keeps failed quota-limited batch exports out of done history", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Quota-failure export proof is covered on desktop/tablet.");

		await mockExportEndpoints(page, { usageFails: true });
		await seedWorkflowProject(page);
		const exported = await page.evaluate(() => window.__mangaWorkflowDebug!.exportReadyChapterBatch());

		expect(exported).toMatchObject({
			pageCount: 2,
			exportReadyCount: 2,
			attentionCount: 0,
			batchExportStatus: "error",
		});
		await expect(editorStatus(page)).toContainText("Export ไม่สำเร็จ");

		await openWorkspaceView(page, "pages");
		const history = page.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		await expect(history).toBeVisible();
		await expect(history.getByText("ไม่สำเร็จ").first()).toBeVisible();
		await expect(history.getByText(/Quota แผน workspace เต็ม/).first()).toBeVisible();
	});

	test("recovers a failed quota-limited export when usage recording succeeds on retry", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Quota retry recovery proof is covered on desktop/tablet.");

		await mockExportEndpoints(page, { usageFailCount: 1 });
		await seedWorkflowProject(page);
		const failed = await page.evaluate(() => window.__mangaWorkflowDebug!.exportReadyChapterBatch());

		expect(failed).toMatchObject({
			pageCount: 2,
			exportReadyCount: 2,
			attentionCount: 0,
			batchExportStatus: "error",
		});
		await expect(editorStatus(page)).toContainText("Export ไม่สำเร็จ");

		const recovered = await page.evaluate(() => window.__mangaWorkflowDebug!.exportReadyChapterBatch());
		expect(recovered).toMatchObject({
			pageCount: 2,
			exportReadyCount: 2,
			attentionCount: 0,
			batchExportStatus: "done",
		});
		expect(recovered.exportRunCount).toBeGreaterThanOrEqual(3);
		await expect(editorStatus(page)).toContainText("Export สำเร็จ 2 หน้า");

		await openWorkspaceView(page, "pages");
		const history = page.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		await expect(history).toBeVisible();
		await expect(history.getByText("เสร็จแล้ว").first()).toBeVisible();
		await expect(history.getByText(/\.zip/).first()).toBeVisible();
		await expect(history.getByRole("button", { name: "ดาวน์โหลด" }).first()).toBeEnabled();
		await expect(history.getByText("ไม่สำเร็จ").first()).toBeVisible();
	});

	test("recovers a failed quota-limited export from the visible history retry action", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Export history retry proof is covered on desktop/tablet.");

		await mockExportEndpoints(page, { usageFailCount: 1 });
		await seedWorkflowProject(page);
		const failed = await page.evaluate(() => window.__mangaWorkflowDebug!.exportReadyChapterBatch());

		expect(failed).toMatchObject({
			pageCount: 2,
			exportReadyCount: 2,
			attentionCount: 0,
			batchExportStatus: "error",
		});

		await openWorkspaceView(page, "pages");
		const history = page.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		await expect(history).toBeVisible();
		await expect(history.getByText("ไม่สำเร็จ").first()).toBeVisible();

		await history.getByRole("button", { name: "สร้างใหม่" }).first().click();
		await expect(editorStatus(page)).toContainText("Export สำเร็จ 2 หน้า");

		const recovered = await page.evaluate(() => window.__mangaWorkflowDebug!.getState());
		expect(recovered).toMatchObject({
			pageCount: 2,
			exportReadyCount: 2,
			attentionCount: 0,
			batchExportStatus: "done",
		});
		await expect(history.getByText("เสร็จแล้ว").first()).toBeVisible();
		await expect(history.getByText(/\.zip/).first()).toBeVisible();
		await expect(history.getByRole("button", { name: "ดาวน์โหลด" }).first()).toBeEnabled();
		await expect(history.getByText("ไม่สำเร็จ").first()).toBeVisible();
	});
});
