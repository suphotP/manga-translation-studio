import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow647-brush-restore-receipt";

async function waitForDebug(page: Page) {
	await page.route("**/api/project", async (route) => {
		if (route.request().method() !== "GET") {
			await route.fallback();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ projects: [] }),
		});
	});
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
}

async function openEditorView(page: Page) {
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("editor"));
	await page.waitForFunction(() => {
		const root = document.querySelector(".editor-root");
		return Boolean(root && !root.classList.contains("workspace-dashboard-view") && !root.classList.contains("workspace-focus-view"));
	});
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

async function seedSelectedBrushLayer(page: Page) {
	await waitForDebug(page);
	await openEditorView(page);
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({
			width: 900,
			height: 1350,
			label: "Flow647 Brush Restore Receipt",
		});
		await window.__mangaEditorDebug!.addImageLayers([
			{
				id: "flow647-brush-layer",
				name: "Flow647 brush target",
				imageId: "flow647-brush-layer.png",
				imageName: "flow647-brush-layer.png",
				originalName: "flow647-brush-layer.png",
				x: 180,
				y: 260,
				w: 360,
				h: 260,
				rotation: 0,
				opacity: 1,
				visible: true,
				locked: false,
				index: 0,
				role: "overlay",
				fill: "#0ea5e9",
			},
		]);
		window.__mangaEditorDebug!.selectImageLayer("flow647-brush-layer");
	});
	await openRightPanel(page, "เลเยอร์");
}

async function brushAtSourcePoint(page: Page, sourcePoint: { x: number; y: number }) {
	const point = await page.evaluate((input) => (
		window.__mangaEditorDebug!.imageLayerSourcePointToClient("flow647-brush-layer", input)
	), sourcePoint);
	if (!point) throw new Error("Could not map selected image layer source point");
	await page.mouse.move(point.x, point.y);
	await page.mouse.down();
	await page.mouse.move(point.x + 12, point.y + 6, { steps: 3 });
	await page.mouse.up();
}

async function clickRestoreBrushMode(page: Page) {
	const restoreButton = page.getByRole("button", { name: "คืนรอยปัด" });
	if (!(await restoreButton.first().isVisible())) {
		await page.getByRole("button", { name: /โหมด\/เป้าหมาย/ }).click();
	}
	await restoreButton.click();
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const visibleControls = Array.from(document.querySelectorAll('[aria-label="แปรง Clean กำลังแก้เลเยอร์ที่เลือก"] button'))
			.filter((control) => {
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
			stripText: document.querySelector('[aria-label="แปรง Clean กำลังแก้เลเยอร์ที่เลือก"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			hudText: document.querySelector('[aria-label="เป้าหมายแปรง"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			brush: window.__mangaEditorDebug!.getState().brush,
			layer: window.__mangaEditorDebug!.getState().imageLayers.find((item: { id: string }) => item.id === "flow647-brush-layer") ?? null,
		};
	});
}

test.describe("Flow647 selected image Clean brush restore receipt", () => {
	test("shows restore-specific receipt after using คืนรอยปัด on a selected image layer", async ({ page }, testInfo: TestInfo) => {
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedSelectedBrushLayer(page);
		await page.getByLabel("คำสั่งแก้รูปเสริมหลัก").getByRole("button", { name: "แปรง Clean" }).click();
		await brushAtSourcePoint(page, { x: 92, y: 92 });
		await expect(page.getByLabel("แปรง Clean กำลังแก้เลเยอร์ที่เลือก")).toContainText("คลีนแล้ว");

		await clickRestoreBrushMode(page);
		await brushAtSourcePoint(page, { x: 92, y: 92 });
		await expect(page.getByLabel("แปรง Clean กำลังแก้เลเยอร์ที่เลือก")).toContainText("คืนรอยปัดแล้ว");
		await expect(page.getByLabel("แปรง Clean กำลังแก้เลเยอร์ที่เลือก")).toContainText("คืนรอยปัดบนเลเยอร์นี้แล้ว");
		await expect(page.getByRole("status", { name: "เป้าหมายแปรง" })).toContainText("คืนรอยปัดบนเลเยอร์นี้แล้ว");

		const metrics = await collectMetrics(page);
		expect(metrics.brush.selectedImageLayerId).toBe("flow647-brush-layer");
		expect(metrics.brush.lastImageLayerBrushCommit?.mode).toBe("restore");
		expect(metrics.layer?.restoreImageId).toBe("flow647-brush-layer.png");
		expect(metrics.stripText).toContain("คืนรอยปัดแล้ว");
		expect(metrics.stripText).not.toContain("คลีนแล้ว");
		expect(metrics.hudText).toContain("คืนรอยปัดบนเลเยอร์นี้แล้ว");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-restore-receipt.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues }, null, 2),
		);
	});
});
