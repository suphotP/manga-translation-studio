import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_DIR = resolve(process.cwd(), "../.codex-dev-logs/visual-checks/flow921-library-add-chapter-metadata-reopen");
const STORY_ID = "moonlit-courier";
const STORY_TITLE = "Moonlit Courier";
const EXISTING_PROJECT_ID = "flow921-moonlit-th-104";
const NEW_PROJECT_ID = "flow921-moonlit-th-105";
const PAGE_IMAGE_ID = "flow921-page-105.png";
const NOW = "2026-05-25T00:15:00.000Z";
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

type ProjectLike = Record<string, any>;

function existingSummary() {
	return {
		projectId: EXISTING_PROJECT_ID,
		name: `${STORY_TITLE} - ตอน 104`,
		createdAt: "2026-05-24T00:00:00.000Z",
		updatedAt: "2026-05-24T01:00:00.000Z",
		targetLang: "th",
		pageCount: 2,
		textLayerCount: 0,
		taskCount: 0,
		openTaskCount: 0,
		reviewTaskCount: 0,
		openCommentCount: 0,
		storyId: STORY_ID,
		storyTitle: STORY_TITLE,
		chapterNumber: "104",
		chapterLabel: "ตอน 104",
	};
}

function summaryFromSavedProject(savedProject: ProjectLike | null) {
	if (!savedProject) return null;
	return {
		projectId: savedProject.projectId,
		name: savedProject.name,
		createdAt: savedProject.createdAt ?? NOW,
		updatedAt: NOW,
		targetLang: savedProject.targetLang,
		pageCount: savedProject.pages?.length ?? 0,
		textLayerCount: savedProject.pages?.reduce((sum: number, page: ProjectLike) => sum + (page.textLayers?.length ?? 0), 0) ?? 0,
		taskCount: savedProject.tasks?.length ?? 0,
		openTaskCount: 0,
		reviewTaskCount: 0,
		openCommentCount: 0,
		coverImageId: savedProject.coverImageId,
		coverOriginalName: savedProject.coverOriginalName,
		storyId: savedProject.storyId,
		storyTitle: savedProject.storyTitle,
		chapterNumber: savedProject.chapterNumber,
		chapterTitle: savedProject.chapterTitle,
		chapterLabel: savedProject.chapterLabel,
	};
}

async function installBackendMocks(page: Page) {
	let savedProject: ProjectLike | null = null;
	const createRequests: ProjectLike[] = [];
	const saveRequests: ProjectLike[] = [];

	await page.route("**/api/project/new", async (route) => {
		const body = route.request().postDataJSON() as ProjectLike;
		createRequests.push(body);
		expect(body).toMatchObject({
			name: `${STORY_TITLE} - ตอน 105 - Side Story`,
			lang: "th",
			storyId: STORY_ID,
			storyTitle: STORY_TITLE,
			chapterNumber: "105",
			chapterTitle: "Side Story",
			chapterLabel: "ตอน 105 - Side Story",
		});
		await route.fulfill({ json: { projectId: NEW_PROJECT_ID } });
	});

	await page.route(`**/api/images/${NEW_PROJECT_ID}/upload`, async (route) => {
		expect(route.request().method()).toBe("POST");
		await route.fulfill({
			json: {
				imageIds: [PAGE_IMAGE_ID],
				assets: [{
					assetId: PAGE_IMAGE_ID,
					imageId: PAGE_IMAGE_ID,
					originalName: "page-105.png",
					mimeType: "image/png",
					sizeBytes: PNG_1X1.length,
					sha256: "flow921-page-105",
					storageDriver: "mock",
					storageKey: `projects/${NEW_PROJECT_ID}/images/${PAGE_IMAGE_ID}`,
					width: 1,
					height: 1,
					storageStatus: "released",
					moderationStatus: "passed",
					derivativeCount: 0,
					createdAt: NOW,
					updatedAt: NOW,
				}],
			},
		});
	});

	await page.route(`**/api/project/${NEW_PROJECT_ID}/save`, async (route) => {
		savedProject = route.request().postDataJSON() as ProjectLike;
		saveRequests.push(savedProject);
		await route.fulfill({ json: { ok: true } });
	});

	await page.route(`**/api/project/${NEW_PROJECT_ID}`, async (route) => {
		await route.fulfill({
			status: savedProject ? 200 : 404,
			contentType: "application/json",
			body: JSON.stringify(savedProject ?? { error: "not saved yet" }),
		});
	});

	for (const path of ["versions", "workflow", "comments", "review-decisions", "ai-markers"]) {
		await page.route(`**/api/project/${NEW_PROJECT_ID}/${path}`, async (route) => {
			const key = path === "workflow" ? { tasks: [], activityLog: [] }
				: path === "comments" ? { comments: [] }
					: path === "review-decisions" ? { decisions: [] }
						: path === "ai-markers" ? { markers: [] }
							: { versions: [] };
			await route.fulfill({ json: key });
		});
	}
	await page.route(`**/api/project/${NEW_PROJECT_ID}/workspace-feed`, async (route) => {
		await route.fulfill({ json: { items: [], messages: [], activityLog: [] } });
	});
	await page.route(`**/api/images/${NEW_PROJECT_ID}/assets`, async (route) => {
		await route.fulfill({ json: { assets: [] } });
	});
	await page.route(`**/api/images/${NEW_PROJECT_ID}/${PAGE_IMAGE_ID}`, async (route) => {
		await route.fulfill({ body: PNG_1X1, headers: { "content-type": "image/png" } });
	});
	await page.route(`**/api/images/${NEW_PROJECT_ID}/${PAGE_IMAGE_ID}/thumbnail**`, async (route) => {
		await route.fulfill({ body: PNG_1X1, headers: { "content-type": "image/png" } });
	});

	await page.route("**/api/project", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const projects = [existingSummary()];
		const newSummary = summaryFromSavedProject(savedProject);
		if (newSummary) projects.push(newSummary);
		await route.fulfill({ json: { projects } });
	});

	return {
		get createRequests() { return createRequests; },
		get saveRequests() { return saveRequests; },
		get savedProject() { return savedProject; },
	};
}

async function collectLibraryMetrics(page: Page) {
	return page.evaluate(() => {
		const visible = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
		};
		const stage = document.querySelector<HTMLElement>(".library-title-stage");
		const rows = Array.from(document.querySelectorAll<HTMLElement>(".stage-chapter-list > button"))
			.filter(visible)
			.map((row) => row.innerText.replace(/\s+/g, " ").trim());
		const controls = Array.from(document.querySelectorAll<HTMLElement>(".workspace-library-shell button, .workspace-library-shell input, .workspace-library-shell summary"))
			.filter(visible)
			.map((control) => {
				const rect = control.getBoundingClientRect();
				return {
					text: (control.innerText || control.getAttribute("aria-label") || control.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			stageText: stage?.innerText.replace(/\s+/g, " ").trim() ?? "",
			chapterRows: rows,
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
		};
	});
}

test.describe("Flow921 Library add-chapter metadata persistence", () => {
	test("keeps an added chapter grouped under the selected story after save and backend reopen", async ({ page }, testInfo) => {
		mkdirSync(ARTIFACT_DIR, { recursive: true });
		const viewport = testInfo.project.name.includes("tablet")
			? { name: "ipad", width: 929, height: 1194 }
			: { name: "desktop", width: 1440, height: 1000 };
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		const backend = await installBackendMocks(page);

		await page.goto("/");
		await page.getByRole("button", { name: "คลัง", exact: true }).click();
		await page.getByRole("button", { name: `เลือกเรื่อง ${STORY_TITLE} จากชั้นวาง` }).click();
		await expect(page.getByLabel(`เรื่องที่เลือก ${STORY_TITLE}`)).toBeVisible();

		const titleSecondaryActions = page.locator(".title-secondary-actions");
		await titleSecondaryActions.locator("summary").click();
		await expect(titleSecondaryActions.getByRole("button", { name: "เพิ่มตอนในเรื่องนี้" })).toBeVisible();
		await titleSecondaryActions.getByRole("button", { name: "เพิ่มตอนในเรื่องนี้" }).click();
		const dialog = page.getByRole("dialog", { name: "ตั้งค่าตอนใหม่" });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText(`เพิ่มตอนของ ${STORY_TITLE}`)).toBeVisible();
		await page.locator("#chapter-setup-number").fill("105");
		await page.locator("#chapter-setup-name").fill("Side Story");
		await page.locator("#chapter-setup-target-lang").selectOption("th");
		await page.locator("#chapter-setup-pages").setInputFiles({
			name: "page-105.png",
			mimeType: "image/png",
			buffer: PNG_1X1,
		});
		await expect(dialog.getByText(`${STORY_TITLE} - ตอน 105 - Side Story`)).toBeVisible();
		await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-add-chapter-dialog.png`), fullPage: true });

		await dialog.getByRole("button", { name: "สร้างตอนและเปิดหน้า 1" }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${NEW_PROJECT_ID}/pages/1/editor$`));
		await expect(page.locator(".editor-root")).toBeVisible();
		expect(backend.createRequests).toHaveLength(1);
		expect(backend.saveRequests).toHaveLength(1);
		expect(backend.savedProject).toMatchObject({
			projectId: NEW_PROJECT_ID,
			name: `${STORY_TITLE} - ตอน 105 - Side Story`,
			targetLang: "th",
			storyId: STORY_ID,
			storyTitle: STORY_TITLE,
			chapterNumber: "105",
			chapterTitle: "Side Story",
			chapterLabel: "ตอน 105 - Side Story",
		});

		const reopened = await page.evaluate(async () => window.__mangaWorkflowDebug!.reopenCurrentProjectFromBackend());
		expect(reopened.opened).toBe(true);
		const reopenedProject = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState());
		expect(reopenedProject).toMatchObject({
			projectId: NEW_PROJECT_ID,
			storyId: STORY_ID,
			storyTitle: STORY_TITLE,
			chapterNumber: "105",
			chapterLabel: "ตอน 105 - Side Story",
		});

		await page.getByRole("button", { name: "คลัง", exact: true }).click();
		await expect(page.getByLabel(`เรื่องที่เลือก ${STORY_TITLE}`)).toBeVisible();
		const metrics = await collectLibraryMetrics(page);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.stageText).toContain(STORY_TITLE);
		expect(metrics.chapterRows.some((row) => row.includes("ตอน 104"))).toBe(true);
		expect(metrics.chapterRows.some((row) => row.includes("ตอน 105"))).toBe(true);
		expect(metrics.under40).toEqual([]);

		await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-grouped-after-reopen.png`), fullPage: true });
		writeFileSync(resolve(ARTIFACT_DIR, `${viewport.name}-metrics.json`), JSON.stringify({
			createRequest: backend.createRequests[0],
			savedProject: backend.savedProject,
			reopenedProject,
			metrics,
		}, null, 2));
	});
});
