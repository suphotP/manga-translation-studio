import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow717-pages-credit-export-gate";

async function openRequiredCreditPages(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		const project = window.__mangaWorkflowDebug!.getProjectState();
		if (!project) throw new Error("Expected seeded project");
		project.creditPolicy = "required";
		for (const pageState of project.pages) {
			pageState.textLayers = (pageState.textLayers ?? []).filter((layer) => layer.sourceCategory !== "credit");
			pageState.imageLayers = (pageState.imageLayers ?? []).filter((layer) => layer.role !== "credit");
		}
		window.__mangaWorkflowDebug!.openView("pages");
	});
	await page.getByRole("region", { name: "หน้าในงาน" }).waitFor({ state: "visible" });
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const visible = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0
				&& rect.height > 0
				&& rect.bottom > 0
				&& rect.right > 0
				&& rect.top < innerHeight
				&& rect.left < innerWidth
				&& style.display !== "none"
				&& style.visibility !== "hidden"
				&& style.opacity !== "0";
		};
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
			.filter(visible)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				const text = element instanceof HTMLElement ? element.innerText : "";
				return {
					text: text.trim().replace(/\s+/g, " "),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
					disabled: element instanceof HTMLButtonElement
						|| element instanceof HTMLInputElement
						|| element instanceof HTMLSelectElement
						|| element instanceof HTMLTextAreaElement
						? element.disabled
						: false,
				};
			});
		const creditGate = document.querySelector(".pages-credit-gate")?.getBoundingClientRect();
		const body = document.body.innerText;
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - window.innerWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
			disabledVisible: controls.filter((control) => control.disabled),
			creditGate: creditGate
				? {
					width: Math.round(creditGate.width),
					height: Math.round(creditGate.height),
					top: Math.round(creditGate.top),
					bottom: Math.round(creditGate.bottom),
				}
				: null,
			requiredCopy: body.includes("Public/Export ต้องมีเครดิต"),
			blockedKpi: body.includes("Public/Export ติดเครดิต"),
			falseReadyCopy: body.includes("พร้อม Export") && !body.includes("Public/Export ติดเครดิต"),
		};
	});
}

test.describe("Flow717 Pages credit export gate", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "Chromium visual proof only");

	test("shows required-credit public export blocker and routes to the credit workflow", async ({ page }, testInfo) => {
		test.skip(testInfo.project.name.includes("mobile"), "Credit gate proof targets desktop/tablet opened workflow.");
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});

		await openRequiredCreditPages(page);

		const pages = page.getByRole("region", { name: "หน้าในงาน" });
		const gate = page.getByRole("region", { name: "เครดิตก่อน Public/Export" });
		await expect(pages).toContainText("Public/Export ติดเครดิต");
		await expect(gate).toContainText("Public/Export ต้องมีเครดิต");
		await expect(gate).toContainText("เพิ่มเครดิตก่อนส่งออกชุดขาย");
		await expect(gate).toContainText("Draft/Internal ยังตรวจหน้าได้ต่อ");
		await expect(gate.getByRole("button", { name: "เปิดเครดิต" })).toBeVisible();
		await expect(page.getByText("ตอนพร้อม Export แล้ว")).toHaveCount(0);

		const beforeMetrics = await collectMetrics(page);
		expect(beforeMetrics.requiredCopy).toBe(true);
		expect(beforeMetrics.blockedKpi).toBe(true);
		expect(beforeMetrics.falseReadyCopy).toBe(false);
		expect(beforeMetrics.creditGate?.width ?? 0).toBeGreaterThan(300);
		expect(beforeMetrics.creditGate?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(beforeMetrics.overflowX).toBe(0);
		expect(beforeMetrics.bodyOverflowX).toBe(0);
		expect(beforeMetrics.under40).toEqual([]);
		expect(beforeMetrics.disabledVisible).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-pages-credit-gate.png`,
			fullPage: false,
		});

		await gate.getByRole("button", { name: "เปิดเครดิต" }).click();
		await page.waitForURL(/\/projects\/[^/]+\/pages\/1\/editor$/);
		await page.getByRole("region", { name: "เส้นทางหน้าที่กำลังแก้" }).waitFor({ state: "visible" });
		await expect(page.getByText("สร้าง / วาง / ลบเครดิต")).toBeVisible();
		await expect(page.locator("#credit-text")).toBeVisible();
		await expect(page.getByRole("button", { name: "นำเข้ารูปเครดิต" })).toBeVisible();
		await page.waitForFunction(() => {
			const visible = (element: Element) => {
				const rect = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				return rect.width > 0
					&& rect.height > 0
					&& rect.bottom > 0
					&& rect.right > 0
					&& rect.top < innerHeight
					&& rect.left < innerWidth
					&& style.display !== "none"
					&& style.visibility !== "hidden"
					&& style.opacity !== "0";
			};
			return Array.from(document.querySelectorAll("button, input, select, textarea"))
				.filter(visible)
				.every((element) => !(element instanceof HTMLButtonElement
					|| element instanceof HTMLInputElement
					|| element instanceof HTMLSelectElement
					|| element instanceof HTMLTextAreaElement) || !element.disabled);
		});

		const afterMetrics = await collectMetrics(page);
		expect(afterMetrics.overflowX).toBe(0);
		expect(afterMetrics.bodyOverflowX).toBe(0);
		expect(afterMetrics.under40).toEqual([]);
		expect(afterMetrics.disabledVisible).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-credit-workflow-opened.png`,
			fullPage: false,
		});
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-metrics.json`, JSON.stringify({
			beforeMetrics,
			afterMetrics,
			consoleIssues,
		}, null, 2));
	});
});
