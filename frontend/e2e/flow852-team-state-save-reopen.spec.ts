import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow852-team-state-save-reopen";
const PROJECT_ID = "123e4567-e89b-42d3-a456-426614185200";

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

async function openTeamWorkBoard(page: Page, backend: Awaited<ReturnType<typeof mockBackendProjectPersistence>>) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	const seededProject = await page.evaluate(async (projectId) => {
		await window.__mangaWorkflowDebug!.seedProject({ projectId });
		const project = window.__mangaWorkflowDebug!.getProjectState();
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
		window.__mangaWorkflowDebug!.openView("work");
		return project;
	}, PROJECT_ID);
	backend.setRemoteProject(seededProject);
	await page.getByRole("region", { name: "บอร์ดงานตอน" }).waitFor({ state: "visible" });
	await page.getByRole("button", { name: /Team/ }).click();
	await page.getByRole("region", { name: "ทีมผลิตแยกบทบาท" }).waitFor({ state: "visible" });
}

async function driveTeamWorkflow(page: Page) {
	const roleMap = page.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });

	await roleMap.getByRole("button", { name: "เลือกบทบาท คนคลีน" }).click();
	const cleanerHandoff = page.getByRole("region", { name: "ส่งงานคลีน" });
	await cleanerHandoff.getByRole("button", { name: "ยืนยันว่าไม่ต้องคลีน" }).click();
	await expect(cleanerHandoff).toContainText("พร้อมให้ลงคำ");

	await roleMap.getByRole("button", { name: "เลือกบทบาท คนแปล" }).click();
	const translatorBench = page.getByRole("region", { name: "โต๊ะแปลข้างรูป" });
	await translatorBench.getByRole("textbox", { name: "คำพูด 2 คำแปล" }).fill("บรรทัด A\nบรรทัด B");
	const pagePreview = translatorBench.locator(".translator-page-preview");
	const placementTarget = translatorBench.locator(".translator-placement-target");
	const previewBox = await pagePreview.boundingBox();
	expect(previewBox).toBeTruthy();
	await placementTarget.click({
		position: {
			x: Math.round((previewBox?.width ?? 240) * 0.25),
			y: Math.round((previewBox?.height ?? 280) * 0.65),
		},
	});
	await translatorBench.getByRole("button", { name: "เพิ่มช่องแปล" }).click();
	await translatorBench.getByRole("textbox", { name: /ชื่อช่องแปล ช่องแปล 4/ }).fill("เสียงกรีด");
	await translatorBench.getByRole("textbox", { name: /เสียงกรีด คำแปล/ }).fill("กรี๊ดดดด\nอย่าเข้ามา");

	await roleMap.getByRole("button", { name: "เลือกบทบาท คนลงคำ" }).click();
	const typesetterBench = page.getByRole("region", { name: "ลงคำจากสคริปต์แปล" });
	const customTypesetCard = typesetterBench.locator(".typesetter-script-card", { hasText: "เสียงกรีด" });
	await customTypesetCard.getByRole("button", { name: "สร้างกล่อง เสียงกรีด บน หน้า 1 ภาษา TH แล้วเปิดหน้า" }).click();
	await expect.poll(() => page.evaluate(() => (
		window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.textLayers
			?.filter((layer: any) => layer.sourceProvider === "translation-slot:custom-0-4").length ?? 0
	))).toBe(1);

	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("work"));
	await expect(roleMap).toBeVisible();
	await roleMap.getByRole("button", { name: "เลือกบทบาท คนแปล" }).click();
	await translatorBench.getByRole("textbox", { name: /เสียงกรีด คำแปล/ }).fill("กรี๊ดดดดดด\nหยุดเดี๋ยวนี้");
	await roleMap.getByRole("button", { name: "เลือกบทบาท คนลงคำ" }).click();
	await customTypesetCard.getByRole("button", { name: "อัปเดตกล่องข้อความ" }).click();

	await roleMap.getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }).click();
	await page.getByRole("region", { name: "QC / เครดิต" }).getByRole("button", { name: "ตรวจใน Focus" }).click();
	const cleanRecheck = page.getByRole("region", { name: "ตรวจ clean/typeset ก่อนส่งต่อ" });
	await expect(cleanRecheck).toContainText("ตรวจตำแหน่งกับภาพ clean ก่อนผ่าน QC");
	await cleanRecheck.getByRole("button", { name: "ยืนยันตรวจ clean แล้ว" }).click();
	await expect(cleanRecheck).toContainText("ตรวจ clean/typeset แล้ว");
}

async function collectMetrics(page: Page, backend: Awaited<ReturnType<typeof mockBackendProjectPersistence>>, consoleIssues: string[]) {
	return page.evaluate((backendState) => {
		const project = window.__mangaWorkflowDebug?.getProjectState() ?? null;
		const pageState = project?.pages?.[0] ?? null;
		const teamTextLayer = pageState?.textLayers?.find((layer: any) => layer.sourceProvider === "translation-slot:custom-0-4") ?? null;
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"));
		const body = document.body.innerText;
		return {
			...backendState,
			saveSyncStatus: window.__mangaWorkflowDebug?.getState().saveSyncStatus ?? null,
			cleaningHandoff: pageState?.cleaningHandoff ?? null,
			translationSlots: pageState?.translationScriptSlots ?? [],
			teamTextLayer,
			teamLayerCount: pageState?.textLayers?.filter((layer: any) => layer.sourceProvider === "translation-slot:custom-0-4").length ?? 0,
			visibleTeamSignals: {
				cleanReady: body.includes("พร้อมให้ลงคำ") || body.includes("ภาพคลีนพร้อม"),
				scriptChanged: body.includes("สคริปต์เปลี่ยนจากกล่องข้อความ"),
				verified: body.includes("ตรวจ clean/typeset แล้ว"),
				customSlotPersisted: pageState?.translationScriptSlots?.some((slot: any) => slot.id === "custom-0-4" && slot.label === "เสียงกรีด") ?? false,
			},
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

test.describe("Flow852 team workflow save/reopen truth", () => {
	test("persists cleaner, translator, typesetter, and QC state through backend reopen without duplicate team layers", async ({ page }, testInfo: TestInfo) => {
		const backend = await mockBackendProjectPersistence(page);
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await openTeamWorkBoard(page, backend);
		await driveTeamWorkflow(page);
		await page.evaluate(async () => window.__mangaWorkflowDebug!.saveState());

		expect(backend.saveRequests).toHaveLength(1);
		const savedPage = backend.savedProject?.pages?.[0];
		expect(savedPage?.cleaningHandoff).toMatchObject({
			status: "clean_ready",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedBy: "qc",
		});
		expect(savedPage?.translationScriptSlots).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "dialogue-2",
				x: 25,
				y: 65,
				translatedText: "บรรทัด A\nบรรทัด B",
			}),
			expect.objectContaining({
				id: "custom-0-4",
				label: "เสียงกรีด",
				translatedText: "กรี๊ดดดดดด\nหยุดเดี๋ยวนี้",
			}),
		]));
		expect(savedPage?.textLayers?.filter((layer: any) => layer.sourceProvider === "translation-slot:custom-0-4")).toHaveLength(1);
		expect(savedPage?.textLayers).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "typeset-custom-0-4",
				name: "เสียงกรีด",
				sourceProvider: "translation-slot:custom-0-4",
				text: "กรี๊ดดดดดด\nหยุดเดี๋ยวนี้",
			}),
		]));

		const reopened = await page.evaluate(async () => window.__mangaWorkflowDebug!.reopenCurrentProjectFromBackend());
		expect(reopened.opened).toBe(true);
		await page.evaluate(() => window.__mangaWorkflowDebug!.openView("work"));
		await page.getByRole("region", { name: "บอร์ดงานตอน" }).waitFor({ state: "visible" });
		await page.getByRole("button", { name: /Team/ }).click();
		const roleMap = page.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await expect(roleMap).toBeVisible();
		await roleMap.getByRole("button", { name: "เลือกบทบาท คนลงคำ" }).click();
		const typesetterBench = page.getByRole("region", { name: "ลงคำจากสคริปต์แปล" });
		const customTypesetCard = typesetterBench.locator(".typesetter-script-card", { hasText: "เสียงกรีด" });
		await expect(customTypesetCard).toContainText("เปิดกล่องหน้า 1");
		await expect(customTypesetCard).not.toContainText("สร้างกล่องหน้า 1");
		await roleMap.getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }).click();
		await page.getByRole("region", { name: "QC / เครดิต" }).getByRole("button", { name: "ตรวจใน Focus" }).click();
		await expect(page.getByRole("region", { name: "ตรวจ clean/typeset ก่อนส่งต่อ" })).toContainText("ตรวจ clean/typeset แล้ว");

		const metrics = await collectMetrics(page, backend, consoleIssues);
		expect(metrics.saveRequestCount).toBe(1);
		expect(metrics.imageRequests).toEqual([]);
		expect(metrics.cleaningHandoff).toMatchObject({
			status: "clean_ready",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedBy: "qc",
		});
		expect(metrics.translationSlots).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "dialogue-2", translatedText: "บรรทัด A\nบรรทัด B" }),
			expect.objectContaining({ id: "custom-0-4", label: "เสียงกรีด", translatedText: "กรี๊ดดดดดด\nหยุดเดี๋ยวนี้" }),
		]));
		expect(metrics.teamLayerCount).toBe(1);
		expect(metrics.teamTextLayer).toMatchObject({
			id: "typeset-custom-0-4",
			name: "เสียงกรีด",
			sourceProvider: "translation-slot:custom-0-4",
			text: "กรี๊ดดดดดด\nหยุดเดี๋ยวนี้",
		});
		expect(metrics.visibleTeamSignals).toMatchObject({
			verified: true,
			customSlotPersisted: true,
		});
		expect(metrics.saveSyncStatus).toBe("saved");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-team-state-save-reopen.png`,
			fullPage: true,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
