import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow812-import-remap-scope";

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
			scopeText: document.querySelector("[aria-label='ปลายทางนำเข้า JSON']")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
		};
	});
}

test.describe("Flow812 import remap target scope", () => {
	test("shows target language and draft-layer scope before applying manual JSON remap", async ({ page }, testInfo) => {
		await openImportReview(page);

		const json = JSON.stringify({
			entries: [
				{ pageNumber: 5, text: "First unmatched source page" },
				{ pageNumber: 8, text: "Second unmatched source page" },
			],
		});
		const chooserPromise = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "นำเข้า JSON" }).click();
		const chooser = await chooserPromise;
		await chooser.setFiles({
			name: "flow812-remap.json",
			mimeType: "application/json",
			buffer: Buffer.from(json),
		});

		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("เลือกต้นทาง JSON ให้ตรงกับหน้าในตอน");
		await expect(page.getByLabel("ปลายทางนำเข้า JSON")).toContainText("TH / 2 หน้า / Draft Layer");
		await expect(dialog).toContainText("มี 2 ต้นทางที่อยู่นอกช่วงหน้าในตอนนี้");
		await expect(dialog.getByRole("button", { name: "ใช้การจับคู่นี้" })).toBeVisible();

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-import-remap-target-scope.png`,
			fullPage: true,
		});
		const metrics = await collectMetrics(page);
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-import-remap-target-scope.json`, JSON.stringify(metrics, null, 2));
		expect(metrics.scopeText).toContain("TH / 2 หน้า / Draft Layer");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
	});
});
