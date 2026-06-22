import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const P104_REAL_IMAGE_PATH = "/Users/work/Documents/Codex/2026-05-16/ssh-suphot-192-168-1-203/p104/image-01.webp";
const PROJECT_ID = "61000000-0000-4000-8000-000000000610";
const PAGE_IMAGE_ID = "flow610-p104-page-1.webp";
const PROJECT_TITLE = "Flow610 Real Create";
const PROJECT_NAME = "Flow610 Real Create - ตอน 104 - Real File Smoke";
const NOW = "2026-05-21T00:00:00.000Z";

async function installChapterCreateApiMocks(page: Page, options: { hideProjectUntilSaved?: boolean } = {}): Promise<void> {
	const imageBuffer = await readFile(P104_REAL_IMAGE_PATH);
	let savedProject: unknown = null;

	await page.route("**/api/project/new", async (route) => {
		const request = route.request();
		expect(request.method()).toBe("POST");
		const body = request.postDataJSON() as { name?: string; lang?: string };
		expect(body.name).toBe(PROJECT_NAME);
		expect(body.lang).toBe("en");
		await route.fulfill({ json: { projectId: PROJECT_ID } });
	});

	await page.route(`**/api/images/${PROJECT_ID}/upload`, async (route) => {
		const request = route.request();
		expect(request.method()).toBe("POST");
		await route.fulfill({
			json: {
				imageIds: [PAGE_IMAGE_ID],
				assets: [
					{
						assetId: PAGE_IMAGE_ID,
						imageId: PAGE_IMAGE_ID,
						originalName: "image-01.webp",
						mimeType: "image/webp",
						sizeBytes: imageBuffer.length,
						sha256: "flow610-p104-real-image",
						storageDriver: "mock",
						storageKey: `projects/${PROJECT_ID}/images/${PAGE_IMAGE_ID}`,
						width: 760,
						height: 1160,
						storageStatus: "released",
						moderationStatus: "passed",
						derivativeCount: 0,
						createdAt: NOW,
						updatedAt: NOW,
					},
				],
			},
		});
	});

	await page.route(`**/api/project/${PROJECT_ID}/save`, async (route) => {
		const request = route.request();
		expect(request.method()).toBe("POST");
		savedProject = request.postDataJSON();
		await route.fulfill({ json: { ok: true } });
	});

	await page.route(`**/api/images/${PROJECT_ID}/${PAGE_IMAGE_ID}`, async (route) => {
		await route.fulfill({
			body: imageBuffer,
			headers: { "content-type": "image/webp" },
		});
	});

	await page.route(`**/api/images/${PROJECT_ID}/${PAGE_IMAGE_ID}/thumbnail**`, async (route) => {
		await route.fulfill({
			body: imageBuffer,
			headers: { "content-type": "image/webp" },
		});
	});

	await page.route(`**/api/images/${PROJECT_ID}/assets`, async (route) => {
		await route.fulfill({ json: { assets: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/versions`, async (route) => {
		await route.fulfill({ json: { versions: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/workflow`, async (route) => {
		await route.fulfill({ json: { tasks: [], activityLog: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/comments`, async (route) => {
		await route.fulfill({ json: { comments: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/review-decisions`, async (route) => {
		await route.fulfill({ json: { decisions: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/workspace-feed`, async (route) => {
		await route.fulfill({ json: { items: [], messages: [], activityLog: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/ai-markers`, async (route) => {
		await route.fulfill({ json: { markers: [] } });
	});
	await page.route("**/api/project", async (route) => {
		const request = route.request();
		if (request.method() !== "GET") return route.fallback();
		const projects = options.hideProjectUntilSaved && !savedProject
			? []
			: [
				{
					projectId: PROJECT_ID,
					name: PROJECT_NAME,
					createdAt: NOW,
					updatedAt: NOW,
					coverImageId: PAGE_IMAGE_ID,
					coverOriginalName: "image-01.webp",
					targetLang: "en",
					pageCount: 1,
					textLayerCount: 0,
					taskCount: 0,
					openTaskCount: 0,
					reviewTaskCount: 0,
					commentCount: 0,
					openCommentCount: 0,
				},
			];
		await route.fulfill({
			json: {
				projects,
			},
		});
	});

	await page.exposeFunction("__flow610SavedProject", () => savedProject);
}

async function openChapterSetupDialog(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.getByRole("button", { name: /เปิด.*ตอน|ตั้งค่าและเปิดตอน/ }).first().click();
	await page.getByRole("dialog", { name: "ตั้งค่าตอนใหม่" }).waitFor({ state: "visible", timeout: 5_000 });
}

test.describe("chapter setup real-file creation", () => {
	test("creates a named chapter from a real p104 image and opens the editor without anonymous Library state", async ({ page }, testInfo) => {
		test.skip(!existsSync(P104_REAL_IMAGE_PATH), `p104 real image not found at ${P104_REAL_IMAGE_PATH}`);

		await installChapterCreateApiMocks(page);
		await openChapterSetupDialog(page);

		await page.getByLabel("ชื่อเรื่อง").fill(PROJECT_TITLE);
		await page.getByRole("button", { name: "ต่อไป: ตั้งตอน" }).click();
		await expect(page.getByRole("dialog", { name: "ตั้งค่าตอนใหม่" }).getByText("สร้างตอนของเรื่องนี้")).toBeVisible();
		await page.locator("#chapter-setup-number").fill("104");
		await page.locator("#chapter-setup-name").fill("Real File Smoke");
		await page.locator("#chapter-setup-target-lang").selectOption("en");
		await page.locator("#chapter-setup-pages").setInputFiles(P104_REAL_IMAGE_PATH);

		const dialog = page.getByRole("dialog", { name: "ตั้งค่าตอนใหม่" });
		await expect(page.getByText("1 รูปที่เลือกแล้ว")).toBeVisible();
		await expect(page.getByText("จะเปิดเป็นหน้า 1: image-01.webp")).toBeVisible();
		await expect(dialog.getByRole("region", { name: "ตัวอย่างรูปหน้าก่อนสร้างตอน" })).toBeVisible();
		await expect(dialog.getByAltText("หน้า 1: image-01.webp")).toBeVisible();
		await expect(dialog.getByText(PROJECT_NAME)).toBeVisible();

		await mkdir("../.codex-dev-logs/visual-checks/flow610-chapter-setup-real-create", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow610-chapter-setup-real-create/${testInfo.project.name}-setup-dialog-filled.png`,
			fullPage: true,
		});

		await page.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }).click();

		await expect(page.locator(".chapter-dialog")).toBeHidden({ timeout: 15_000 });
		await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/pages/1/editor$`));
		await expect(page.locator(".editor-root")).toBeVisible();
		await expect(page.getByLabel("เส้นทางหน้าที่กำลังแก้").getByText(PROJECT_NAME)).toBeVisible();
		if (testInfo.project.name === "chromium-desktop") {
			await expect(page.locator(".recent-trigger .recent-trigger-title", { hasText: PROJECT_NAME })).toBeVisible();
		}
		await expect(page.getByText("หน้า 1/1").first()).toBeVisible();
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));

		const state = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState());
		expect(state?.name).toBe(PROJECT_NAME);
		expect(state?.targetLang).toBe("en");
		expect(state?.pages).toHaveLength(1);
		expect(state?.pages[0]?.imageId).toBe(PAGE_IMAGE_ID);
		expect(state?.pages[0]?.originalName).toBe("image-01.webp");

		const savedProject = await page.evaluate(() => (window as unknown as { __flow610SavedProject: () => unknown }).__flow610SavedProject());
		expect((savedProject as { name?: string }).name).toBe(PROJECT_NAME);
		expect((savedProject as { pages?: unknown[] }).pages).toHaveLength(1);

		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow610-chapter-setup-real-create/${testInfo.project.name}-created-editor.png`,
			fullPage: true,
		});

		await mkdir("../.codex-dev-logs/visual-checks/flow856-editor-first-action-owner", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow856-editor-first-action-owner/${testInfo.project.name}-p104-editor-first-action.png`,
			fullPage: true,
		});

		const metrics = await page.evaluate(() => {
			const body = document.body.innerText;
			const layersInspector = document.querySelector(".layers-inspector");
			const starterCard = layersInspector?.querySelector(".next-layer-action-card") ?? null;
			const stackOverview = layersInspector?.querySelector(".layer-stack-overview") ?? null;
			const unifiedStack = layersInspector?.querySelector(".unified-layer-stack") ?? null;
			const pathStarter = document.querySelector(".path-starter");
			const modeJump = document.querySelector(".right-panel-mode-jump");
			const workspaceModeSwitch = document.querySelector(".workspace-mode-switch");
			const workspaceModeCompact = document.querySelector(".workspace-mode-compact");
			const starterRect = starterCard?.getBoundingClientRect();
			const pathStarterRect = pathStarter?.getBoundingClientRect();
			const visibleInViewport = starterRect
				? starterRect.width > 0 && starterRect.height > 0 && starterRect.bottom > 0 && starterRect.right > 0 && starterRect.top < innerHeight && starterRect.left < innerWidth
				: false;
			const pathStarterVisibleInViewport = pathStarterRect
				? pathStarterRect.width > 0 && pathStarterRect.height > 0 && pathStarterRect.bottom > 0 && pathStarterRect.right > 0 && pathStarterRect.top < innerHeight && pathStarterRect.left < innerWidth
				: false;
			const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
				.filter((element) => {
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
				})
				.map((element) => {
					const rect = element.getBoundingClientRect();
					const text = element instanceof HTMLElement ? element.innerText : "";
					return { width: Math.round(rect.width), height: Math.round(rect.height), text: text.trim().replace(/\s+/g, " ") };
				});
			return {
				overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
				under40: controls.filter((control) => control.width < 40 || control.height < 40),
				badHits: ["ตอน 1/0", "ตอนใหม่", "No project", "Choose File", "No file chosen"].filter((term) => body.includes(term)),
				editorFirstAction: {
					visibleInViewport,
					copy: starterCard?.textContent?.replace(/\s+/g, " ").trim() ?? "",
					stackOverviewAfterStarter: Boolean(starterCard && stackOverview && (starterCard.compareDocumentPosition(stackOverview) & Node.DOCUMENT_POSITION_FOLLOWING)),
					unifiedStackVisibleBeforeTools: Boolean(unifiedStack),
					pathStarterVisibleInViewport,
					pathStarterCopy: pathStarter?.textContent?.replace(/\s+/g, " ").trim() ?? "",
					panelJumpText: modeJump?.textContent?.replace(/\s+/g, " ").trim() ?? "",
					panelJumpStillSaysNext: Boolean(modeJump?.textContent?.includes("ถัดไป")),
					editorModeSegmentedVisible: Boolean(workspaceModeSwitch),
					editorModeCompactText: workspaceModeCompact?.textContent?.replace(/\s+/g, " ").trim() ?? "",
				},
			};
		});

		await writeFile(
			`../.codex-dev-logs/visual-checks/flow610-chapter-setup-real-create/${testInfo.project.name}-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);

		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(metrics.badHits).toEqual([]);
		expect(metrics.editorFirstAction.visibleInViewport).toBe(true);
		expect(metrics.editorFirstAction.copy).toContain("เพิ่มเลเยอร์แก้ไข");
		expect(metrics.editorFirstAction.copy).toContain("วางข้อความ");
		expect(metrics.editorFirstAction.stackOverviewAfterStarter).toBe(true);
		expect(metrics.editorFirstAction.unifiedStackVisibleBeforeTools).toBe(false);
		expect(metrics.editorFirstAction.pathStarterVisibleInViewport).toBe(true);
		expect(metrics.editorFirstAction.pathStarterCopy).toContain("เริ่มแก้");
		expect(metrics.editorFirstAction.pathStarterCopy).toContain("วางข้อความ");
		expect(metrics.editorFirstAction.panelJumpStillSaysNext).toBe(false);
		expect(metrics.editorFirstAction.editorModeSegmentedVisible).toBe(false);
		expect(metrics.editorFirstAction.editorModeCompactText).toContain("Solo");

		await page.getByRole("button", { name: "เปิดเครื่องมือเครดิตจากงานเลเยอร์ถัดไป" }).click();
		await expect(page.getByLabel("ลบเครดิตแบบเลือกขอบเขต")).toContainText("ยังไม่มีเครดิตให้ลบ");
		await expect(page.getByRole("button", { name: "ลบเครดิตทุกหน้า" })).toHaveCount(0);
		await page.getByLabel("ลบเครดิตแบบเลือกขอบเขต").scrollIntoViewIfNeeded();
		await mkdir("../.codex-dev-logs/visual-checks/flow858-credit-delete-noop", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow858-credit-delete-noop/${testInfo.project.name}-credit-no-delete-noop.png`,
			fullPage: true,
		});
	});

	test("creates a real p104 chapter from the clean-start import path and opens Import Review", async ({ page }, testInfo) => {
		test.skip(!existsSync(P104_REAL_IMAGE_PATH), `p104 real image not found at ${P104_REAL_IMAGE_PATH}`);

		await installChapterCreateApiMocks(page, { hideProjectUntilSaved: true });
		await page.goto("/");
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));

		const start = page.getByLabel("เริ่มตรงนี้");
		await expect(start.getByRole("button", { name: /สร้างตอนแรก\s+ตั้งเรื่อง \+ อัปโหลดรูปหน้า/ })).toBeVisible();
		await start.getByRole("button", { name: /สร้างตอนแรก\s+ตั้งเรื่อง \+ อัปโหลดรูปหน้า/ }).click();

		const dialog = page.getByRole("dialog", { name: "ตั้งค่าตอนใหม่" });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText("ตั้งชื่อเรื่อง แล้วอัปโหลดรูปหน้า")).toBeVisible();
		await page.getByLabel("ชื่อเรื่อง").fill(PROJECT_TITLE);
		await page.getByRole("button", { name: "ต่อไป: อัปโหลดรูปหน้า" }).click();
		await page.locator("#chapter-setup-number").fill("104");
		await page.locator("#chapter-setup-name").fill("Real File Smoke");
		await page.locator("#chapter-setup-target-lang").selectOption("en");
		await page.locator("#chapter-setup-pages").setInputFiles(P104_REAL_IMAGE_PATH);
		await expect(dialog.getByText(PROJECT_NAME)).toBeVisible();

		await mkdir("../.codex-dev-logs/visual-checks/flow962-first-run-import-intent", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow962-first-run-import-intent/${testInfo.project.name}-setup-filled.png`,
			fullPage: true,
		});

		await page.getByRole("button", { name: "สร้างตอนและไป Import / Review" }).click();

		await expect(page.locator(".chapter-dialog")).toBeHidden({ timeout: 15_000 });
		await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/import$`));
		await expect(page.getByRole("region", { name: "นำเข้าข้อความ" })).toBeVisible();
		await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();

		const metrics = await page.evaluate(() => {
			const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
				.filter((element) => {
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
				})
				.map((element) => {
					const rect = element.getBoundingClientRect();
					const text = element instanceof HTMLElement ? element.innerText : "";
					return { width: Math.round(rect.width), height: Math.round(rect.height), text: text.trim().replace(/\s+/g, " ") };
				});
			return {
				overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
				under40: controls.filter((control) => control.width < 40 || control.height < 40),
				bodyText: document.body.innerText.replace(/\s+/g, " ").trim(),
				pathname: window.location.pathname,
			};
		});
		await writeFile(
			`../.codex-dev-logs/visual-checks/flow962-first-run-import-intent/${testInfo.project.name}-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow962-first-run-import-intent/${testInfo.project.name}-import-review.png`,
			fullPage: true,
		});

		expect(metrics.pathname).toBe(`/projects/${PROJECT_ID}/import`);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(metrics.bodyText).toContain(PROJECT_NAME);
		expect(metrics.bodyText).not.toContain("สร้างตอนและเปิดหน้า 1");
	});
});
