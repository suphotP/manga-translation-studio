import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow643-brush-layer-restore-mode";

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
			label: "Flow643 Brush Restore",
		});
		await window.__mangaEditorDebug!.addImageLayers([
			{
				id: "flow643-brush-layer",
				name: "Flow643 brush target",
				imageId: "flow643-brush-layer.png",
				imageName: "flow643-brush-layer.png",
				originalName: "flow643-brush-layer.png",
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
		window.__mangaEditorDebug!.selectImageLayer("flow643-brush-layer");
	});
	await openRightPanel(page, "เลเยอร์");
}

async function brushSelectedLayer(page: Page) {
	const point = await page.evaluate(() => (
		window.__mangaEditorDebug!.imageLayerSourcePointToClient("flow643-brush-layer", { x: 92, y: 92 })
	));
	if (!point) throw new Error("Could not map selected image layer source point");
	await page.mouse.move(point.x, point.y);
	await page.mouse.down();
	await page.mouse.move(point.x + 12, point.y + 6, { steps: 3 });
	await page.mouse.up();
	await expect.poll(async () => {
		const state = await page.evaluate(() => window.__mangaEditorDebug!.getState());
		return state.imageLayers.find((layer: { id: string }) => layer.id === "flow643-brush-layer")?.restoreImageId ?? null;
	}).toBe("flow643-brush-layer.png");
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
		const buttons = Array.from(document.querySelectorAll(".tool-options-bar .brush-options button"));
		const visibleButtons = buttons.filter((button) => {
			const rect = button.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
		});
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			under40: visibleButtons
				.map((button) => {
					const rect = button.getBoundingClientRect();
					return {
						text: button.textContent?.trim() ?? "",
						width: Math.round(rect.width),
						height: Math.round(rect.height),
					};
				})
				.filter((item) => item.width < 40 || item.height < 40),
			stripText: document.querySelector('[aria-label="แปรง Clean กำลังแก้เลเยอร์ที่เลือก"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			topbarText: document.querySelector(".tool-options-bar .brush-options")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			duplicateLayerModeControls: document.querySelectorAll('[aria-label="โหมดแปรง Clean ของเลเยอร์ที่เลือก"]').length,
			brush: window.__mangaEditorDebug!.getState().brush,
			layer: window.__mangaEditorDebug!.getState().imageLayers.find((item: { id: string }) => item.id === "flow643-brush-layer") ?? null,
		};
	});
}

test.describe("Flow643 selected image Clean brush restore mode", () => {
	test("reveals topbar restore mode only after a selected layer brush stroke creates a source", async ({ page }, testInfo: TestInfo) => {
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedSelectedBrushLayer(page);
		await page.getByLabel("คำสั่งแก้รูปเสริมหลัก").getByRole("button", { name: "แปรง Clean" }).click();
		await expect(page.getByLabel("แปรง Clean กำลังแก้เลเยอร์ที่เลือก")).toContainText("กู้คืนจะเปิดหลังมีรอยแปรง");
		await expect(page.getByLabel("โหมดแปรง Clean ของเลเยอร์ที่เลือก")).toHaveCount(0);
		await expect(page.locator(".tool-options-bar .brush-options")).toContainText("กู้คืน (ยังไม่มีรอยแปรง)");

		await brushSelectedLayer(page);
		await expect(page.locator(".tool-options-bar .brush-options")).toContainText("คืนรอยปัด");
		await clickRestoreBrushMode(page);
		await expect(page.getByRole("button", { name: "คืนรอยปัด" })).toHaveAttribute("aria-pressed", "true");

		const metrics = await collectMetrics(page);
		expect(metrics.brush.mode).toBe("restore");
		expect(metrics.brush.selectedImageLayerId).toBe("flow643-brush-layer");
		expect(metrics.layer?.restoreImageId).toBe("flow643-brush-layer.png");
		expect(metrics.stripText).toContain("กู้คืนพร้อมใช้");
		expect(metrics.topbarText).toContain("คืนรอยปัด");
		expect(metrics.duplicateLayerModeControls).toBe(0);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-layers-brush-restore-mode.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues }, null, 2),
		);
	});
});
