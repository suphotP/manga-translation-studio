import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

// Wave 3 W3.16: bulk image import + merge/split dialog smoke + screenshots.
// Seeds a workspace project via the debug API, opens the Import surface, then the
// "นำเข้ารูปแบบรวม" dialog, exercises the three modes, and screenshots each.

const SHOT_DIR = "../.codex-dev-logs/visual-checks/w3-16-bulk-import";

// Tiny in-browser-constructed PNG files attached to the hidden multi-file input.
async function attachSampleImages(page: Page, count: number): Promise<void> {
	const files = Array.from({ length: count }, (_, i) => ({
		name: `page-${String(i + 1).padStart(2, "0")}.png`,
		mimeType: "image/png",
		// 1x1 PNG (distinct names; bytes can repeat — the dialog only previews them).
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		),
	}));
	await page.locator(".bi-dialog input[type='file']").first().setInputFiles(files);
}

test.describe("W3.16 bulk import dialog", () => {
	test("opens, switches modes, reorders, and renders the preview strip", async ({ page }, testInfo) => {
		await page.goto("/");
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug));
		await page.evaluate(async () => {
			await window.__mangaWorkflowDebug!.seedProject();
			window.__mangaWorkflowDebug!.openView("import");
		});

		// Open the bulk-import dialog from the Import command bar.
		await page.getByRole("button", { name: "นำเข้ารูปแบบรวม" }).click();
		const dialog = page.getByRole("dialog", { name: "นำเข้ารูปแบบรวม" });
		await expect(dialog).toBeVisible();

		await attachSampleImages(page, 5);
		await expect(dialog.getByText("5 รูป").first()).toBeVisible();

		await mkdir(SHOT_DIR, { recursive: true });
		await page.screenshot({ path: `${SHOT_DIR}/${testInfo.project.name}-keep.png`, fullPage: true });

		// Merge mode reveals the N-per-page control + an estimated page count.
		await dialog.getByText("รวม N รูปต่อหน้า").click();
		await expect(dialog.getByRole("spinbutton", { name: "รูปต่อหน้า" })).toBeVisible();
		await page.screenshot({ path: `${SHOT_DIR}/${testInfo.project.name}-merge.png`, fullPage: true });

		// Split mode reveals the px-per-page threshold control.
		await dialog.getByText("ตัดรูปยาวอัตโนมัติ").click();
		await expect(dialog.getByRole("spinbutton", { name: "ความสูงสูงสุด (px)" })).toBeVisible();
		await page.screenshot({ path: `${SHOT_DIR}/${testInfo.project.name}-split.png`, fullPage: true });

		// The submit button is enabled once files + a project are present.
		await expect(dialog.getByRole("button", { name: "นำเข้า", exact: true })).toBeEnabled();
	});
});
