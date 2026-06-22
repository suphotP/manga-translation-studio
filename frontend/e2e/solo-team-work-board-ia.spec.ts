import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

async function openSeededWorkBoard(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		window.__mangaWorkflowDebug!.openView("work");
	});
	await page.getByRole("region", { name: "บอร์ดงานตอน" }).waitFor({ state: "visible" });
}

async function metrics(page: Page) {
	return page.evaluate(() => {
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
		};
	});
}

test.describe("Solo / Team Work Board IA", () => {
	test("keeps Solo queue detail light and restores team pipeline language only in Team mode", async ({ page }, testInfo) => {
		await openSeededWorkBoard(page);

		const workBoard = page.getByRole("region", { name: "บอร์ดงานตอน" });
		await expect(workBoard).toContainText("รายละเอียดคิวทั้งหมด");
		await expect(workBoard).toContainText("เปิดดูขั้นงานละเอียด");
		await expect(workBoard).not.toContainText("งานตามคนรับงาน");
		await expect(workBoard).not.toContainText("คิวตามขั้นตอน");

		await page.getByText("รายละเอียดคิวทั้งหมด").click();
		await expect(page.getByRole("region", { name: "ขั้นงานละเอียด" })).toBeVisible();
		await expect(workBoard).toContainText("ลำดับงาน");
		await expect(workBoard).not.toContainText("งานตามคนรับงาน");

		await mkdir("../.codex-dev-logs/visual-checks/flow615-solo-team-work-board-ia", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow615-solo-team-work-board-ia/${testInfo.project.name}-solo.png`,
			fullPage: true,
		});
		const soloMetrics = await metrics(page);
		expect(soloMetrics.overflowX).toBe(0);
		expect(soloMetrics.under40).toEqual([]);

		await page.getByRole("button", { name: /Team/ }).click();
		await expect(workBoard).toContainText("งานทั้งหมด");
		await expect(workBoard).toContainText("งานตามคนรับงาน");
		await expect(workBoard).toContainText("คิวตามขั้นตอน");
		await expect(workBoard).not.toContainText("เปิดดูขั้นงานละเอียด");

		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow615-solo-team-work-board-ia/${testInfo.project.name}-team.png`,
			fullPage: true,
		});
		const teamMetrics = await metrics(page);
		await writeFile(
			`../.codex-dev-logs/visual-checks/flow615-solo-team-work-board-ia/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ soloMetrics, teamMetrics }, null, 2),
		);
		expect(teamMetrics.overflowX).toBe(0);
		expect(teamMetrics.under40).toEqual([]);
	});
});
