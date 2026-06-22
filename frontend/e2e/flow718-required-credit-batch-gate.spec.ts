import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow718-required-credit-batch-gate";
const REQUIRED_CREDIT_MESSAGE = "Export ยังไม่พร้อม: Public/Export ต้องมีเครดิตอย่างน้อย 1 รายการในตอนนี้";

async function openProjectExportGate(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		await window.__mangaWorkflowDebug!.markChapterExportReady();
		const project = window.__mangaWorkflowDebug!.getProjectState();
		if (!project) throw new Error("Expected seeded project");
		project.creditPolicy = "required";
		for (const pageState of project.pages) {
			pageState.textLayers = (pageState.textLayers ?? []).filter((layer) => layer.sourceCategory !== "credit");
			pageState.imageLayers = (pageState.imageLayers ?? []).filter((layer) => layer.role !== "credit");
		}
		window.__mangaWorkflowDebug!.openView("editor");
	});
	await page.getByRole("region", { name: "เส้นทางหน้าที่กำลังแก้" }).waitFor({ state: "visible" });
	await page.getByRole("button", { name: /เปิดแผง โปรเจกต์/ }).click();
	await page.getByRole("button", { name: /ส่วนหน้า ปิดอยู่/ }).click();
	await page.locator(".batch-action-bar").waitFor({ state: "visible" });
}

async function collectMetrics(page: Page) {
	return page.evaluate((requiredCreditMessage) => {
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
				const text = element instanceof HTMLElement ? element.innerText : "";
				return { text: text.trim().replace(/\s+/g, " "), width: Math.round(rect.width), height: Math.round(rect.height) };
			});
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - window.innerWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
			requiredCreditMessage: document.body.innerText.includes(requiredCreditMessage),
			creditRouteVisible: controls.some((control) => control.text === "เปิดเครดิต"),
			exportDoneCopy: document.body.innerText.includes("Export สำเร็จ"),
			exportRunCount: window.__mangaWorkflowDebug!.getState().exportRunCount,
			batchExportStatus: window.__mangaWorkflowDebug!.getState().batchExportStatus,
		};
	}, REQUIRED_CREDIT_MESSAGE);
}

test.describe("Flow718 required-credit batch export gate", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "Chromium visual proof only");

	test("blocks direct batch export from Project panel when required credit is missing", async ({ page }, testInfo) => {
		test.skip(testInfo.project.name.includes("mobile"), "Batch export proof targets desktop/tablet project panel.");
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});

		await openProjectExportGate(page);
		const actionBar = page.locator(".batch-action-bar");
		await expect(actionBar.getByRole("button", { name: "Export ZIP" })).toBeVisible();
		await expect(actionBar.getByRole("button", { name: "เปิดเครดิต" })).toBeVisible();

		await actionBar.getByRole("button", { name: "เช็ก Public" }).click();
		await expect(actionBar).toContainText(REQUIRED_CREDIT_MESSAGE);
		let metrics = await collectMetrics(page);
		expect(metrics.requiredCreditMessage).toBe(true);
		expect(metrics.creditRouteVisible).toBe(true);
		expect(metrics.exportDoneCopy).toBe(false);
		expect(metrics.exportRunCount).toBe(1);
		expect(metrics.batchExportStatus).not.toBe("done");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under40).toEqual([]);

		await actionBar.getByRole("button", { name: "Export ZIP" }).click();
		await expect(actionBar).toContainText(REQUIRED_CREDIT_MESSAGE);
		metrics = await collectMetrics(page);
		expect(metrics.requiredCreditMessage).toBe(true);
		expect(metrics.creditRouteVisible).toBe(true);
		expect(metrics.exportDoneCopy).toBe(false);
		expect(metrics.exportRunCount).toBe(1);
		expect(metrics.batchExportStatus).not.toBe("done");
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-required-credit-batch-gate.png`,
			fullPage: false,
		});
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-metrics.json`, JSON.stringify({
			metrics,
			consoleIssues,
		}, null, 2));

		await actionBar.getByRole("button", { name: "เปิดเครดิต" }).click();
		await page.waitForURL(/\/projects\/[^/]+\/pages\/1\/editor$/);
		await page.getByRole("region", { name: "เส้นทางหน้าที่กำลังแก้" }).waitFor({ state: "visible" });
		await expect(page.getByText("สร้าง / วาง / ลบเครดิต")).toBeVisible();
		await expect(page.getByLabel("สถานะสร้างเครดิตข้อความ")).toBeVisible();
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("เปิดเครื่องมือเครดิตในแผงเลเยอร์แล้ว");
	});
});
