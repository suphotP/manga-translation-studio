import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_DIR = resolve(process.cwd(), "../.codex-dev-logs/visual-checks/flow965-long-chapter-scale");
const PROJECT_ID = "flow965-moonlit-th-120";
const NOW = "2026-05-25T21:00:00.000Z";
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

const page104Task = {
	id: "flow965-typeset-page-104",
	type: "typeset",
	status: "open",
	priority: "high",
	pageIndex: 103,
	title: "Place dungeon SFX on page 104",
	createdAt: NOW,
	updatedAt: NOW,
};

function projectState() {
	return {
		projectId: PROJECT_ID,
		name: "Moonlit Courier - ตอน 120",
		createdAt: NOW,
		updatedAt: NOW,
		currentPage: 0,
		targetLang: "th",
		storyId: "moonlit-courier",
		storyTitle: "Moonlit Courier",
		chapterNumber: "120",
		chapterLabel: "ตอน 120",
		coverImageId: "page-001.png",
		coverOriginalName: "page-001.png",
		pages: Array.from({ length: 120 }, (_, index) => {
			const pageNumber = index + 1;
			return {
				imageId: `page-${String(pageNumber).padStart(3, "0")}.png`,
				imageName: `page-${String(pageNumber).padStart(3, "0")}.png`,
				originalName: `page-${String(pageNumber).padStart(3, "0")}.png`,
				textLayers: pageNumber % 5 === 0 ? [{ id: `text-${pageNumber}`, text: `หน้า ${pageNumber}` }] : [],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			};
		}),
		tasks: [page104Task],
		activityLog: [],
		comments: [{
			id: "flow965-comment-page-42",
			pageIndex: 41,
			status: "open",
			author: "qc",
			text: "Check redraw seam before export",
			createdAt: NOW,
			updatedAt: NOW,
		}],
		reviewDecisions: [],
		aiReviewMarkers: [{
			id: "flow965-ai-page-88",
			pageIndex: 87,
			kind: "clean",
			status: "needs_review",
			label: "Clean Pro",
			region: { x: 24, y: 32, w: 180, h: 120 },
			createdAt: NOW,
			updatedAt: NOW,
		}],
		workspaceMessages: [],
		versionReviewRequests: [],
	};
}

async function installMocks(page: Page): Promise<void> {
	await page.route("**/api/project", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			json: {
				projects: [{
					projectId: PROJECT_ID,
					name: "Moonlit Courier - ตอน 120",
					createdAt: NOW,
					updatedAt: NOW,
					targetLang: "th",
					pageCount: 120,
					textLayerCount: 24,
					taskCount: 1,
					openTaskCount: 1,
					reviewTaskCount: 0,
					openCommentCount: 1,
					storyId: "moonlit-courier",
					storyTitle: "Moonlit Courier",
					chapterNumber: "120",
					chapterLabel: "ตอน 120",
				}],
			},
		});
	});
	await page.route(`**/api/project/${PROJECT_ID}`, async (route) => {
		await route.fulfill({ json: projectState() });
	});
	await page.route(`**/api/project/${PROJECT_ID}/save`, async (route) => {
		await route.fulfill({ json: { ok: true } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/versions`, async (route) => {
		await route.fulfill({ json: { versions: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/workflow`, async (route) => {
		await route.fulfill({ json: { tasks: [page104Task], activityLog: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/comments`, async (route) => {
		await route.fulfill({ json: { comments: projectState().comments } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/review-decisions`, async (route) => {
		await route.fulfill({ json: { decisions: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/workspace-feed`, async (route) => {
		await route.fulfill({ json: { items: [], messages: [], activityLog: [] } });
	});
	await page.route(`**/api/project/${PROJECT_ID}/ai-markers`, async (route) => {
		await route.fulfill({ json: { markers: projectState().aiReviewMarkers } });
	});
	await page.route(`**/api/images/${PROJECT_ID}/assets`, async (route) => {
		await route.fulfill({ json: { assets: [] } });
	});
	await page.route(`**/api/images/${PROJECT_ID}/**`, async (route) => {
		if (route.request().url().endsWith(`/api/images/${PROJECT_ID}/assets`)) return route.fallback();
		await route.fulfill({ body: PNG_1X1, headers: { "content-type": "image/png" } });
	});
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const visible = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
		};
		const controls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea, summary"))
			.filter(visible)
			.map((control) => {
				const rect = control.getBoundingClientRect();
				return {
					text: (control.innerText || control.getAttribute("aria-label") || control.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		const queue = document.querySelector<HTMLElement>(".chapter-queue");
		const search = document.querySelector<HTMLInputElement>('input[aria-label="ค้นหาในรายการหน้า"]');
		const pageCards = Array.from(document.querySelectorAll<HTMLElement>(".page-queue-list .page-card"))
			.filter(visible)
			.map((card) => card.innerText.replace(/\s+/g, " ").trim());
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			queueText: queue?.innerText.replace(/\s+/g, " ").trim() ?? "",
			searchVisible: Boolean(search && visible(search)),
			searchHeight: search ? Math.round(search.getBoundingClientRect().height) : 0,
			searchValue: search?.value ?? "",
			pageCards,
			pageCardCount: pageCards.length,
			mapDotCount: document.querySelectorAll(".chapter-map .map-dot").length,
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
		};
	});
}

test.describe("Flow965 long chapter scale", () => {
	test("filters and searches a 120-page chapter without forcing users to scroll blindly", async ({ page }, testInfo) => {
		const viewport = testInfo.project.name.includes("tablet")
			? { name: "ipad", width: 929, height: 1194 }
			: { name: "desktop", width: 1440, height: 1000 };
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(message.text());
		});
		mkdirSync(ARTIFACT_DIR, { recursive: true });
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await installMocks(page);

		await page.goto(`/projects/${PROJECT_ID}/pages`);
		await expect(page.getByRole("region", { name: "หน้าในตอน" })).toBeVisible();
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug));
		await expect(page.locator(".cover-meta small")).toContainText("/120 พร้อม");
		const chapterQueue = page.locator(".chapter-queue");
		await expect(chapterQueue.getByRole("searchbox", { name: "ค้นหาในรายการหน้า" })).toBeVisible();
		await expect(chapterQueue).toHaveAttribute("data-queue-mounted", "true");

		await chapterQueue.getByRole("button", { name: "ทั้งหมด", exact: true }).click();
		await expect(chapterQueue).toHaveAttribute("data-queue-filtered-count", "120");
		await expect(page.locator(".queue-search-count")).toContainText("120/120 หน้า");
		const pageSearch = chapterQueue.getByRole("searchbox", { name: "ค้นหาในรายการหน้า" });
		await pageSearch.click();
		await pageSearch.pressSequentially("104");
		await pageSearch.evaluate((input) => input.dispatchEvent(new Event("input", { bubbles: true })));
		await expect(page.locator(".queue-search-count")).toContainText("1/120 หน้า");
		const visiblePageCards = page.locator(".page-queue-list .page-card:not([hidden])");
		await expect(visiblePageCards).toHaveCount(1);
		await expect(visiblePageCards).toContainText("หน้า 104");
		await expect(visiblePageCards).toHaveAttribute("href", `/projects/${PROJECT_ID}/pages/104/editor`);

		const metrics = await collectMetrics(page);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.searchVisible).toBe(true);
		expect(metrics.searchHeight).toBeGreaterThanOrEqual(40);
		expect(metrics.searchValue).toBe("104");
		expect(metrics.mapDotCount).toBe(120);
		expect(metrics.pageCardCount).toBe(1);
		expect(metrics.pageCards[0]).toContain("หน้า 104");
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);
		await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-search-p104.png`), fullPage: true });

		await visiblePageCards.scrollIntoViewIfNeeded();
		await visiblePageCards.click();
		await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/pages/104/editor$`));
		await expect(page.locator(".editor-root")).toBeVisible();
		writeFileSync(resolve(ARTIFACT_DIR, `${viewport.name}-metrics.json`), JSON.stringify({ metrics, consoleIssues }, null, 2));
	});
});
