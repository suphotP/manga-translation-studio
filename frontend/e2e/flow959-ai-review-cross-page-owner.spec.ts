import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow959-ai-review-cross-page-owner";

async function seedCrossPageAppliedResult(page: Page, projectId: string) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	return page.evaluate(async (seedProjectId) => {
		await window.__mangaWorkflowDebug!.seedProject({ projectId: seedProjectId });
		return window.__mangaWorkflowDebug!.seedCrossPageAppliedAiResult();
	}, projectId);
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const project = window.__mangaWorkflowDebug!.getProjectState();
		const editorState = window.__mangaEditorDebug!.getState();
		const controls = Array.from(document.querySelectorAll("button, input, select, textarea"));
		return {
			currentPage: project?.currentPage ?? null,
			activeLayerId: editorState.activeLayerId ?? null,
			pathText: document.querySelector('[aria-label="เส้นทางหน้าปัจจุบัน"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			focusText: document.querySelector('[aria-label="ผล AI ที่เลือก"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			under40: controls
				.filter((control) => {
					const rect = control.getBoundingClientRect();
					const style = getComputedStyle(control);
					return rect.width > 0
						&& rect.height > 0
						&& rect.bottom >= 0
						&& rect.top <= window.innerHeight
						&& style.display !== "none"
						&& style.visibility !== "hidden";
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

test.describe("Flow959 AI Review cross-page owner", () => {
	test("chapter AI review opens the destination page before selecting the applied AI layer", async ({ page }, testInfo: TestInfo) => {
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (!["error", "warning"].includes(message.type())) return;
			const issue = `${message.type()}: ${message.text()}`;
			if (issue.includes("[ProjectStore] loadRecentProjects error")) return;
			consoleIssues.push(issue);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		const projectId = `flow959-${testInfo.project.name}`;
		const seeded = await seedCrossPageAppliedResult(page, projectId);
		expect(seeded.markerId).toBe("flow959-cross-page-applied");

		const aiSectionButton = page.getByRole("button", { name: /ตรวจผล AI .*อยู่/ }).first();
		if (await aiSectionButton.getAttribute("aria-expanded") !== "true") {
			await aiSectionButton.click();
		}
		await page.getByRole("button", { name: "ดูผล AI ทั้งตอน 1 ผล" }).click();
		await expect(page.getByLabel("ผล AI ที่เลือก")).toContainText("P2");
		await page.getByRole("button", { name: "เปิดเลเยอร์ AI" }).click();

		await expect.poll(() => page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.currentPage)).toBe(1);
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("ai-result-flow959-cross-page-applied");
		await expect(page.getByLabel("เส้นทางหน้าปัจจุบัน")).toContainText("หน้า 2");

		const metrics = await collectMetrics(page);
		expect(metrics.currentPage).toBe(1);
		expect(metrics.activeLayerId).toBe("ai-result-flow959-cross-page-applied");
		expect(metrics.pathText).toContain("หน้า 2");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-cross-page-ai-owner.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues }, null, 2),
		);
	});
});
