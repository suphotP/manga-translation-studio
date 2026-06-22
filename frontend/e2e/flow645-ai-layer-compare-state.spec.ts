import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow645-ai-layer-compare-state";

async function seedSamePageAiResults(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	return page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		return window.__mangaWorkflowDebug!.seedSamePageAiResultVariants();
	});
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const focusCard = document.querySelector(".ai-layer-focus-card");
		const controls = Array.from(document.querySelectorAll(".ai-layer-focus-card button, .ai-layer-focus-card input"));
		const visibleControls = controls.filter((control) => {
			const rect = control.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
		});
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			under40: visibleControls
				.map((control) => {
					const rect = control.getBoundingClientRect();
					return {
						text: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName,
						width: Math.round(rect.width),
						height: Math.round(rect.height),
					};
				})
				.filter((item) => item.width < 40 || item.height < 40),
			cardText: focusCard?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			activeLayerId: window.__mangaEditorDebug!.getState().activeLayerId,
			layer: window.__mangaEditorDebug!.getState().imageLayers.find((item: { id: string }) => item.id === "ai-result-flow564-ai-applied") ?? null,
		};
	});
}

test.describe("Flow645 selected AI layer compare state", () => {
	test("makes hidden applied AI layers clearly read as base-image comparison", async ({ page }, testInfo: TestInfo) => {
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedSamePageAiResults(page);
		await page.locator("#ai-mode-results")
			.getByRole("button", { name: /เปิดผล AI P1 Clean Pro วางแล้ว/ })
			.click();
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("ai-result-flow564-ai-applied");

		await page.getByRole("button", { name: "ซ่อนผล AI เพื่อเทียบภาพฐาน" }).click();
		await expect(page.getByLabel("งานด่วนเลเยอร์ AI ที่เลือก")).toContainText("กำลังเทียบภาพฐาน");
		await expect(page.getByLabel("งานด่วนเลเยอร์ AI ที่เลือก")).toContainText("ผล AI ถูกซ่อนไว้ชั่วคราวเพื่อดูภาพฐานเดิม");
		await expect(page.getByRole("button", { name: "กลับมาแสดงผล AI" })).toContainText("กลับ AI");

		const metrics = await collectMetrics(page);
		expect(metrics.activeLayerId).toBe("ai-result-flow564-ai-applied");
		expect(metrics.layer?.visible).toBe(false);
		expect(metrics.cardText).toContain("กำลังเทียบภาพฐาน");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-ai-layer-compare-state.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues }, null, 2),
		);
	});
});
