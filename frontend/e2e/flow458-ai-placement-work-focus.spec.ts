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

async function seedAcceptedUnplaced(page: Page, view: "work" | "focus" | "editor") {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	return page.evaluate(async (targetView) => {
		await window.__mangaWorkflowDebug!.seedProject();
		const state = await window.__mangaWorkflowDebug!.markAcceptedAiResultUnplaced();
		window.__mangaWorkflowDebug!.openView(targetView);
		await new Promise((resolve) => setTimeout(resolve, 300));
		return state;
	}, view);
}

async function uiMetrics(page: Page) {
	return page.evaluate((bannedTerms) => ({
		hasPlaceLayerCopy: document.body.textContent?.includes("วางเลเยอร์ AI")
			|| document.body.textContent?.includes("รอวางเลเยอร์")
			|| document.body.textContent?.includes("รอวาง"),
			hasFalseReady: document.body.textContent?.includes("ตอนพร้อม Export แล้ว")
			|| document.body.textContent?.includes("2/2 พร้อม Export"),
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
}

test.describe("Flow458 accepted AI placement handoff", () => {
	test("makes accepted-unplaced AI results actionable across Work, Focus, and Canvas", async ({ page }, testInfo) => {
		await mkdir("../.codex-dev-logs/visual-checks/flow464-demo-identity-cleanup", { recursive: true });
		await waitForDebug(page);

		await seedAcceptedUnplaced(page, "work");
		const workBoard = page.getByRole("region", { name: "บอร์ดงานตอน" });
		const soloBlocker = page.getByRole("region", { name: "คำสั่งตัวบล็อกสำหรับ solo" });
		await expect(workBoard).toContainText("วางเลเยอร์ AI หน้า 1");
		await expect(soloBlocker.getByRole("button", { name: "พรีวิวตัวบล็อก หน้า 1" })).toBeVisible();
		await expect(soloBlocker).toContainText("พื้นที่ AI ผ่านแล้ว");
		await expect(soloBlocker.locator(".blocker-region-target")).toBeVisible();
		await expect(soloBlocker.getByRole("button", { name: "วางเลเยอร์ AI" })).toBeVisible();
		await expect(page.getByRole("region", { name: "สถานะพร้อม Export ตอน" }).getByRole("button", { name: "วางเลเยอร์ AI" })).toBeVisible();
		await expect(workBoard).not.toContainText("คิวนี้เคลียร์แล้ว");
		let metrics = await uiMetrics(page);
		expect(metrics.hasPlaceLayerCopy).toBe(true);
		expect(metrics.hasFalseReady).toBe(false);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under36).toEqual([]);
		expect(metrics.bannedVisibleTerms).toEqual([]);
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow464-demo-identity-cleanup/${testInfo.project.name}-work.png`,
			fullPage: false,
		});

		await seedAcceptedUnplaced(page, "focus");
		const focusSignal = page.getByRole("region", { name: "สัญญาณตรวจ AI ที่กำลังแก้" });
		await expect(page.getByRole("heading", { name: "วางผล AI หน้า 1" })).toBeVisible();
		await expect(focusSignal).toContainText("ผ่านตรวจแล้ว แต่ Export ยังไม่พร้อม");
		await expect(focusSignal).toContainText("ผ่านตรวจ รอวางเลเยอร์");
		await expect(focusSignal.getByRole("group", { name: "พรีวิวตำแหน่งวางเลเยอร์ AI" })).toBeVisible();
		await expect(focusSignal).toContainText("กรอบทองคือพื้นที่ที่ต้องวางผล AI เป็นเลเยอร์แก้ได้");
		await expect(focusSignal.locator(".focus-ai-placement-frame i")).toBeVisible();
		await expect(focusSignal.getByRole("button", { name: "วางเลเยอร์ AI" })).toBeVisible();
		await expect(focusSignal).not.toContainText("accepted");
		await expect(focusSignal).not.toContainText("flow208-ai-result");
		metrics = await uiMetrics(page);
		expect(metrics.hasPlaceLayerCopy).toBe(true);
		expect(metrics.hasFalseReady).toBe(false);
		expect(metrics.under36).toEqual([]);
		expect(metrics.bannedVisibleTerms).toEqual([]);
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow464-demo-identity-cleanup/${testInfo.project.name}-focus.png`,
			fullPage: false,
		});
		await focusSignal.getByRole("button", { name: "วางเลเยอร์ AI" }).click();
		await expect.poll(() => page.evaluate(() => (
			window.__mangaWorkflowDebug?.getProjectState()?.pages[0]?.imageLayers?.some((layer) => layer.id === "ai-result-flow208-ai-marker-p1") ?? false
		))).toBe(true);
		await expect.poll(() => page.evaluate(() => (
			window.__mangaWorkflowDebug?.getProjectState()?.aiReviewMarkers?.find((marker) => marker.id === "flow208-ai-marker-p1")?.status
		))).toBe("applied");

		await seedAcceptedUnplaced(page, "editor");
		await expect(page.getByRole("button", { name: /เปิดพื้นที่ผล AI: ผ่านตรวจ/ })).toBeVisible();
		await expect(page.locator(".region-label", { hasText: "รอวางเลเยอร์" })).toBeVisible();
		await page.getByRole("button", { name: /เปิดแผง งาน/ }).click();
		await page.getByRole("region", { name: "ผล AI บนหน้านี้" })
			.getByRole("button", { name: /เปิดผล AI P1 .*ผ่านตรวจ ยังไม่วาง/ })
			.click();
		await expect(page.getByLabel("คำสั่งผล AI ผ่านตรวจ รอวางเลเยอร์")).toHaveCount(0);
		await expect(page.getByRole("region", { name: "ผล AI บนหน้านี้" })).not.toContainText("วาง Layer");
		const placementInspector = page.getByRole("region", { name: "AI ผ่านแล้วรอวางเป็นเลเยอร์" });
		await expect(placementInspector.getByRole("button", { name: "วางเลเยอร์ AI" })).toBeVisible();
		await expect(page.getByRole("button", { name: "วางเลเยอร์ที่คัดลอก" })).toHaveCount(0);
		await expect(page.getByRole("status", { name: "สถานะตัวแก้หน้า" })).toContainText("Export ยังไม่พร้อม");
		metrics = await uiMetrics(page);
		expect(metrics.hasPlaceLayerCopy).toBe(true);
		expect(metrics.hasFalseReady).toBe(false);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under36).toEqual([]);
		expect(metrics.bannedVisibleTerms).toEqual([]);
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow464-demo-identity-cleanup/${testInfo.project.name}-canvas.png`,
			fullPage: false,
		});
		await placementInspector.getByRole("button", { name: "วางเลเยอร์ AI" }).click();
		await expect.poll(() => page.evaluate(() => (
			window.__mangaWorkflowDebug!.getProjectState()!.pages[0].imageLayers?.some((layer) => layer.id === "ai-result-flow208-ai-marker-p1") ?? false
		))).toBe(true);
	});
});
