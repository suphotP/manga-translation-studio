import { expect, test, type Page } from "@playwright/test";

async function seedSamePageAiResults(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	return page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		return window.__mangaWorkflowDebug!.seedSamePageAiResultVariants();
	});
}

async function uiMetrics(page: Page) {
	return page.evaluate(() => {
		const buttons = [...document.querySelectorAll("button, [role='button']")].filter((element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
		});
		return {
			overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
			under36: buttons
				.map((element) => {
					const rect = element.getBoundingClientRect();
					return {
						text: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
						width: rect.width,
						height: rect.height,
					};
				})
				.filter((item) => item.width < 36 || item.height < 36),
			aiRefs: ["AI 1", "AI 2", "AI 3"].filter((label) => document.body.innerText.includes(label)),
			panelText: document.body.innerText,
			editorState: window.__mangaEditorDebug!.getState(),
			workflowState: window.__mangaWorkflowDebug!.getState(),
		};
	});
}

test.describe("Flow564 same-page AI results", () => {
	test("shows distinct AI result states on one page and opens the applied layer exactly", async ({ page }, testInfo) => {
		test.skip(testInfo.project.name.includes("mobile"), "Same-page multi-result proof is covered on desktop/tablet and fallback browser screenshots.");

		const seeded = await seedSamePageAiResults(page);
		expect(seeded.markerIds).toEqual(["flow564-ai-review", "flow564-ai-accepted", "flow564-ai-applied"]);

		await expect(page.getByRole("button", { name: /เปิดผล AI P1 Clean Pro รอตรวจ.*พื้นที่/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /เปิดผล AI P1 SFX Pro ผ่านตรวจ ยังไม่วาง.*พื้นที่/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /เปิดผล AI P1 Clean Pro วางแล้ว.*พื้นที่/ })).toBeVisible();
		const aiPanelResults = page.locator("#ai-mode-results");
		await expect(aiPanelResults).toContainText("AI 3");
		await expect(aiPanelResults).toContainText("วางแล้ว");

		let metrics = await uiMetrics(page);
		expect(metrics.aiRefs).toEqual(["AI 1", "AI 2", "AI 3"]);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under36).toEqual([]);

		const seededTextLayerId = metrics.editorState.textLayers[0]?.id;
		expect(seededTextLayerId).toBeTruthy();
		await page.evaluate((layerId) => window.__mangaEditorDebug!.selectTextLayer(layerId), seededTextLayerId);
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe(seededTextLayerId);
		await aiPanelResults
			.getByRole("button", { name: /เปิดผล AI P1 Clean Pro รอตรวจ/ })
			.click();
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBeNull();

		await aiPanelResults.locator(".ai-marker-row").filter({ hasText: "AI 2" }).click();
		await expect(aiPanelResults.locator(".ai-marker-row.selected")).toContainText("AI 2");
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBeNull();

		await aiPanelResults
			.getByRole("button", { name: /เปิดผล AI P1 Clean Pro วางแล้ว/ })
			.click();
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("ai-result-flow564-ai-applied");
		metrics = await uiMetrics(page);
		expect(metrics.editorState.activeLayerId).toBe("ai-result-flow564-ai-applied");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under36).toEqual([]);
	});
});
