import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow900-actual-zip-truth";
const PROJECT_ID = "flow208-project";

type ZipEntries = Record<string, Uint8Array>;

function usageSummary(projectId = PROJECT_ID) {
	return {
		workspaceId: projectId,
		projectId,
		planId: "debug",
		enforced: false,
		daily: {
			windowStart: Date.now(),
			windowEnd: Date.now() + 86_400_000,
			aiReservedThb: 0,
			aiCommittedThb: 0,
			uploadBytes: 0,
			exportBytes: 0,
			moderationImages: 0,
			limits: { aiCreditThb: 0, uploadBytes: 0, exportBytes: 0 },
			remaining: { aiCreditThb: null, uploadBytes: null, exportBytes: null },
			percentUsed: { aiCredit: null, uploadBytes: null, exportBytes: null },
		},
		monthly: {
			windowStart: Date.now(),
			windowEnd: Date.now() + 2_592_000_000,
			aiReservedThb: 0,
			aiCommittedThb: 0,
			uploadBytes: 0,
			exportBytes: 0,
			moderationImages: 0,
			limits: { aiCreditThb: 0, uploadBytes: 0, exportBytes: 0 },
			remaining: { aiCreditThb: null, uploadBytes: null, exportBytes: null },
			percentUsed: { aiCredit: null, uploadBytes: null, exportBytes: null },
		},
		eventCount: 1,
	};
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function readUint16(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function unzipStoredEntries(bytes: Uint8Array): ZipEntries {
	const entries: ZipEntries = {};
	const decoder = new TextDecoder();
	let offset = 0;
	while (offset + 30 <= bytes.length) {
		const signature = readUint32(bytes, offset);
		if (signature === 0x02014b50 || signature === 0x06054b50) break;
		expect(signature).toBe(0x04034b50);
		const method = readUint16(bytes, offset + 8);
		const compressedSize = readUint32(bytes, offset + 18);
		const fileNameLength = readUint16(bytes, offset + 26);
		const extraLength = readUint16(bytes, offset + 28);
		expect(method).toBe(0);
		const nameStart = offset + 30;
		const dataStart = nameStart + fileNameLength + extraLength;
		const name = decoder.decode(bytes.slice(nameStart, nameStart + fileNameLength));
		entries[name] = bytes.slice(dataStart, dataStart + compressedSize);
		offset = dataStart + compressedSize;
	}
	return entries;
}

function readPngSize(bytes: Uint8Array): { width: number; height: number } {
	expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		width: view.getUint32(16, false),
		height: view.getUint32(20, false),
	};
}

async function collectRenderedPixelProof(page: Page, pngBytes: Uint8Array) {
	return page.evaluate(async (input) => {
		const blob = new Blob([new Uint8Array(input.bytes)], { type: "image/png" });
		const image = await createImageBitmap(blob);
		const canvas = document.createElement("canvas");
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("Cannot sample exported PNG");
		context.drawImage(image, 0, 0);
		const pixelAt = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
		const countContrastingPixels = (x: number, y: number, w: number, h: number, base: number[]) => {
			let count = 0;
			for (let yy = y; yy < y + h; yy += 3) {
				for (let xx = x; xx < x + w; xx += 3) {
					const [r, g, b, a] = context.getImageData(xx, yy, 1, 1).data;
					const delta = Math.abs(r - base[0]) + Math.abs(g - base[1]) + Math.abs(b - base[2]);
					if (a > 0 && delta > 85) count += 1;
				}
			}
			return count;
		};
		return {
			imageSize: { width: image.width, height: image.height },
			basePixel: pixelAt(40, 40),
			imageLayerPixels: [
				pixelAt(132, 132),
				pixelAt(180, 180),
				pixelAt(230, 230),
				pixelAt(320, 320),
			],
			textContrastPixels: countContrastingPixels(450, 150, 360, 140, [32, 64, 96]),
			creditContrastPixels: countContrastingPixels(36, 1238, 828, 84, [32, 64, 96]),
			imageCreditPixels: [
				pixelAt(746, 1250),
				pixelAt(796, 1270),
				pixelAt(846, 1290),
			],
		};
	}, { bytes: Array.from(pngBytes) });
}

async function mockExportSideEffects(page: Page, artifactUploads: unknown[], imageRequests: string[]) {
	await page.route(`**/api/images/${PROJECT_ID}/**`, async (route) => {
		imageRequests.push(route.request().url());
		await route.abort("failed");
	});
	await page.route(`**/api/usage/${PROJECT_ID}/export`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ ok: true, eventId: "flow900-export-usage", usage: usageSummary() }),
		});
	});
	await page.route(`**/api/project/${PROJECT_ID}/exports/*/artifact`, async (route) => {
		artifactUploads.push({
			method: route.request().method(),
			contentType: route.request().headers()["content-type"] ?? "",
			size: route.request().postDataBuffer()?.byteLength ?? 0,
		});
		const runId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "flow900-export");
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				artifact: {
					exportId: runId,
					storageDriver: "debug",
					storageKey: `flow900/${runId}.zip`,
					filename: "flow900-actual-zip.zip",
					mimeType: "application/zip",
					sizeBytes: route.request().postDataBuffer()?.byteLength ?? 0,
					createdAt: "2026-05-25T03:20:00.000Z",
				},
			}),
		});
	});
}

async function seedActualZipProject(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		const solid = (fill: string, width = 900, height = 1350) => {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Cannot create solid image");
			context.fillStyle = fill;
			context.fillRect(0, 0, canvas.width, canvas.height);
			return canvas.toDataURL("image/png");
		};

		await window.__mangaWorkflowDebug!.seedProject();
		await window.__mangaWorkflowDebug!.openPage(0);
		window.__mangaWorkflowDebug!.setCurrentPageImageForTesting("flow900-blue-base", "flow900-blue-base.png", solid("rgb(32, 64, 96)"));
		await window.__mangaWorkflowDebug!.openPage(1);
		window.__mangaWorkflowDebug!.setCurrentPageImageForTesting("flow900-red-layer", "flow900-red-layer.png", solid("rgb(220, 20, 60)"));
		await window.__mangaWorkflowDebug!.openPage(0);
		await window.__mangaWorkflowDebug!.markChapterExportReady();
		await window.__mangaEditorDebug!.addImageLayers([{
			id: "flow900-red-image-layer",
			name: "AI result proof layer",
			imageId: "flow900-red-layer",
			imageName: "flow900-red-layer.png",
			imageUrl: solid("rgb(220, 20, 60)"),
			x: 120,
			y: 120,
			w: 220,
			h: 220,
			rotation: 0,
			opacity: 1,
			index: 0,
			zIndex: 0,
			role: "overlay",
			visible: true,
			locked: false,
		}]);
		window.__mangaEditorDebug!.addTextLayers([{
			id: "flow900-sfx-text",
			name: "ZIP truth SFX",
			text: "ZIP",
			x: 145,
			y: 155,
			w: 170,
			h: 90,
			rotation: 0,
			fontSize: 64,
			fontFamily: "Arial",
			fill: "#ffffff",
			stroke: "#000000",
			strokeWidth: 8,
			alignment: "center",
			opacity: 1,
			index: 0,
			zIndex: 1,
			visible: true,
			locked: false,
			sourceProvider: "manual",
			sourceCategory: "sfx",
		}]);
		window.__mangaWorkflowDebug!.addCurrentPageCreditTextForTesting("Credit QA");
		await window.__mangaWorkflowDebug!.addCurrentPageCreditImageForTesting(
			solid("rgb(255, 216, 0)", 320, 160),
			"flow900-credit-logo.png",
		);

		const project = window.__mangaWorkflowDebug!.getProjectState();
		if (!project) throw new Error("Project seed failed");
		const firstPage = project.pages[0];
		firstPage.imageId = "flow900-blue-base";
		firstPage.imageName = "flow900-blue-base.png";
		firstPage.originalName = "flow900-blue-base.png";
		if (!firstPage.imageLayers?.some((layer) => layer.role === "credit")) {
			throw new Error("Flow900 seed did not create an image credit layer");
		}
		if (!firstPage.textLayers.some((layer) => layer.sourceCategory === "credit")) {
			throw new Error("Flow900 seed did not create a text credit layer");
		}
		project.exportRuns = [];
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
		window.__mangaWorkflowDebug!.openView("pages");
	});
}

test.describe("Flow900 actual ZIP truth", () => {
	test("exports a real downloaded ZIP and verifies manifest plus rendered PNG pixels", async ({ page }, testInfo: TestInfo) => {
		test.skip(testInfo.project.name.includes("mobile"), "Actual ZIP byte proof targets desktop/tablet browser downloads.");
		const artifactUploads: unknown[] = [];
		const imageRequests: string[] = [];
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			const text = message.text();
			if (text.includes("[ProjectStore] loadRecentProjects error")) return;
			consoleIssues.push(`${message.type()}: ${text}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await mockExportSideEffects(page, artifactUploads, imageRequests);
		await seedActualZipProject(page);

		const exportGate = page.getByRole("region", { name: "ส่งออกตอนนี้" });
		await expect(exportGate).toContainText("Export ZIP พร้อม");
		const downloadPromise = page.waitForEvent("download");
		await page.evaluate(() => window.__mangaWorkflowDebug!.exportCurrentChapterBatchForTesting());
		const download = await downloadPromise;
		await expect.poll(() => page.evaluate(() => window.__mangaWorkflowDebug!.getState().batchExportStatus)).toBe("done");
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("Export สำเร็จ");

		const path = await download.path();
		expect(path).toBeTruthy();
		const zipBytes = new Uint8Array(await readFile(path!));
		const entries = unzipStoredEntries(zipBytes);
		const entryNames = Object.keys(entries).sort();
		expect(entryNames).toEqual([
			"manifest.json",
			"pages/001_flow900-blue-base_merged.png",
			"pages/002_flow900-red-layer_merged.png",
		]);

		const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
		expect(manifest).toMatchObject({
			projectId: PROJECT_ID,
			pageCount: 2,
			pages: [
				expect.objectContaining({
					pageIndex: 0,
					pageNumber: 1,
					imageId: "flow900-blue-base",
					filename: "001_flow900-blue-base_merged.png",
					layerCount: expect.any(Number),
					width: 900,
					height: 1350,
				}),
				expect.objectContaining({
					pageIndex: 1,
					pageNumber: 2,
					imageId: "flow900-red-layer",
					filename: "002_flow900-red-layer_merged.png",
					layerCount: 1,
					width: 900,
					height: 1350,
				}),
			],
		});
		expect(manifest.pages[0].layerCount).toBeGreaterThanOrEqual(2);
		const firstPageLayerKeys = manifest.pages[0].layers.map((layer: { kind: string; id: string }) => `${layer.kind}:${layer.id}`);
		expect(firstPageLayerKeys.slice(0, 2)).toEqual([
			"image:flow900-red-image-layer",
			"text:flow900-sfx-text",
		]);
		expect(manifest.pages[0].layers).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "image", id: "flow900-red-image-layer", sourceCategory: "overlay", zIndex: 0 }),
			expect.objectContaining({ kind: "text", id: "flow900-sfx-text", sourceCategory: "sfx", zIndex: 1 }),
			expect.objectContaining({ kind: "text", sourceCategory: "credit" }),
			expect.objectContaining({ kind: "image", role: "credit", sourceCategory: "credit" }),
			expect.objectContaining({ kind: "image", sourceCategory: "ai-result" }),
		]));
		expect(manifest.pages[1].layers).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "text", sourceCategory: "dialogue", sourceProvider: "json-import" }),
		]));

		const firstPng = entries["pages/001_flow900-blue-base_merged.png"];
		const secondPng = entries["pages/002_flow900-red-layer_merged.png"];
		expect(readPngSize(firstPng)).toEqual({ width: 900, height: 1350 });
		expect(readPngSize(secondPng)).toEqual({ width: 900, height: 1350 });
		const pixelProof = await collectRenderedPixelProof(page, firstPng);
		expect(pixelProof.basePixel.slice(0, 3)).toEqual([32, 64, 96]);
		expect(pixelProof.imageLayerPixels.map((pixel) => pixel.slice(0, 3))).toContainEqual([231, 241, 255]);
		expect(pixelProof.textContrastPixels).toBeGreaterThan(80);
		expect(pixelProof.creditContrastPixels).toBeGreaterThan(40);
		expect(pixelProof.imageCreditPixels.map((pixel) => pixel.slice(0, 3))).toContainEqual([255, 216, 0]);

		const metrics = {
			downloadFilename: download.suggestedFilename(),
			zipBytes: zipBytes.length,
			entryNames,
			manifest,
			pixelProof,
			artifactUploads,
			imageRequests,
			consoleIssues,
			batchStatus: await page.evaluate(() => window.__mangaWorkflowDebug!.getState().batchExportStatus),
		};
		expect(imageRequests).toEqual([]);
		expect(artifactUploads).toHaveLength(1);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-actual-zip-pages.png`,
			fullPage: true,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-actual-zip-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
