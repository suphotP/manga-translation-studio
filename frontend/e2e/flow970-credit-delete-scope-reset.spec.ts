import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow970-credit-delete-scope-reset";

async function openEditorWithCredits(page: Page): Promise<void> {
	await page.goto("/projects/flow208-project/pages/1/editor");
	await page.waitForFunction(() => Boolean(window.__mangaEditorDebug && window.__mangaWorkflowDebug));
	await expect(page.getByLabel("เส้นทางหน้าที่กำลังแก้")).toBeVisible();
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({
			width: 1200,
			height: 1800,
			label: "FLOW970",
		});
		const creditLayers = [
			{
				id: "flow970-credit-a",
				name: "Credit A",
				text: "Scan / Typeset",
				x: 160,
				y: 1400,
				w: 320,
				h: 80,
				rotation: 0,
				fontSize: 28,
				fontFamily: "Arial",
				fill: "#ffffff",
				stroke: "#111111",
				strokeWidth: 2,
				alignment: "center",
				index: 0,
				visible: true,
				locked: false,
				sourceCategory: "credit",
			},
			{
				id: "flow970-credit-b",
				name: "Credit B",
				text: "QC / Lettering",
				x: 620,
				y: 1400,
				w: 320,
				h: 80,
				rotation: 0,
				fontSize: 28,
				fontFamily: "Arial",
				fill: "#ffffff",
				stroke: "#111111",
				strokeWidth: 2,
				alignment: "center",
				index: 1,
				visible: true,
				locked: false,
				sourceCategory: "credit",
			},
		];
		window.__mangaWorkflowDebug!.setCurrentPageTextLayersForTesting(creditLayers);
		window.__mangaEditorDebug!.addTextLayers(creditLayers);
	});
	await page.evaluate(() => window.__mangaEditorDebug!.selectTextLayer("flow970-credit-a"));
	await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("flow970-credit-a");
	await expect(page.getByLabel(/เลเยอร์ที่เลือก: Credit A/)).toBeVisible();
}

async function openCreditDeleteScope(page: Page): Promise<void> {
	const collapsedCreditToggle = page.getByRole("button", { name: "เครดิต พับอยู่" });
	if (await collapsedCreditToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
		await collapsedCreditToggle.click();
	}
	const manageCredit = page.getByRole("button", { name: "เพิ่ม/จัดการเครดิตอื่น" });
	await expect(manageCredit).toBeVisible();
	await manageCredit.scrollIntoViewIfNeeded();
	await manageCredit.click();
	await expect(page.getByLabel("ลบเครดิตแบบเลือกขอบเขต")).toBeVisible();
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const scope = document.querySelector("#credit-delete-scope") as HTMLSelectElement | null;
		const deleteCard = document.querySelector(".credit-delete-quick-card") as HTMLElement | null;
		const scopeDetail = document.querySelector(".credit-delete-scope-detail") as HTMLElement | null;
		const viewportWidth = document.documentElement.clientWidth;
		const under40 = Array.from(document.querySelectorAll("button, [role='button'], select"))
			.map((element) => {
				const rect = element.getBoundingClientRect();
				const label = element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName;
				return { height: Math.round(rect.height), label, width: Math.round(rect.width) };
			})
			.filter((item) => item.width > 0 && item.height > 0 && (item.width < 40 || item.height < 40));
		return {
			bodyOverflowX: Math.max(0, document.body.scrollWidth - viewportWidth),
			deleteCardText: deleteCard?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			overflowX: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
			scopeDetailText: scopeDetail?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			scopeText: scope?.selectedOptions?.[0]?.textContent ?? null,
			scopeValue: scope?.value ?? null,
			under40,
		};
	});
}

test.describe("Flow970 credit delete scope reset", () => {
	test("keeps credit delete scoped to the newly selected credit", async ({ page }, testInfo) => {
			await openEditorWithCredits(page);
			await openCreditDeleteScope(page);

			await page.getByLabel("เลือกขอบเขตลบเครดิต").selectOption("chapter-all");
			await expect(page.getByLabel("เลือกขอบเขตลบเครดิต")).toHaveValue("chapter-all");

			await page.evaluate(() => window.__mangaEditorDebug!.selectTextLayer("flow970-credit-b"));
			await expect.poll(() => page.evaluate(() => window.__mangaEditorDebug!.getState().activeLayerId)).toBe("flow970-credit-b");
			await expect(page.getByLabel(/เลเยอร์ที่เลือก: Credit B/)).toBeVisible();
			await expect(page.getByLabel("เลือกขอบเขตลบเครดิต")).toHaveValue("selected");

			const metrics = await collectMetrics(page);
			expect(metrics.scopeValue).toBe("selected");
			expect(metrics.scopeText).toBe("เฉพาะเครดิตที่เลือก");
			expect(metrics.deleteCardText).toContain("QC / Lettering");
			expect(metrics.scopeDetailText).toBe("QC / Lettering / ลบจากหน้านี้เท่านั้น");
			expect(metrics.overflowX).toBe(0);
			expect(metrics.bodyOverflowX).toBe(0);
			expect(metrics.under40).toEqual([]);

			await mkdir(PROOF_DIR, { recursive: true });
			await page.screenshot({ path: `${PROOF_DIR}/${testInfo.project.name}-credit-delete-scope-reset.png`, fullPage: false });
			await writeFile(`${PROOF_DIR}/${testInfo.project.name}-metrics.json`, JSON.stringify(metrics, null, 2));
	});
});
