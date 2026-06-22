import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow971-ai-accepted-existing-layer";

async function seedAcceptedMarkerWithExistingLayer(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		await window.__mangaWorkflowDebug!.seedSamePageAiResultVariants();
		await window.__mangaEditorDebug!.addImageLayers([{
			id: "ai-result-flow564-ai-accepted",
			imageId: "flow564-ai-accepted-result.webp",
			imageName: "ผล AI accepted.webp",
			originalName: "ผล AI accepted.webp",
			x: 360,
			y: 285,
			w: 210,
			h: 130,
			rotation: 0,
			opacity: 1,
			index: 2,
			role: "overlay",
		}]);
		window.__mangaEditorDebug!.clearSelection();
	});
}

async function collectMetrics(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const viewportWidth = document.documentElement.clientWidth;
		const controls = Array.from(document.querySelectorAll("button, [role='button']"));
		const under40 = controls
			.map((element) => {
				const rect = element.getBoundingClientRect();
				const label = element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ") || element.tagName;
				return { height: Math.round(rect.height), label, width: Math.round(rect.width) };
			})
			.filter((item) => item.width > 0 && item.height > 0 && (item.width < 40 || item.height < 40));
		return {
			activeLayerId: window.__mangaEditorDebug!.getState().activeLayerId,
			bodyOverflowX: Math.max(0, document.body.scrollWidth - viewportWidth),
			overflowX: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
			panelText: document.body.innerText.replace(/\s+/g, " "),
			under40,
		};
	});
}

test.describe("Flow971 accepted AI marker with existing layer", () => {
	test("opens the editable AI layer instead of falling back to review", async ({ page }, testInfo) => {
		await seedAcceptedMarkerWithExistingLayer(page);

		await expect(page.getByRole("button", { name: /เปิดผล AI P1 SFX Pro ผ่านตรวจ วางแล้ว/ })).toBeVisible();
		await page.getByRole("button", { name: /เปิดผล AI P1 SFX Pro ผ่านตรวจ วางแล้ว/ }).click();
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("ai-result-flow564-ai-accepted");

		const metrics = await collectMetrics(page);
		expect(metrics.activeLayerId).toBe("ai-result-flow564-ai-accepted");
		expect(metrics.panelText).toContain("เลเยอร์");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under40).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({ path: `${PROOF_DIR}/${testInfo.project.name}-accepted-existing-layer.png`, fullPage: false });
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-metrics.json`, JSON.stringify(metrics, null, 2));
	});
});
