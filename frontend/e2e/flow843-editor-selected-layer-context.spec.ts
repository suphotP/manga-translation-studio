import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow843-editor-selected-layer-context";

async function openEditorWithSelectedLayer(page: Page): Promise<void> {
	await page.goto("/projects/flow208-project/pages/1/editor");
	await page.waitForFunction(() => Boolean(window.__mangaEditorDebug && window.__mangaWorkflowDebug));
	await expect(page.getByLabel("เส้นทางหน้าที่กำลังแก้")).toBeVisible();
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({
			width: 1600,
			height: 2400,
			label: "FLOW843",
		});
		window.__mangaEditorDebug!.addTextLayers([
			{
				id: "flow843-selected-dialogue",
				name: "Dialogue top",
				text: "เลือกเลเยอร์นี้",
				x: 260,
				y: 320,
				w: 360,
				h: 92,
				rotation: 0,
				fontSize: 42,
				alignment: "center",
				index: 0,
			},
		]);
		window.__mangaEditorDebug!.selectTextLayer("flow843-selected-dialogue");
	});
	await expect(page.getByLabel(/เลเยอร์ที่เลือก: Dialogue top/)).toBeVisible();
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const chip = document.querySelector(".selected-layer-chip") as HTMLElement | null;
		const chipBox = chip?.getBoundingClientRect();
		const toolOptionsBar = document.querySelector(".tool-options-bar") as HTMLElement | null;
		const toolOptionsText = toolOptionsBar?.textContent?.replace(/\s+/g, " ").trim() ?? "";
		const viewportWidth = document.documentElement.clientWidth;
		const viewportHeight = document.documentElement.clientHeight;
		const under40 = Array.from(document.querySelectorAll("button, [role='button']"))
			.map((element) => {
				const rect = element.getBoundingClientRect();
				const label = element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName;
				return { height: Math.round(rect.height), label, width: Math.round(rect.width) };
			})
			.filter((item) => item.width > 0 && item.height > 0 && (item.width < 40 || item.height < 40));
		return {
			bodyOverflowX: Math.max(0, document.body.scrollWidth - viewportWidth),
			chipBox: chipBox
				? {
					height: Math.round(chipBox.height),
					insideViewport: chipBox.left >= 0 && chipBox.right <= viewportWidth && chipBox.top >= 0 && chipBox.bottom <= viewportHeight,
					width: Math.round(chipBox.width),
				}
				: null,
			chipText: chip?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			toolOptionsHasDuplicateEditorControls: /Tahoma|Arial|px|สีหลัก|สไตล์เพิ่มเติม|จัดกึ่งกลาง|ความโปร่งใส|พอดีหน้า|เต็มกว้าง/.test(toolOptionsText),
			toolOptionsText,
			overflowX: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
			under40,
		};
	});
}

test.describe("Flow843 editor selected-layer first viewport", () => {
	for (const viewport of [
		{ height: 1000, name: "desktop", width: 1440 },
		{ height: 1194, name: "ipad", width: 929 },
	]) {
		test(`shows selected layer context above the canvas on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await openEditorWithSelectedLayer(page);

			const metrics = await collectMetrics(page);
			expect(metrics.chipText).toContain("Dialogue top");
			expect(metrics.chipText).not.toContain("0, 0 / 0px");
			expect(metrics.toolOptionsText).toContain("เลือกเลเยอร์");
			expect(metrics.toolOptionsText).toContain("เปิดในแผงขวา");
			expect(metrics.toolOptionsHasDuplicateEditorControls).toBe(false);
			expect(metrics.chipBox?.insideViewport).toBe(true);
			expect(metrics.overflowX).toBe(0);
			expect(metrics.bodyOverflowX).toBe(0);
			expect(metrics.under40).toEqual([]);

			await mkdir(PROOF_DIR, { recursive: true });
			await page.screenshot({ path: `${PROOF_DIR}/${viewport.name}-selected-layer-context.png`, fullPage: true });
			await writeFile(`${PROOF_DIR}/${viewport.name}-metrics.json`, JSON.stringify(metrics, null, 2));
		});
	}
});
