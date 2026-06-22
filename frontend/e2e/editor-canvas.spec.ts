import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const P104_REAL_IMAGE_PATH = "/Users/work/Documents/Codex/2026-05-16/ssh-suphot-192-168-1-203/p104/image-01.webp";
const P104_LONG_IMAGE_PATH = "/Users/work/Documents/Codex/2026-05-16/ssh-suphot-192-168-1-203/p104/image-02.webp";
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

async function waitForDebug(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaEditorDebug && window.__mangaWorkflowDebug));
}

async function openEditorView(page: Page) {
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("editor"));
	await page.waitForFunction(() => {
		const root = document.querySelector(".editor-root");
		return Boolean(root && !root.classList.contains("workspace-dashboard-view") && !root.classList.contains("workspace-focus-view"));
	});
}

async function loadEditorTestImage(page: Page) {
	await waitForDebug(page);
	await openEditorView(page);
	return page.evaluate(() => window.__mangaEditorDebug!.loadTestImage({
		width: 1600,
		height: 2400,
		label: "E2E CANVAS",
	}));
}

async function loadP104RealImage(page: Page, imagePath = P104_REAL_IMAGE_PATH) {
	test.skip(!existsSync(imagePath), `p104 real image not found at ${imagePath}`);
	await waitForDebug(page);
	await openEditorView(page);
	const imageBuffer = await readFile(imagePath);
	return page.evaluate((url) => window.__mangaEditorDebug!.loadImageUrl(url), `data:image/webp;base64,${imageBuffer.toString("base64")}`);
}

async function imagePointToClient(page: Page, point: { x: number; y: number }) {
	return page.evaluate((input) => window.__mangaEditorDebug!.imagePointToClient(input), point);
}

function editorStatus(page: Page) {
	return page.getByRole("status", { name: "สถานะตัวแก้หน้า" });
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

async function openLayerSection(page: Page, label: "กล่องข้อความ" | "เครดิต") {
	const section = page.getByRole("button", { name: new RegExp(`${label} พับอยู่`) });
	if (await section.count()) {
		await section.click();
	}
}

async function dragImageSelection(
	page: Page,
	start: { x: number; y: number },
	end: { x: number; y: number },
) {
	const startClient = await imagePointToClient(page, start);
	const endClient = await imagePointToClient(page, end);
	await page.mouse.move(startClient.x, startClient.y);
	await page.mouse.down();
	await page.mouse.move(endClient.x, endClient.y, { steps: 8 });
	await page.mouse.up();
}

async function dragImageSelectionWithTouchPointer(
	page: Page,
	start: { x: number; y: number },
	end: { x: number; y: number },
) {
	const startClient = await imagePointToClient(page, start);
	const endClient = await imagePointToClient(page, end);
	await page.evaluate(({ startClient, endClient }) => {
		const canvas = document.querySelector("canvas.upper-canvas") as HTMLCanvasElement | null;
		if (!canvas) throw new Error("Fabric upper canvas is not mounted");
		const fire = (type: string, x: number, y: number) => {
			canvas.dispatchEvent(new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				composed: true,
				pointerId: 37,
				pointerType: "touch",
				clientX: x,
				clientY: y,
				button: 0,
				buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
				isPrimary: true,
				pressure: type === "pointerup" || type === "pointercancel" ? 0 : 0.5,
			}));
		};
		fire("pointerdown", startClient.x, startClient.y);
		fire("pointermove", (startClient.x + endClient.x) / 2, (startClient.y + endClient.y) / 2);
		fire("pointermove", endClient.x, endClient.y);
		fire("pointerup", endClient.x, endClient.y);
	}, { startClient, endClient });
}

async function getEditorState(page: Page) {
	return page.evaluate(() => window.__mangaEditorDebug!.getState());
}

test.describe("editor canvas real-use harness", () => {
	test("keeps AI crop anchored in every drag direction and clamps width to 1024 image pixels", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Mouse-drag geometry is covered on desktop; mobile keeps viewport smoke coverage.");

		await loadEditorTestImage(page);
		await page.evaluate(() => {
			window.__mangaEditorDebug!.setAspectRatio([1, 1]);
			window.__mangaEditorDebug!.setTool("cover");
		});

		const cases = [
			{ name: "down-right", start: { x: 20, y: 60 }, end: { x: 1590, y: 2200 }, anchor: "start" },
			{ name: "up-left", start: { x: 1580, y: 2320 }, end: { x: 0, y: 0 }, anchor: "end" },
			{ name: "up-right", start: { x: 260, y: 1900 }, end: { x: 1590, y: 100 }, anchor: "x-start-y-end" },
			{ name: "down-left", start: { x: 1400, y: 220 }, end: { x: 0, y: 1800 }, anchor: "x-end-y-start" },
		] as const;
		const anchorTolerance = test.info().project.name.includes("tablet") ? 4 : 2;

		for (const testCase of cases) {
			await dragImageSelection(page, testCase.start, testCase.end);
			const { crop } = await getEditorState(page);
			expect(crop, testCase.name).not.toBeNull();
			expect(crop!.w, testCase.name).toBeLessThanOrEqual(1024);
			expect(crop!.w, testCase.name).toBeGreaterThan(900);
			expect(Math.abs(crop!.w - crop!.h), testCase.name).toBeLessThanOrEqual(1);

			if (testCase.anchor === "start") {
				expect(Math.abs(crop!.x - testCase.start.x), testCase.name).toBeLessThanOrEqual(anchorTolerance);
				expect(Math.abs(crop!.y - testCase.start.y), testCase.name).toBeLessThanOrEqual(anchorTolerance);
			}
			if (testCase.anchor === "end") {
				expect(Math.abs(crop!.x + crop!.w - testCase.start.x), testCase.name).toBeLessThanOrEqual(anchorTolerance);
				expect(Math.abs(crop!.y + crop!.h - testCase.start.y), testCase.name).toBeLessThanOrEqual(anchorTolerance);
			}
			if (testCase.anchor === "x-start-y-end") {
				expect(Math.abs(crop!.x - testCase.start.x), testCase.name).toBeLessThanOrEqual(anchorTolerance);
				expect(Math.abs(crop!.y + crop!.h - testCase.start.y), testCase.name).toBeLessThanOrEqual(anchorTolerance);
			}
			if (testCase.anchor === "x-end-y-start") {
				expect(Math.abs(crop!.x + crop!.w - testCase.start.x), testCase.name).toBeLessThanOrEqual(anchorTolerance);
				expect(Math.abs(crop!.y - testCase.start.y), testCase.name).toBeLessThanOrEqual(anchorTolerance);
			}
		}
	});

	test("brush erase uses image coordinates and preserves canvas placement after compositing", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Brush pixel geometry is covered on desktop; mobile keeps viewport smoke coverage.");

		const loaded = await loadEditorTestImage(page);
		await page.evaluate(() => window.__mangaEditorDebug!.setAiOverlayTestImage({
			width: 1600,
			height: 2400,
			fill: "#c1121f",
			label: "AI OVERLAY",
		}));
		await page.evaluate(() => window.__mangaEditorDebug!.setLegacyAiMaskBrushEnabled(true));
		const before = await getEditorState(page);

		await page.evaluate(() => window.__mangaEditorDebug!.setTool("brush"));
		await dragImageSelection(page, { x: 800, y: 1250 }, { x: 960, y: 1250 });
		await page.waitForTimeout(300);

		const after = await getEditorState(page);
		const erasedPixel = await page.evaluate(() => window.__mangaEditorDebug!.sampleEraserPixel({ x: 800, y: 1250 }));

		expect(erasedPixel).toEqual([255, 255, 255, 255]);
		expect(after.image.bounds.left).toBeCloseTo(loaded.image.bounds.left, 3);
		expect(after.image.bounds.top).toBeCloseTo(loaded.image.bounds.top, 3);
		expect(after.image.bounds.width).toBeCloseTo(loaded.image.bounds.width, 3);
		expect(after.image.bounds.height).toBeCloseTo(loaded.image.bounds.height, 3);
		expect(after.image.item?.left).toBeCloseTo(before.image.item!.left, 3);
		expect(after.image.item?.top).toBeCloseTo(before.image.item!.top, 3);
	});

	test("brush erase targets the selected image layer without replacing the page image", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Selected overlay brush behavior is covered on desktop.");

		const loaded = await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "brush-target-overlay",
					name: "Brush target overlay",
					imageId: "brush-target-overlay.png",
					imageName: "brush-target-overlay.png",
					originalName: "brush-target-overlay.png",
					x: 600,
					y: 760,
					w: 320,
					h: 220,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
		});
		await openRightPanel(page, "เลเยอร์");
		await page.evaluate(() => window.__mangaEditorDebug!.selectImageLayer("brush-target-overlay"));
		await page.waitForFunction(() => window.__mangaEditorDebug!.getState().activeLayerId === "brush-target-overlay");

		const beforePixel = await page.evaluate(() => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-target-overlay", { x: 690, y: 830 }));
		expect(beforePixel?.[3]).toBe(255);

		await page.evaluate(() => window.__mangaEditorDebug!.setTool("brush"));
		await expect.poll(async () => (await getEditorState(page)).brush.selectedImageLayerId).toBe("brush-target-overlay");
		await dragImageSelection(page, { x: 690, y: 830 }, { x: 750, y: 830 });
		await page.waitForTimeout(300);

		const after = await getEditorState(page);
		expect(after.brush.lastTargetKind).toBe("image-layer");
		const erasedPixel = await page.evaluate(() => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-target-overlay", { x: 690, y: 830 }));
		const layer = after.imageLayers.find((item: { id: string }) => item.id === "brush-target-overlay");

		expect(erasedPixel?.[3]).toBeLessThan(32);
		expect(layer?.imageId).toContain("brush-brush-target-overlay-");
		expect(layer?.restoreImageId).toBe("brush-target-overlay.png");
		expect(after.image.item?.left).toBeCloseTo(loaded.image.item!.left, 3);
		expect(after.image.item?.top).toBeCloseTo(loaded.image.item!.top, 3);
		expect(layer?.x).toBe(600);
		expect(layer?.y).toBe(760);
		expect(layer?.w).toBe(320);
		expect(layer?.h).toBe(220);

		await mkdir("../.codex-dev-logs/visual-checks/flow391-selected-overlay-brush", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow391-selected-overlay-brush/desktop-overlay-brush.png",
			fullPage: false,
		});

		await page.evaluate(() => window.__mangaEditorDebug!.undo());
		await expect.poll(async () => (await getEditorState(page)).imageLayers.find((item: { id: string }) => item.id === "brush-target-overlay")?.imageId).toBe("brush-target-overlay.png");
		const restoredPixel = await page.evaluate(() => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-target-overlay", { x: 690, y: 830 }));
		expect(restoredPixel?.[3]).toBe(255);
	});

	test("brush uses the selected image layer transform for rotated and flipped pixels", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Transform brush mapping is covered on desktop.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "brush-transform-overlay",
					name: "Brush transform overlay",
					imageId: "brush-transform-overlay.png",
					imageName: "brush-transform-overlay.png",
					originalName: "brush-transform-overlay.png",
					x: 600,
					y: 760,
					w: 320,
					h: 220,
					rotation: 17,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					flipX: true,
					flipY: true,
					fill: "#0ea5e9",
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("brush-transform-overlay");
			window.__mangaEditorDebug!.setBrushSize(44);
			window.__mangaEditorDebug!.setTool("brush");
		});

		const targetSourcePoint = { x: 44, y: 58 };
		const protectedSourcePoint = { x: 276, y: 162 };
		const beforeTarget = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerSourcePixel("brush-transform-overlay", point), targetSourcePoint);
		const beforeProtected = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerSourcePixel("brush-transform-overlay", point), protectedSourcePoint);
		expect(beforeTarget?.[3]).toBe(255);
		expect(beforeProtected?.[3]).toBe(255);

		const clientPoint = await page.evaluate((point) => (
			window.__mangaEditorDebug!.imageLayerSourcePointToClient("brush-transform-overlay", point)
		), targetSourcePoint);
		if (!clientPoint) throw new Error("Could not map image-layer source point to client point");

		await page.mouse.move(clientPoint.x, clientPoint.y);
		await expect.poll(async () => (await getEditorState(page)).brush.preview?.visible ?? false).toBe(true);
		await page.mouse.down();
		await page.mouse.move(clientPoint.x + 2, clientPoint.y + 2, { steps: 2 });
		await page.mouse.up();
		await page.waitForTimeout(300);

		const state = await getEditorState(page);
		const afterTarget = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerSourcePixel("brush-transform-overlay", point), targetSourcePoint);
		const afterProtected = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerSourcePixel("brush-transform-overlay", point), protectedSourcePoint);
		expect(state.brush.lastTargetKind).toBe("image-layer");
		expect(afterTarget?.[3]).toBeLessThan(32);
		expect(afterProtected).toEqual(beforeProtected);
	});

	test("brush does not fall back to AI-mask background when the selected image layer misses", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Selected image brush miss behavior is covered on desktop.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "brush-miss-overlay",
					name: "Brush miss overlay",
					imageId: "brush-miss-overlay.png",
					imageName: "brush-miss-overlay.png",
					originalName: "brush-miss-overlay.png",
					x: 600,
					y: 760,
					w: 320,
					h: 220,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
			await window.__mangaEditorDebug!.setAiOverlayTestImage({
				width: 1600,
				height: 2400,
				fill: "#c1121f",
				label: "AI MASK SHOULD NOT CHANGE",
			});
			window.__mangaEditorDebug!.selectImageLayer("brush-miss-overlay");
			window.__mangaEditorDebug!.setTool("brush");
		});
		await expect.poll(async () => (await getEditorState(page)).brush.selectedImageLayerId).toBe("brush-miss-overlay");

		const outsideSelectedLayer = { x: 320, y: 360 };
		const outsideSelectedLayerClient = await imagePointToClient(page, outsideSelectedLayer);
		await page.mouse.move(outsideSelectedLayerClient.x, outsideSelectedLayerClient.y);
		await expect.poll(async () => (await getEditorState(page)).brush.preview?.visible ?? false).toBe(true);
		await expect.poll(async () => (await getEditorState(page)).brush.preview?.blocked ?? false).toBe(true);
		await expect(page.getByRole("status", { name: "เตือนแปรงนอกเลเยอร์" })).toContainText("นอกเลเยอร์ที่เลือก");

		const insideSelectedLayerClient = await imagePointToClient(page, { x: 690, y: 830 });
		await page.mouse.move(insideSelectedLayerClient.x, insideSelectedLayerClient.y);
		await expect.poll(async () => (await getEditorState(page)).brush.preview?.visible ?? false).toBe(true);
		await expect.poll(async () => (await getEditorState(page)).brush.preview?.blocked ?? true).toBe(false);
		await expect(page.getByRole("status", { name: "เป้าหมายแปรง" })).toContainText("ลบเฉพาะเลเยอร์นี้");
		await page.mouse.move(outsideSelectedLayerClient.x, outsideSelectedLayerClient.y);
		await expect.poll(async () => (await getEditorState(page)).brush.preview?.visible ?? false).toBe(true);
		await expect.poll(async () => (await getEditorState(page)).brush.preview?.blocked ?? false).toBe(true);

		const beforeMaskPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleEraserPixel(point), outsideSelectedLayer);
		expect(beforeMaskPixel?.slice(0, 3)).toEqual([193, 18, 31]);

		await dragImageSelection(page, outsideSelectedLayer, { x: 380, y: 360 });
		await page.waitForTimeout(300);
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("นอกเลเยอร์ที่เลือก");

		const after = await getEditorState(page);
		const afterMaskPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleEraserPixel(point), outsideSelectedLayer);
		const layer = after.imageLayers.find((item: { id: string }) => item.id === "brush-miss-overlay");

		expect(after.brush.lastTargetKind).toBeNull();
		expect(after.brush.activeTargetLayerId).toBeNull();
		expect(afterMaskPixel).toEqual(beforeMaskPixel);
		expect(layer?.imageId).toBe("brush-miss-overlay.png");
	});

	test("brush does not edit the legacy flattened AI mask unless explicitly enabled", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Legacy mask opt-in is covered on desktop.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.setAiOverlayTestImage({
				width: 1600,
				height: 2400,
				fill: "#c1121f",
				label: "AI MASK LOCKED BY DEFAULT",
			});
			window.__mangaEditorDebug!.setTool("brush");
		});

		const sample = { x: 800, y: 1250 };
		const beforePixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleEraserPixel(point), sample);
		await dragImageSelection(page, sample, { x: 960, y: 1250 });
		await page.waitForTimeout(300);

		const state = await getEditorState(page);
		const afterPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleEraserPixel(point), sample);
		expect(state.brush.lastTargetKind).toBeNull();
		expect(state.brush.preview?.visible ?? false).toBe(false);
		expect(afterPixel).toEqual(beforePixel);
	});

	test("brush restore mode repaints erased selected image layer pixels", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Selected overlay restore behavior is covered on desktop.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "brush-restore-overlay",
					name: "Brush restore overlay",
					imageId: "brush-restore-overlay.png",
					imageName: "brush-restore-overlay.png",
					originalName: "brush-restore-overlay.png",
					x: 600,
					y: 760,
					w: 320,
					h: 220,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("brush-restore-overlay");
			window.__mangaEditorDebug!.setTool("brush");
			window.__mangaEditorDebug!.setBrushMode("erase");
		});

		await dragImageSelection(page, { x: 690, y: 830 }, { x: 750, y: 830 });
		await page.waitForTimeout(300);
		const erasedPixel = await page.evaluate(() => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-restore-overlay", { x: 690, y: 830 }));
		expect(erasedPixel?.[3]).toBeLessThan(32);

		await page.evaluate(() => window.__mangaEditorDebug!.setBrushMode("restore"));
		await dragImageSelection(page, { x: 690, y: 830 }, { x: 750, y: 830 });
		await page.waitForTimeout(300);
		const restoredPixel = await page.evaluate(() => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-restore-overlay", { x: 690, y: 830 }));
		const state = await getEditorState(page);
		const layer = state.imageLayers.find((item: { id: string }) => item.id === "brush-restore-overlay");
		expect(state.brush.mode).toBe("restore");
		expect(layer?.restoreImageId).toBe("brush-restore-overlay.png");
		expect(restoredPixel?.[3]).toBeGreaterThan(220);
	});

	test("brush handles touch pointer erase and restore for selected image layers", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Touch brush proof targets tablet and desktop pointer environments.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "brush-touch-overlay",
					name: "Brush touch overlay",
					imageId: "brush-touch-overlay.png",
					imageName: "brush-touch-overlay.png",
					originalName: "brush-touch-overlay.png",
					x: 600,
					y: 760,
					w: 320,
					h: 220,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("brush-touch-overlay");
			window.__mangaEditorDebug!.setBrushSize(140);
			window.__mangaEditorDebug!.setTool("brush");
		});
		await expect.poll(async () => (await getEditorState(page)).brush.selectedImageLayerId).toBe("brush-touch-overlay");

		const sample = { x: 690, y: 830 };
		const beforePixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-touch-overlay", point), sample);
		await dragImageSelectionWithTouchPointer(page, sample, { x: 770, y: 880 });
		await page.waitForTimeout(300);

		const erasedState = await getEditorState(page);
		const erasedPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-touch-overlay", point), sample);
		expect(erasedState.brush.lastTargetKind).toBe("image-layer");
		expect(erasedPixel?.[3]).toBeLessThan(32);

		await page.evaluate(() => window.__mangaEditorDebug!.setBrushMode("restore"));
		await dragImageSelectionWithTouchPointer(page, sample, { x: 770, y: 880 });
		await page.waitForTimeout(300);

		const restoredState = await getEditorState(page);
		const restoredPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-touch-overlay", point), sample);
		expect(restoredState.brush.mode).toBe("restore");
		expect(restoredState.brush.lastTargetKind).toBe("image-layer");
		expect(restoredPixel).toEqual(beforePixel);
	});

	test("brush restore mode does not erase when restore source is unavailable", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Restore-source guard is covered on desktop/tablet.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "brush-missing-restore-overlay",
					name: "Missing restore overlay",
					imageId: "brush-missing-restore-overlay.png",
					imageName: "brush-missing-restore-overlay.png",
					originalName: "brush-missing-restore-overlay.png",
					x: 600,
					y: 760,
					w: 320,
					h: 220,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("brush-missing-restore-overlay");
			window.__mangaEditorDebug!.setBrushSize(140);
			window.__mangaEditorDebug!.setBrushMode("restore");
			window.__mangaEditorDebug!.setTool("brush");
		});

		const sample = { x: 690, y: 830 };
		const beforePixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-missing-restore-overlay", point), sample);
		await dragImageSelection(page, sample, { x: 770, y: 880 });
		await page.waitForTimeout(300);

		const afterState = await getEditorState(page);
		const afterPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-missing-restore-overlay", point), sample);
		expect(afterState.brush.lastTargetKind).toBeNull();
		expect(afterPixel).toEqual(beforePixel);
	});

	test("brush-mutated image layer uploads and saves the persisted image id", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Persisted brush save proof is covered on desktop/tablet.");

		const projectId = "123e4567-e89b-12d3-a456-426614174431";
		const persistedImageId = "persisted-brush-layer.png";
		let uploadCount = 0;
		let remoteProjectState: any = null;
		let savedState: any = null;

		await page.route(`**/api/images/${projectId}/upload`, async (route) => {
			uploadCount += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					imageIds: [persistedImageId],
					assets: [{
						assetId: persistedImageId,
						imageId: persistedImageId,
						originalName: "Persisted-brush-layer.png",
						mimeType: "image/png",
						sizeBytes: 5,
						sha256: "flow432",
						storageDriver: "local",
						storageKey: `projects/${projectId}/images/${persistedImageId}`,
						width: 1,
						height: 1,
						storageStatus: "released",
						moderationStatus: "passed",
						derivativeCount: 0,
						createdAt: "2026-05-19T00:00:00.000Z",
						updatedAt: "2026-05-19T00:00:00.000Z",
					}],
				}),
			});
		});
		await page.route(`**/api/project/${projectId}`, async (route) => {
			if (route.request().method() !== "GET") {
				await route.fallback();
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(remoteProjectState),
			});
		});
		await page.route(`**/api/project/${projectId}/save`, async (route) => {
			savedState = JSON.parse(route.request().postData() ?? "null");
			await route.fulfill({ status: 204, body: "" });
		});

		await waitForDebug(page);
		await page.evaluate(async (projectId) => window.__mangaWorkflowDebug!.seedProject({ projectId }), projectId);
		remoteProjectState = await page.evaluate(() => JSON.parse(JSON.stringify(window.__mangaWorkflowDebug!.getProjectState())));
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "brush-persist-overlay",
					name: "Brush persist overlay",
					imageId: "brush-persist-overlay.png",
					imageName: "brush-persist-overlay.png",
					originalName: "brush-persist-overlay.png",
					x: 600,
					y: 760,
					w: 320,
					h: 220,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("brush-persist-overlay");
			window.__mangaEditorDebug!.setBrushSize(140);
			window.__mangaEditorDebug!.setTool("brush");
		});

		const sample = { x: 690, y: 830 };
		await dragImageSelection(page, sample, { x: 770, y: 880 });
		await expect.poll(async () => {
			const state = await getEditorState(page);
			return state.imageLayers.find((item: { id: string }) => item.id === "brush-persist-overlay")?.imageId;
		}).toBe(persistedImageId);

		const erasedPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerPixel("brush-persist-overlay", point), sample);
		expect(erasedPixel?.[3]).toBeLessThan(32);
		expect(uploadCount).toBe(1);

		await page.evaluate(async () => window.__mangaWorkflowDebug!.saveState());
		expect(savedState?.pages?.[0]?.imageLayers?.[0]).toMatchObject({
			id: "brush-persist-overlay",
			imageId: persistedImageId,
			restoreImageId: "brush-persist-overlay.png",
		});
	});

	test("AI-mask brush uploads background edit, saves page edits, and exports the edited image", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "AI-mask persistence proof is covered on desktop/tablet.");

		const projectId = "123e4567-e89b-12d3-a456-426614174436";
		const persistedImageId = "persisted-ai-mask-background.png";
		let uploadCount = 0;
		let persistedExportRequests = 0;
		let originalExportRequests = 0;
		let remoteProjectState: any = null;
		let savedState: any = null;

		await page.route(`**/api/images/${projectId}/upload`, async (route) => {
			uploadCount += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					imageIds: [persistedImageId],
					assets: [{
						assetId: persistedImageId,
						imageId: persistedImageId,
						originalName: "page-1-brush-mask.png",
						mimeType: "image/png",
						sizeBytes: 5,
						sha256: "flow436",
						storageDriver: "local",
						storageKey: `projects/${projectId}/images/${persistedImageId}`,
						width: 1600,
						height: 2400,
						storageStatus: "released",
						moderationStatus: "passed",
						derivativeCount: 0,
						createdAt: "2026-05-19T00:00:00.000Z",
						updatedAt: "2026-05-19T00:00:00.000Z",
					}],
				}),
			});
		});
		await page.route(`**/api/project/${projectId}`, async (route) => {
			if (route.request().method() !== "GET") {
				await route.fallback();
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(remoteProjectState),
			});
		});
		await page.route(`**/api/project/${projectId}/save`, async (route) => {
			savedState = JSON.parse(route.request().postData() ?? "null");
			remoteProjectState = structuredClone(savedState);
			await route.fulfill({ status: 204, body: "" });
		});
		await page.route(`**/api/project/${projectId}/images/**`, async (route) => {
			const url = route.request().url();
			if (url.includes(persistedImageId)) persistedExportRequests += 1;
			if (url.includes("flow208-page-01")) originalExportRequests += 1;
			await route.fulfill({
				status: 200,
				contentType: "image/png",
				headers: { "Access-Control-Allow-Origin": "*" },
				body: TINY_PNG,
			});
		});
		await page.route(`**/api/usage/${projectId}/export`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					eventId: "flow436-export-usage",
					usage: { projectId, workspaceId: projectId, enforced: false },
				}),
			});
		});
		await page.route(`**/api/project/${projectId}/exports/**/artifact`, async (route) => {
			const runId = decodeURIComponent(route.request().url().match(/\/exports\/([^/]+)\/artifact/)?.[1] ?? "export-run");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					artifact: {
						artifactId: "flow436-artifact",
						storageKey: `projects/${projectId}/exports/${runId}.zip`,
						sizeBytes: 12,
						createdAt: "2026-05-19T00:00:00.000Z",
					},
					exportRun: {
						id: runId,
						kind: "batch-zip",
						status: "done",
						filename: "flow436.zip",
						pageIndexes: [0, 1],
						bytes: 12,
						createdAt: "2026-05-19T00:00:00.000Z",
						artifact: {
							artifactId: "flow436-artifact",
							storageKey: `projects/${projectId}/exports/${runId}.zip`,
							sizeBytes: 12,
							createdAt: "2026-05-19T00:00:00.000Z",
						},
					},
				}),
			});
		});

		await waitForDebug(page);
		await page.evaluate(async (projectId) => window.__mangaWorkflowDebug!.seedProject({ projectId }), projectId);
		remoteProjectState = await page.evaluate(() => JSON.parse(JSON.stringify(window.__mangaWorkflowDebug!.getProjectState())));
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.setAiOverlayTestImage({
				width: 1600,
				height: 2400,
				fill: "#c1121f",
				label: "AI MASK PERSIST",
			});
			window.__mangaEditorDebug!.setLegacyAiMaskBrushEnabled(true);
			window.__mangaEditorDebug!.setBrushSize(180);
			window.__mangaEditorDebug!.setTool("brush");
		});

		const sample = { x: 800, y: 1250 };
		const beforePixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleEraserPixel(point), sample);
		expect(beforePixel?.slice(0, 3)).toEqual([193, 18, 31]);

		await dragImageSelection(page, sample, { x: 960, y: 1250 });
		await expect.poll(async () => {
			return page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages?.[0]?.edits?.imageId ?? null);
		}).toBe(persistedImageId);

		const state = await getEditorState(page);
		const erasedPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleEraserPixel(point), sample);
		expect(state.brush.lastTargetKind).toBe("background");
		expect(state.brush.activeTargetLayerId).toBeNull();
		expect(erasedPixel).toEqual([247, 242, 255, 255]);
		expect(uploadCount).toBe(1);

		const exportedPixel = await page.evaluate(async (point) => {
			const dataUrl = await window.__mangaEditorDebug!.exportMergedImageDataUrl();
			const image = new Image();
			await new Promise<void>((resolve, reject) => {
				image.onload = () => resolve();
				image.onerror = () => reject(new Error("export image decode failed"));
				image.src = dataUrl;
			});
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(image, 0, 0);
			return Array.from(ctx.getImageData(point.x, point.y, 1, 1).data);
		}, sample);
		expect(exportedPixel).toEqual([247, 242, 255, 255]);

		await page.evaluate(async () => window.__mangaWorkflowDebug!.saveState());
		expect(savedState?.pages?.[0]?.edits).toEqual({ imageId: persistedImageId });
	});

	test("full AI mask restore is blocked while a background brush commit is pending", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "AI-mask pending-restore guard is covered on desktop/tablet.");

		const projectId = "123e4567-e89b-12d3-a456-426614174446";
		let uploadCount = 0;
		let releaseUpload: (() => void) | null = null;
		let remoteProjectState: any = null;

		await page.route(`**/api/images/${projectId}/upload`, async (route) => {
			uploadCount += 1;
			if (uploadCount === 1) {
				await new Promise<void>((resolve) => {
					releaseUpload = resolve;
				});
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					imageIds: [`persisted-ai-mask-${uploadCount}.png`],
					assets: [{
						assetId: `persisted-ai-mask-${uploadCount}.png`,
						imageId: `persisted-ai-mask-${uploadCount}.png`,
						originalName: "page-1-brush-mask.png",
						mimeType: "image/png",
						sizeBytes: 5,
						sha256: `flow446-${uploadCount}`,
						storageDriver: "local",
						storageKey: `projects/${projectId}/images/persisted-ai-mask-${uploadCount}.png`,
						width: 1600,
						height: 2400,
						storageStatus: "released",
						moderationStatus: "passed",
						derivativeCount: 0,
						createdAt: "2026-05-19T00:00:00.000Z",
						updatedAt: "2026-05-19T00:00:00.000Z",
					}],
				}),
			});
		});
		await page.route(`**/api/project/${projectId}`, async (route) => {
			if (route.request().method() !== "GET") {
				await route.fallback();
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(remoteProjectState),
			});
		});

		await waitForDebug(page);
		await page.evaluate(async (projectId) => window.__mangaWorkflowDebug!.seedProject({ projectId }), projectId);
		remoteProjectState = await page.evaluate(() => JSON.parse(JSON.stringify(window.__mangaWorkflowDebug!.getProjectState())));
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.setAiOverlayTestImage({
				width: 1600,
				height: 2400,
				fill: "#c1121f",
				label: "AI MASK PENDING",
			});
			window.__mangaEditorDebug!.setLegacyAiMaskBrushEnabled(true);
			window.__mangaEditorDebug!.setBrushSize(180);
			window.__mangaEditorDebug!.setTool("brush");
		});

		await dragImageSelection(page, { x: 800, y: 1250 }, { x: 960, y: 1250 });
		await expect.poll(async () => {
			const state = await getEditorState(page);
			return state.brush.pendingCommit;
		}).toBe(true);

		const restoreState = await page.evaluate(() => window.__mangaEditorDebug!.clearEraserMask());
		expect(restoreState.brush.commitError).toContain("รอให้รอยแปรงก่อนหน้าบันทึกเสร็จ");
		expect(uploadCount).toBe(1);
		expect(await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages?.[0]?.edits ?? null)).toBeNull();

		releaseUpload?.();
		await expect.poll(async () => {
			const state = await getEditorState(page);
			return state.brush.pendingCommit;
		}).toBe(false);
		await expect.poll(async () => {
			return page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages?.[0]?.edits?.imageId ?? null);
		}).toBe("persisted-ai-mask-1.png");
		expect(uploadCount).toBe(1);
	});

			test("AI-mask brush upload failure shows fail-closed recovery state", async ({ page }) => {
				test.skip(test.info().project.name.includes("mobile"), "AI-mask upload failure UX is covered on desktop/tablet.");

		const projectId = "123e4567-e89b-12d3-a456-426614174437";
		let uploadCount = 0;
		let saveCount = 0;
		let remoteProjectState: any = null;

		await page.route(`**/api/images/${projectId}/upload`, async (route) => {
			uploadCount += 1;
			await route.fulfill({
				status: 429,
				contentType: "application/json",
				body: JSON.stringify({ error: "quota" }),
			});
		});
		await page.route(`**/api/project/${projectId}`, async (route) => {
			if (route.request().method() !== "GET") {
				await route.fallback();
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(remoteProjectState),
			});
		});
		await page.route(`**/api/project/${projectId}/save`, async (route) => {
			saveCount += 1;
			await route.fulfill({ status: 204, body: "" });
		});

		await waitForDebug(page);
		await page.evaluate(async (projectId) => window.__mangaWorkflowDebug!.seedProject({ projectId }), projectId);
		remoteProjectState = await page.evaluate(() => JSON.parse(JSON.stringify(window.__mangaWorkflowDebug!.getProjectState())));
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.setAiOverlayTestImage({
				width: 1600,
				height: 2400,
				fill: "#c1121f",
				label: "AI MASK FAIL",
			});
			window.__mangaEditorDebug!.clearSelection();
			window.__mangaEditorDebug!.setLegacyAiMaskBrushEnabled(true);
			window.__mangaEditorDebug!.setBrushSize(180);
			window.__mangaEditorDebug!.setTool("brush");
		});

		await dragImageSelection(page, { x: 800, y: 1250 }, { x: 960, y: 1250 });
		await expect.poll(async () => {
			return page.evaluate(() => window.__mangaEditorDebug!.getBrushCommitErrorMessage?.() ?? null);
		}).toContain("ส่งคำขอถี่");
		await page.locator([
			`button[aria-label*="เปิดแผง AI"]:visible`,
			`button[aria-label*="เปิดแผงถัดไป: AI"]:visible`,
		].join(", ")).first().click();

		const alert = page.getByRole("alert", { name: "บันทึกรอยแปรงไม่สำเร็จ" });
		await expect(alert).toContainText("กันบันทึกและส่งออกไว้ก่อน");
		await expect(alert).toContainText("รอยแปรงยังไม่ถูกบันทึก");
		await expect(alert).toContainText("เจ้าของรอยแปรง: ผล AI ทั้งภาพ");
		await expect(alert).toContainText("หลังสำเร็จค่อยบันทึกหรือส่งออกอีกครั้ง");
		await expect(alert).not.toContainText("storage");
		await expect(alert).toContainText("ส่งคำขอถี่");
		await expect(alert.getByRole("button", { name: "กลับไปแปรงเดิม" })).toBeVisible();
		await expect(alert.getByRole("button", { name: "ดูเลเยอร์เป้าหมาย" })).toBeVisible();
		await expect(alert.getByRole("button", { name: "คืนผล AI เต็ม" })).toBeVisible();
		expect(await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages?.[0]?.edits ?? null)).toBeNull();
		expect(uploadCount).toBe(1);
		await alert.scrollIntoViewIfNeeded();

		const metrics = await page.evaluate(() => {
			const visibleControls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea"))
				.filter((element) => {
					const rect = element.getBoundingClientRect();
					const style = window.getComputedStyle(element);
					return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
				});
			return {
				overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
				bodyOverflowX: Math.max(0, document.body.scrollWidth - window.innerWidth),
				under36: visibleControls
					.map((element) => {
						const rect = element.getBoundingClientRect();
						return {
							label: element.getAttribute("aria-label") || element.textContent?.trim() || element.id,
							width: Math.round(rect.width),
							height: Math.round(rect.height),
						};
					})
					.filter((item) => item.width < 36 || item.height < 36),
			};
		});
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under36).toEqual([]);

		await mkdir("../.codex-dev-logs/visual-checks/flow437-brush-upload-failure-recovery", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow437-brush-upload-failure-recovery/${test.info().project.name}-ai-mask-upload-failure.png`,
			fullPage: false,
		});

		await page.getByRole("button", { name: /บันทึก/ }).first().click();
			await expect(editorStatus(page)).toContainText("บันทึกไม่สำเร็จ");
			expect(saveCount).toBe(0);
		});

		test("successful image-layer brush does not clear failed AI-mask brush commit", async ({ page }) => {
			test.skip(test.info().project.name.includes("mobile"), "Brush commit error scoping is covered on desktop/tablet.");

			const projectId = "123e4567-e89b-12d3-a456-426614174441";
			const persistedLayerImageId = "persisted-after-background-failure.png";
			let uploadCount = 0;
			let saveCount = 0;
			let remoteProjectState: any = null;

			await page.route(`**/api/images/${projectId}/upload`, async (route) => {
				uploadCount += 1;
				if (uploadCount === 1) {
					await route.fulfill({
						status: 429,
						contentType: "application/json",
						body: JSON.stringify({ error: "quota" }),
					});
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						imageIds: [persistedLayerImageId],
						assets: [{
							assetId: persistedLayerImageId,
							imageId: persistedLayerImageId,
							originalName: "layer-brush-after-background-failure.png",
							mimeType: "image/png",
							sizeBytes: 5,
							sha256: "flow442",
							storageDriver: "local",
							storageKey: `projects/${projectId}/images/${persistedLayerImageId}`,
							width: 1,
							height: 1,
							storageStatus: "released",
							moderationStatus: "passed",
							derivativeCount: 0,
							createdAt: "2026-05-19T00:00:00.000Z",
							updatedAt: "2026-05-19T00:00:00.000Z",
						}],
					}),
				});
			});
			await page.route(`**/api/project/${projectId}`, async (route) => {
				if (route.request().method() !== "GET") {
					await route.fallback();
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(remoteProjectState),
				});
			});
			await page.route(`**/api/project/${projectId}/save`, async (route) => {
				saveCount += 1;
				await route.fulfill({ status: 204, body: "" });
			});

			await waitForDebug(page);
			await page.evaluate(async (projectId) => window.__mangaWorkflowDebug!.seedProject({ projectId }), projectId);
			remoteProjectState = await page.evaluate(() => JSON.parse(JSON.stringify(window.__mangaWorkflowDebug!.getProjectState())));
			await page.evaluate(async () => {
				await window.__mangaEditorDebug!.setAiOverlayTestImage({
					width: 1600,
					height: 2400,
					fill: "#c1121f",
					label: "AI MASK FAIL",
				});
				window.__mangaEditorDebug!.setLegacyAiMaskBrushEnabled(true);
				window.__mangaEditorDebug!.setBrushSize(180);
				window.__mangaEditorDebug!.setTool("brush");
			});

			await dragImageSelection(page, { x: 800, y: 1250 }, { x: 960, y: 1250 });
			await expect.poll(async () => page.evaluate(() => window.__mangaEditorDebug!.getBrushCommitErrorMessage?.() ?? null)).toContain("ส่งคำขอถี่");

			await page.evaluate(async () => {
				await window.__mangaEditorDebug!.addImageLayers([
					{
						id: "brush-scope-overlay",
						name: "Brush scope overlay",
						imageId: "brush-scope-overlay.png",
						imageName: "brush-scope-overlay.png",
						originalName: "brush-scope-overlay.png",
						x: 600,
						y: 760,
						w: 320,
						h: 220,
						rotation: 0,
						opacity: 1,
						visible: true,
						locked: false,
						index: 0,
						role: "overlay",
						fill: "#0ea5e9",
					},
				]);
				window.__mangaEditorDebug!.selectImageLayer("brush-scope-overlay");
				window.__mangaEditorDebug!.setBrushSize(140);
				window.__mangaEditorDebug!.setTool("brush");
			});

			const sample = { x: 690, y: 830 };
			await dragImageSelection(page, sample, { x: 770, y: 880 });
			await expect.poll(async () => {
				const state = await getEditorState(page);
				return state.imageLayers.find((item: { id: string }) => item.id === "brush-scope-overlay")?.imageId;
			}).toBe(persistedLayerImageId);
			expect(uploadCount).toBe(2);
			await expect.poll(async () => page.evaluate(() => window.__mangaEditorDebug!.getBrushCommitErrorMessage?.() ?? null)).toContain("ส่งคำขอถี่");

			await page.getByRole("button", { name: /บันทึก/ }).first().click();
			await expect(editorStatus(page)).toContainText("บันทึกไม่สำเร็จ");
			expect(saveCount).toBe(0);

			const metrics = await page.evaluate(() => {
				const visibleControls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea"))
					.filter((element) => {
						const rect = element.getBoundingClientRect();
						const style = window.getComputedStyle(element);
						return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
					});
				return {
					overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
					bodyOverflowX: Math.max(0, document.body.scrollWidth - window.innerWidth),
					under36: visibleControls
						.map((element) => {
							const rect = element.getBoundingClientRect();
							return {
								label: element.getAttribute("aria-label") || element.textContent?.trim() || element.id,
								width: Math.round(rect.width),
								height: Math.round(rect.height),
							};
						})
						.filter((item) => item.width < 36 || item.height < 36),
				};
			});
			expect(metrics.overflowX).toBe(0);
			expect(metrics.bodyOverflowX).toBe(0);
			expect(metrics.under36).toEqual([]);

			await mkdir("../.codex-dev-logs/visual-checks/flow442-brush-error-scope", { recursive: true });
			await page.screenshot({
				path: `../.codex-dev-logs/visual-checks/flow442-brush-error-scope/${test.info().project.name}-scoped-brush-error.png`,
				fullPage: false,
			});
		});

		test("AI brush panel identifies the selected image layer target", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Selected brush target UX is covered on desktop.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "brush-target-panel-overlay",
					name: "Panel target overlay",
					imageId: "brush-target-panel-overlay.png",
					imageName: "brush-target-panel-overlay.png",
					originalName: "brush-target-panel-overlay.png",
					x: 600,
					y: 760,
					w: 320,
					h: 220,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("brush-target-panel-overlay");
			window.__mangaEditorDebug!.setTool("brush");
		});

		await openRightPanel(page, "AI");
		const target = page.locator(".brush-target-card");
		if (!await target.count()) {
			await page.getByRole("button", { name: /แปรง Clean/ }).click();
		}
		await expect(target).toContainText("เลเยอร์รูปแก้ไข");
		await expect(target).toContainText("Panel target overlay");
		await expect(target).toContainText("เส้นแปรงจะลบเฉพาะเนื้อภาพของเลเยอร์นี้");
		await expect(page.getByRole("button", { name: "คืนผล AI เต็ม" })).toHaveCount(0);

		await mkdir("../.codex-dev-logs/visual-checks/flow392-brush-target-feedback", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow392-brush-target-feedback/desktop-brush-target-panel.png",
			fullPage: false,
		});
	});

	test("brush cleanup works on the p104 real manga page", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Real p104 brush proof is covered on desktop.");

		const loaded = await loadP104RealImage(page);
		const imageWidth = loaded.image.width || 1024;
		const imageHeight = loaded.image.height || 1024;
		const layerX = Math.round(imageWidth * 0.36);
		const layerY = Math.round(imageHeight * 0.24);
		const layerW = Math.round(imageWidth * 0.22);
		const layerH = Math.round(imageHeight * 0.1);
		const sample = { x: layerX + Math.round(layerW * 0.35), y: layerY + Math.round(layerH * 0.45) };

		await page.evaluate(async ({ x, y, w, h }) => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "p104-brush-overlay",
					name: "P104 clean overlay",
					imageId: "p104-brush-overlay.png",
					imageName: "p104-brush-overlay.png",
					originalName: "p104-brush-overlay.png",
					x,
					y,
					w,
					h,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("p104-brush-overlay");
			window.__mangaEditorDebug!.setTool("brush");
		}, { x: layerX, y: layerY, w: layerW, h: layerH });

		await dragImageSelection(page, sample, { x: sample.x + Math.round(layerW * 0.28), y: sample.y });
		await page.waitForTimeout(300);

		const state = await getEditorState(page);
		const erasedPixel = await page.evaluate((point) => window.__mangaEditorDebug!.sampleImageLayerPixel("p104-brush-overlay", point), sample);
		expect(state.brush.lastTargetKind).toBe("image-layer");
		expect(erasedPixel?.[3]).toBeLessThan(32);
		expect(state.image.item?.left).toBeCloseTo(loaded.image.item!.left, 3);
		expect(state.image.item?.top).toBeCloseTo(loaded.image.item!.top, 3);

		await mkdir("../.codex-dev-logs/visual-checks/flow394-p104-brush-presets", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow394-p104-brush-presets/desktop-p104-brush-cleanup.png",
			fullPage: false,
		});
	});

	test("brush erases and restores a real p104 selected image layer", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Real p104 selected image-layer brush proof is covered on desktop/tablet.");
		test.skip(!existsSync(P104_REAL_IMAGE_PATH), `p104 selected image layer not found at ${P104_REAL_IMAGE_PATH}`);

		await loadEditorTestImage(page);
		const imageBuffer = await readFile(P104_REAL_IMAGE_PATH);
		const imageUrl = `data:image/webp;base64,${imageBuffer.toString("base64")}`;
		const layerInfo = await page.evaluate(async (url) => {
			const image = new Image();
			image.src = url;
			await image.decode();
			const width = 540;
			const height = Math.max(1, Math.round(width * (image.naturalHeight / Math.max(1, image.naturalWidth))));
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "p104-real-layer-brush",
					name: "P104 real selected layer",
					imageId: "p104-real-layer-brush.webp",
					imageName: "p104-real-layer-brush.webp",
					originalName: "p104-real-layer-brush.webp",
					x: 520,
					y: 620,
					w: width,
					h: height,
					sourceW: image.naturalWidth,
					sourceH: image.naturalHeight,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					imageUrl: url,
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("p104-real-layer-brush");
			window.__mangaEditorDebug!.setBrushSize(52);
			window.__mangaEditorDebug!.setTool("brush");
			return { sourceW: image.naturalWidth, sourceH: image.naturalHeight, width, height };
		}, imageUrl);
		await expect.poll(async () => (await getEditorState(page)).brush.selectedImageLayerId).toBe("p104-real-layer-brush");

		const sourcePoint = {
			x: Math.round(layerInfo.sourceW * 0.46),
			y: Math.round(layerInfo.sourceH * 0.42),
		};
		const beforePixel = await page.evaluate((point) => (
			window.__mangaEditorDebug!.sampleImageLayerSourcePixel("p104-real-layer-brush", point)
		), sourcePoint);
		expect(beforePixel?.[3]).toBeGreaterThan(220);

		const clientPoint = await page.evaluate((point) => (
			window.__mangaEditorDebug!.imageLayerSourcePointToClient("p104-real-layer-brush", point)
		), sourcePoint);
		if (!clientPoint) throw new Error("Could not map p104 selected image source point");

		await page.mouse.move(clientPoint.x, clientPoint.y);
		await expect.poll(async () => (await getEditorState(page)).brush.preview?.visible ?? false).toBe(true);
		await page.mouse.down();
		await page.mouse.move(clientPoint.x + 10, clientPoint.y + 4, { steps: 4 });
		await page.mouse.up();
		await page.waitForTimeout(300);

		const erasedState = await getEditorState(page);
		const erasedPixel = await page.evaluate((point) => (
			window.__mangaEditorDebug!.sampleImageLayerSourcePixel("p104-real-layer-brush", point)
		), sourcePoint);
		expect(erasedState.brush.lastTargetKind).toBe("image-layer");
		expect(erasedPixel?.[3]).toBeLessThan(32);

		await page.evaluate(() => window.__mangaEditorDebug!.setBrushMode("restore"));
		await page.mouse.move(clientPoint.x, clientPoint.y);
		await page.mouse.down();
		await page.mouse.move(clientPoint.x + 10, clientPoint.y + 4, { steps: 4 });
		await page.mouse.up();
		await page.waitForTimeout(300);

		const restoredState = await getEditorState(page);
		const restoredPixel = await page.evaluate((point) => (
			window.__mangaEditorDebug!.sampleImageLayerSourcePixel("p104-real-layer-brush", point)
		), sourcePoint);
		const layer = restoredState.imageLayers.find((item: { id: string }) => item.id === "p104-real-layer-brush");
		expect(restoredState.brush.mode).toBe("restore");
		expect(restoredState.brush.lastTargetKind).toBe("image-layer");
		expect(layer?.restoreImageId).toBe("p104-real-layer-brush.webp");
		expect(restoredPixel).toEqual(beforePixel);

		await mkdir("../.codex-dev-logs/visual-checks/flow622-p104-real-selected-layer-brush", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow622-p104-real-selected-layer-brush/desktop-p104-selected-layer-brush.png",
			fullPage: false,
		});
	});

	test("credit image import repeats on a long p104 page", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Real p104 credit repeat proof is covered on desktop/tablet.");
		test.skip(!existsSync(P104_REAL_IMAGE_PATH), `p104 credit image not found at ${P104_REAL_IMAGE_PATH}`);

		await page.goto("/projects/flow208-project/pages/1/editor");
		await page.waitForFunction(() => Boolean(window.__mangaEditorDebug));
		await page.waitForFunction(() => (window.__mangaEditorDebug?.getState().image.height ?? 0) > 0);
		const longImageBuffer = await readFile(P104_LONG_IMAGE_PATH);
		await page.evaluate((url) => window.__mangaEditorDebug!.loadImageUrl(url), `data:image/webp;base64,${longImageBuffer.toString("base64")}`);
		await expect.poll(async () => (await getEditorState(page)).image.height).toBe(15000);

		await openLayerSection(page, "เครดิต");
		await page.locator(".credit-advanced-details").first().evaluate((node) => {
			(node as HTMLDetailsElement).open = true;
		});
		await page.getByLabel("เลือกขอบเขตเครดิต", { exact: true }).selectOption("current");
		await page.getByLabel("รูปเครดิตกว้างสุด").fill("160");
		await page.getByLabel("เครดิตซ้ำทุก px").fill("3000");
		await page.locator("#credit-text").fill("Translator: Long Page Team");
		await page.getByRole("button", { name: "สร้างเครดิตข้อความ" }).click();
		await page.waitForFunction(() => {
			const state = window.__mangaEditorDebug?.getState();
			return (state?.textLayers ?? []).filter((layer) => layer.sourceCategory === "credit").length >= 5;
		});
		const chooserPromise = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "นำเข้ารูปเครดิต" }).click();
		const chooser = await chooserPromise;
		await chooser.setFiles(P104_REAL_IMAGE_PATH);
		await page.waitForFunction(() => {
			const state = window.__mangaEditorDebug?.getState();
			return (state?.imageLayers ?? []).filter((layer) => layer.role === "credit").length >= 5;
		});

		const proof = await page.evaluate(() => {
			const state = window.__mangaEditorDebug!.getState();
			const credits = state.imageLayers.filter((layer) => layer.role === "credit");
			const textCredits = state.textLayers.filter((layer) => layer.sourceCategory === "credit");
			const ys = credits.map((layer) => Math.round(layer.y)).sort((a, b) => a - b);
			const textYs = textCredits.map((layer) => Math.round(layer.y)).sort((a, b) => a - b);
			return {
				imageHeight: state.image.height,
				count: credits.length,
				textCount: textCredits.length,
				widths: credits.map((layer) => Math.round(layer.w)),
				imageNames: credits.map((layer) => layer.name),
				ys,
				textNames: textCredits.map((layer) => layer.name),
				textYs,
				spacings: ys.slice(1).map((y, index) => y - ys[index]),
				textSpacings: textYs.slice(1).map((y, index) => y - textYs[index]),
				selectedIsCredit: credits.some((layer) => layer.id === state.activeLayerId),
			};
		});

		expect(proof.imageHeight).toBe(15000);
		expect(proof.count).toBe(5);
		expect(proof.textCount).toBe(5);
		expect(proof.widths.every((width) => width === 160)).toBe(true);
		expect(proof.ys).toEqual([24, 3024, 6024, 9024, 12024]);
		expect(proof.imageNames).toEqual([
			"รูปเครดิต 1/5",
			"รูปเครดิต 2/5",
			"รูปเครดิต 3/5",
			"รูปเครดิต 4/5",
			"รูปเครดิต 5/5",
		]);
		expect(proof.textYs).toEqual([24, 3024, 6024, 9024, 12024]);
		expect(proof.textNames).toEqual([
			"เครดิตข้อความ 1/5",
			"เครดิตข้อความ 2/5",
			"เครดิตข้อความ 3/5",
			"เครดิตข้อความ 4/5",
			"เครดิตข้อความ 5/5",
		]);
		expect(proof.spacings).toEqual([3000, 3000, 3000, 3000]);
		expect(proof.textSpacings).toEqual([3000, 3000, 3000, 3000]);
		expect(proof.selectedIsCredit).toBe(true);

		const layerStack = page.getByRole("region", { name: "ลำดับเลเยอร์จริงบนหน้านี้" });
		await layerStack.scrollIntoViewIfNeeded();
		await page.locator(".unified-stack-summary").click();
		await expect(layerStack.getByRole("button", { name: "เครดิต 10" })).toBeVisible();
		await expect(layerStack.getByRole("button", { name: "ข้อความ 0" })).toBeVisible();
		await expect(layerStack.getByRole("button", { name: "รูป 0" })).toBeVisible();
		await layerStack.getByRole("button", { name: "เครดิต 10" }).click();
		await expect(layerStack).toContainText("แสดง 10/10 เลเยอร์");
		await expect(layerStack).toContainText("รูปเครดิต 5/5");
		await expect(layerStack).toContainText("เครดิตข้อความ 5/5");
		await layerStack.getByRole("button", { name: "ข้อความ 0" }).click();
		await expect(layerStack).toContainText("ไม่มีเลเยอร์ในตัวกรองนี้");

		await mkdir("../.codex-dev-logs/visual-checks/flow484-credit-image-import", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow484-credit-image-import/e2e-credit-repeat-p104.png",
			fullPage: false,
		});
	});

	test("image-layer recovery asks for a layer relink without replacing the page image", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Layer recovery overlay proof is covered on desktop.");

		await waitForDebug(page);
		await page.evaluate(async () => {
			await window.__mangaWorkflowDebug!.seedProject();
			window.__mangaWorkflowDebug!.markImageLayerAssetRecoveryError(0, 2);
		});
		await openEditorView(page);

		await expect(page.getByText("รูปเสริมหาย")).toBeVisible();
		await expect(page.getByText(/รูปหน้าหลักยังเปิดได้อยู่/)).toBeVisible();
		await expect(page.getByRole("button", { name: "Relink รูปเสริมนี้" })).toBeVisible();
		await expect(page.getByText("ยังมีรูปที่ต้องกู้ 2 รายการในหน้านี้")).toBeVisible();
		await expect(page.locator(".asset-error-issue-row").filter({ hasText: "Logo overlay" })).toBeVisible();
		await expect(page.locator(".asset-error-issue-row").filter({ hasText: "Credit overlay 2" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Relink เลเยอร์นี้" })).toHaveCount(2);
		await expect(page.getByRole("button", { name: "Relink รูปที่ชื่อตรงกัน" })).toHaveCount(0);

		await mkdir("../.codex-dev-logs/visual-checks/flow401-multi-layer-recovery", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow401-multi-layer-recovery/desktop-multi-layer-recovery-overlay.png",
			fullPage: false,
		});
	});

	test("project switch stays on the current project when pre-switch save fails", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Project switch recovery proof is covered on desktop.");

		const currentId = "11111111-1111-4111-8111-111111111111";
		const nextId = "22222222-2222-4222-8222-222222222222";
		const baseProject = {
			projectId: currentId,
			name: "Current Dirty Chapter",
			createdAt: "2026-05-19T00:00:00.000Z",
			currentPage: 0,
			targetLang: "th",
			pages: [{
				imageId: "current-image.webp",
				imageName: "current-image.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}],
			tasks: [],
			activityLog: [],
			comments: [],
			aiReviewMarkers: [],
			reviewDecisions: [],
			workspaceMessages: [],
		};
		let requestedNextProject = false;

		await page.route(`**/api/project/${currentId}`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(baseProject),
			});
		});
		await page.route(`**/api/project/${currentId}/save`, async (route) => {
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: "disk is full" }),
			});
		});
		await page.route(`**/api/project/${nextId}`, async (route) => {
			requestedNextProject = true;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ...baseProject, projectId: nextId, name: "Next Chapter" }),
			});
		});

		await waitForDebug(page);
		await page.evaluate(async ({ currentId, nextId }) => {
			await window.__mangaWorkflowDebug!.exerciseProjectSwitchSaveFailure(currentId, nextId);
		}, { currentId, nextId });

		const state = await page.evaluate(() => window.__mangaWorkflowDebug!.getState());

		expect(requestedNextProject).toBe(false);
		expect(state.projectId).toBe(currentId);
		expect(state.saveSyncStatus).toBe("error");
		expect(state.saveErrorKind).toBe("generic");
		expect(state.statusMsg).toBe("งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะบันทึกงานเดิมไม่สำเร็จ (disk is full) กดลองบันทึกอีกครั้งก่อน");
		await expect(page.getByLabel("กู้การบันทึกก่อนเปิดงานใหม่")).toContainText("ยังไม่ได้เปิดงานใหม่");
		await expect(page.getByLabel("กู้การบันทึกก่อนเปิดงานใหม่")).toContainText("งานเดิมยังปลอดภัย");

		await mkdir("../.codex-dev-logs/visual-checks/flow402-project-switch-save-guard", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow402-project-switch-save-guard/desktop-project-switch-save-failed.png",
			fullPage: false,
		});
	});

	test("background AI completion does not steal the selected review focus", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "AI completion focus proof is covered on desktop.");

		await waitForDebug(page);
		const state = await page.evaluate(async () => {
			await window.__mangaWorkflowDebug!.seedProject();
			return window.__mangaWorkflowDebug!.exerciseAiResultCompletionFocusRetention();
		});

		expect(state.selectedMarkerId).toBe("flow403-active-ai-marker");
		expect(state.completedMarkerId).toBe("flow403-completed-ai-marker");
		expect(state.selectedMarkerId).not.toBe(state.completedMarkerId);
		const focusCard = page.locator(".ai-marker-focus-card");
		await expect(focusCard).toContainText("Clean Pro");
		await expect(focusCard).not.toContainText("SFX Pro");
		const completedResultButton = page.getByRole("button", { name: /เปิดผล AI P1 SFX Pro.*ผลพร้อม/ }).first();
		await expect(completedResultButton).toBeVisible();
		await expect(completedResultButton).toHaveAttribute("aria-label", /ผลพร้อม/);
		await expect(completedResultButton).toContainText(/ดู/);

		await mkdir("../.codex-dev-logs/visual-checks/flow404-ai-result-identity", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow404-ai-result-identity/desktop-ai-result-identity.png",
			fullPage: false,
		});

		const beforeJumpTransform = await page.evaluate(() => window.__mangaEditorDebug!.getState().canvas.viewportTransform.join(","));
		await completedResultButton.click();
		await expect(focusCard).toContainText("SFX Pro");
		const jumpState = await page.evaluate(() => {
			const state = window.__mangaEditorDebug!.getState();
			return {
				transform: state.canvas.viewportTransform.join(","),
				rect: state.canvas.rect,
				zoom: state.canvas.zoom,
			};
		});
		const regionCenterClient = await imagePointToClient(page, { x: 550, y: 430 });
		expect(jumpState.transform).not.toBe(beforeJumpTransform);
		expect(jumpState.zoom).toBeGreaterThanOrEqual(1.25);
		expect(jumpState.rect).not.toBeNull();
		expect(regionCenterClient.x).toBeGreaterThan(jumpState.rect!.left);
		expect(regionCenterClient.x).toBeLessThan(jumpState.rect!.left + jumpState.rect!.width);
		expect(regionCenterClient.y).toBeGreaterThan(jumpState.rect!.top);
		expect(regionCenterClient.y).toBeLessThan(jumpState.rect!.top + jumpState.rect!.height);

		await mkdir("../.codex-dev-logs/visual-checks/flow405-ai-review-region-jump", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow405-ai-review-region-jump/desktop-ai-region-jump.png",
			fullPage: false,
		});

		await focusCard.getByRole("button", { name: "ยืนยันผลผ่าน" }).click();
		await expect(focusCard).toContainText("ผ่านตรวจ");
		await focusCard.getByRole("button", { name: "วางเลเยอร์ AI" }).click();
		await page.waitForFunction(() =>
			window.__mangaEditorDebug!.getState().activeLayerId === "ai-result-flow403-completed-ai-marker"
		);
		const appliedMarkerButton = page.getByRole("button", {
			name: /เปิดผล AI P1 SFX Pro วางแล้ว/,
		}).first();
		await expect(appliedMarkerButton).toBeVisible();
		await expect(appliedMarkerButton).toHaveAttribute("aria-label", /วางแล้ว/);
		await appliedMarkerButton.click();
		await page.waitForFunction(() =>
			window.__mangaEditorDebug!.getState().activeLayerId === "ai-result-flow403-completed-ai-marker"
		);

		await mkdir("../.codex-dev-logs/visual-checks/flow406-ai-applied-layer-jump", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow406-ai-applied-layer-jump/desktop-ai-applied-layer-jump.png",
			fullPage: false,
		});
	});

	test("brush no-target state can promote a ready AI result into an editable layer", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Brush ready-result action is covered on desktop/tablet.");

		await waitForDebug(page);
		await page.evaluate(async () => {
			await window.__mangaWorkflowDebug!.seedProject();
		});
		await openEditorView(page);
		await page.getByRole("button", { name: "แปรง", exact: true }).click();
		await expect(page.getByText("AI แปล SFX")).toBeVisible();
		const canvasBrushTargetHud = page.getByRole("status", { name: "เป้าหมายแปรง", exact: true });
		await expect(canvasBrushTargetHud).toContainText("แปรงล็อก");
		await expect(canvasBrushTargetHud).toContainText("เลือกเลเยอร์รูปหรือผล AI");
		await expect(page.locator(".brush-clean-hud")).toHaveCount(0);

			await expect(page.getByText("ผล AI หน้า 1 พร้อมวางเป็นเลเยอร์แก้")).toBeVisible();
			const useResultButton = page.getByRole("button", { name: "วางเลเยอร์ AI" }).first();
			await expect(useResultButton).toBeVisible();
			await expect(page.getByRole("button", { name: "วางเลเยอร์ AI" })).toHaveCount(1);
			await expect(page.getByRole("button", { name: "เพิ่มรูปแก้" })).toHaveCount(1);
			await expect(page.getByRole("button", { name: "เปิดแผงเลเยอร์" })).toHaveCount(1);
			const noTargetMetrics = await page.evaluate(() => {
				const textBlocks = Array.from(document.querySelectorAll<HTMLElement>(".brush-command-copy, .brush-target-copy, .brush-target-note"))
					.map((element) => {
						const rect = element.getBoundingClientRect();
						return {
							text: element.textContent?.trim().replace(/\s+/g, " ") ?? "",
							width: Math.round(rect.width),
							height: Math.round(rect.height),
						};
					});
				return {
					narrowTallText: textBlocks.filter((item) => item.text.length > 12 && item.width < 80 && item.height > 80),
				};
			});
			expect(noTargetMetrics.narrowTallText).toEqual([]);

			const before = await getEditorState(page);
			expect(before.imageLayers).toHaveLength(0);

		await useResultButton.click();
		await page.waitForFunction(() => {
			const state = window.__mangaEditorDebug!.getState();
			return state.activeLayerId === "ai-result-flow208-ai-marker-p1"
				&& state.imageLayers.some((layer: any) => layer.imageId === "flow208-ai-result-p1");
		});

		const after = await getEditorState(page);
		const markerState = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.aiReviewMarkers?.[0]?.status ?? null);
		expect(after.activeLayerId).toBe("ai-result-flow208-ai-marker-p1");
		expect(after.imageLayers.some((layer: any) => layer.imageId === "flow208-ai-result-p1")).toBe(true);
		expect(markerState).toBe("needs_review");
		expect(after.imageLayerStyles.find((style: any) => style.layerData?.id === "ai-result-flow208-ai-marker-p1")?.hasControls).toBe(false);
		expect(after.imageLayerStyles.find((style: any) => style.layerData?.id === "ai-result-flow208-ai-marker-p1")?.hasBorders).toBe(false);
			await expect(editorStatus(page)).toContainText("พร้อมใช้แปรงกับผล AI หน้า 1");
			await expect(editorStatus(page)).not.toContainText("AI result P1");
			await expect(page.locator("#ai-brush-controls").getByText("ผล AI ที่วางแล้ว")).toBeVisible();
		await expect(page.locator("#ai-brush-controls").getByRole("button", { name: "ลบจากผล AI" })).toBeVisible();
			await expect(page.getByRole("button", { name: "วางเลเยอร์ AI" })).toHaveCount(0);

		const restoredHandles = await page.evaluate(() => {
			window.__mangaEditorDebug!.setTool("select");
			const state = window.__mangaEditorDebug!.getState();
			return state.imageLayerStyles.find((style: any) => style.layerData?.id === "ai-result-flow208-ai-marker-p1");
		});
		expect(restoredHandles?.hasControls).toBe(true);
		expect(restoredHandles?.hasBorders).toBe(true);
		const brushHandles = await page.evaluate(() => {
			window.__mangaEditorDebug!.setTool("brush");
			const state = window.__mangaEditorDebug!.getState();
			return state.imageLayerStyles.find((style: any) => style.layerData?.id === "ai-result-flow208-ai-marker-p1");
		});
		expect(brushHandles?.hasControls).toBe(false);
		expect(brushHandles?.hasBorders).toBe(false);

		const metrics = await page.evaluate(() => {
			const visibleControls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea"))
				.filter((element) => {
					const rect = element.getBoundingClientRect();
					const style = window.getComputedStyle(element);
					return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
				});
			return {
				overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
				bodyOverflowX: Math.max(0, document.body.scrollWidth - window.innerWidth),
				under36: visibleControls
					.map((element) => {
						const rect = element.getBoundingClientRect();
						return {
							label: element.getAttribute("aria-label") || element.textContent?.trim() || element.id,
							width: Math.round(rect.width),
							height: Math.round(rect.height),
						};
					})
					.filter((item) => item.width < 36 || item.height < 36),
			};
		});
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under36).toEqual([]);

		await mkdir("../.codex-dev-logs/visual-checks/flow439-brush-ready-ai-layer", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow439-brush-ready-ai-layer/${test.info().project.name}-after-use-ai-result-layer.png`,
			fullPage: false,
		});
	});

	test("brush preview follows the image and scales with brush size", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Brush hover geometry is covered on desktop; mobile keeps viewport smoke coverage.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.setAiOverlayTestImage({
				width: 1600,
				height: 2400,
				fill: "#c1121f",
				label: "AI OVERLAY",
			});
			window.__mangaEditorDebug!.setLegacyAiMaskBrushEnabled(true);
			window.__mangaEditorDebug!.setTool("brush");
		});

		const brushPoint = await imagePointToClient(page, { x: 800, y: 1250 });
		await page.mouse.move(brushPoint.x, brushPoint.y);

		let state = await getEditorState(page);
		expect(state.brush.preview?.visible).toBe(true);
		expect(state.brush.preview?.radius).toBeGreaterThan(0);
		expect(state.brush.preview?.left).toBeCloseTo(
			state.image.bounds.left + state.image.bounds.width / 2,
			1,
		);

		const smallRadius = state.brush.preview!.radius;
		await page.evaluate(() => window.__mangaEditorDebug!.setBrushSize(90));
		await page.mouse.move(brushPoint.x + 2, brushPoint.y + 2);

		state = await getEditorState(page);
		expect(state.brush.size).toBe(90);
		expect(state.brush.preview?.visible).toBe(true);
		expect(state.brush.preview!.radius).toBeGreaterThan(smallRadius);

		await page.evaluate(() => window.__mangaEditorDebug!.setTool("select"));
		state = await getEditorState(page);
		expect(state.brush.preview?.visible).toBe(false);
	});

	test("workspace canvas fills the editor viewport without shrinking to the image", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Mobile editor layout is not the right-panel canvas geometry target yet.");

		await loadEditorTestImage(page);
		const state = await getEditorState(page);

		expect(state.canvas.upper?.width).toBeGreaterThan(300);
		expect(state.canvas.upper?.height).toBeGreaterThan(300);
		expect(state.canvas.upper?.width).toBe(state.canvas.lower?.width);
		expect(state.canvas.upper?.height).toBe(state.canvas.lower?.height);
		expect(state.image.bounds.width).toBeLessThanOrEqual(state.canvas.width);
		expect(state.image.bounds.height).toBeLessThanOrEqual(state.canvas.height);
		expect(state.canvas.width).toBeGreaterThan(state.image.bounds.width);
	});

	test("fits very tall webtoon pages by readable width instead of shrinking the full page", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Mobile keeps editor smoke coverage; webtoon fit geometry is covered on desktop/tablet.");

		await waitForDebug(page);
		await openEditorView(page);
		await page.evaluate(() => window.__mangaEditorDebug!.loadTestImage({
			width: 800,
			height: 13_855,
			fill: "#39d353",
			label: "WEBTOON FIT",
		}));

		const state = await getEditorState(page);

		expect(state.canvas.upper?.width).toBe(state.canvas.lower?.width);
		expect(state.canvas.upper?.height).toBe(state.canvas.lower?.height);
		expect(state.image.bounds.width).toBeCloseTo(state.canvas.width, 1);
		expect(state.image.bounds.height).toBeGreaterThan(state.canvas.height * 8);
		expect(state.image.bounds.top).toBeCloseTo(0, 1);
		expect(state.image.bounds.left).toBeCloseTo(0, 1);
	});

	test("pinch zoom expands the editor viewport around the touch midpoint", async ({ page }) => {
		await loadEditorTestImage(page);
		const before = await getEditorState(page);

		await page.evaluate(() => {
			const canvas = document.querySelector("canvas.upper-canvas") as HTMLCanvasElement | null;
			if (!canvas) throw new Error("Fabric upper canvas is not mounted");
			const rect = canvas.getBoundingClientRect();
			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;
			const fire = (type: string, pointerId: number, x: number, y: number) => {
				canvas.dispatchEvent(new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId,
					pointerType: "touch",
					clientX: x,
					clientY: y,
					buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
					isPrimary: pointerId === 1,
				}));
			};

			fire("pointerdown", 1, centerX - 40, centerY);
			fire("pointerdown", 2, centerX + 40, centerY);
			fire("pointermove", 1, centerX - 120, centerY);
			fire("pointermove", 2, centerX + 120, centerY);
			fire("pointerup", 1, centerX - 120, centerY);
			fire("pointerup", 2, centerX + 120, centerY);
		});

		const after = await getEditorState(page);
		expect(after.canvas.zoom).toBeGreaterThan(before.canvas.zoom * 1.8);
		expect(after.canvas.upper?.width).toBe(before.canvas.upper?.width);
		expect(after.canvas.upper?.height).toBe(before.canvas.upper?.height);
		expect(after.image.bounds.width).toBe(before.image.bounds.width);
		expect(after.image.bounds.height).toBe(before.image.bounds.height);
	});

	test("keeps the image visibly rendered after extreme zoom", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "High-zoom visible-pixel regression is covered on desktop canvas.");

		await waitForDebug(page);
		await openEditorView(page);
		await page.evaluate(() => window.__mangaEditorDebug!.loadTestImage({
			width: 1600,
			height: 5200,
			fill: "#39d353",
			label: "HIGH ZOOM",
		}));
		const before = await getEditorState(page);

		await page.evaluate(() => {
			const state = window.__mangaEditorDebug!.getState();
			window.__mangaEditorDebug!.zoomAtCanvasPoint({
				x: state.canvas.width / 2,
				y: state.canvas.height / 2,
			}, 20);
		});
		await page.waitForTimeout(100);

		const visibleGreenPixels = await page.evaluate(() => {
			const canvas = document.querySelector("canvas.lower-canvas") as HTMLCanvasElement | null;
			if (!canvas) throw new Error("Fabric lower canvas is not mounted");
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Fabric lower canvas has no 2D context");
			const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
			let greenPixels = 0;
			for (let index = 0; index < data.length; index += 4) {
				const r = data[index];
				const g = data[index + 1];
				const b = data[index + 2];
				const a = data[index + 3];
				if (a > 200 && r < 100 && g > 150 && b < 120) greenPixels += 1;
			}
			return greenPixels;
		});
		const after = await getEditorState(page);

		expect(after.canvas.zoom).toBeGreaterThanOrEqual(19.9);
		expect(after.canvas.skipOffscreen).toBe(false);
		expect(after.canvas.upper?.width).toBe(before.canvas.upper?.width);
		expect(after.canvas.upper?.height).toBe(before.canvas.upper?.height);
		expect(after.image.bounds.width).toBe(before.image.bounds.width);
		expect(after.image.bounds.height).toBe(before.image.bounds.height);
		expect(visibleGreenPixels).toBeGreaterThan(20_000);
	});

	test("keeps tall pages reachable when wheel panning is followed by extreme zoom", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Wheel pan and high-zoom pixel coverage are covered on desktop and tablet canvas.");

		await waitForDebug(page);
		await openEditorView(page);
		await page.evaluate(() => window.__mangaEditorDebug!.loadTestImage({
			width: 1600,
			height: 5200,
			fill: "#39d353",
			label: "PAN ZOOM",
		}));

		await page.evaluate(() => {
			const upperCanvas = document.querySelector("canvas.upper-canvas") as HTMLCanvasElement | null;
			if (!upperCanvas) throw new Error("Fabric upper canvas is not mounted");
			const rect = upperCanvas.getBoundingClientRect();
			const dispatchWheel = (deltaY: number, altKey = false) => {
				upperCanvas.dispatchEvent(new WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					deltaY,
					altKey,
					clientX: rect.left + rect.width / 2,
					clientY: rect.top + rect.height / 2,
				}));
			};

			dispatchWheel(5000);
			for (let index = 0; index < 80; index += 1) {
				dispatchWheel(-600, true);
			}
		});
		await page.waitForTimeout(100);

		const result = await page.evaluate(() => {
			const canvas = document.querySelector("canvas.lower-canvas") as HTMLCanvasElement | null;
			if (!canvas) throw new Error("Fabric lower canvas is not mounted");
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Fabric lower canvas has no 2D context");
			const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
			let greenPixels = 0;
			for (let index = 0; index < data.length; index += 4) {
				const r = data[index];
				const g = data[index + 1];
				const b = data[index + 2];
				const a = data[index + 3];
				if (a > 200 && r < 100 && g > 150 && b < 120) greenPixels += 1;
			}
			const state = window.__mangaEditorDebug!.getState();
			return {
				greenPixels,
				zoom: state.canvas.zoom,
			};
		});

		expect(result.zoom).toBeGreaterThanOrEqual(19.9);
		expect(result.greenPixels).toBeGreaterThan(20_000);
	});

	test("AI mode selector gates SFX-specific controls", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "AI inspector controls are covered on desktop until mobile editor panels are redesigned.");

		await loadEditorTestImage(page);
		await openRightPanel(page, "AI");

		await expect(page.locator("#ai-tier-select")).toHaveValue("sfx-pro");
		await expect(page.getByLabel("สลับ SFX")).toBeEnabled();
		await expect(page.locator("#ai-tier-select option[value='clean-pro']")).toBeDisabled();
		await expect(page.locator("#ai-tier-select option[value='budget-clean']")).toBeDisabled();
	});

	test("text layers stay in image coordinates and sync with the right inspector", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Mouse text placement geometry is covered on desktop; mobile keeps viewport smoke coverage.");

		await loadEditorTestImage(page);
		const textToolButton = page.getByRole("button", { name: "วางข้อความ", exact: true });
		await page.keyboard.press("t");
		await expect(page.getByText("คลิกบนรูปเพื่อวางข้อความ", { exact: true })).toBeVisible();
		await expect(editorStatus(page)).toContainText("คลิกบนรูปเพื่อวางข้อความ");
		await expect(textToolButton).toHaveClass(/active/);
		await page.keyboard.press("Escape");
		await expect(textToolButton).not.toHaveClass(/active/);
		await textToolButton.click();
		await expect(editorStatus(page)).toContainText("คลิกบนรูปเพื่อวางข้อความ");
		const placementPoint = { x: 860, y: 1120 };
		const placementClient = await imagePointToClient(page, placementPoint);
		await page.mouse.click(placementClient.x, placementClient.y);
		await expect(page.locator("#text-layer-text")).toBeFocused();

		const firstState = await getEditorState(page);
		expect(firstState.textLayers).toHaveLength(1);
		expect(Math.abs(firstState.textLayers[0].x + firstState.textLayers[0].w / 2 - placementPoint.x)).toBeLessThanOrEqual(4);
		expect(Math.abs(firstState.textLayers[0].y + firstState.textLayers[0].h / 2 - placementPoint.y)).toBeLessThanOrEqual(4);
		expect(firstState.textLayerStyles[0].fill).toBe("#111111");
		expect(firstState.textLayerStyles[0].stroke).toBe("#ffffff");
		expect(firstState.textLayerStyles[0].paintFirst).toBe("stroke");
		expect(firstState.textLayerStyles[0].strokeWidth).toBeLessThanOrEqual(1.25);

		await page.locator(".layer-select").first().click();
		await expect(page.locator("#text-layer-text")).toHaveJSProperty("tagName", "TEXTAREA");
		await page.locator("#text-layer-text").fill("Imported line draft\nSecond bubble line");
		await expect.poll(async () => (await getEditorState(page)).textLayers[0].text).toBe("Imported line draft\nSecond bubble line");
		await page.evaluate(() => window.__mangaEditorDebug!.undo());
		await expect.poll(async () => (await getEditorState(page)).textLayers[0].text).toBe(firstState.textLayers[0].text);
		await page.evaluate(() => window.__mangaEditorDebug!.redo());
		await expect.poll(async () => (await getEditorState(page)).textLayers[0].text).toBe("Imported line draft\nSecond bubble line");
		await page.locator("#text-style-preset").selectOption("builtin-sfx-draft");
		const presetState = await getEditorState(page);
		expect(presetState.textLayers[0].fontSize).toBe(42);
		expect(presetState.textLayers[0].fontFamily).toContain("Impact");
		expect(presetState.textLayers[0].strokeWidth).toBeCloseTo(4, 1);

		await page.locator("#text-style-preset").selectOption("builtin-whisper-glow");
		const glowPresetState = await getEditorState(page);
		expect(glowPresetState.textLayers[0].effects.outerGlow).toMatchObject({ enabled: true, opacity: 42 });
		expect(glowPresetState.textLayerStyles[0].shadow).toBeTruthy();

		await page.locator("#text-style-preset").selectOption("builtin-sfx-draft");
		const resetPresetState = await getEditorState(page);
		expect(resetPresetState.textLayers[0].effects).toBeUndefined();
		expect(resetPresetState.textLayerStyles[0].shadow).toBeNull();

		await page.locator("#text-layer-fill").fill("#c1121f");
		await expect(page.locator("#text-style-preset")).toHaveValue("");
		await page.getByText("ขอบพื้นฐาน", { exact: true }).click();
		await page.locator("#text-layer-stroke").fill("#ffffff");
		await page.locator("#text-layer-stroke-width").fill("4");

		const editedState = await getEditorState(page);
		expect(editedState.textLayers[0].text).toBe("Imported line draft\nSecond bubble line");
		expect(editedState.textLayers[0].fill).toBe("#c1121f");
		expect(editedState.textLayers[0].stroke).toBe("#ffffff");
		expect(editedState.textLayers[0].strokeWidth).toBeCloseTo(4, 1);
		await expect(page.locator(".layer-row").first()).toContainText("Imported line draft");

		await page.getByTitle("ทำซ้ำกล่องข้อความที่เลือก").click();
		let layerOpsState = await getEditorState(page);
		expect(layerOpsState.textLayers).toHaveLength(2);
		expect(layerOpsState.textLayers[1].text).toContain("copy");
		expect(layerOpsState.textLayers.map((layer: any) => layer.index)).toEqual([0, 1]);

		await page.getByTitle("ซ่อนกล่องข้อความ").last().click();
		layerOpsState = await getEditorState(page);
		expect(layerOpsState.textLayers[1].visible).toBe(false);
		expect(layerOpsState.textLayerStyles[1].visible).toBe(false);
		expect(layerOpsState.textLayerStyles[1].selectable).toBe(false);

		await page.getByTitle("แสดงกล่องข้อความ").last().click();
		await page.getByTitle("ล็อกกล่องข้อความ").last().click();
		layerOpsState = await getEditorState(page);
		expect(layerOpsState.textLayers[1].locked).toBe(true);
		expect(layerOpsState.textLayerStyles[1].locked).toBe(true);
		expect(layerOpsState.textLayerStyles[1].selectable).toBe(true);

		await page.getByTitle("ลบกล่องข้อความ").first().click();
		layerOpsState = await getEditorState(page);
		expect(layerOpsState.textLayers).toHaveLength(1);
	});

	test("text effects update the selected text layer live", async ({ page }, testInfo: TestInfo) => {
		test.skip(test.info().project.name.includes("mobile"), "Desktop text-effect controls are covered with precise inspector interaction.");

		await loadEditorTestImage(page);
		await page.getByRole("button", { name: "วางข้อความ", exact: true }).click();
		const placementClient = await imagePointToClient(page, { x: 520, y: 700 });
		await page.mouse.click(placementClient.x, placementClient.y);
		await page.locator("#text-layer-text").fill("EFFECT");
		await openRightPanel(page, "เลเยอร์");

		const effectsToggle = page.getByRole("button", { name: /เอฟเฟกต์/ }).first();
		if (await effectsToggle.getAttribute("aria-expanded") !== "true") {
			await effectsToggle.click();
		}
		await page.getByRole("button", { name: /ปรับละเอียด/ }).click();
		await page.getByRole("button", { name: "เปิดขอบตัวอักษร" }).click();
		await page.locator("#effect-stroke-width").fill("6");
		await page.locator("#effect-stroke-color").evaluate((input) => {
			(input as HTMLInputElement).value = "#00ff00";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.getByRole("button", { name: "เรืองแสง" }).click();

		const state = await getEditorState(page);
		expect(state.textLayers[0].effects.stroke).toMatchObject({ enabled: true, color: "#00ff00", width: 6 });
		expect(state.textLayers[0].effects.outerGlow).toMatchObject({ enabled: true });
		expect(state.textLayerStyles[0].stroke).toBe("#00ff00");
		expect(state.textLayers[0].effects.stroke.width).toBe(6);
		expect(state.textLayerStyles[0].strokeWidth).toBeGreaterThan(1);
		expect(state.textLayerStyles[0].shadow).toBeTruthy();
		await expect(page.getByText("ภาพและ Export ใช้ขอบ + แสง + เงาในสแต็กเดียว")).toBeVisible();
		await expect(page.getByText("ตัวอย่างสดบนภาพ / แสงเงาปัจจุบัน: แสง")).toBeVisible();

		await page.getByRole("button", { name: "เงา", exact: true }).click();
		const shadowState = await getEditorState(page);
		const textLayerId = shadowState.textLayers[0].id;
		expect(shadowState.textLayers[0].effects.outerGlow).toMatchObject({ enabled: true });
		expect(shadowState.textLayers[0].effects.dropShadow).toMatchObject({ enabled: true });
		expect(shadowState.textLayerStyles[0].shadow).toBeNull();
		expect(shadowState.textEffectShadowPassStyles).toHaveLength(2);
		expect(shadowState.textEffectShadowPassStyles.map((item: { layerId: string }) => item.layerId)).toEqual([textLayerId, textLayerId]);
		expect(shadowState.objectLayerOrder.filter((item: string) => item === `text-effect:${textLayerId}`)).toHaveLength(2);
		await expect(page.getByText("ภาพและ Export ใช้ขอบ + แสง + เงาในสแต็กเดียว")).toBeVisible();
		await expect(page.getByText("ตัวอย่างสดบนภาพ / แสงเงาปัจจุบัน: แสง + เงา")).toBeVisible();
		await mkdir("../.codex-dev-logs/visual-checks/flow892-text-fx-live-stack", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow892-text-fx-live-stack/${testInfo.project.name}-live-stack.png`,
			fullPage: false,
		});
		await page.evaluate(() => window.__mangaEditorDebug!.undo());
		const undoShadowState = await getEditorState(page);
		expect(undoShadowState.textLayers[0].effects.outerGlow).toMatchObject({ enabled: true });
		expect(undoShadowState.textLayers[0].effects.dropShadow?.enabled ?? false).toBe(false);
		expect(undoShadowState.textEffectShadowPassStyles).toHaveLength(0);
		await page.evaluate(() => window.__mangaEditorDebug!.redo());
		const redoShadowState = await getEditorState(page);
		expect(redoShadowState.textLayers[0].effects.dropShadow).toMatchObject({ enabled: true });
		expect(redoShadowState.textEffectShadowPassStyles).toHaveLength(2);
	});

	test("mood text style presets save and export their rendered effect stack", async ({ page }, testInfo: TestInfo) => {
		test.skip(test.info().project.name.includes("mobile"), "Text style preset persistence/export proof is covered on desktop/tablet.");

		const projectId = "123e4567-e89b-12d3-a456-426614174808";
		let remoteProjectState: any = null;
		let savedState: any = null;

		await page.route(`**/api/project/${projectId}`, async (route) => {
			if (route.request().method() !== "GET") {
				await route.fallback();
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(remoteProjectState),
			});
		});
		await page.route(`**/api/project/${projectId}/save`, async (route) => {
			savedState = JSON.parse(route.request().postData() ?? "null");
			remoteProjectState = structuredClone(savedState);
			await route.fulfill({ status: 204, body: "" });
		});

		await waitForDebug(page);
		await page.evaluate(async (projectId) => window.__mangaWorkflowDebug!.seedProject({ projectId }), projectId);
		remoteProjectState = await page.evaluate(() => JSON.parse(JSON.stringify(window.__mangaWorkflowDebug!.getProjectState())));
		await openRightPanel(page, "เลเยอร์");
		await page.evaluate(() => {
			window.__mangaEditorDebug!.updateTextLayer("flow208-imported-p1", {
				text: "กรี๊ด",
				x: 220,
				y: 360,
				w: 500,
				h: 180,
				fontSize: 56,
				fontFamily: "Tahoma, sans-serif",
				fill: "#111111",
				stroke: "#ffffff",
				strokeWidth: 2,
				effects: undefined,
			});
			window.__mangaEditorDebug!.selectTextLayer("flow208-imported-p1");
		});
		await page.locator("#text-style-preset").selectOption("builtin-sfx-scream-red");
		await page.locator("#effects-section").getByRole("button", { name: /เอฟเฟกต์/ }).click();
		await page.locator("#effects-section").getByRole("button", { name: "ปรับละเอียด" }).click();
		await page.locator("#effect-shape-skew-x").evaluate((input) => {
			const element = input as HTMLInputElement;
			element.value = "-22";
			element.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.locator("#effect-shape-skew-y").evaluate((input) => {
			const element = input as HTMLInputElement;
			element.value = "6";
			element.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await expect.poll(async () => (await getEditorState(page)).textLayers[0]).toMatchObject({
			fill: "#fff1f2",
			stroke: "#450a0a",
			strokeWidth: 10,
			charSpacing: -25,
			skewX: -22,
			skewY: 6,
			effects: {
				dropShadow: expect.objectContaining({
					enabled: true,
					color: "#991b1b",
					offsetX: 9,
					offsetY: 10,
				}),
			},
		});

		await page.evaluate(async () => window.__mangaWorkflowDebug!.saveState());
		expect(savedState?.pages?.[0]?.textLayers?.[0]).toMatchObject({
			id: "flow208-imported-p1",
			text: "กรี๊ด",
			fill: "#fff1f2",
			stroke: "#450a0a",
			strokeWidth: 10,
			charSpacing: -25,
			skewX: -22,
			skewY: 6,
			effects: {
				dropShadow: expect.objectContaining({
					enabled: true,
					color: "#991b1b",
					offsetX: 9,
					offsetY: 10,
				}),
			},
		});

		const exported = await page.evaluate(async () => {
			const dataUrl = await window.__mangaEditorDebug!.exportMergedImageDataUrl();
			const image = new Image();
			image.src = dataUrl;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(image, 0, 0);
			const sample = ctx.getImageData(120, 260, 650, 320).data;
			let deepRedPixels = 0;
			let paleFillPixels = 0;
			for (let i = 0; i < sample.length; i += 4) {
				const r = sample[i];
				const g = sample[i + 1];
				const b = sample[i + 2];
				if (r > 60 && r < 190 && g < 75 && b < 75) deepRedPixels += 1;
				if (r > 235 && g > 205 && g < 250 && b > 205 && b < 250) paleFillPixels += 1;
			}
			return {
				prefix: dataUrl.slice(0, 22),
				width: image.naturalWidth,
				height: image.naturalHeight,
				deepRedPixels,
				paleFillPixels,
			};
		});

		expect(exported.prefix).toBe("data:image/png;base64,");
		expect(exported.width).toBe(900);
		expect(exported.height).toBe(1350);
		expect(exported.deepRedPixels).toBeGreaterThan(80);
		expect(exported.paleFillPixels).toBeGreaterThan(80);

		await mkdir("../.codex-dev-logs/visual-checks/flow867-text-skew-presets", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow867-text-skew-presets/${testInfo.project.name}-scream-skew-preset.png`,
			fullPage: false,
		});
		await writeFile(
			`../.codex-dev-logs/visual-checks/flow867-text-skew-presets/${testInfo.project.name}-metrics.json`,
			JSON.stringify({
				charSpacing: savedState?.pages?.[0]?.textLayers?.[0]?.charSpacing,
				skewX: savedState?.pages?.[0]?.textLayers?.[0]?.skewX,
				skewY: savedState?.pages?.[0]?.textLayers?.[0]?.skewY,
				exported,
			}, null, 2),
		);
	});

	test("keyboard copy paste and duplicate follow the selected text layer", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Desktop keyboard shortcuts are covered in the desktop editor harness.");

		await loadEditorTestImage(page);
		await page.evaluate(() => {
			window.__mangaEditorDebug!.addTextLayers([
				{
					id: "keyboard-copy-source",
					text: "Keyboard copy source",
					x: 320,
					y: 520,
					w: 280,
					h: 80,
					rotation: 0,
					fontSize: 38,
					alignment: "center",
					index: 0,
				},
			]);
		});

		await page.keyboard.press("Control+C");
		await expect(editorStatus(page)).toContainText("คัดลอกชั้นข้อความแล้ว");

		await page.keyboard.press("Control+V");
		await page.waitForFunction(() => window.__mangaEditorDebug!.getState().textLayers.length === 2);
		let state = await getEditorState(page);
		expect(state.textLayers[1].text).toContain("copy");
		expect(state.textLayers[1].x).toBe(state.textLayers[0].x + 24);
		expect(state.textLayers[1].y).toBe(state.textLayers[0].y + 24);

		await page.keyboard.press("Control+V");
		await page.waitForFunction(() => window.__mangaEditorDebug!.getState().textLayers.length === 3);
		state = await getEditorState(page);
		expect(state.textLayers[2].x).toBe(state.textLayers[0].x + 48);
		expect(state.textLayers[2].y).toBe(state.textLayers[0].y + 48);

		await page.keyboard.press("Control+D");
		await page.waitForFunction(() => window.__mangaEditorDebug!.getState().textLayers.length === 4);
		state = await getEditorState(page);
		expect(state.textLayers[3].x).toBe(state.textLayers[0].x + 72);
		expect(state.textLayers[3].y).toBe(state.textLayers[0].y + 72);
	});

	test("keyboard copy paste follows the selected image layer", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Desktop keyboard shortcuts are covered in the desktop editor harness.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "keyboard-image-source",
					imageId: "keyboard-image-source.png",
					imageName: "Reference copy source.png",
					originalName: "Reference copy source.png",
					x: 260,
					y: 420,
					w: 240,
					h: 160,
					rotation: 0,
					opacity: 0.85,
					visible: true,
					locked: false,
					index: 0,
					role: "reference",
					fill: "#2563eb",
				},
			]);
		});
		await page.locator(".image-layer-row .layer-select").first().click();

		await page.keyboard.press("Control+C");
		await expect(editorStatus(page)).toContainText("คัดลอกรูปเสริมแล้ว");

		await page.keyboard.press("Control+V");
		await page.waitForFunction(() => window.__mangaEditorDebug!.getState().imageLayers.length === 2);
		let state = await getEditorState(page);
		expect(state.imageLayers[1].imageName).toBe("Reference copy source.png");
		expect(state.imageLayers[1].x).toBe(state.imageLayers[0].x + 14);
		expect(state.imageLayers[1].y).toBe(state.imageLayers[0].y + 12);
		expect(state.imageLayers[1].opacity).toBeCloseTo(0.85, 2);

		await page.keyboard.press("Control+D");
		await page.waitForFunction(() => window.__mangaEditorDebug!.getState().imageLayers.length === 3);
		state = await getEditorState(page);
		expect(state.imageLayers[2].x).toBe(state.imageLayers[1].x + 14);
		expect(state.imageLayers[2].y).toBe(state.imageLayers[1].y + 12);
	});

	test("selected image quick layout actions update the layer and visible readout", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Selected image transform reset is covered on desktop/tablet.");

		await waitForDebug(page);
		await page.evaluate(async () => {
			await window.__mangaWorkflowDebug!.seedProject();
			window.__mangaWorkflowDebug!.openView("editor");
			await window.__mangaEditorDebug!.loadTestImage({
				width: 1600,
				height: 2400,
				label: "E2E CANVAS",
			});
			const canvas = document.createElement("canvas");
			canvas.width = 2000;
			canvas.height = 1000;
			const ctx = canvas.getContext("2d")!;
			ctx.fillStyle = "#00cc66";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "reset-transform-image",
					name: "Reset transform image",
					imageId: "reset-transform-image.png",
					imageName: "reset-transform-image.png",
					originalName: "reset-transform-image.png",
					x: 30,
					y: 40,
					w: 300,
					h: 300,
					rotation: 17,
					opacity: 0.42,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					flipX: true,
					flipY: true,
					blendMode: "multiply",
					imageUrl: canvas.toDataURL("image/png"),
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("reset-transform-image");
			window.__mangaWorkflowDebug!.openLibraryEntryEditor({
				reason: "แก้รูปเสริมจาก Library",
			});
		});
		await openRightPanel(page, "เลเยอร์");
		const quickLayout = page.getByLabel("จัดวางรูปเสริมที่เลือกแบบเร็ว");
		await expect(quickLayout).toBeVisible();
		await expect(page.getByLabel("ผลจัดวางรูปเสริมที่เลือก")).toContainText("30, 40 / 300 x 300 / หมุน 17°");

		await quickLayout.getByRole("button", { name: "ปรับรูปเสริมให้พอดีหน้า" }).click();
		await expect.poll(async () => page.evaluate(() => (
			window.__mangaEditorDebug!.getState().imageLayers.find((item: { id: string }) => item.id === "reset-transform-image")
		))).toMatchObject({
			x: 0,
			y: 800,
			w: 1600,
			h: 800,
			rotation: 17,
		});
		await expect(page.getByLabel("ผลจัดวางรูปเสริมที่เลือก")).toContainText("0, 800 / 1600 x 800 / หมุน 17°");

		await quickLayout.getByRole("button", { name: "คืนสัดส่วนจริงรูปเสริม" }).click();
		await expect.poll(async () => page.evaluate(() => (
			window.__mangaEditorDebug!.getState().imageLayers.find((item: { id: string }) => item.id === "reset-transform-image")
		))).toMatchObject({
			x: 0,
			y: 800,
			w: 1600,
			h: 800,
			rotation: 17,
		});

		await quickLayout.getByRole("button", { name: "รีเซ็ตตำแหน่งและขนาดรูปเสริม" }).click();

		const layer = await page.evaluate(() => (
			window.__mangaEditorDebug!.getState().imageLayers.find((item: { id: string }) => item.id === "reset-transform-image")
		));
		expect(layer).toMatchObject({
			x: 0,
			y: 800,
			w: 1600,
			h: 800,
			rotation: 0,
			opacity: 1,
			flipX: false,
			flipY: false,
			blendMode: "normal",
		});
		await expect(page.getByLabel("ผลจัดวางรูปเสริมที่เลือก")).toContainText("0, 800 / 1600 x 800 / หมุน 0°");
		await expect(page.getByLabel("ผลจัดวางรูปเสริมที่เลือก")).toContainText("รูปทับซ้อน / ทึบ 100% / ผสมภาพ ปกติ");
	});

	test("selected image opens properties before asset replacement", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Selected image ownership is covered on desktop/tablet.");

		await waitForDebug(page);
		await page.evaluate(async () => {
			await window.__mangaWorkflowDebug!.seedProject();
			window.__mangaWorkflowDebug!.openView("editor");
			await window.__mangaEditorDebug!.loadTestImage({
				width: 1600,
				height: 2400,
				label: "E2E CANVAS",
			});
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "replace-intent-image",
					name: "Replace intent image",
					imageId: "replace-intent-image.png",
					imageName: "replace-intent-image.png",
					originalName: "replace-intent-image.png",
					x: 160,
					y: 240,
					w: 360,
					h: 220,
					rotation: 0,
					opacity: 0.72,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
				},
			]);
			window.__mangaEditorDebug!.selectImageLayer("replace-intent-image");
		});
		await openRightPanel(page, "เลเยอร์");

		await expect(page.getByLabel("โหมดแทนที่รูปในเลเยอร์ที่เลือก")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "คุณสมบัติ เปิดอยู่" })).toBeVisible();
		await expect(page.getByText("ตั้งค่ารูปเสริม")).toBeVisible();
		await expect(page.getByText("replace-intent-image.png").first()).toBeVisible();

		await page.getByText("คลังรูป").click();
		await expect(page.getByLabel("โหมดแทนที่รูปในเลเยอร์ที่เลือก")).toBeVisible();
		await expect(page.getByLabel("โหมดแทนที่รูปในเลเยอร์ที่เลือก")).toContainText("กำลังแทนที่รูปของ Replace intent image");
	});

	test("unified layer stack can move an image layer above text in the real canvas order", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Mixed layer ordering is covered on desktop/tablet.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "mixed-order-image",
					name: "Mixed order image",
					imageId: "mixed-order-image.png",
					imageName: "mixed-order-image.png",
					originalName: "mixed-order-image.png",
					x: 520,
					y: 640,
					w: 320,
					h: 220,
					rotation: 0,
					opacity: 1,
					visible: true,
					locked: false,
					index: 0,
					role: "overlay",
					fill: "#00cc66",
				},
			]);
			window.__mangaEditorDebug!.addTextLayers([
				{
					id: "mixed-order-text",
					text: "TEXT OVERLAY",
					x: 540,
					y: 700,
					w: 280,
					h: 72,
					rotation: 0,
					fontSize: 42,
					fill: "#ff0000",
					stroke: "#ff0000",
					strokeWidth: 0,
					alignment: "center",
					index: 0,
				},
			]);
		});

		let state = await getEditorState(page);
		expect(state.objectLayerOrder.indexOf("image:mixed-order-image")).toBeLessThan(state.objectLayerOrder.indexOf("text:mixed-order-text"));

		await page.evaluate(() => window.__mangaEditorDebug!.moveLayerInStackWithHistory("image", "mixed-order-image", 1));
		state = await getEditorState(page);
		expect(state.objectLayerOrder.indexOf("image:mixed-order-image")).toBeGreaterThan(state.objectLayerOrder.indexOf("text:mixed-order-text"));
		expect(state.imageLayers.find((layer: { id: string }) => layer.id === "mixed-order-image")?.zIndex)
			.toBeGreaterThan(state.textLayers.find((layer: { id: string }) => layer.id === "mixed-order-text")?.zIndex ?? -1);

		await page.evaluate(() => window.__mangaEditorDebug!.undo());
		state = await getEditorState(page);
		expect(state.objectLayerOrder.indexOf("image:mixed-order-image")).toBeLessThan(state.objectLayerOrder.indexOf("text:mixed-order-text"));

		await page.evaluate(() => window.__mangaEditorDebug!.redo());
		state = await getEditorState(page);
		expect(state.objectLayerOrder.indexOf("image:mixed-order-image")).toBeGreaterThan(state.objectLayerOrder.indexOf("text:mixed-order-text"));

		const exported = await page.evaluate(async () => {
			const dataUrl = await window.__mangaEditorDebug!.exportMergedImageDataUrl();
			const image = new Image();
			image.src = dataUrl;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(image, 0, 0);
			const sample = ctx.getImageData(590, 730, 140, 50).data;
			let greenPixels = 0;
			let redPixels = 0;
			for (let i = 0; i < sample.length; i += 4) {
				const r = sample[i];
				const g = sample[i + 1];
				const b = sample[i + 2];
				if (g > 150 && r < 80 && b < 140) greenPixels += 1;
				if (r > 150 && g < 90 && b < 90) redPixels += 1;
			}
			return {
				prefix: dataUrl.slice(0, 22),
				greenPixels,
				redPixels,
			};
		});
		expect(exported.prefix).toBe("data:image/png;base64,");
		expect(exported.greenPixels).toBeGreaterThan(1200);
		expect(exported.redPixels).toBeLessThan(300);
	});

	test("editable layer names identify text and image layers in the Layers inspector", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Layer naming interaction is covered by desktop browser proof.");

		await loadEditorTestImage(page);
		await page.evaluate(async () => {
			window.__mangaEditorDebug!.addTextLayers([
				{
					id: "named-text-source",
					text: "Original translated line",
					x: 220,
					y: 260,
					w: 420,
					h: 96,
					rotation: 0,
					fontSize: 32,
					alignment: "center",
					index: 0,
				},
			]);
			await window.__mangaEditorDebug!.addImageLayers([
				{
					id: "named-ai-result-source",
					imageId: "named-ai-result-source.png",
					imageName: "ai-result-source.png",
					originalName: "AI SFX result.png",
					x: 260,
					y: 430,
					w: 260,
					h: 170,
					rotation: 0,
					opacity: 0.82,
					visible: true,
					locked: false,
					index: 1,
					role: "overlay",
					fill: "#0ea5e9",
				},
			]);
		});
		await openRightPanel(page, "เลเยอร์");

		const textSectionToggle = page.getByRole("button", { name: /กล่องข้อความ พับอยู่/ });
		if (await textSectionToggle.count()) {
			await textSectionToggle.click();
		}
		await page.getByRole("button", { name: "เลือกและแก้ค่ากล่องข้อความ Original translated line" }).click();
		const editSelected = page.getByRole("button", { name: "แก้กล่องข้อความที่เลือก" });
		if (await editSelected.isVisible()) {
			await editSelected.click();
		}
		await page.locator("#text-layer-name").fill("Narration top");
		await expect(page.locator(".selection-focus-card")).toContainText("Narration top");
		await expect(page.locator(".selection-focus-card")).toContainText("Original translated line");
		const selectedTextMetrics = await page.evaluate(() => {
			const rightPanel = document.querySelector<HTMLElement>(".right-panel-content");
			const visibleControls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea"))
				.filter((element) => {
					if (!rightPanel?.contains(element)) return false;
					const rect = element.getBoundingClientRect();
					const style = window.getComputedStyle(element);
					return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
				});
			return {
				under40: visibleControls
					.map((element) => {
						const rect = element.getBoundingClientRect();
						return { label: element.getAttribute("aria-label") || element.textContent?.trim() || element.id, width: Math.round(rect.width), height: Math.round(rect.height) };
					})
					.filter((item) => item.width < 40 || item.height < 40),
			};
		});
		expect(selectedTextMetrics.under40).toEqual([]);

		const imageSectionToggle = page.getByRole("button", { name: /รูปเสริม พับอยู่/ });
		if (await imageSectionToggle.count()) {
			await imageSectionToggle.click();
		}
		await page.locator('button.layer-select[aria-label="เลือกและแก้ค่ารูปเสริม AI SFX result.png"]').click();
		await page.getByText("ตั้งค่าเลเยอร์ AI ขั้นสูง").click();
		await expect(page.locator("#image-layer-name")).toBeVisible();
		await page.locator("#image-layer-name").fill("AI clean result");
		await page.locator("#image-layer-name").blur();
		await expect(page.locator(".selection-focus-card")).toContainText("AI clean result");

		const state = await getEditorState(page);
		expect(state.textLayers.find((layer: { id: string }) => layer.id === "named-text-source")?.name).toBe("Narration top");
		const imageLayer = state.imageLayers.find((layer: { id: string }) => layer.id === "named-ai-result-source");
		expect(imageLayer?.name).toBe("AI clean result");
		expect(imageLayer?.originalName).toBe("AI SFX result.png");

		const metrics = await page.evaluate(() => {
			const visibleControls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea"))
				.filter((element) => {
					const rect = element.getBoundingClientRect();
					const style = window.getComputedStyle(element);
					return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
				});
			return {
				overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
				layerNameInputs: Array.from(document.querySelectorAll<HTMLInputElement>("#text-layer-name, #image-layer-name")).map((input) => ({
					id: input.id,
					value: input.value,
					height: Math.round(input.getBoundingClientRect().height),
				})),
				under40: visibleControls
					.map((element) => {
						const rect = element.getBoundingClientRect();
						return { label: element.getAttribute("aria-label") || element.textContent?.trim() || element.id, width: Math.round(rect.width), height: Math.round(rect.height) };
					})
					.filter((item) => item.width < 40 || item.height < 40),
			};
		});
		expect(metrics.overflowX).toBe(0);
		expect(metrics.layerNameInputs).toEqual([
			expect.objectContaining({ id: "image-layer-name", value: "AI clean result" }),
		]);
		expect(metrics.under40).toEqual([]);

		await mkdir("../.codex-dev-logs/visual-checks/flow390-layer-names", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow390-layer-names/desktop-layer-names.png",
			fullPage: false,
		});
	});

	test("fits oversized text into its image-space layer box from the inspector", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Layers inspector geometry is covered on desktop until mobile editor panels are redesigned.");

		await loadEditorTestImage(page);
		await page.evaluate(() => {
			window.__mangaEditorDebug!.addTextLayers([
				{
					id: "fit-box-layer",
					text: "THIS IS A LONG TRANSLATED LINE THAT SHOULD FIT INSIDE THE BUBBLE",
					x: 360,
					y: 620,
					w: 300,
					h: 88,
					rotation: 0,
					fontSize: 148,
					fontFamily: "Impact, Arial Black, sans-serif",
					fill: "#111111",
					stroke: "#ffffff",
					strokeWidth: 4,
					alignment: "center",
					sourceCategory: "dialogue",
					sourceProvider: "json-import",
					confidence: 0.83,
					visible: true,
					locked: false,
					index: 0,
				},
			]);
		});

		await openRightPanel(page, "เลเยอร์");
		await openLayerSection(page, "กล่องข้อความ");
		await page.locator(".layer-select").first().click();
		await expect(page.locator(".layer-row").first()).toContainText("บทพูด");
		await expect(page.locator(".layer-row").first()).toContainText("83%");
		await expect(page.locator(".layer-row").first()).toContainText("JSON");
		const before = await getEditorState(page);
		await expect(page.locator("#text-layer-fit-box")).toBeEnabled();
		expect(before.textLayers[0].fontSize).toBe(148);
		expect(before.textLayers[0].x).toBe(360);
		expect(before.textLayers[0].y).toBe(620);
		expect(before.textLayers[0].w).toBe(300);
		expect(before.textLayers[0].h).toBe(88);

		await page.locator("#text-layer-fit-box").click();

		const after = await getEditorState(page);
		expect(after.textLayers[0].fontSize).toBeLessThan(148);
		expect(after.textLayers[0].fontSize).toBeGreaterThanOrEqual(6);
		expect(after.textLayers[0].x).toBe(360);
		expect(after.textLayers[0].y).toBe(620);
		expect(after.textLayers[0].w).toBe(300);
		expect(after.textLayers[0].h).toBe(88);
		expect(after.textLayerStyles[0].fontSize).toBeLessThan(before.textLayerStyles[0].fontSize);
		expect(after.textLayerStyles[0].textHeight).toBeLessThanOrEqual(after.textLayerStyles[0].boxHeight);
		expect(after.textLayerStyles[0].scaleX).toBe(1);
		expect(after.textLayerStyles[0].scaleY).toBe(1);
	});

	test("adds protected credit layers from placement presets", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Layers inspector controls are covered on desktop until mobile editor panels are redesigned.");

		await loadEditorTestImage(page);
		await openRightPanel(page, "เลเยอร์");
		await openLayerSection(page, "เครดิต");

		await page.locator("#credit-preset").selectOption("credit-bottom-center");
		await page.locator("#credit-text").fill("Translator: QA Team");
		await page.locator("#credit-offset").fill("30");
		await page.getByRole("button", { name: "สร้างเครดิตข้อความ" }).click();
		await openLayerSection(page, "กล่องข้อความ");

		const state = await getEditorState(page);
		expect(state.textLayers).toHaveLength(1);
		expect(state.textLayers[0]).toEqual(expect.objectContaining({
			text: "Translator: QA Team",
			sourceCategory: "credit",
			sourceProvider: "credit-preset",
			protected: true,
			locked: true,
			visible: true,
			x: 30,
			w: 1540,
			alignment: "center",
		}));
		expect(state.textLayers[0].y + state.textLayers[0].h).toBe(2370);
		await expect(page.locator(".layer-row").first()).toContainText("ล็อก");
		await expect(page.locator(".layer-row").first()).toContainText("เครดิต");
		await expect(page.locator(".layer-row").first()).toContainText("กันแก้");
	});

	test("adds multiline text credits and deletes selected/current-page credits from the inspector", async ({ page }) => {
		test.skip(test.info().project.name.includes("mobile"), "Credit delete workflow proof is covered on desktop/tablet.");

		await loadEditorTestImage(page);
		await openRightPanel(page, "เลเยอร์");
		await openLayerSection(page, "เครดิต");

		await page.locator("#credit-preset").selectOption("credit-bottom-center");
		await page.locator("#credit-text").fill("แปล / จัดตัวอักษร\nQC: Moonlit");
		await page.locator("#credit-offset").fill("36");
		await page.getByRole("button", { name: "สร้างเครดิตข้อความ" }).click();
		await expect.poll(async () => (await getEditorState(page)).textLayers.filter((layer: any) => layer.sourceCategory === "credit").length).toBe(1);

		const firstState = await getEditorState(page);
		const firstCredit = firstState.textLayers.find((layer: any) => layer.sourceCategory === "credit");
		expect(firstCredit).toEqual(expect.objectContaining({
			text: "แปล / จัดตัวอักษร\nQC: Moonlit",
			sourceProvider: "credit-preset",
			protected: true,
			locked: true,
			alignment: "center",
		}));
		expect(firstState.activeLayerId).toBe(firstCredit.id);

		await expect(page.getByRole("button", { name: "ลบเครดิตที่เลือก" })).toBeEnabled();
		await page.getByRole("button", { name: "ลบเครดิตที่เลือก" }).click();
		await expect(page.getByRole("dialog", { name: "ลบเครดิตข้อความนี้?" })).toBeVisible();
		await page.getByRole("button", { name: "ลบเลย" }).click();
		await expect.poll(async () => (await getEditorState(page)).textLayers.filter((layer: any) => layer.sourceCategory === "credit").length).toBe(0);
		await expect(editorStatus(page)).toContainText("ลบเครดิตข้อความที่เลือกแล้ว");

		await page.locator("#credit-text").fill("เครดิตหน้าเดียว");
		await page.locator("#credit-offset").fill("40");
		await page.getByRole("button", { name: "สร้างเครดิตข้อความ" }).click();
		await page.getByRole("button", { name: "เพิ่ม/จัดการเครดิตอื่น" }).click();
		await page.locator("#credit-text").fill("เครดิตอีกจุด");
		await page.locator("#credit-offset").fill("92");
		await page.getByRole("button", { name: "สร้างเครดิตข้อความ" }).click();
		await expect.poll(async () => (await getEditorState(page)).textLayers.filter((layer: any) => layer.sourceCategory === "credit").length).toBe(2);

		await page.getByLabel("เลือกขอบเขตลบเครดิต").selectOption("current-all");
		await page.getByRole("button", { name: "ลบเครดิตตามขอบเขตที่เลือก" }).click();
		await expect(page.getByRole("dialog", { name: "ลบเครดิตหน้านี้?" })).toContainText("จะลบเครดิต 2 เลเยอร์จากหน้าปัจจุบัน");
		await page.getByRole("button", { name: "ลบเลย" }).click();
		await expect.poll(async () => (await getEditorState(page)).textLayers.filter((layer: any) => layer.sourceCategory === "credit").length).toBe(0);
		await expect(editorStatus(page)).toContainText("ลบเครดิตบนหน้านี้แล้ว: 2 เลเยอร์");

		await mkdir("../.codex-dev-logs/visual-checks/flow626-credit-text-delete-workflow", { recursive: true });
		await page.screenshot({
			path: "../.codex-dev-logs/visual-checks/flow626-credit-text-delete-workflow/desktop-credit-text-delete-proof.png",
			fullPage: false,
		});
	});

	test("exports a merged original-size PNG with rendered text layers", async ({ page }) => {
		await loadEditorTestImage(page);
		await page.evaluate(() => {
			window.__mangaEditorDebug!.addTextLayers([
				{
					id: "export-smoke",
					text: "Export text",
					x: 430,
					y: 850,
					w: 520,
					h: 160,
					rotation: 0,
					fontSize: 72,
					fill: "#c1121f",
					stroke: "#ffffff",
					strokeWidth: 4,
					alignment: "center",
					index: 0,
				},
			]);
		});

		const exported = await page.evaluate(async () => {
			const dataUrl = await window.__mangaEditorDebug!.exportMergedImageDataUrl();
			const image = new Image();
			image.src = dataUrl;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(image, 0, 0);

			let redPixels = 0;
			const sample = ctx.getImageData(430, 850, 520, 160).data;
			for (let i = 0; i < sample.length; i += 4) {
				const r = sample[i];
				const g = sample[i + 1];
				const b = sample[i + 2];
				if (r > 140 && g < 80 && b < 80) {
					redPixels += 1;
				}
			}

			return {
				prefix: dataUrl.slice(0, 22),
				width: image.naturalWidth,
				height: image.naturalHeight,
				redPixels,
			};
		});

		expect(exported.prefix).toBe("data:image/png;base64,");
		expect(exported.width).toBe(1600);
		expect(exported.height).toBe(2400);
		expect(exported.redPixels).toBeGreaterThan(200);
	});

	test("exports Text FX stroke glow and shadow pixels", async ({ page }, testInfo: TestInfo) => {
		test.skip(test.info().project.name.includes("mobile"), "Text FX export pixels are covered on desktop/tablet.");

		await waitForDebug(page);
		await openEditorView(page);
		await page.evaluate(async () => {
			const canvas = document.createElement("canvas");
			canvas.width = 1600;
			canvas.height = 2400;
			const ctx = canvas.getContext("2d")!;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			await window.__mangaEditorDebug!.loadImageUrl(canvas.toDataURL("image/png"));
			window.__mangaEditorDebug!.addTextLayers([
				{
					id: "export-fx-text",
					text: "FX",
					x: 500,
					y: 820,
					w: 420,
					h: 180,
					rotation: 0,
					fontSize: 118,
					fontFamily: "Arial",
					fill: "#111111",
					stroke: "#ffffff",
					strokeWidth: 2,
					alignment: "center",
					index: 0,
					effects: {
						stroke: { enabled: true, color: "#00ff00", width: 10 },
						outerGlow: { enabled: true, color: "#0044ff", opacity: 100, blur: 18 },
					},
				},
			]);
		});

		const countFxPixels = async () => page.evaluate(async () => {
			const dataUrl = await window.__mangaEditorDebug!.exportMergedImageDataUrl();
			const image = new Image();
			image.src = dataUrl;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(image, 0, 0);
			const sample = ctx.getImageData(440, 760, 560, 300).data;
			let greenStrokePixels = 0;
			let blueEffectPixels = 0;
			let redShadowPixels = 0;
			let darkTextPixels = 0;
			for (let i = 0; i < sample.length; i += 4) {
				const r = sample[i];
				const g = sample[i + 1];
				const b = sample[i + 2];
				if (g > 150 && r < 90 && b < 120) greenStrokePixels += 1;
				if (b > 140 && r < 120 && g < 150) blueEffectPixels += 1;
				if (r > 140 && g < 100 && b < 120) redShadowPixels += 1;
				if (r < 60 && g < 60 && b < 60) darkTextPixels += 1;
			}
			return {
				prefix: dataUrl.slice(0, 22),
				width: image.naturalWidth,
				height: image.naturalHeight,
				greenStrokePixels,
				blueEffectPixels,
				redShadowPixels,
				darkTextPixels,
			};
		});

		const glowExport = await countFxPixels();
		expect(glowExport.prefix).toBe("data:image/png;base64,");
		expect(glowExport.width).toBe(1600);
		expect(glowExport.height).toBe(2400);
		expect(glowExport.darkTextPixels).toBeGreaterThan(200);
		expect(glowExport.greenStrokePixels).toBeGreaterThan(100);
		expect(glowExport.blueEffectPixels).toBeGreaterThan(20);

		await page.evaluate(() => {
			window.__mangaEditorDebug!.updateTextLayer("export-fx-text", {
				effects: {
					stroke: { enabled: true, color: "#00ff00", width: 10 },
					outerGlow: { enabled: true, color: "#0044ff", opacity: 100, blur: 18 },
					dropShadow: { enabled: true, color: "#ff0033", opacity: 100, blur: 0, offsetX: 44, offsetY: 34 },
				},
			});
		});

		const shadowExport = await countFxPixels();
		expect(shadowExport.prefix).toBe("data:image/png;base64,");
		expect(shadowExport.width).toBe(1600);
		expect(shadowExport.height).toBe(2400);
		expect(shadowExport.darkTextPixels).toBeGreaterThan(200);
		expect(shadowExport.greenStrokePixels).toBeGreaterThan(100);
		expect(shadowExport.blueEffectPixels).toBeGreaterThan(20);
		expect(shadowExport.redShadowPixels).toBeGreaterThan(20);

		await mkdir("../.codex-dev-logs/visual-checks/flow866-text-fx-stacked-shadows", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow866-text-fx-stacked-shadows/${testInfo.project.name}-stacked-text-fx.png`,
			fullPage: false,
		});
		await writeFile(
			`../.codex-dev-logs/visual-checks/flow866-text-fx-stacked-shadows/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ glowExport, shadowExport }, null, 2),
		);
	});
});
