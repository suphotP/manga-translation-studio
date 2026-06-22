import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_DIR = resolve(process.cwd(), "../.codex-dev-logs/visual-checks/flow922-chapter-detail-page-status-drill-in");
const PROJECT_ID = "flow922-moonlit-th-104";
const NOW = "2026-05-25T00:30:00.000Z";
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

const task = {
	id: "flow922-review-page-2",
	type: "review",
	status: "review",
	priority: "high",
	pageIndex: 1,
	title: "Review page 2",
	createdAt: NOW,
	updatedAt: NOW,
};

function projectState() {
	return {
		projectId: PROJECT_ID,
		name: "Moonlit Courier - ตอน 104",
		createdAt: NOW,
		updatedAt: NOW,
		currentPage: 0,
		targetLang: "th",
		storyId: "moonlit-courier",
		storyTitle: "Moonlit Courier",
		chapterNumber: "104",
		chapterLabel: "ตอน 104",
		coverImageId: "page-1.png",
		coverOriginalName: "page-1.png",
		pages: [
			{
				imageId: "page-1.png",
				imageName: "page-1.png",
				originalName: "page-1.png",
				textLayers: [{ id: "layer-1", text: "พร้อม" }],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
			{
				imageId: "page-2.png",
				imageName: "page-2.png",
				originalName: "page-2.png",
				textLayers: [],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
		tasks: [task],
		activityLog: [],
		comments: [],
		reviewDecisions: [],
		aiReviewMarkers: [],
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
					name: "Moonlit Courier - ตอน 104",
					createdAt: NOW,
					updatedAt: NOW,
					targetLang: "th",
					pageCount: 2,
					textLayerCount: 1,
					taskCount: 1,
					openTaskCount: 1,
					reviewTaskCount: 1,
					openCommentCount: 0,
					storyId: "moonlit-courier",
					storyTitle: "Moonlit Courier",
					chapterNumber: "104",
					chapterLabel: "ตอน 104",
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
		await route.fulfill({ json: { tasks: [task], activityLog: [] } });
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
	await page.route(`**/api/images/${PROJECT_ID}/assets`, async (route) => {
		await route.fulfill({ json: { assets: [] } });
	});
	await page.route(`**/api/images/${PROJECT_ID}/**`, async (route) => {
		if (route.request().url().endsWith(`/api/images/${PROJECT_ID}/assets`)) return route.fallback();
		await route.fulfill({ body: PNG_1X1, headers: { "content-type": "image/png" } });
	});
}

async function metrics(page: Page) {
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
		const packet = document.querySelector<HTMLElement>(".chapter-work-packet");
		const queue = document.querySelector<HTMLElement>(".chapter-queue");
		const next = document.querySelector<HTMLElement>(".chapter-next-card");
		const pageCards = Array.from(document.querySelectorAll<HTMLElement>(".page-queue-list .page-card"))
			.filter(visible)
			.map((card) => card.innerText.replace(/\s+/g, " ").trim());
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			packetVisible: Boolean(packet && visible(packet)),
			pageQueueVisible: Boolean(queue && visible(queue)),
			queueText: queue?.innerText.replace(/\s+/g, " ").trim() ?? "",
			nextText: next?.innerText.replace(/\s+/g, " ").trim() ?? "",
			pageCards,
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
		};
	});
}

test.describe("Flow922 chapter detail page-status drill-in", () => {
	test("shows one obvious next page and opens the exact page from the chapter packet", async ({ page }, testInfo) => {
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

		await page.goto("/");
		await page.getByRole("button", { name: "คลัง", exact: true }).click();
		await page.getByRole("button", { name: "เลือกเรื่อง Moonlit Courier จากชั้นวาง" }).click();
		await expect(page.getByLabel("เรื่องที่เลือก Moonlit Courier")).toBeVisible();
		await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-title-before-load.png`), fullPage: true });

		await page.getByText("เปลี่ยนเรื่อง / ตอน").click();
		await page.getByRole("button", { name: "เปิด ตอน 104 Moonlit Courier: ตรวจหน้าที่รอ" }).click();
		await expect(page.getByLabel("แพ็กเกจงานตอน ตอน 104 TH")).toBeVisible();
		await expect(page.getByRole("region", { name: "งานถัดไปในตอน" })).toContainText("หน้า 2");
		await expect(page.getByRole("region", { name: "งานถัดไปในตอน" })).toContainText("1 งานเปิด");
		await expect(page.getByRole("heading", { name: "ทำหน้า P2 ต่อ" })).toBeVisible();

		const after = await metrics(page);
		expect(after.overflowX).toBe(0);
		expect(after.packetVisible).toBe(true);
		expect(after.pageQueueVisible).toBe(true);
		expect(after.nextText).toContain("หน้า 2");
		expect(after.nextText).toContain("Review page 2");
		expect(after.pageCards.some((card) => card.includes("หน้า 2"))).toBe(true);
		expect(after.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);
		await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-chapter-page-status.png`), fullPage: true });

		await page.getByRole("button", { name: "เปิดหน้า 2: ตรวจคำเตือนและงานส่งต่อ" }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/pages/2/editor$`));
		await expect(page.locator(".editor-root")).toBeVisible();
		writeFileSync(resolve(ARTIFACT_DIR, `${viewport.name}-metrics.json`), JSON.stringify({ after, consoleIssues }, null, 2));
	});
});
