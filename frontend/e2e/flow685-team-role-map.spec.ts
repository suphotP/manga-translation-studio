import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow685-team-role-map";

async function openTeamWorkBoard(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.seedProject();
		window.__mangaWorkflowDebug!.openView("work");
	});
	await page.getByRole("region", { name: "บอร์ดงานตอน" }).waitFor({ state: "visible" });
	await page.getByRole("button", { name: /Team/ }).click();
	await page.getByRole("region", { name: "ทีมผลิตแยกบทบาท" }).waitFor({ state: "visible" });
}

async function collectMetrics(page: Page) {
	return page.evaluate(() => {
		const visible = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0
				&& rect.height > 0
				&& rect.bottom > 0
				&& rect.right > 0
				&& rect.top < innerHeight
				&& rect.left < innerWidth
				&& style.display !== "none"
				&& style.visibility !== "hidden"
				&& style.opacity !== "0";
		};
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
			.filter(visible)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				const text = element instanceof HTMLElement ? element.innerText : "";
				return { width: Math.round(rect.width), height: Math.round(rect.height), text: text.trim().replace(/\s+/g, " ") };
			});
		const body = document.body.innerText;
		const roleCardTexts = Array.from(document.querySelectorAll(".production-role-grid > article"))
			.map((element) => (element as HTMLElement).innerText.trim().replace(/\s+/g, " "));
		return {
			overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
			roleHits: ["คนคลีน", "คนแปล", "คนลงคำ", "QC / เครดิต"].filter((text) => body.includes(text)),
			roleCardTexts,
			soloLeakHits: ["รายละเอียดคิวทั้งหมด", "เปิดดูขั้นงานละเอียด", "โหมด Solo"].filter((text) => body.includes(text)),
		};
	});
}

test.describe("Flow685 team role map", () => {
	test("shows explicit production roles only in Team mode without layout regressions", async ({ page }, testInfo) => {
		await openTeamWorkBoard(page);

		const workBoard = page.getByRole("region", { name: "บอร์ดงานตอน" });
		const roleMap = page.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await expect(roleMap).toContainText("แยกคลีน / แปล / ลงคำ / QC");
		await expect(roleMap).toContainText("คนคลีน");
		await expect(roleMap).toContainText("Raw -> Clean");
		await expect(roleMap).toContainText("คนแปล");
		await expect(roleMap).toContainText("Raw -> Script");
		await expect(roleMap).toContainText("คนลงคำ");
		await expect(roleMap).toContainText("Script -> Typeset");
		await expect(roleMap).toContainText("QC / เครดิต");
		await expect(roleMap).toContainText("Review -> Main");
		await expect(workBoard).toContainText("งานตามคนรับงาน");
		await expect(workBoard).toContainText("คิวตามขั้นตอน");
		await expect(workBoard).not.toContainText("เปิดดูขั้นงานละเอียด");
		const pageHandoff = page.getByRole("region", { name: "สถานะงานแยกหน้าสำหรับทีม" });
		await expect(pageHandoff).toContainText("ดูสถานะรายหน้า");
		await expect(pageHandoff).toContainText("เปิดเมื่ออยากเทียบคลีน แปล ลงคำ และ QC ของแต่ละหน้า");
		await expect(pageHandoff).not.toHaveAttribute("open", "");
		await pageHandoff.getByText("ดูสถานะรายหน้า").click();
		await expect(pageHandoff).toHaveAttribute("open", "");
		await expect(pageHandoff).toContainText("P1");
		await expect(pageHandoff).toContainText("ถัดไป:");
		const mainHandoff = page.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		await expect(mainHandoff).toContainText("ส่งกลับโปรเจกต์หลัก");
		await expect(mainHandoff).toContainText("คลีน ·");
		await expect(mainHandoff.getByRole("button", { name: /ไปคนคลีน|ไปคนแปล|ไปคนลงคำ|ไป QC \/ เครดิต|ไปปิด QC|ไปเครดิต|ไปหน้า Export/ })).toBeVisible();

		const cleanerCard = roleMap.locator(".production-role-grid > article", { hasText: "คนคลีน" });
		await roleMap.getByRole("button", { name: "เลือกบทบาท คนคลีน" }).click();
		await expect(cleanerCard).toHaveClass(/active/);
		const cleanerHandoff = page.getByRole("region", { name: "ส่งงานคลีน" });
		await expect(cleanerHandoff).toContainText("ยังเป็น raw / รอคลีน");
		await expect(cleanerHandoff).toContainText("ยังไม่ส่งภาพ clean แต่ไม่บล็อกสคริปต์/ลงคำต้นทาง");
		await cleanerHandoff.getByRole("button", { name: "ยืนยันว่าไม่ต้องคลีน" }).click();
		await expect(cleanerHandoff).toContainText("พร้อมให้ลงคำ");
		await expect(cleanerHandoff).toContainText("คนลงคำใช้ภาพ clean ตรวจตำแหน่งได้");
		const cleanHandoffState = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.cleaningHandoff);
		expect(cleanHandoffState).toEqual(expect.objectContaining({
			status: "clean_ready",
			updatedBy: "cleaner",
		}));

		const translatorCard = roleMap.locator(".production-role-grid > article", { hasText: "คนแปล" });
		await roleMap.getByRole("button", { name: "เลือกบทบาท คนแปล" }).click();
		await expect(translatorCard).toHaveClass(/active/);
		const translatorBench = page.getByRole("region", { name: "โต๊ะแปลข้างรูป" });
		await expect(translatorBench).toBeVisible();
		await expect(translatorBench).toContainText("รูปต้นฉบับ + สคริปต์ข้างรูป");
		await expect(translatorBench).toContainText("คำพูด 1");
		await expect(translatorBench).toContainText("SFX / ป้าย");
		await expect(translatorBench.getByRole("textbox", { name: "คำพูด 1 คำแปล" })).toHaveValue("");
		await translatorBench.getByRole("textbox", { name: "คำพูด 2 คำแปล" }).fill("บรรทัด A\nบรรทัด B");
		const pagePreview = translatorBench.locator(".translator-page-preview");
		const placementTarget = translatorBench.locator(".translator-placement-target");
		const previewBox = await pagePreview.boundingBox();
		expect(previewBox).toBeTruthy();
		await placementTarget.click({
			position: {
				x: Math.round((previewBox?.width ?? 240) * 0.25),
				y: Math.round((previewBox?.height ?? 280) * 0.65),
			},
		});
		const translationSlots = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.translationScriptSlots ?? []);
		expect(translationSlots).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "dialogue-2",
				x: 25,
				y: 65,
				translatedText: "บรรทัด A\nบรรทัด B",
			}),
		]));
		await translatorBench.getByRole("button", { name: "เพิ่มช่องแปล" }).click();
		await expect(translatorBench).toContainText("ช่องแปล 4");
		await translatorBench.getByRole("textbox", { name: /ชื่อช่องแปล ช่องแปล 4/ }).fill("เสียงกรีด");
		await translatorBench.getByRole("textbox", { name: /เสียงกรีด คำแปล/ }).fill("กรี๊ดดดด\nอย่าเข้ามา");
		const customTranslationSlots = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.translationScriptSlots ?? []);
		expect(customTranslationSlots).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "custom-0-4",
				label: "เสียงกรีด",
				x: 50,
				y: 50,
				translatedText: "กรี๊ดดดด\nอย่าเข้ามา",
			}),
		]));
		const typesetterCard = roleMap.locator(".production-role-grid > article", { hasText: "คนลงคำ" });
		await roleMap.getByRole("button", { name: "เลือกบทบาท คนลงคำ" }).click();
		await expect(typesetterCard).toHaveClass(/active/);
		const typesetterBench = page.getByRole("region", { name: "ลงคำจากสคริปต์แปล" });
		await expect(typesetterBench).toContainText("ภาพคลีนพร้อม");
		await expect(typesetterBench).toContainText("ใช้ภาพ clean เป็นฐานตรวจตำแหน่ง");
		await expect(typesetterBench).toContainText("สร้างบน clean-ready");
		const customTypesetCard = typesetterBench.locator(".typesetter-script-card", { hasText: "เสียงกรีด" });
		await customTypesetCard.getByRole("button", { name: "สร้างกล่อง เสียงกรีด บน หน้า 1 ภาษา TH แล้วเปิดหน้า" }).click();
		const textLayers = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.textLayers ?? []);
		expect(textLayers).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "typeset-custom-0-4",
				name: "เสียงกรีด",
				sourceProvider: "translation-slot:custom-0-4",
				text: "กรี๊ดดดด\nอย่าเข้ามา",
			}),
		]));
		await page.evaluate(() => window.__mangaWorkflowDebug!.openView("work"));
		await expect(roleMap).toBeVisible();
		await roleMap.getByRole("button", { name: "เลือกบทบาท คนแปล" }).click();
		await translatorBench.getByRole("textbox", { name: /เสียงกรีด คำแปล/ }).fill("กรี๊ดดดดดด\nหยุดเดี๋ยวนี้");
		await roleMap.getByRole("button", { name: "เลือกบทบาท คนลงคำ" }).click();
		await expect(customTypesetCard).toContainText("สคริปต์เปลี่ยนจากกล่องข้อความ");
		await customTypesetCard.getByRole("button", { name: "อัปเดตกล่องข้อความ" }).click();
		const syncedTextLayers = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.textLayers ?? []);
		expect(syncedTextLayers.filter((layer: any) => layer.sourceProvider === "translation-slot:custom-0-4")).toHaveLength(1);
		expect(syncedTextLayers).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "typeset-custom-0-4",
				sourceProvider: "translation-slot:custom-0-4",
				text: "กรี๊ดดดดดด\nหยุดเดี๋ยวนี้",
			}),
		]));

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-team-role-map.png`,
			fullPage: true,
		});
		const metrics = await collectMetrics(page);
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-metrics.json`, JSON.stringify(metrics, null, 2));

		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(metrics.roleHits).toEqual(["คนคลีน", "คนแปล", "คนลงคำ", "QC / เครดิต"]);
		expect(metrics.roleCardTexts.some((text) => text.includes("ยังไม่มีงาน"))).toBe(false);
		expect(metrics.soloLeakHits).toEqual([]);

		await roleMap.getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }).click();
		await page.getByRole("region", { name: "QC / เครดิต" }).getByRole("button", { name: "ตรวจใน Focus" }).click();
		const cleanRecheck = page.getByRole("region", { name: "ตรวจ clean/typeset ก่อนส่งต่อ" });
		await expect(cleanRecheck).toContainText("ตรวจตำแหน่งกับภาพ clean ก่อนผ่าน QC");
		await expect(cleanRecheck).toContainText("กล่องข้อความมาจากสคริปต์แปล");
		await cleanRecheck.getByRole("button", { name: "ยืนยันตรวจ clean แล้ว" }).click();
		const verifiedRecheckState = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.cleaningHandoff);
		expect(verifiedRecheckState).toEqual(expect.objectContaining({
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedBy: "qc",
		}));
		await expect(cleanRecheck).toContainText("ตรวจ clean/typeset แล้ว");
		await cleanRecheck.getByRole("button", { name: "ต้องแก้ตำแหน่ง" }).click();
		const adjustmentRecheckState = await page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.cleaningHandoff);
		expect(adjustmentRecheckState).toEqual(expect.objectContaining({
			typesetRecheckStatus: "needs_adjustment",
			typesetRecheckUpdatedBy: "qc",
		}));
		await expect(cleanRecheck).toContainText("ตำแหน่งบน clean ต้องแก้");
	});

	test("opens Team QC and credit bench into Focus and real Layers credit tools", async ({ page }, testInfo) => {
		await openTeamWorkBoard(page);

		const roleMap = page.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await roleMap.getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }).click();
		const qcBench = page.getByRole("region", { name: "QC / เครดิต" });
		await expect(qcBench).toBeVisible();
		await expect(qcBench).toContainText("งานที่ต้องตัดสินก่อนส่งต่อ");
		await expect(qcBench).toContainText("เครดิต");
		await expect(qcBench).toContainText("เปิดเครื่องมือเครดิต");
		await expect(qcBench).not.toContainText("ผ่านตรวจหน้า");
		await expect(qcBench.getByRole("button", { name: "ส่งกลับแก้" })).toHaveCount(0);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-qc-credit-bench.png`,
			fullPage: true,
		});
		const metrics = await collectMetrics(page);
		await writeFile(`${PROOF_DIR}/${testInfo.project.name}-qc-credit-metrics.json`, JSON.stringify(metrics, null, 2));
		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);

		await qcBench.getByRole("button", { name: "ตรวจใน Focus" }).click();
		await expect(page).toHaveURL(/\/projects\/flow208-project\/focus\/review-task-flow208-review-p1/);

		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug));
		await page.evaluate(() => window.__mangaWorkflowDebug!.openView("work"));
		await page.getByRole("region", { name: "ทีมผลิตแยกบทบาท" }).getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }).click();
		await page.getByRole("region", { name: "QC / เครดิต" }).getByRole("button", { name: "เปิดเครื่องมือเครดิต" }).click();
		await expect(page.getByLabel("สถานะสร้างเครดิตข้อความ")).toContainText("ยังไม่สร้างข้อความ");
		await page.locator("#credit-text").fill("QC: Moonlit");
		const creditButton = page.getByRole("button", { name: "สร้างเครดิตข้อความ" });
		await expect(creditButton).toBeVisible();
		await creditButton.click();
		const creditLayers = await page.evaluate(() =>
			(window.__mangaWorkflowDebug!.getProjectState()?.pages[0]?.textLayers ?? [])
				.filter((layer: any) => layer.sourceCategory === "credit")
		);
		expect(creditLayers.length).toBeGreaterThan(0);
	});
});
