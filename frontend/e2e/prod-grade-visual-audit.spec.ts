import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const AUDIT_DIR = resolve(process.cwd(), "../.codex-dev-logs/visual-checks/flow418-prod-grade-visual-audit");
const P104_REAL_IMAGE_PATH = "/Users/work/Documents/Codex/2026-05-16/ssh-suphot-192-168-1-203/p104/image-01.webp";

type AuditViewport = {
	name: "desktop" | "ipad";
	width: number;
	height: number;
};

type AuditSurface = {
	name: string;
	path: string;
	minControls: number;
	minTextLength: number;
	targetControls?: number;
	targetTextLength?: number;
	requiredText?: string[];
	forbiddenText?: string[];
	openers?: string[];
	prepare?: (page: Page) => Promise<void>;
};

const AUDIT_VIEWPORTS: AuditViewport[] = [
	{ name: "desktop", width: 1440, height: 1000 },
	{ name: "ipad", width: 929, height: 1194 },
];

const PROD_RISK_TERMS = [
	"debug",
	"debug-provider",
	"Flow208",
	"flow208",
	"Flow169",
	"UX Audit",
	"Prototype Journey",
	"FLOW208 PAGE",
	"AI RESULT",
	"flow208-page",
	"flow208-ai-result",
	"flow208-export",
	"production sample",
	"Sales Demo",
	"ยังไม่ได้เปิด Chapter",
	"เปิดโฟลเดอร์ Chapter",
	"rev ",
	"provider returned",
	"image cleanup provider",
	"พื้นที่ปก AI",
];

async function installLocalPreauthBackendFallbacks(page: Page): Promise<void> {
	await page.route("**/api/project", async (route) => {
		if (route.request().method() !== "GET") {
			await route.fallback();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ projects: [] }),
		});
	});
	await page.route("**/api/ai/capabilities", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				tiers: [
					{ id: "sfx-pro", label: "SFX Pro", provider: "local", available: true, reason: null, detail: "Local audit fallback" },
					{ id: "clean-pro", label: "Clean Pro", provider: "local", available: true, reason: null, detail: "Local audit fallback" },
					{ id: "budget-clean", label: "Budget Clean", provider: "local", available: true, reason: null, detail: "Local audit fallback" },
				],
			}),
		});
	});
}

async function waitForDebug(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
}

async function seedProject(page: Page): Promise<void> {
	await waitForDebug(page);
	await page.evaluate(() => window.__mangaWorkflowDebug!.seedProject());
}

async function openAiReview(page: Page): Promise<void> {
	await seedProject(page);
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.openPage(1);
		window.__mangaWorkflowDebug!.markAiProviderFailure();
		await window.__mangaWorkflowDebug!.openPage(0);
	});
	await clickVisibleText(page, "AI");
	await clickVisibleText(page, "ตอน 2");
}

async function clickCanvasWithoutProject(page: Page): Promise<void> {
	await clickVisibleText(page, "แก้หน้า");
	await page.waitForTimeout(250);
}

async function openChapterSetupDialog(page: Page): Promise<void> {
	await page.getByRole("button", { name: "สร้างตอนใหม่ (Hero)" }).click();
	await page.getByRole("dialog", { name: "ตั้งค่าตอนใหม่" }).waitFor({ state: "visible", timeout: 5_000 });
}

async function openLayersWithDepth(page: Page): Promise<void> {
	await seedProject(page);
	await ensureInspectorOpen(page);
	await clickVisibleText(page, "เลือกแผง เลเยอร์");
	await clickVisibleText(page, "เครดิต");
	await clickVisibleText(page, "รูปเสริม");
	await clickVisibleText(page, "กล่องข้อความ");
	await clickVisibleText(page, "เอฟเฟกต์");
}

async function openCreditWorkflow(page: Page): Promise<void> {
	await seedProject(page);
	await ensureInspectorOpen(page);
	await clickVisibleText(page, "เลือกแผง เลเยอร์");
	await clickVisibleText(page, "เครดิต");
	await clickVisibleText(page, "ตั้งค่ารูปเครดิต");
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

async function openP104Editor(page: Page): Promise<void> {
	test.skip(!existsSync(P104_REAL_IMAGE_PATH), `p104 real image not found at ${P104_REAL_IMAGE_PATH}`);
	await waitForDebug(page);
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("editor"));
	await page.waitForFunction(() => Boolean(document.querySelector(".editor-root")));
	const imageBuffer = await readFile(P104_REAL_IMAGE_PATH);
	await page.evaluate((url) => window.__mangaEditorDebug!.loadImageUrl(url), `data:image/webp;base64,${imageBuffer.toString("base64")}`);
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.addImageLayers([
			{
				id: "flow418-credit-logo",
				name: "P104 credit logo",
				imageId: "flow418-credit-logo.png",
				imageName: "flow418-credit-logo.png",
				originalName: "flow418-credit-logo.png",
				x: 120,
				y: 160,
				w: 320,
				h: 90,
				rotation: 0,
				opacity: 0.86,
				visible: true,
				locked: false,
				index: 0,
				role: "credit",
				fill: "#f8fafc",
			},
		]);
		window.__mangaEditorDebug!.addTextLayers([
			{
				id: "flow418-p104-title",
				text: "PROD UX CHECK",
				x: 140,
				y: 280,
				w: 520,
				h: 120,
				fontSize: 54,
				fontFamily: "Arial",
				fill: "#111827",
				alignment: "center",
				rotation: 0,
				visible: true,
				locked: false,
				index: 1,
			},
		]);
		window.__mangaEditorDebug!.selectImageLayer("flow418-credit-logo");
	});
	await clickVisibleText(page, "แผงขวา");
	await clickVisibleText(page, "เลเยอร์");
}

async function openBrushMissHud(page: Page): Promise<void> {
	await seedProject(page);
	await page.evaluate(async () => {
		window.__mangaWorkflowDebug!.openView("editor");
		await window.__mangaEditorDebug!.loadTestImage({
			width: 1600,
			height: 2400,
			label: "แปรง",
		});
		await window.__mangaEditorDebug!.addImageLayers([
			{
				id: "audit-brush-miss-overlay",
				name: "แปรง",
				imageId: "audit-brush-miss-overlay.png",
				imageName: "audit-brush-miss-overlay.png",
				originalName: "audit-brush-miss-overlay.png",
				x: 600,
				y: 760,
				w: 320,
				h: 220,
				rotation: 0,
				opacity: 1,
				visible: true,
				locked: false,
				index: 0,
				role: "overlay",
				fill: "#0ea5e9",
			},
		]);
		window.__mangaEditorDebug!.selectImageLayer("audit-brush-miss-overlay");
		window.__mangaEditorDebug!.setBrushSize(96);
		window.__mangaEditorDebug!.setTool("brush");
	});
	await page.waitForFunction(() => window.__mangaEditorDebug!.getState().brush.selectedImageLayerId === "audit-brush-miss-overlay");
	const missPoint = await page.evaluate(() => window.__mangaEditorDebug!.imagePointToClient({ x: 320, y: 360 }));
	await page.mouse.move(missPoint.x, missPoint.y);
	await page.waitForFunction(() => window.__mangaEditorDebug!.getState().brush.preview?.blocked === true);
}

async function clickVisibleText(page: Page, label: string): Promise<boolean> {
	const clicked = await page.evaluate((needle) => {
		const candidate = Array.from(document.querySelectorAll("button, [role='button'], summary")).find((element) => {
			const text = (element.textContent || element.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return text.includes(needle)
				&& rect.width > 0
				&& rect.height > 0
				&& style.display !== "none"
				&& style.visibility !== "hidden"
				&& style.opacity !== "0";
		});
		if (!candidate) return false;
		(candidate as HTMLElement).click();
		return true;
	}, label);
	if (clicked) await page.waitForTimeout(180);
	return clicked;
}

async function collectProdGradeMetrics(page: Page) {
	return page.evaluate((riskTerms) => {
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
		const activeOverlay = Array.from(document.querySelectorAll(".recent-menu, .account-popover, .chapter-dialog, dialog.modal-open, .modal-box"))
			.find((element) => visible(element));
		const inActiveOverlay = (element: Element) => !activeOverlay || activeOverlay === element || activeOverlay.contains(element);
		const visibleControlText = (element: Element) => {
			const renderedText = element instanceof HTMLElement ? element.innerText : "";
			return (renderedText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "")
				.trim()
				.replace(/\s+/g, " ");
		};
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
			.filter(visible)
			.filter(inActiveOverlay)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					text: visibleControlText(element).slice(0, 120),
					type: element instanceof HTMLInputElement ? element.type : null,
					width: Math.round(rect.width),
					height: Math.round(rect.height),
					x: Math.round(rect.x),
					y: Math.round(rect.y),
					disabled: element instanceof HTMLButtonElement ? element.disabled : element.getAttribute("aria-disabled") === "true",
				};
			});
		const regions = Array.from(document.querySelectorAll("[role='region'], section, details, dialog, aside, nav, header, footer"))
			.filter(visible)
			.filter(inActiveOverlay)
			.length;
		const text = document.body.innerText.replace(/\s+/g, " ").trim();
		const compactLongLabels = controls.filter((control) => control.text.length > 42 && control.width < 190);
		const detachedTinyLabels = controls.filter((control) => /^[A-Z]{1,3}\\+?$/.test(control.text) && control.width <= 48);
		const disabledVisible = controls.filter((control) => control.disabled);
		const canvases = Array.from(document.querySelectorAll("canvas")).filter(visible).map((canvas) => {
			const rect = canvas.getBoundingClientRect();
			return { width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) };
		});
		return {
			path: location.pathname,
			title: document.title,
			controlCount: controls.length,
			textLength: text.length,
			regionCount: regions,
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			tiny: controls.filter((control) => (control.width < 36 || control.height < 36) && control.type !== "range").slice(0, 12),
			touchRisk: controls.filter((control) => (control.width < 40 || control.height < 40) && control.type !== "range").slice(0, 12),
			sliderTiny: controls.filter((control) => control.type === "range" && (control.width < 36 || control.height < 36)).slice(0, 12),
			sliderTouchRisk: controls.filter((control) => control.type === "range" && (control.width < 40 || control.height < 40)).slice(0, 12),
			compactLongLabels: compactLongLabels.slice(0, 12),
			detachedTinyLabels: detachedTinyLabels.slice(0, 12),
			disabledVisible: disabledVisible.slice(0, 16),
			canvases,
			visibleCanvasArea: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
			riskMatches: riskTerms.filter((term) => text.includes(term)),
		};
	}, PROD_RISK_TERMS);
}

const SURFACES: AuditSurface[] = [
	{ name: "root-entry", path: "/", minControls: 8, minTextLength: 120 },
	{ name: "root-canvas-gate", path: "/", minControls: 8, minTextLength: 120, prepare: clickCanvasWithoutProject },
	{
		name: "root-chapter-setup-dialog",
		path: "/",
		minControls: 4,
		minTextLength: 300,
		requiredText: ["ตั้งชื่อเรื่องก่อนสร้างตอน", "ต่อไป: ตั้งตอน", "รูปปก"],
		prepare: openChapterSetupDialog,
	},
	{ name: "library-title", path: "/library/flow208-prototype-journey", minControls: 10, minTextLength: 220, openers: ["TH", "Moonlit"] },
	{ name: "project-dashboard", path: "/projects/flow208-project", minControls: 18, minTextLength: 320 },
	{ name: "pages-open", path: "/projects/flow208-project/pages", minControls: 18, minTextLength: 320, openers: ["ประวัติ Export", "หน้าในตอน"] },
	{ name: "work-open", path: "/projects/flow208-project/work", minControls: 20, minTextLength: 360, openers: ["งานด่วน", "ตรวจผล AI", "เช็กคุณภาพ"] },
	{ name: "focus-open", path: "/projects/flow208-project/focus/review-task-flow208-review-p1", minControls: 14, minTextLength: 320, openers: ["รายการ Focus", "รายละเอียด", "คิว"] },
	{ name: "editor-layers-depth", path: "/projects/flow208-project/pages/1/editor", minControls: 20, minTextLength: 260, targetControls: 28, targetTextLength: 420, prepare: openLayersWithDepth },
	{
		name: "editor-credit-workflow",
		path: "/projects/flow208-project/pages/1/editor",
		minControls: 22,
		minTextLength: 420,
		targetControls: 34,
		targetTextLength: 620,
		requiredText: ["ยังไม่สร้างข้อความ", "ใช้รูปเครดิต", "นำเข้ารูปเครดิต", "ซ้ำเครดิตทุก px", "ลบเครดิต", "ยังไม่มีเครดิตให้ลบ"],
		forbiddenText: ["ลบเครดิตทุกหน้า"],
		prepare: openCreditWorkflow,
	},
	{ name: "editor-ai-review-depth", path: "/projects/flow208-project/pages/1/editor", minControls: 28, minTextLength: 420, requiredText: ["ลากพื้นที่ให้ AI"], prepare: openAiReview },
	{ name: "editor-p104-real-image", path: "/projects/flow208-project/pages/1/editor", minControls: 12, minTextLength: 160, targetControls: 24, targetTextLength: 360, prepare: openP104Editor },
	{
		name: "editor-brush-miss-hud",
		path: "/projects/flow208-project/pages/1/editor",
		minControls: 12,
		minTextLength: 220,
		targetTextLength: 320,
		requiredText: ["ขยับแปรง", "นอกเลเยอร์ที่เลือก", "แปรง"],
		prepare: openBrushMissHud,
	},
];

test.describe("prod-grade visual audit", () => {
	test("fails blank or metric-only customer-ready screenshots", async ({ page }) => {
		test.skip(!test.info().project.name.includes("desktop"), "This audit drives exact desktop and iPad viewport sizes itself.");
		test.setTimeout(180_000);
		await mkdir(AUDIT_DIR, { recursive: true });

		const report: Array<{
			viewport: string;
			surface: string;
			screenshot: string;
			metrics: Awaited<ReturnType<typeof collectProdGradeMetrics>>;
			consoleIssues: string[];
			findings: string[];
		}> = [];
		const hardFailures: unknown[] = [];
		await installLocalPreauthBackendFallbacks(page);

		for (const viewport of AUDIT_VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			for (const surface of SURFACES) {
				const consoleIssues: string[] = [];
				const consoleHandler = (message: { type(): string; text(): string }) => {
					if (message.type() === "error" || message.type() === "warning") {
						consoleIssues.push(`${message.type()}: ${message.text()}`);
					}
				};
				const pageErrorHandler = (error: Error) => consoleIssues.push(`pageerror: ${error.message}`);
				page.on("console", consoleHandler);
				page.on("pageerror", pageErrorHandler);

				await page.goto(surface.path, { waitUntil: "domcontentloaded" });
				await page.waitForFunction(() => document.body.innerText.trim().length > 0, null, { timeout: 10_000 }).catch(() => {});
				await page.waitForTimeout(700);
				if (surface.prepare) {
					await surface.prepare(page);
					await page.waitForTimeout(400);
				}
				for (const opener of surface.openers ?? []) {
					await clickVisibleText(page, opener);
				}
				let metrics = await collectProdGradeMetrics(page);
				if (metrics.controlCount === 0 && metrics.textLength === 0) {
					await page.goto(surface.path, { waitUntil: "domcontentloaded" });
					await page.waitForFunction(() => document.body.innerText.trim().length > 0, null, { timeout: 10_000 }).catch(() => {});
					await page.waitForTimeout(700);
					if (surface.prepare) {
						await surface.prepare(page);
						await page.waitForTimeout(400);
					}
					for (const opener of surface.openers ?? []) {
						await clickVisibleText(page, opener);
					}
					metrics = await collectProdGradeMetrics(page);
				}
				const screenshot = `${viewport.name}-${surface.name}.png`;
				await page.screenshot({ path: resolve(AUDIT_DIR, screenshot), fullPage: false });
				page.off("console", consoleHandler);
				page.off("pageerror", pageErrorHandler);

				const findings: string[] = [];
				if (metrics.controlCount < surface.minControls) findings.push(`blank-risk controls ${metrics.controlCount}/${surface.minControls}`);
				if (metrics.textLength < surface.minTextLength) findings.push(`blank-risk text ${metrics.textLength}/${surface.minTextLength}`);
				if (surface.targetControls && metrics.controlCount < surface.targetControls) findings.push(`shallow tool context controls ${metrics.controlCount}/${surface.targetControls}`);
				if (surface.targetTextLength && metrics.textLength < surface.targetTextLength) findings.push(`shallow tool context text ${metrics.textLength}/${surface.targetTextLength}`);
				const bodyText = await page.locator("body").innerText();
				const missingRequiredText = (surface.requiredText ?? []).filter((text) => !bodyText.includes(text));
				if (missingRequiredText.length) findings.push(`missing required text ${missingRequiredText.join(", ")}`);
				const presentForbiddenText = (surface.forbiddenText ?? []).filter((text) => bodyText.includes(text));
				if (presentForbiddenText.length) findings.push(`forbidden text visible ${presentForbiddenText.join(", ")}`);
				if (surface.name === "editor-p104-real-image" && bodyText.includes("Drop manga images")) {
					findings.push("loaded single-image editor still shows empty dropzone copy");
				}
				if (metrics.regionCount > 85) findings.push(`visual-region overload ${metrics.regionCount}`);
				if (metrics.compactLongLabels.length) findings.push(`compact long labels ${metrics.compactLongLabels.length}`);
				if (metrics.detachedTinyLabels.length > 6) findings.push(`symbol-only controls need stronger icon language ${metrics.detachedTinyLabels.length}`);
				if (metrics.disabledVisible.length > 10) findings.push(`too many disabled visible actions ${metrics.disabledVisible.length}`);
				if (metrics.riskMatches.length) findings.push(`prod-risk copy ${metrics.riskMatches.join(", ")}`);
				if (metrics.sliderTouchRisk.length) findings.push(`slider touch-risk controls below 40px ${metrics.sliderTouchRisk.length}`);
				if (surface.name.startsWith("editor") && metrics.visibleCanvasArea < viewport.width * viewport.height * 0.12) {
					findings.push(`canvas too visually secondary ${metrics.visibleCanvasArea}`);
				}

				report.push({ viewport: viewport.name, surface: surface.name, screenshot, metrics, consoleIssues, findings });

				if (
					consoleIssues.length
					|| metrics.overflowX
					|| metrics.bodyOverflowX
					|| metrics.tiny.length
					|| metrics.touchRisk.length
					|| metrics.riskMatches.length
					|| metrics.sliderTouchRisk.length
					|| metrics.controlCount < surface.minControls
					|| metrics.textLength < surface.minTextLength
					|| (surface.name === "editor-p104-real-image" && bodyText.includes("Drop manga images"))
					|| missingRequiredText.length
					|| presentForbiddenText.length
				) {
					hardFailures.push({
						viewport: viewport.name,
						surface: surface.name,
						consoleIssues: consoleIssues.slice(0, 8),
						overflowX: metrics.overflowX,
						bodyOverflowX: metrics.bodyOverflowX,
						tiny: metrics.tiny,
						touchRisk: metrics.touchRisk,
						sliderTouchRisk: metrics.sliderTouchRisk,
						riskMatches: metrics.riskMatches,
						controlCount: metrics.controlCount,
						minControls: surface.minControls,
						textLength: metrics.textLength,
						minTextLength: surface.minTextLength,
						missingRequiredText,
						presentForbiddenText,
					});
				}
			}
		}

		await writeFile(resolve(AUDIT_DIR, "prod-grade-visual-audit-report.json"), JSON.stringify(report, null, 2));
		await writeFile(
			resolve(AUDIT_DIR, "prod-grade-visual-audit-summary.md"),
			[
				"# Flow418 Prod-Grade Visual Audit",
				"",
				...report.map((entry) => [
					`## ${entry.viewport} / ${entry.surface}`,
					`- screenshot: ${entry.screenshot}`,
					`- controls: ${entry.metrics.controlCount}`,
					`- textLength: ${entry.metrics.textLength}`,
					`- regions: ${entry.metrics.regionCount}`,
					`- overflowX: ${entry.metrics.overflowX}`,
					`- tiny: ${entry.metrics.tiny.length}`,
					`- console: ${entry.consoleIssues.length}`,
					`- findings: ${entry.findings.length ? entry.findings.join("; ") : "none"}`,
					"",
				].join("\n")),
			].join("\n"),
		);

		expect(hardFailures).toEqual([]);
	});
});
