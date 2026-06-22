import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow894-ai-layer-single-owner";

async function seedSamePageAiResults(page: Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	return page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		return window.__mangaWorkflowDebug!.seedSamePageAiResultVariants();
	});
}

async function ensureInspectorOpen(page: Page): Promise<void> {
	const toggled = await page.evaluate(() => {
		const root = document.querySelector(".editor-root");
		if (!root?.classList.contains("inspector-hidden")) return false;
		const opener = Array.from(document.querySelectorAll("button")).find((element) => {
			const text = (element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || "").trim();
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return text.includes("คุณสมบัติ")
				&& rect.width > 0
				&& rect.height > 0
				&& style.display !== "none"
				&& style.visibility !== "hidden";
		});
		(opener as HTMLButtonElement | undefined)?.click();
		return Boolean(opener);
	});
	if (toggled) await page.waitForTimeout(180);
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const focusCard = document.querySelector<HTMLElement>(".ai-layer-focus-card");
		const advancedDrawer = document.querySelector<HTMLDetailsElement>(".image-layer-advanced-drawer");
		const lifecycleDetails = document.querySelector<HTMLDetailsElement>(".ai-layer-lifecycle-details");
		const visibleControls = Array.from(document.querySelectorAll<HTMLElement>(".ai-layer-focus-card button, .ai-layer-focus-card input, .ai-layer-lifecycle-details summary"))
			.filter((control) => {
				const rect = control.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
			});
		return {
			activeLayerId: window.__mangaEditorDebug!.getState().activeLayerId,
			focusCardText: focusCard?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			genericAiActionRows: document.querySelectorAll('[aria-label="คำสั่งหลักผล AI ที่เลือก"]').length,
			quickBrushButtons: document.querySelectorAll('[aria-label="เปิดแปรง Clean เฉพาะผล AI ที่เลือก"]').length,
			advancedOpen: advancedDrawer?.open ?? null,
			lifecycleOpen: lifecycleDetails?.open ?? null,
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
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
		};
	});
}

test.describe("Flow894 selected AI layer single command owner", () => {
	test("keeps selected applied AI layer actions owned by the AI focus card", async ({ page }, testInfo: TestInfo) => {
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
		await ensureInspectorOpen(page);
		await page.getByRole("button", { name: /เปิดแผง เลเยอร์/ }).click();
		await expect(page.locator(".layers-inspector")).toBeVisible();
		await page.evaluate(() => window.__mangaEditorDebug!.selectImageLayer("ai-result-flow564-ai-applied"));
		await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("ai-result-flow564-ai-applied");

		await expect(page.getByLabel("งานด่วนเลเยอร์ AI ที่เลือก")).toContainText("ปรับบนผืนงานก่อนส่งออก");
		await expect(page.getByLabel("คำสั่งหลักผล AI ที่เลือก")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "เปิดแปรง Clean เฉพาะผล AI ที่เลือก" })).toHaveCount(1);
		await expect(page.getByRole("button", { name: "จัดรูปเสริมชิดซ้าย" })).toHaveCount(0);
		await expect(page.locator(".image-layer-advanced-drawer")).not.toHaveAttribute("open", "");

		await page.getByText("จัดการเลเยอร์").click();
		await expect(page.getByRole("button", { name: "คัดลอกผล AI ที่เลือก" })).toBeVisible();
		await expect(page.getByRole("button", { name: "ทำซ้ำผล AI ที่เลือก" })).toBeVisible();
		await expect(page.getByRole("button", { name: "ลบผล AI ที่เลือก" })).toBeVisible();

		const metrics = await collectMetrics(page);
		expect(metrics.activeLayerId).toBe("ai-result-flow564-ai-applied");
		expect(metrics.genericAiActionRows).toBe(0);
		expect(metrics.quickBrushButtons).toBe(1);
		expect(metrics.advancedOpen).toBe(false);
		expect(metrics.lifecycleOpen).toBe(true);
		expect(metrics.focusCardText).toContain("จัดการเลเยอร์");
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-ai-layer-single-owner.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify({ ...metrics, consoleIssues, ignoredStartupIssues }, null, 2),
		);
	});
});
