import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow876-editor-readiness-bridge";

async function installLocalPreauthBackendFallbacks(page: Page) {
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
	await page.route("**/api/ai/capabilities", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				tiers: [
					{ id: "sfx-pro", label: "SFX Pro", provider: "local", available: true, reason: null, detail: "Local proof fallback" },
					{ id: "clean-pro", label: "Clean Pro", provider: "local", available: true, reason: null, detail: "Local proof fallback" },
				],
			}),
		});
	});
}

async function openPostEditEditorWithReviewTask(page: Page) {
	await installLocalPreauthBackendFallbacks(page);
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		const project = window.__mangaWorkflowDebug!.getProjectState();
		if (!project) throw new Error("Expected seeded project");
		project.pages[0].textLayers = [{
			id: "flow876-ready-text",
			text: "พร้อมตรวจ",
			x: 96,
			y: 160,
			w: 240,
			h: 72,
			rotation: 0,
			fontSize: 36,
			alignment: "center",
			index: 0,
		} as any];
		project.tasks = [{
			id: "flow876-review-task",
			type: "review",
			status: "todo",
			priority: "high",
			pageIndex: 0,
			pageImageId: project.pages[0].imageId,
			title: "Review page 1",
			createdAt: "2026-05-23T00:00:00.000Z",
			updatedAt: "2026-05-23T00:00:00.000Z",
		} as any];
		window.__mangaWorkflowDebug!.openView("editor");
	});
	await page.getByRole("region", { name: "เส้นทางหน้าที่กำลังแก้" }).waitFor({ state: "visible" });
	await expect(page.getByRole("button", { name: /เปิด Focus หน้านี้:/ })).toBeVisible();
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
		const controls = Array.from(document.querySelectorAll("button, input, select, textarea"))
			.filter(visible)
			.map((control) => {
				const rect = control.getBoundingClientRect();
				return {
					text: control.getAttribute("aria-label") ?? control.textContent?.replace(/\s+/g, " ").trim() ?? control.tagName,
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		const bridge = Array.from(document.querySelectorAll("button"))
			.find((button) => (button.getAttribute("aria-label") ?? "").includes("เปิด Focus หน้านี้"));
		const bridgeRect = bridge?.getBoundingClientRect();
		return {
			path: window.location.pathname,
			bridgeText: bridge?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			bridgeAria: bridge?.getAttribute("aria-label") ?? "",
			bridgeBox: bridgeRect ? {
				width: Math.round(bridgeRect.width),
				height: Math.round(bridgeRect.height),
				top: Math.round(bridgeRect.top),
				bottom: Math.round(bridgeRect.bottom),
			} : null,
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
		};
	});
}

test.describe("Flow876 editor readiness bridge", () => {
	test("routes post-edit current-page blockers from editor to Focus without hiding in tools", async ({ page }, testInfo: TestInfo) => {
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await openPostEditEditorWithReviewTask(page);
		const before = await collectMetrics(page);
		expect(before.bridgeText).toContain("เปิด Focus หน้านี้");
		expect(before.bridgeAria).toContain("หน้า 1");
		expect(before.bridgeAria).toContain("พร้อมตรวจ");
		expect(before.bridgeBox?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(before.overflowX).toBe(0);
		expect(before.bodyOverflowX).toBe(0);
		expect(before.under40).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-editor-readiness-bridge.png`,
			fullPage: false,
		});

		await page.getByRole("button", { name: /เปิด Focus หน้านี้:/ }).click();
		await expect(page).toHaveURL(/\/projects\/flow208-project\/focus\/[^/]+$/);
		await expect(page.locator(".editor-root.workspace-focus-view")).toBeVisible();
		const after = await collectMetrics(page);
		expect(after.path).toMatch(/\/projects\/flow208-project\/focus\/[^/]+$/);
		expect(after.overflowX).toBe(0);
		expect(after.bodyOverflowX).toBe(0);
		expect(consoleIssues).toEqual([]);

		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ before, after, consoleIssues }, null, 2),
		);
	});
});
