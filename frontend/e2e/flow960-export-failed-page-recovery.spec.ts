import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow960-export-failed-page-recovery";

async function waitForWorkflowDebug(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug));
}

async function seedWorkflowProject(page: Page) {
	await waitForWorkflowDebug(page);
	return page.evaluate(() => window.__mangaWorkflowDebug!.seedProject({}));
}

async function openWorkspaceView(page: Page, view: "pages") {
	await page.evaluate((target) => window.__mangaWorkflowDebug!.openView(target), view);
	await expect(page.locator(`.editor-root.workspace-${view}-view`)).toBeVisible();
}

test.describe("Flow960 export failed-page recovery", () => {
	test("shows structured failed page and opens the failed page from export history", async ({ page }, testInfo) => {
		const consoleIssues: string[] = [];
		page.on("console", (msg) => {
			if (["error", "warning"].includes(msg.type())) consoleIssues.push(`${msg.type()}: ${msg.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedWorkflowProject(page);
		await page.evaluate(() => window.__mangaWorkflowDebug!.addImageFailedExportRun());
		await openWorkspaceView(page, "pages");

		const history = page.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		await expect(history).toBeVisible();
		await expect(history.getByText("ล้มเหลวที่หน้า 2")).toBeVisible();
		await expect(history.getByText(/โหลดรูปสำหรับ Export ไม่สำเร็จ/)).toBeVisible();

		await history.getByRole("button", { name: "เปิดหน้า" }).first().click();
		await expect(page.locator(".editor-root.workspace-editor-view")).toBeVisible();
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("หน้า 2");
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug));

		const metrics = await page.evaluate(() => {
			const doc = document.documentElement;
			const under40 = Array.from(document.querySelectorAll("button, [role='button'], input, select, textarea, a"))
				.map((node) => {
					const rect = (node as HTMLElement).getBoundingClientRect();
					const label = ((node as HTMLElement).innerText || node.getAttribute("aria-label") || node.getAttribute("title") || node.tagName).trim();
					return { label, width: rect.width, height: rect.height };
				})
				.filter((item) => item.width > 0 && item.height > 0 && (item.width < 40 || item.height < 40));
			return {
				pageIndex: window.__mangaWorkflowDebug!.getState().pageIndex,
				statusText: document.querySelector("[role='status']")?.textContent ?? "",
				overflowX: Math.max(0, doc.scrollWidth - doc.clientWidth),
				under40,
			};
		});

		expect(metrics.pageIndex).toBe(1);
		expect(metrics.statusText).toContain("หน้า 2");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		mkdirSync(PROOF_DIR, { recursive: true });
		const prefix = testInfo.project.name.includes("tablet") ? "tablet" : "desktop";
		await page.screenshot({ path: join(PROOF_DIR, `${prefix}-failed-export-page-recovery.png`), fullPage: true });
		writeFileSync(join(PROOF_DIR, `${prefix}-metrics.json`), JSON.stringify({ ...metrics, consoleIssues }, null, 2));
	});
});
