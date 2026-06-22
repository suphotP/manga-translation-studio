import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow844-text-opacity-layer-proof";

async function openEditorWithOpacityText(page: Page): Promise<void> {
	await page.goto("/projects/flow208-project/pages/1/editor");
	await page.waitForFunction(() => Boolean(window.__mangaEditorDebug && window.__mangaWorkflowDebug));
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({
			width: 800,
			height: 600,
			fill: "#ffffff",
			label: "FLOW844",
		});
		window.__mangaEditorDebug!.addTextLayers([
			{
				id: "flow844-text-opacity",
				name: "Opacity proof text",
				text: "TEXT",
				x: 120,
				y: 250,
				w: 560,
				h: 130,
				rotation: 0,
				opacity: 1,
				fontSize: 112,
				fontFamily: "Arial",
				fill: "#000000",
				stroke: "#000000",
				strokeWidth: 0,
				alignment: "center",
				index: 0,
			},
		]);
		window.__mangaEditorDebug!.selectTextLayer("flow844-text-opacity");
	});
	await expect(page.getByLabel(/เลเยอร์ที่เลือก: Opacity proof text/)).toBeVisible();
	await openRightPanel(page, "เลเยอร์");
	const styleToggle = page.getByRole("button", { name: /สี \/ จัดวาง \/ ขอบ/ });
	await styleToggle.click();
	await expect(page.locator("#text-layer-opacity")).toBeVisible();
}

async function openRightPanel(page: Page, label: "AI" | "เลเยอร์") {
	const header = page.locator(".right-panel-title").filter({ hasText: `แผง ${label}` });
	if (await header.count()) return;
	await page.locator([
		`button[aria-label*="เปิดแผง ${label}"]:visible`,
		`button[aria-label*="เปิดแผงถัดไป: ${label}"]:visible`,
	].join(", ")).first().click();
	await expect(header).toBeVisible();
}

async function setRangeValue(locator: ReturnType<Page["locator"]>, value: number): Promise<void> {
	await locator.evaluate((input, nextValue) => {
		const range = input as HTMLInputElement;
		range.value = String(nextValue);
		range.dispatchEvent(new Event("input", { bubbles: true }));
		range.dispatchEvent(new Event("change", { bubbles: true }));
	}, value);
}

async function exportDataUrl(page: Page): Promise<string> {
	return page.evaluate(() => window.__mangaEditorDebug!.exportMergedImageDataUrl());
}

async function compareExportDataUrls(page: Page, before: string, after: string) {
	return page.evaluate(async (source) => {
		const decode = async (dataUrl: string) => {
			const image = new Image();
			image.src = dataUrl;
			await image.decode();
			return image;
		};
		const beforeImage = await decode(source.before);
		const afterImage = await decode(source.after);
		const canvas = document.createElement("canvas");
		canvas.width = beforeImage.naturalWidth;
		canvas.height = beforeImage.naturalHeight;
		const ctx = canvas.getContext("2d")!;
		ctx.drawImage(beforeImage, 0, 0);
		const beforePixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(afterImage, 0, 0);
		const afterPixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		let changedPixels = 0;
		let totalDelta = 0;
		for (let index = 0; index < beforePixels.length; index += 4) {
			const delta = Math.abs(beforePixels[index] - afterPixels[index])
				+ Math.abs(beforePixels[index + 1] - afterPixels[index + 1])
				+ Math.abs(beforePixels[index + 2] - afterPixels[index + 2]);
			if (delta > 8) changedPixels += 1;
			totalDelta += delta / 3;
		}
		return {
			changedPixels,
			averageDelta: totalDelta / (beforePixels.length / 4),
		};
	}, { before, after });
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const rightPanel = document.querySelector<HTMLElement>(".right-panel-content");
		const visible = (element: HTMLElement) => {
			const rect = element.getBoundingClientRect();
			const style = window.getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
		};
		const controls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea"))
			.filter((element) => rightPanel?.contains(element) && visible(element));
		const state = window.__mangaEditorDebug!.getState();
		const layer = state.textLayers.find((item: { id: string }) => item.id === "flow844-text-opacity");
		const style = state.textLayerStyles.find((item: { layerData?: { id?: string } }) => item.layerData?.id === "flow844-text-opacity");
		return {
			layerOpacity: layer?.opacity,
			styleOpacity: style?.opacity,
			overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
			under40: controls
				.map((element) => {
					const rect = element.getBoundingClientRect();
					return {
						label: element.getAttribute("aria-label") || element.textContent?.trim() || element.id,
						width: Math.round(rect.width),
						height: Math.round(rect.height),
					};
				})
				.filter((item) => item.width < 40 || item.height < 40),
		};
	});
}

test.describe("Flow844 text layer opacity", () => {
	for (const viewport of [
		{ height: 1000, name: "desktop", width: 1440 },
		{ height: 1194, name: "ipad", width: 929 },
	]) {
		test(`edits text opacity and proves export difference on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await openEditorWithOpacityText(page);

			const opaqueExport = await exportDataUrl(page);
			await setRangeValue(page.locator("#text-layer-opacity"), 35);
			await expect(page.getByLabel("สีและจัดวางข้อความ")).toContainText("ความทึบข้อความ: 35%");
			const fadedExport = await exportDataUrl(page);
			const exportDelta = await compareExportDataUrls(page, opaqueExport, fadedExport);

			const metrics = await collectMetrics(page);
			expect(metrics.layerOpacity).toBeCloseTo(0.35, 2);
			expect(metrics.styleOpacity).toBeCloseTo(0.35, 2);
			expect(exportDelta.changedPixels).toBeGreaterThan(1000);
			expect(exportDelta.averageDelta).toBeGreaterThan(0.2);
			expect(metrics.overflowX).toBe(0);
			expect(metrics.under40).toEqual([]);

			await mkdir(PROOF_DIR, { recursive: true });
			await page.screenshot({ path: `${PROOF_DIR}/${viewport.name}-text-opacity.png`, fullPage: true });
			await writeFile(`${PROOF_DIR}/${viewport.name}-metrics.json`, JSON.stringify({
				...metrics,
				exportDelta,
			}, null, 2));
		});
	}
});
