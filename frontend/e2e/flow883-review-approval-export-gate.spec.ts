import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow883-review-approval-export-gate";

async function seedFinalQcPendingWithoutReview(page: Page) {
	await page.route("**/api/project", async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
	});
	await page.route("**/api/ai/capabilities", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ tiers: [] }),
		});
	});
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedFinalQcPendingPage();
		window.__mangaWorkflowDebug!.openView("pages");
	});
	await page.getByRole("region", { name: "ส่งออกตอนนี้" }).waitFor({ state: "visible" });
}

async function collectMetrics(page: Page, consoleIssues: string[]) {
	return page.evaluate((issues) => {
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
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
					text: control.getAttribute("aria-label") ?? control.textContent?.trim().replace(/\s+/g, " ") ?? control.tagName,
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		const state = window.__mangaWorkflowDebug!.getState();
		return {
			path: window.location.pathname,
			statusText: document.body.innerText,
			batchExportStatus: state.batchExportStatus,
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
			consoleIssues: issues,
		};
	}, consoleIssues);
}

test.describe("Flow883 review approval export gate", () => {
	test("routes team-production pages without review approval to Work before export", async ({ page }, testInfo: TestInfo) => {
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await seedFinalQcPendingWithoutReview(page);
		const exportGate = page.getByRole("region", { name: "ส่งออกตอนนี้" });
		await expect(exportGate).toContainText("Export ยังไม่พร้อม");
		await expect(exportGate).toContainText("ยังไม่มีผลตรวจผ่านหน้า");
		await exportGate.getByRole("button", { name: "เปิดตัวค้าง" }).click();

		await expect(page).toHaveURL(/\/projects\/flow707-final-qc-pending\/work$/);
		await expect(page.getByRole("region", { name: "สถานะพร้อม Export ตอน" })).toContainText("ยัง Export ไม่ได้");
		const mainHandoff = page.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		await expect(mainHandoff).toContainText("QC · 1 หน้ารอผลตรวจ");
		await mainHandoff.getByRole("button", { name: "ไปตรวจหน้า" }).click();
		const qcBench = page.getByRole("region", { name: "QC / เครดิต" });
		await expect(qcBench).toContainText("ตรวจใน Focus");
		await qcBench.getByRole("button", { name: "ตรวจใน Focus" }).click();
		await expect(page).toHaveURL(/\/projects\/flow707-final-qc-pending\/focus\/(workflow-focus|review-task)-.*page-review-p1-/);
		const reviewRegion = page.getByRole("region", { name: "ผลตรวจของหน้าใน Focus" });
		await expect(reviewRegion).toContainText("ผ่านตรวจหรือส่งกลับแก้");
		await reviewRegion.getByRole("button", { name: "ผ่านตรวจหน้า" }).click();
		await expect(page).toHaveURL(/\/projects\/flow707-final-qc-pending\/pages$/);
		await expect(page.getByRole("region", { name: "ส่งออกตอนนี้" })).toContainText("ยังไม่ปิด QC ขั้นสุดท้าย");

		const metrics = await collectMetrics(page, consoleIssues);
		expect(metrics.batchExportStatus).not.toBe("done");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(metrics.consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-review-approval-blocker.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
