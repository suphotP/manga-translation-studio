import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const ARTIFACT_DIR = "../.codex-dev-logs/visual-checks/flow972-library-zero-page-loaded-chapter";
const NOW = "2026-05-26T00:00:00.000Z";
const STORY_ID = "moonlit-courier";
const STORY_TITLE = "Moonlit Courier";
const TITLE_KEY = "moonlit-courier";
const PROJECT_ID = "97200000-0000-4000-8000-000000000972";

function projectSummary() {
	return {
		projectId: PROJECT_ID,
		name: `${STORY_TITLE} - ตอน 104`,
		createdAt: NOW,
		updatedAt: NOW,
		targetLang: "th",
		pageCount: 0,
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

function projectState() {
	return {
		projectId: PROJECT_ID,
		name: `${STORY_TITLE} - ตอน 104`,
		createdAt: NOW,
		updatedAt: NOW,
		currentPage: 0,
		targetLang: "th",
		storyId: STORY_ID,
		storyTitle: STORY_TITLE,
		chapterNumber: "104",
		chapterLabel: "ตอน 104",
		pages: [],
		tasks: [],
		comments: [],
		reviewDecisions: [],
		aiReviewMarkers: [],
		activityLog: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		exportRuns: [],
	};
}

async function installZeroPageMocks(page: Page) {
	await page.route("**/api/project**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/project" && request.method() === "GET") {
			await route.fulfill({ json: { projects: [projectSummary()] } });
			return;
		}
		const match = url.pathname.match(/^\/api\/project\/([^/]+)(?:\/([^/]+))?/);
		if (!match) return route.fallback();
		const [, projectId, section] = match;
		if (projectId !== PROJECT_ID) {
			await route.fulfill({ status: 404, json: { error: "not found" } });
			return;
		}
		if (!section && request.method() === "GET") {
			await route.fulfill({ json: projectState() });
			return;
		}
		if (section === "versions") {
			await route.fulfill({ json: { versions: [] } });
			return;
		}
		if (section === "workflow") {
			await route.fulfill({ json: { tasks: [], activityLog: [] } });
			return;
		}
		if (section === "comments") {
			await route.fulfill({ json: { comments: [] } });
			return;
		}
		if (section === "review-decisions") {
			await route.fulfill({ json: { decisions: [] } });
			return;
		}
		if (section === "workspace-feed") {
			await route.fulfill({ json: { items: [], messages: [], activityLog: [] } });
			return;
		}
		if (section === "ai-markers") {
			await route.fulfill({ json: { markers: [] } });
			return;
		}
		await route.fulfill({ json: {} });
	});

	await page.route("**/api/images/**", async (route) => {
		if (new URL(route.request().url()).pathname.endsWith("/assets")) {
			await route.fulfill({ json: { assets: [] } });
			return;
		}
		await route.fulfill({ status: 404, json: { error: "no image assets for zero-page chapter" } });
	});
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const visible = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0
				&& rect.height > 0
				&& rect.right > 0
				&& rect.bottom > 0
				&& rect.left < innerWidth
				&& rect.top < innerHeight
				&& style.display !== "none"
				&& style.visibility !== "hidden"
				&& style.opacity !== "0";
		};
		const controls = Array.from(document.querySelectorAll<HTMLElement>("button, a, input, select, textarea, summary"))
			.filter(visible)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
			bodyText: document.body.innerText.replace(/\s+/g, " ").trim(),
			editorOpened: location.pathname.includes("/editor"),
			dialogOpen: Boolean(document.querySelector('[role="dialog"]')),
		};
	});
}

test.describe("Flow972 Library loaded zero-page chapter owner", () => {
	test("opens setup from a loaded empty chapter instead of fake page 1/0 editor", async ({ page }, testInfo) => {
		await mkdir(ARTIFACT_DIR, { recursive: true });
		await installZeroPageMocks(page);

		await page.goto(`/library/${TITLE_KEY}/chapters/${PROJECT_ID}`);
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));

		const emptyReceipt = page.getByLabel("สถานะหน้าของ ตอน 104");
		await expect(emptyReceipt).toBeVisible();
		await expect(emptyReceipt).toContainText("ไม่มีรูปหน้าในตอน");
		await expect(emptyReceipt).toContainText("เพิ่มรูปหน้าและจัดหน้าเพื่อเริ่มทำงาน");
		await expect(page.getByRole("button", { name: "เพิ่มรูปหน้าเพื่อเริ่มงาน" })).toBeVisible();
		await expect(page.getByText("เปิดหน้า 1")).toHaveCount(0);
		await expect(page.getByText("เปิดหน้า 0")).toHaveCount(0);

		const beforeMetrics = await collectMetrics(page);
		expect(beforeMetrics.overflowX).toBe(0);
		expect(beforeMetrics.bodyOverflowX).toBe(0);
		expect(beforeMetrics.under40).toEqual([]);
		expect(beforeMetrics.editorOpened).toBe(false);

		await page.screenshot({ path: `${ARTIFACT_DIR}/${testInfo.project.name}-empty-chapter.png`, fullPage: true });

		await page.getByRole("button", { name: "เพิ่มรูปหน้าเพื่อเริ่มงาน" }).click();
		await expect(page).toHaveURL(/\/library$/);
		const setupDialog = page.getByRole("dialog", { name: "ตั้งค่าตอนใหม่" });
		await expect(setupDialog).toBeVisible();
		await expect(page.getByText("เพิ่มรูปหน้าก่อนเข้าแก้หน้า")).toBeVisible();
		await expect(page.getByText("จะเติมเข้า")).toBeVisible();
		await expect(setupDialog.getByText("Moonlit Courier - ตอน 104")).toBeVisible();

		const dialogMetrics = await collectMetrics(page);
		expect(dialogMetrics.overflowX).toBe(0);
		expect(dialogMetrics.bodyOverflowX).toBe(0);
		expect(dialogMetrics.under40).toEqual([]);
		expect(dialogMetrics.editorOpened).toBe(false);
		expect(dialogMetrics.dialogOpen).toBe(true);

		await page.screenshot({ path: `${ARTIFACT_DIR}/${testInfo.project.name}-setup-dialog.png`, fullPage: true });
		await writeFile(`${ARTIFACT_DIR}/${testInfo.project.name}-metrics.json`, JSON.stringify({
			beforeMetrics,
			dialogMetrics,
		}, null, 2));
	});
});
