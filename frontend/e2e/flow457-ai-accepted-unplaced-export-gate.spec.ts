import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const FLOW464_VISIBLE_BANS = [
	"Flow208",
	"flow208",
	"Prototype Journey",
	"FLOW208 PAGE",
	"AI RESULT",
	"debug-provider",
	"flow208-page",
	"flow208-ai-result",
	"flow208-export",
	"production sample",
	"rev ",
];

async function waitForDebug(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
}

async function forceAcceptedUnplaced(page: Page) {
	return page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		const state = await window.__mangaWorkflowDebug!.markAcceptedAiResultUnplaced();
		window.__mangaWorkflowDebug!.openView("pages");
		return state;
	});
}

test.describe("Flow457 accepted AI result export gate", () => {
	test("keeps accepted-but-unplaced AI results visibly blocked on Pages", async ({ page }) => {
		await waitForDebug(page);
		const state = await forceAcceptedUnplaced(page);

		expect(state.markerId).toBeTruthy();
		const nextAction = page.getByRole("region", { name: "งานถัดไปในหน้า" });
		await expect(nextAction).toContainText("วางผล AI ก่อน Export");
		await expect(nextAction).toContainText("Export ยังไม่พร้อม");
		await expect(nextAction).toContainText("ผล AI ผ่านแล้วแต่ยังไม่วาง");
		await expect(nextAction.getByRole("button", { name: "พรีวิวงาน หน้า 1" })).toBeVisible();
		await expect(nextAction).not.toContainText("AI ผ่านแล้วรอวาง");
		await expect(nextAction.locator(".pages-next-frame i")).toBeVisible();
		await expect(nextAction.getByRole("button", { name: "วางเลเยอร์ AI หน้า 1" })).toBeVisible();
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("Export ยังไม่พร้อม");
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).not.toContainText("ตอนพร้อม Export แล้ว");
		await expect(page.getByText("2/2 พร้อม Export")).toHaveCount(0);
		await expect(page.getByText("1 พร้อม Export")).toHaveCount(0);
		await expect(page.getByText("0 ส่งออกตอนนี้")).toBeVisible();

		const metrics = await page.evaluate((bannedTerms) => ({
			exportReadyCount: window.__mangaWorkflowDebug!.getState().exportReadyCount,
			attentionCount: window.__mangaWorkflowDebug!.getState().attentionCount,
			batchExportStatus: window.__mangaWorkflowDebug!.getState().batchExportStatus,
			acceptedUnplacedCopy: document.body.textContent?.includes("ผล AI ผ่านแล้วแต่ยังไม่วาง") ?? false,
			creatorPreviewCopy: document.body.textContent?.includes("กรอบทองคือพื้นที่ที่ต้องวางเป็นเลเยอร์") ?? false,
			oldFalseReady: document.body.textContent?.includes("ตอนพร้อม Export แล้ว") ?? false,
			nextActionButton: document.querySelector(".next-action-buttons button")?.textContent?.trim() ?? "",
			previewFrame: (() => {
				const frame = document.querySelector(".pages-next-frame")?.getBoundingClientRect();
				const target = document.querySelector(".pages-next-frame i")?.getBoundingClientRect();
				return {
					width: frame?.width ?? 0,
					height: frame?.height ?? 0,
					targetWidth: target?.width ?? 0,
					targetHeight: target?.height ?? 0,
				};
			})(),
			overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
			under36: [...document.querySelectorAll("button, [role='button'], input, select, textarea")]
				.map((el) => {
					const rect = el.getBoundingClientRect();
					const style = getComputedStyle(el);
					return {
						text: el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName,
						width: rect.width,
						height: rect.height,
						visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
					};
				})
				.filter((item) => item.visible && (item.width < 36 || item.height < 36)),
			bannedVisibleTerms: bannedTerms.filter((term) => document.body.innerText.includes(term)),
		}), FLOW464_VISIBLE_BANS);
		expect(metrics.exportReadyCount).toBeLessThan(2);
		expect(metrics.attentionCount).toBeGreaterThan(0);
		expect(metrics.batchExportStatus).not.toBe("done");
		expect(metrics.acceptedUnplacedCopy).toBe(true);
		expect(metrics.creatorPreviewCopy).toBe(true);
		expect(metrics.oldFalseReady).toBe(false);
		expect(metrics.nextActionButton).toBe("วางเลเยอร์ AI หน้า 1");
		expect(metrics.previewFrame.width).toBeGreaterThan(36);
		expect(metrics.previewFrame.height).toBeGreaterThan(48);
		expect(metrics.previewFrame.targetWidth).toBeGreaterThan(0);
		expect(metrics.previewFrame.targetHeight).toBeGreaterThan(0);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under36).toEqual([]);
		expect(metrics.bannedVisibleTerms).toEqual([]);

		await mkdir("../.codex-dev-logs/visual-checks/flow464-demo-identity-cleanup", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow464-demo-identity-cleanup/${test.info().project.name}-accepted-unplaced-pages.png`,
			fullPage: false,
		});
	});
});
