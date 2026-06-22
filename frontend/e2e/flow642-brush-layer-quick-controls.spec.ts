import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow642-brush-layer-quick-controls";

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

async function setRangeValue(locator: ReturnType<Page["getByLabel"]>, value: number) {
	await locator.evaluate((input, nextValue) => {
		const range = input as HTMLInputElement;
		range.value = String(nextValue);
		range.dispatchEvent(new Event("input", { bubbles: true }));
	}, value);
}

async function seedSelectedBrushLayer(page: Page) {
	await waitForDebug(page);
	await openEditorView(page);
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({
			width: 900,
			height: 1350,
			label: "Flow642 Brush Layer",
		});
		await window.__mangaEditorDebug!.addImageLayers([
			{
				id: "flow642-brush-layer",
				name: "Flow642 brush target",
				imageId: "flow642-brush-layer.png",
				imageName: "flow642-brush-layer.png",
				originalName: "flow642-brush-layer.png",
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
		window.__mangaEditorDebug!.selectImageLayer("flow642-brush-layer");
	});
	await openRightPanel(page, "เลเยอร์");
}

async function collectBrushMetrics(page: Page) {
	return page.evaluate(() => {
		const viewportWidth = document.documentElement.clientWidth;
		const controls = Array.from(document.querySelectorAll(".tool-options-bar .brush-options input, .tool-options-bar .brush-options button"));
		const visibleControls = controls.filter((control) => {
			const rect = control.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
		});
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
			duplicateLayerControls: document.querySelectorAll(".selected-image-brush-presets, .selected-image-brush-fine-tune, [aria-label='โหมดแปรง Clean ของเลเยอร์ที่เลือก']").length,
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
			ownerText: document.querySelector('[aria-label="เจ้าของการตั้งค่าแปรง Clean"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			topbarText: document.querySelector(".tool-options-bar .brush-options")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			brush: window.__mangaEditorDebug!.getState().brush,
		};
	});
}

test.describe("Flow642 selected image Clean brush quick controls", () => {
	test("keeps brush sizing in the top options bar while Layers only names the target", async ({ page }, testInfo: TestInfo) => {
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedSelectedBrushLayer(page);
		await page.getByLabel("คำสั่งแก้รูปเสริมหลัก").getByRole("button", { name: "แปรง Clean" }).click();
		await expect(page.getByLabel("แปรง Clean กำลังแก้เลเยอร์ที่เลือก")).toContainText("ภาพฐานไม่ถูกแตะ");
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().brush.selectedImageLayerId)).toBe("flow642-brush-layer");

		await setRangeValue(page.getByLabel("ขนาดแปรง (px)"), 72);
		await expect(page.locator(".tool-options-bar .brush-options")).toContainText("72 px");

		const metrics = await collectBrushMetrics(page);
		expect(metrics.brush.size).toBe(72);
		expect(metrics.brush.opacity).toBe(100);
		expect(metrics.brush.selectedImageLayerId).toBe("flow642-brush-layer");
		expect(metrics.stripText).toContain("Flow642 brush target");
		expect(metrics.ownerText).toContain("ตั้งขนาด, ความทึบ, โหมดลบ/กู้คืนที่แถบบน");
		expect(metrics.ownerText).toContain("72px / 100% / ลบภาพ");
		expect(metrics.topbarText).toContain("กำลังแก้ไข: Flow642 brush target");
		expect(metrics.duplicateLayerControls).toBe(0);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-layers-brush-quick-controls.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues }, null, 2),
		);
	});

	test("keeps the canvas cursor blocked after the selected brush layer is locked", async ({ page }, testInfo: TestInfo) => {
		await seedSelectedBrushLayer(page);
		await page.getByLabel("คำสั่งแก้รูปเสริมหลัก").getByRole("button", { name: "แปรง Clean" }).click();
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().brush.defaultCursor)).toBe("crosshair");

		await page.evaluate(() => window.__mangaEditorDebug!.updateImageLayer("flow642-brush-layer", { locked: true }));
		await page.evaluate(() => window.__mangaEditorDebug!.setTool("brush"));
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().brush.defaultCursor)).toBe("not-allowed");

		const metrics = await collectBrushMetrics(page);
		expect(metrics.brush.selectedImageLayerId).toBe("flow642-brush-layer");
		expect(metrics.brush.defaultCursor).toBe("not-allowed");
		expect(metrics.topbarText).toContain("เลือกเลเยอร์รูปหรือผล AI ก่อนใช้แปรง");
		expect(metrics.topbarText).not.toContain("ขนาด:");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-locked-target-cursor-blocked.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-locked-target-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
