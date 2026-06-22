import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_DIR = resolve(process.cwd(), "../.codex-dev-logs/visual-checks/flow683-library-story-shelf");

async function openSeededLibrary(page: Page): Promise<void> {
	let listRequests = 0;
	await page.route("**/api/project", async (route) => {
		listRequests += 1;
		await route.fulfill({
			json: {
				projects: [
					{
						projectId: "moonlit-th-104",
						name: "Moonlit Courier Chapter 104",
						createdAt: "2026-05-23T00:00:00.000Z",
						updatedAt: "2026-05-23T01:00:00.000Z",
						targetLang: "th",
						pageCount: 2,
						textLayerCount: 0,
						taskCount: 2,
						openTaskCount: 1,
						reviewTaskCount: 1,
						openCommentCount: 0,
					},
					{
						projectId: "glass-th-12",
						name: "Glass Harbor Chapter 12",
						createdAt: "2026-05-23T00:00:00.000Z",
						updatedAt: "2026-05-23T00:30:00.000Z",
						targetLang: "th",
						pageCount: 1,
						textLayerCount: 0,
						taskCount: 1,
						openTaskCount: 1,
						reviewTaskCount: 0,
						openCommentCount: 0,
					},
				],
			},
		});
	});
	await page.goto("/");
	await page.getByRole("button", { name: "คลัง", exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll(".library-shelf-card").length >= 2);
	expect(listRequests).toBeGreaterThanOrEqual(1);
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const visible = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0
				&& rect.height > 0
				&& style.display !== "none"
				&& style.visibility !== "hidden"
				&& style.opacity !== "0";
		};
		const cards = Array.from(document.querySelectorAll<HTMLElement>(".library-shelf-card"))
			.filter(visible)
			.map((card) => card.innerText.replace(/\s+/g, " ").trim());
		const libraryIntro = document.querySelector<HTMLElement>(".library-top p");
		const titleStage = document.querySelector<HTMLElement>(".library-title-stage");
		const chapterPacket = document.querySelector<HTMLElement>(".chapter-work-packet");
		const chapterRows = Array.from(document.querySelectorAll<HTMLElement>(".stage-chapter-list > button"))
			.filter(visible)
			.map((row) => row.innerText.replace(/\s+/g, " ").trim());
		const shell = document.querySelector<HTMLElement>(".workspace-library-shell");
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
			browserOverflowX: shell ? Math.max(0, shell.scrollWidth - shell.clientWidth) : null,
			cardCount: cards.length,
			cards,
			detailEmptyText: libraryIntro?.innerText.replace(/\s+/g, " ").trim() ?? "",
			titleStageVisible: Boolean(titleStage && visible(titleStage)),
			chapterPacketVisible: Boolean(chapterPacket && visible(chapterPacket)),
			chapterRows,
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
		};
	});
}

test.describe("Flow683 Library story shelf", () => {
	for (const viewport of [
		{ name: "desktop", width: 1440, height: 1000 },
		{ name: "ipad", width: 929, height: 1194 },
	] as const) {
		test(`keeps story shelf minimal before title selection on ${viewport.name}`, async ({ page }) => {
			mkdirSync(ARTIFACT_DIR, { recursive: true });
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await openSeededLibrary(page);

			await expect(page.getByLabel("ชั้นวางเรื่อง")).toBeVisible();
			await expect(page.locator(".stage-chapter-list > button")).toHaveCount(0);

			const before = await collectMetrics(page);
			expect(before.overflowX).toBe(0);
			expect(before.browserOverflowX).toBe(0);
			expect(before.cardCount).toBeGreaterThanOrEqual(2);
			expect(before.detailEmptyText).toContain("เลือกเรื่องจากชั้นวาง");
			expect(before.titleStageVisible).toBe(false);
			expect(before.chapterPacketVisible).toBe(false);
			expect(before.cards.every((text) => text.includes("ตอน"))).toBe(true);
			expect(before.cards.some((text) => text.includes("งานเปิด") || text.includes("รีวิว"))).toBe(false);
			expect(before.under40).toEqual([]);

			await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-story-shelf.png`), fullPage: true });

			await page.getByRole("button", { name: "เลือกเรื่อง Moonlit Courier จากชั้นวาง" }).click();
			await expect(page.getByLabel("เรื่องที่เลือก Moonlit Courier")).toBeVisible();
			const after = await collectMetrics(page);
			expect(after.overflowX).toBe(0);
			expect(after.browserOverflowX).toBe(0);
			expect(after.cardCount).toBe(0);
			expect(after.titleStageVisible).toBe(true);
			expect(after.chapterPacketVisible).toBe(false);
			expect(after.under40).toEqual([]);

			await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-story-detail.png`), fullPage: true });
			writeFileSync(resolve(ARTIFACT_DIR, `${viewport.name}-metrics.json`), JSON.stringify({ before, after }, null, 2));
		});
	}
});
