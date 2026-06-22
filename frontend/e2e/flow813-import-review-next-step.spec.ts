import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow813-import-review-next-step";

async function openImportReview(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		window.__mangaWorkflowDebug!.openView("import");
	});
	await page.getByRole("region", { name: "นำเข้าข้อความ" }).waitFor({ state: "visible" });
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const visible = (element: Element) => {
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
		};
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
			.filter(visible)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					text: element instanceof HTMLElement ? element.innerText.trim().replace(/\s+/g, " ") : "",
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
			hasImportedAction: document.body.innerText.includes("ตรวจหน้าที่มีข้อความแรก"),
			hasImportedHint: document.body.innerText.includes("มี Draft Layer แล้ว เปิดตรวจตำแหน่งและจัดบรรทัด"),
			hasEmptyHint: document.body.innerText.includes("รอนำเข้า JSON หรือเว้นไว้ถ้ายังไม่ใช้หน้านี้"),
		};
	});
}

test.describe("Flow813 import review next step", () => {
	test("routes users to the first imported draft layer page and separates empty-page guidance", async ({ page }, testInfo) => {
		await openImportReview(page);

		const targetReview = page.getByRole("region", { name: "หน้าเป้าหมายนำเข้า" });
		await expect(targetReview.getByRole("button", { name: "ตรวจหน้าที่มีข้อความแรก" })).toBeVisible();
		await expect(targetReview).toContainText("มี Draft Layer แล้ว เปิดตรวจตำแหน่งและจัดบรรทัด");
		await expect(targetReview).toContainText("รอนำเข้า JSON หรือเว้นไว้ถ้ายังไม่ใช้หน้านี้");
		await expect(targetReview).not.toContainText("ตรวจตำแหน่งข้อความ");

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-import-review-next-step.png`,
			fullPage: true,
		});
		const metrics = await collectMetrics(page);
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-import-review-next-step.json`, JSON.stringify(metrics, null, 2));
		expect(metrics.hasImportedAction).toBe(true);
		expect(metrics.hasImportedHint).toBe(true);
		expect(metrics.hasEmptyHint).toBe(true);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
	});
});
