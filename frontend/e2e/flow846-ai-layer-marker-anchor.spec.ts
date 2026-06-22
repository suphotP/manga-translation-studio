import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow846-ai-layer-marker-anchor";

async function seedSamePageAiResults(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	return page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		return window.__mangaWorkflowDebug!.seedSamePageAiResultVariants();
	});
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const appliedRail = document.querySelector<HTMLButtonElement>('[aria-label="เปิดผล AI P1 Clean Pro วางแล้ว พื้นที่ 515,650 / 250x160"]');
		const reviewRail = document.querySelector<HTMLButtonElement>('[aria-label="เปิดผล AI P1 Clean Pro รอตรวจ ผลพร้อม พื้นที่ 110,310 / 220x145"]');
		const debugState = window.__mangaEditorDebug!.getState();
		const focusedImageStyle = debugState.imageLayerStyles.find((style: any) => style.layerData?.id === "ai-result-flow564-ai-applied") ?? null;
		const focusCard = document.querySelector('[aria-label="ผล AI ที่เลือก"]');
		const controls = Array.from(document.querySelectorAll("button, input, select, textarea"));
		return {
			activeLayerId: debugState.activeLayerId,
			appliedRailSelected: appliedRail?.classList.contains("selected") ?? false,
			reviewRailSelected: reviewRail?.classList.contains("selected") ?? false,
			focusedImageStyle: focusedImageStyle
				? {
					hasControls: focusedImageStyle.hasControls,
					hasBorders: focusedImageStyle.hasBorders,
					left: Math.round(focusedImageStyle.left ?? 0),
					top: Math.round(focusedImageStyle.top ?? 0),
				}
				: null,
			focusText: focusCard?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			under40: controls
				.filter((control) => {
					const rect = control.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
				})
				.map((control) => {
					const rect = control.getBoundingClientRect();
					return {
						text: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName,
						width: Math.round(rect.width),
						height: Math.round(rect.height),
					};
				})
				.filter((item) => item.width < 40 || item.height < 40),
		};
	});
}

test.describe("Flow846 AI selected-layer marker anchor", () => {
	test("selected applied AI layer owns rail, region, and review focus even after another marker was selected", async ({ page }, testInfo: TestInfo) => {
		const consoleIssues: string[] = [];
		const ignoredStartupIssues: string[] = [];
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			const issue = `${message.type()}: ${message.text()}`;
			if (issue.includes("Failed to load resource") || issue.includes("[ProjectStore] loadRecentProjects error")) {
				ignoredStartupIssues.push(issue);
				return;
			}
			consoleIssues.push(issue);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedSamePageAiResults(page);
		const reviewRail = page.getByRole("button", { name: "เปิดผล AI P1 Clean Pro รอตรวจ ผลพร้อม พื้นที่ 110,310 / 220x145" });
		await reviewRail.click();
		await expect(reviewRail).toHaveClass(/selected/);

		await page.evaluate(() => window.__mangaEditorDebug!.selectImageLayer("ai-result-flow564-ai-applied"));
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("ai-result-flow564-ai-applied");
		await expect(page.getByLabel("ผล AI ที่เลือก")).toContainText("แก้ต่อที่เลเยอร์ AI");

		const metrics = await collectMetrics(page);
		expect(metrics.activeLayerId).toBe("ai-result-flow564-ai-applied");
		expect(metrics.appliedRailSelected).toBe(true);
		expect(metrics.reviewRailSelected).toBe(false);
		expect(metrics.focusedImageStyle?.hasControls).toBe(true);
		expect(metrics.focusedImageStyle?.hasBorders).toBe(true);
		expect(metrics.focusText).toContain("แก้ต่อที่เลเยอร์ AI");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-ai-layer-marker-anchor.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues, ignoredStartupIssues }, null, 2),
		);
	});
});
