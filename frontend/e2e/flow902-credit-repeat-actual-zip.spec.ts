import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow902-credit-repeat-actual-zip";
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

async function collectRepeatCreditPixels(page: Page, pngBytes: Uint8Array) {
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
			for (let yy = y; yy < y + h; yy += 2) {
				for (let xx = x; xx < x + w; xx += 2) {
					const [r, g, b, a] = context.getImageData(xx, yy, 1, 1).data;
					const delta = Math.abs(r - base[0]) + Math.abs(g - base[1]) + Math.abs(b - base[2]);
					if (a > 0 && delta > 85) count += 1;
				}
			}
			return count;
		};
		return {
			imageSize: { width: image.width, height: image.height },
			basePixel: pixelAt(850, 300),
			imageCreditPixels: input.imageCreditSamplePoints.map(([x, y]) => pixelAt(x, y)),
			textCreditContrastPixels: input.textCreditRegions.map(([x, y, w, h]) => countContrastingPixels(x, y, w, h, input.baseColor)),
		};
	}, {
		bytes: Array.from(pngBytes),
		baseColor: [18, 42, 72],
		imageCreditSamplePoints: [[450, 64], [450, 1264], [450, 2464], [450, 3664], [450, 4864]],
		textCreditRegions: [[32, 24, 300, 56], [32, 1224, 300, 56], [32, 2424, 300, 56], [32, 3624, 300, 56], [32, 4824, 300, 56]],
	});
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
			body: JSON.stringify({ ok: true, eventId: "flow902-export-usage", usage: usageSummary() }),
		});
	});
	await page.route(`**/api/project/${PROJECT_ID}/exports/*/artifact`, async (route) => {
		artifactUploads.push({
			method: route.request().method(),
			contentType: route.request().headers()["content-type"] ?? "",
			size: route.request().postDataBuffer()?.byteLength ?? 0,
		});
		const runId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "flow902-export");
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				artifact: {
					exportId: runId,
					storageDriver: "debug",
					storageKey: `flow902/${runId}.zip`,
					filename: "flow902-credit-repeat.zip",
					mimeType: "application/zip",
					sizeBytes: route.request().postDataBuffer()?.byteLength ?? 0,
					createdAt: "2026-05-25T03:40:00.000Z",
				},
			}),
		});
	});
}

async function seedLongPageRepeatCreditProject(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		const solid = (fill: string, width = 900, height = 6000) => {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Cannot create solid image");
			context.fillStyle = fill;
			context.fillRect(0, 0, canvas.width, canvas.height);
			return canvas.toDataURL("image/png");
		};

		const tallBase = solid("rgb(18, 42, 72)");
		const creditLogo = solid("rgb(255, 216, 0)", 320, 160);
		await window.__mangaWorkflowDebug!.seedProject();
		const project = window.__mangaWorkflowDebug!.getProjectState();
		if (!project) throw new Error("Project seed failed");
		project.pages.splice(1);
		project.pages[0].textLayers = [];
		project.pages[0].imageLayers = [];
		await window.__mangaWorkflowDebug!.openPage(0);
		await window.__mangaEditorDebug!.loadImageUrl(tallBase);
		window.__mangaWorkflowDebug!.setCurrentPageImageForTesting("flow902-tall-base", "flow902-tall-base.png", tallBase);
		await window.__mangaWorkflowDebug!.markChapterExportReady();
		await window.__mangaEditorDebug!.loadImageUrl(tallBase);
		window.__mangaWorkflowDebug!.setCurrentPageImageForTesting("flow902-tall-base", "flow902-tall-base.png", tallBase);
		window.__mangaWorkflowDebug!.addCurrentPageCreditTextForTesting(
			"TEXT CREDIT",
			{
				presetId: "credit-left-bottom",
				offset: 24,
				repeatEveryPx: 1200,
				scope: "current",
			},
		);
		await window.__mangaWorkflowDebug!.addCurrentPageCreditImageForTesting(
			creditLogo,
			"flow902-repeat-credit.png",
			{
				presetId: "credit-bottom-center",
				maxWidth: 160,
				repeatEveryPx: 1200,
				scope: "current",
			},
		);
		const updated = window.__mangaWorkflowDebug!.getProjectState();
		const imageCredits = updated?.pages[0]?.imageLayers?.filter((layer) => layer.role === "credit") ?? [];
		const textCredits = updated?.pages[0]?.textLayers?.filter((layer) => layer.sourceCategory === "credit") ?? [];
		if (imageCredits.length !== 5) throw new Error(`Expected 5 repeated credit image layers, got ${imageCredits.length}`);
		if (textCredits.length !== 5) throw new Error(`Expected 5 repeated credit text layers, got ${textCredits.length}`);
		updated!.pages[0].imageLayers = imageCredits;
		updated!.pages[0].textLayers = textCredits;
		window.__mangaWorkflowDebug!.clearAiReviewMarkersForTesting();
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
		window.__mangaWorkflowDebug!.openView("pages");
	});
}

test.describe("Flow902 repeat credit actual ZIP proof", () => {
	test("exports repeated long-page text and image credits into the real downloaded ZIP", async ({ page }, testInfo: TestInfo) => {
		test.skip(testInfo.project.name.includes("mobile"), "Actual ZIP byte proof targets desktop/tablet browser downloads.");
		const artifactUploads: unknown[] = [];
		const imageRequests: string[] = [];
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			const text = message.text();
			if (text.includes("[ProjectStore] loadRecentProjects error")) return;
			if (text.includes("WebSocket connection") && text.includes("ERR_CONNECTION_REFUSED")) return;
			consoleIssues.push(`${message.type()}: ${text}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await mockExportSideEffects(page, artifactUploads, imageRequests);
		await seedLongPageRepeatCreditProject(page);

		const exportGate = page.getByRole("region", { name: "ส่งออกตอนนี้" });
		await expect(exportGate).toContainText("Export ZIP พร้อม");
		const downloadPromise = page.waitForEvent("download");
		await page.evaluate(() => window.__mangaWorkflowDebug!.exportCurrentChapterBatchForTesting());
		const download = await downloadPromise;
		await expect.poll(() => page.evaluate(() => window.__mangaWorkflowDebug!.getState().batchExportStatus)).toBe("done");

		const path = await download.path();
		expect(path).toBeTruthy();
		const zipBytes = new Uint8Array(await readFile(path!));
		const entries = unzipStoredEntries(zipBytes);
		const entryNames = Object.keys(entries).sort();
		expect(entryNames).toEqual([
			"manifest.json",
			"pages/001_flow902-tall-base_merged.png",
		]);

		const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
		expect(manifest.pages[0]).toMatchObject({
			pageIndex: 0,
			pageNumber: 1,
			imageId: "flow902-tall-base",
			filename: "001_flow902-tall-base_merged.png",
			width: 900,
			height: 6000,
		});
		expect(manifest.pages[0].layerCount).toBeGreaterThanOrEqual(10);
		const manifestLayers = manifest.pages[0].layers ?? [];
		const manifestTextCredits = manifestLayers.filter((layer: { kind?: string; sourceCategory?: string }) => (
			layer.kind === "text" && layer.sourceCategory === "credit"
		));
		const manifestImageCredits = manifestLayers.filter((layer: { kind?: string; sourceCategory?: string; role?: string }) => (
			layer.kind === "image" && layer.role === "credit" && layer.sourceCategory === "credit"
		));
		expect(manifestTextCredits).toHaveLength(5);
		expect(manifestImageCredits).toHaveLength(5);

		const png = entries["pages/001_flow902-tall-base_merged.png"];
		expect(readPngSize(png)).toEqual({ width: 900, height: 6000 });
		const pixelProof = await collectRepeatCreditPixels(page, png);
		expect(pixelProof.basePixel.slice(0, 3)).toEqual([18, 42, 72]);
		expect(pixelProof.imageCreditPixels.map((pixel) => pixel.slice(0, 3))).toEqual([
			[255, 216, 0],
			[255, 216, 0],
			[255, 216, 0],
			[255, 216, 0],
			[255, 216, 0],
		]);
		expect(pixelProof.textCreditContrastPixels.every((count) => count > 20)).toBe(true);

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
			path: `${PROOF_DIR}/${testInfo.project.name}-repeat-credit-pages.png`,
			fullPage: true,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-repeat-credit-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
