import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow903-text-fx-actual-zip";
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

async function collectTextFxPixelProof(page: Page, pngBytes: Uint8Array) {
	return page.evaluate(async (input) => {
		const blob = new Blob([new Uint8Array(input.bytes)], { type: "image/png" });
		const image = await createImageBitmap(blob);
		const canvas = document.createElement("canvas");
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("Cannot sample exported PNG");
		context.drawImage(image, 0, 0);
		const countPixels = (x: number, y: number, w: number, h: number, predicate: (r: number, g: number, b: number, a: number) => boolean) => {
			const data = context.getImageData(x, y, w, h).data;
			let count = 0;
			for (let index = 0; index < data.length; index += 4) {
				if (predicate(data[index], data[index + 1], data[index + 2], data[index + 3])) count += 1;
			}
			return count;
		};
		return {
			imageSize: { width: image.width, height: image.height },
			screamPaleFill: countPixels(90, 120, 720, 250, (r, g, b, a) => a > 0 && r > 230 && g > 190 && b > 190),
			screamDeepRed: countPixels(90, 120, 720, 250, (r, g, b, a) => a > 0 && r > 70 && r < 190 && g < 95 && b < 110),
			dungeonBlueFill: countPixels(90, 430, 720, 260, (r, g, b, a) => a > 0 && r > 185 && g > 220 && b > 230),
			dungeonCyanGlow: countPixels(90, 430, 720, 260, (r, g, b, a) => a > 0 && r < 130 && g > 140 && b > 160),
			dungeonDarkStroke: countPixels(90, 430, 720, 260, (r, g, b, a) => a > 0 && r < 35 && g < 45 && b < 70),
			romanceWarmFill: countPixels(90, 780, 720, 260, (r, g, b, a) => a > 0 && r > 235 && g > 205 && b > 180),
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
			body: JSON.stringify({ ok: true, eventId: "flow903-export-usage", usage: usageSummary() }),
		});
	});
	await page.route(`**/api/project/${PROJECT_ID}/exports/*/artifact`, async (route) => {
		artifactUploads.push({
			method: route.request().method(),
			contentType: route.request().headers()["content-type"] ?? "",
			size: route.request().postDataBuffer()?.byteLength ?? 0,
		});
		const runId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "flow903-export");
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				artifact: {
					exportId: runId,
					storageDriver: "debug",
					storageKey: `flow903/${runId}.zip`,
					filename: "flow903-text-fx.zip",
					mimeType: "application/zip",
					sizeBytes: route.request().postDataBuffer()?.byteLength ?? 0,
					createdAt: "2026-05-25T03:55:00.000Z",
				},
			}),
		});
	});
}

async function seedTextFxProject(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		const solid = (fill: string) => {
			const canvas = document.createElement("canvas");
			canvas.width = 900;
			canvas.height = 1350;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Cannot create solid image");
			context.fillStyle = fill;
			context.fillRect(0, 0, canvas.width, canvas.height);
			return canvas.toDataURL("image/png");
		};
		const base = solid("rgb(21, 24, 34)");
		await window.__mangaWorkflowDebug!.seedProject();
		const project = window.__mangaWorkflowDebug!.getProjectState();
		if (!project) throw new Error("Project seed failed");
		project.pages.splice(1);
		project.pages[0].textLayers = [];
		project.pages[0].imageLayers = [];
		await window.__mangaWorkflowDebug!.openPage(0);
		await window.__mangaEditorDebug!.loadImageUrl(base);
		window.__mangaWorkflowDebug!.setCurrentPageImageForTesting("flow903-text-fx-base", "flow903-text-fx-base.png", base);
		window.__mangaEditorDebug!.addTextLayers([
			{
				id: "flow903-scream",
				text: "กรี๊ด!",
				x: 90,
				y: 130,
				w: 720,
				h: 210,
				rotation: -4,
				fontSize: 96,
				fontFamily: "Arial Black, Tahoma, sans-serif",
				charSpacing: -25,
				skewX: -18,
				fill: "#fff1f2",
				stroke: "#450a0a",
				strokeWidth: 10,
				alignment: "center",
				opacity: 1,
				index: 0,
				zIndex: 0,
				visible: true,
				locked: false,
				effects: {
					outerGlow: { enabled: true, color: "#fb7185", blur: 18, opacity: 78 },
					accentShadows: [
						{ enabled: true, color: "#7f1d1d", offsetX: -9, offsetY: 8, blur: 0, opacity: 84 },
						{ enabled: true, color: "#dc2626", offsetX: 15, offsetY: 16, blur: 0, opacity: 70 },
						{ enabled: true, color: "#fecdd3", offsetX: -2, offsetY: -2, blur: 12, opacity: 46 },
					],
					passes: [
						{ enabled: true, fill: "#7f1d1d", stroke: "#450a0a", strokeWidth: 10, offsetX: 14, offsetY: 16, opacity: 88 },
						{ enabled: true, fill: "#b91c1c", stroke: "#450a0a", strokeWidth: 7, offsetX: -10, offsetY: 11, opacity: 64 },
					],
					dropShadow: { enabled: true, color: "#991b1b", offsetX: 12, offsetY: 14, blur: 0, opacity: 95 },
				},
			},
			{
				id: "flow903-dungeon",
				text: "MANA",
				x: 80,
				y: 450,
				w: 740,
				h: 230,
				rotation: 0,
				fontSize: 112,
				fontFamily: "Arial Black, Tahoma, sans-serif",
				charSpacing: 45,
				skewX: -8,
				fill: "#e0f7ff",
				stroke: "#020617",
				strokeWidth: 8,
				alignment: "center",
				opacity: 1,
				index: 1,
				zIndex: 1,
				visible: true,
				locked: false,
				effects: {
					outerGlow: { enabled: true, color: "#22d3ee", blur: 48, opacity: 94 },
					accentShadows: [
						{ enabled: true, color: "#67e8f9", offsetX: -8, offsetY: 0, blur: 14, opacity: 64 },
						{ enabled: true, color: "#1e3a8a", offsetX: 10, offsetY: 12, blur: 0, opacity: 88 },
					],
					passes: [
						{ enabled: true, fill: "#1e3a8a", stroke: "#020617", strokeWidth: 8, offsetX: 12, offsetY: 14, opacity: 86 },
						{ enabled: true, fill: "#155e75", stroke: "#0f172a", strokeWidth: 4, offsetX: -7, offsetY: 7, opacity: 58 },
					],
					dropShadow: { enabled: true, color: "#0f172a", offsetX: 6, offsetY: 8, blur: 0, opacity: 78 },
				},
			},
			{
				id: "flow903-romance",
				text: "Rose",
				x: 90,
				y: 820,
				w: 720,
				h: 220,
				rotation: 3,
				fontSize: 94,
				fontFamily: "Georgia, Tahoma, serif",
				charSpacing: 30,
				skewX: 5,
				fill: "#fff7ed",
				stroke: "#7c2d12",
				strokeWidth: 5,
				alignment: "center",
				opacity: 1,
				index: 2,
				zIndex: 2,
				visible: true,
				locked: false,
				effects: {
					outerGlow: { enabled: true, color: "#facc15", blur: 30, opacity: 78 },
					accentShadows: [
						{ enabled: true, color: "#f97316", offsetX: 3, offsetY: 5, blur: 0, opacity: 46 },
						{ enabled: true, color: "#fde68a", offsetX: -4, offsetY: -3, blur: 16, opacity: 62 },
					],
					passes: [
						{ enabled: true, fill: "#f59e0b", stroke: "#7c2d12", strokeWidth: 5, offsetX: 5, offsetY: 7, opacity: 46 },
					],
				},
			},
		]);
		const synced = window.__mangaWorkflowDebug!.getProjectState();
		const fxLayers = synced?.pages[0]?.textLayers?.filter((layer) => layer.id.startsWith("flow903-")) ?? [];
		if (fxLayers.length !== 3) throw new Error(`Expected 3 Text FX layers, got ${fxLayers.length}`);
		await window.__mangaWorkflowDebug!.markChapterExportReady();
		window.__mangaWorkflowDebug!.openView("pages");
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		window.__mangaWorkflowDebug!.setCurrentPageTextLayersForTesting(fxLayers);
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		window.__mangaWorkflowDebug!.markCurrentProjectClean();
	});
}

test.describe("Flow903 Text FX actual ZIP proof", () => {
	test("exports sellable Text FX mood stacks into the real downloaded ZIP", async ({ page }, testInfo: TestInfo) => {
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
		await seedTextFxProject(page);
		const seededPage = await page.evaluate(() => {
			const project = window.__mangaWorkflowDebug!.getProjectState();
			const pageState = project?.pages[0];
			return {
				imageId: pageState?.imageId,
				textLayerIds: pageState?.textLayers?.map((layer) => layer.id) ?? [],
				textLayerTexts: pageState?.textLayers?.map((layer) => layer.text) ?? [],
			};
		});
		expect(seededPage).toEqual({
			imageId: "flow903-text-fx-base",
			textLayerIds: ["flow903-scream", "flow903-dungeon", "flow903-romance"],
			textLayerTexts: ["กรี๊ด!", "MANA", "Rose"],
		});

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
			"pages/001_flow903-text-fx-base_merged.png",
		]);

		const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
		expect(manifest.pages[0]).toMatchObject({
			pageIndex: 0,
			pageNumber: 1,
			imageId: "flow903-text-fx-base",
			filename: "001_flow903-text-fx-base_merged.png",
			width: 900,
			height: 1350,
		});
		expect(manifest.pages[0].layerCount).toBeGreaterThanOrEqual(1);

		const png = entries["pages/001_flow903-text-fx-base_merged.png"];
		expect(readPngSize(png)).toEqual({ width: 900, height: 1350 });
		const pixelProof = await collectTextFxPixelProof(page, png);
		await mkdir(PROOF_DIR, { recursive: true });
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-text-fx-export.png`, png);
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-text-fx-pixel-proof.json`,
			JSON.stringify(pixelProof, null, 2),
		);
		expect(pixelProof.screamPaleFill).toBeGreaterThan(250);
		expect(pixelProof.screamDeepRed).toBeGreaterThan(250);
		expect(pixelProof.dungeonBlueFill).toBeGreaterThan(200);
		expect(pixelProof.dungeonDarkStroke).toBeGreaterThan(200);
		expect(pixelProof.romanceWarmFill).toBeGreaterThan(160);

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
			path: `${PROOF_DIR}/${testInfo.project.name}-text-fx-pages.png`,
			fullPage: true,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-text-fx-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
