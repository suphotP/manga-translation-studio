import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_DIR = resolve(process.cwd(), "../.codex-dev-logs/visual-checks/flow855-library-drill-in-owner");

async function openSeededLibrary(page: Page): Promise<void> {
	await page.route("**/api/project", async (route) => {
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
		const shelfCards = Array.from(document.querySelectorAll<HTMLElement>(".library-shelf-card")).filter(visible);
		const storyCards = shelfCards.map((card) => card.innerText.replace(/\s+/g, " ").trim());
		const stage = document.querySelector<HTMLElement>(".library-title-stage");
		const packet = document.querySelector<HTMLElement>(".chapter-work-packet");
		const drawerBrowser = document.querySelector<HTMLElement>(".library-browser-drawer .workspace-browser");
		const controls = Array.from(document.querySelectorAll<HTMLElement>("button, input, summary"))
			.filter(visible)
			.map((control) => {
				const rect = control.getBoundingClientRect();
				return {
					text: (control.innerText || control.getAttribute("aria-label") || control.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		const stageRect = stage?.getBoundingClientRect();
		const packetRect = packet?.getBoundingClientRect();
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			storyCards,
			shelfVisibleCount: shelfCards.length,
			stageVisible: Boolean(stage && visible(stage)),
			stageText: stage?.innerText.replace(/\s+/g, " ").trim() ?? "",
			stageTop: stageRect ? Math.round(stageRect.top) : null,
			stageBottom: stageRect ? Math.round(stageRect.bottom) : null,
			packetTop: packetRect ? Math.round(packetRect.top) : null,
			drawerBrowserVisible: Boolean(drawerBrowser && visible(drawerBrowser)),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
		};
	});
}

test.describe("Flow855 Library drill-in owner", () => {
	test("makes the title detail own the first viewport after story selection", async ({ page }, testInfo) => {
		const viewport = testInfo.project.name.includes("tablet")
			? { name: "ipad", width: 929, height: 1194 }
			: { name: "desktop", width: 1440, height: 1000 };
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(message.text());
		});

		mkdirSync(ARTIFACT_DIR, { recursive: true });
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await openSeededLibrary(page);

		const before = await collectMetrics(page);
		expect(before.overflowX).toBe(0);
		expect(before.shelfVisibleCount).toBeGreaterThanOrEqual(2);
		expect(before.storyCards.every((text) => text.includes("ตอน"))).toBe(true);
		expect(before.storyCards.some((text) => text.includes("งานเปิด") || text.includes("รีวิว"))).toBe(false);
		expect(before.stageVisible).toBe(false);
		expect(before.drawerBrowserVisible).toBe(false);
		expect(before.under40).toEqual([]);

		await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-library-home.png`), fullPage: true });

		await page.getByRole("button", { name: "เลือกเรื่อง Moonlit Courier จากชั้นวาง" }).click();
		await expect(page.getByLabel("เรื่องที่เลือก Moonlit Courier")).toBeVisible();

		const after = await collectMetrics(page);
		expect(after.overflowX).toBe(0);
		expect(after.shelfVisibleCount).toBe(0);
		expect(after.stageVisible).toBe(true);
		expect(after.stageText).toContain("Moonlit Courier");
		expect(after.stageText).toContain("ตอน 104");
		expect(after.stageTop).not.toBeNull();
		expect(after.stageTop ?? 9999).toBeLessThan(viewport.name === "desktop" ? 360 : 420);
		expect(after.packetTop).toBeNull();
		expect(after.drawerBrowserVisible).toBe(false);
		expect(after.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await page.screenshot({ path: resolve(ARTIFACT_DIR, `${viewport.name}-title-drill-in-owner.png`), fullPage: true });
		writeFileSync(resolve(ARTIFACT_DIR, `${viewport.name}-metrics.json`), JSON.stringify({ before, after, consoleIssues }, null, 2));
	});
});
