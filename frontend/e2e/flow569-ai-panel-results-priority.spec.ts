import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow895-ai-auto-selection";

const blockedCapabilities = {
	tiers: [
		{
			id: "sfx-pro",
			label: "SFX Pro",
			provider: "python-worker",
			available: false,
			reason: "sfx_worker_no_available_accounts",
			detail: "SFX Pro is not available: Worker has no available SFX accounts.",
		},
		{
			id: "clean-pro",
			label: "Clean Pro",
			provider: "gemini-3.1-flash-image-preview",
			available: false,
			reason: "provider_disabled",
			detail: "Provider disabled.",
		},
		{
			id: "budget-clean",
			label: "Budget Clean",
			provider: "gemini-2.5-flash-image",
			available: false,
			reason: "adapter_pending",
			detail: "Adapter implementation pending.",
		},
	],
};

async function seedSamePageAiResults(page: Page) {
	await page.route("**/api/ai/capabilities", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(blockedCapabilities),
		});
	});
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	return page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		return window.__mangaWorkflowDebug!.seedSamePageAiResultVariants();
	});
}

async function panelMetrics(page: Page) {
	return page.evaluate(() => {
		const visible = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
		};
		const controls = [...document.querySelectorAll("button, [role='button'], input, select, textarea")].filter(visible);
		const results = document.querySelector("#ai-mode-results");
		const headers = [...document.querySelectorAll(".right-panel-content .panel-section-header")]
			.filter(visible)
			.map((element) => element.textContent?.trim().replace(/\s+/g, " ") ?? "");
		const resultPanelText = results?.textContent?.trim().replace(/\s+/g, " ") ?? "";
		return {
			headers,
			resultRefs: ["AI 1", "AI 2", "AI 3"].filter((label) => resultPanelText.includes(label)),
			hasAutoSelectionReceipt: resultPanelText.includes("แนะนำอัตโนมัติ") && resultPanelText.includes("ยังไม่ได้เลือกผลเอง"),
			hasProviderRecoveryVisible: document.body.innerText.includes("เพิ่มหรือรีเฟรชบัญชี worker"),
			hasAccountBadge: document.body.innerText.includes("บัญชีไม่พร้อม"),
			overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
			under36: controls
				.map((element) => {
					const rect = element.getBoundingClientRect();
					return {
						text: element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ") || element.tagName,
						width: Math.round(rect.width),
						height: Math.round(rect.height),
					};
				})
				.filter((item) => item.width < 36 || item.height < 36),
			editorState: window.__mangaEditorDebug!.getState(),
		};
	});
}

test.describe("Flow569 AI panel results priority", () => {
	test("shows existing page AI results before blocked provider setup", async ({ page }, testInfo) => {
		test.skip(testInfo.project.name.includes("mobile"), "AI panel priority proof is covered on desktop/tablet and fallback screenshots.");

		const seeded = await seedSamePageAiResults(page);
		expect(seeded.markerIds).toEqual(["flow564-ai-review", "flow564-ai-accepted", "flow564-ai-applied"]);
		await page.evaluate(() => window.__mangaWorkflowDebug!.clearAiReviewMarkerSelection());

		const resultsHeader = page.getByRole("button", { name: /ผล AI บนหน้านี้ เปิดอยู่/ });
		const setupHeader = page.getByRole("button", { name: /AI แปล SFX พับอยู่/ });
		await expect(resultsHeader).toBeVisible();
		await expect(setupHeader).toBeVisible();
		await expect(resultsHeader).toContainText("3 ผล");
		await expect(resultsHeader).toContainText("1 รอตรวจ");
		await expect(resultsHeader).toContainText("1 รอวาง");

		const metrics = await panelMetrics(page);
		expect(metrics.headers[0]).toContain("ผล AI บนหน้านี้");
		expect(metrics.headers[1]).toContain("AI แปล SFX");
		expect(metrics.resultRefs).toEqual(["AI 1", "AI 2", "AI 3"]);
		expect(metrics.hasAutoSelectionReceipt).toBe(true);
		expect(metrics.hasAccountBadge).toBe(true);
		expect(metrics.hasProviderRecoveryVisible).toBe(false);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under36).toEqual([]);
		await expect(page.getByRole("region", { name: "ผล AI ที่เลือก" })).toContainText("แนะนำอัตโนมัติ");
		await expect(page.getByRole("region", { name: "ผล AI ที่เลือก" })).toContainText("ยังไม่ได้เลือกผลเอง");
		await expect(page.getByRole("region", { name: "ผล AI ที่เลือก" })).toContainText("วางเลเยอร์ AI ก่อน Export");
		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-ai-results-owner.png`,
			fullPage: false,
		});
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-metrics.json`, JSON.stringify(metrics, null, 2));

		await page.locator("#ai-mode-results .ai-marker-row").filter({ hasText: "AI 1" }).click();
		await expect(page.getByText("รีวิวผลก่อนยืนยัน")).toBeVisible();
		await expect(page.getByRole("region", { name: "ผล AI ที่เลือก" })).not.toContainText("แนะนำอัตโนมัติ");
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBeNull();

		await page.locator("#ai-mode-results .ai-marker-row").filter({ hasText: "AI 3" }).click();
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("ai-result-flow564-ai-applied");
	});
});
