import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow847-ai-layer-source-dimensions";

async function seedAcceptedUnplacedFocus(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	return page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		await window.__mangaWorkflowDebug!.markAcceptedAiResultUnplaced();
		window.__mangaWorkflowDebug!.openView("focus");
	});
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const project = window.__mangaWorkflowDebug?.getProjectState() ?? null;
		const layer = project?.pages[0]?.imageLayers?.find((item: any) => item.id === "ai-result-flow208-ai-marker-p1") ?? null;
		const controls = Array.from(document.querySelectorAll("button, input, select, textarea"));
		return {
			activeLayerId: window.__mangaEditorDebug!.getState().activeLayerId,
			layer,
			markerStatus: project?.aiReviewMarkers?.find((marker: any) => marker.id === "flow208-ai-marker-p1")?.status ?? null,
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
			bodyText: document.body.textContent?.replace(/\s+/g, " ").trim() ?? "",
		};
	});
}

test.describe("Flow847 AI layer source dimensions", () => {
	test("placing from Focus keeps result source dimensions for later real-aspect controls", async ({ page }, testInfo: TestInfo) => {
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

		await seedAcceptedUnplacedFocus(page);
		const focusSignal = page.getByRole("region", { name: "สัญญาณตรวจ AI ที่กำลังแก้" });
		await expect(focusSignal).toContainText("ผ่านตรวจ รอวางเลเยอร์");
		await focusSignal.getByRole("button", { name: "วางเลเยอร์ AI" }).click();
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));

		await expect.poll(() => page.evaluate(() => (
			window.__mangaWorkflowDebug?.getProjectState()?.pages[0]?.imageLayers?.find((item: any) => item.id === "ai-result-flow208-ai-marker-p1")?.sourceW
		))).toBe(900);

		const metrics = await collectMetrics(page);
		expect(metrics.layer).toMatchObject({
			id: "ai-result-flow208-ai-marker-p1",
			imageId: "flow208-ai-result-p1",
			x: 110,
			y: 310,
			w: 280,
			h: 180,
			sourceW: 900,
			sourceH: 1350,
		});
		expect(metrics.markerStatus).toBe("applied");
		expect(metrics.activeLayerId).toBe("ai-result-flow208-ai-marker-p1");
		expect(metrics.bodyText).toContain("ผล AI ที่วางแล้ว");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-ai-layer-source-dimensions.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues, ignoredStartupIssues }, null, 2),
		);
	});
});
