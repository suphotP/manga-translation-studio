import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type AuditViewport = {
	name: "desktop" | "ipad";
	width: number;
	height: number;
};

type CustomerAuditSurface = {
	name: string;
	path: string;
	openers?: string[];
	requiredText?: string[];
	forbiddenText?: string[];
	prepare?: (page: Page) => Promise<void>;
	viewports?: AuditViewport["name"][];
};

const AUDIT_DIR = resolve(process.cwd(), "../.codex-dev-logs/visual-checks/flow374-customer-ready");

const AUDIT_VIEWPORTS: AuditViewport[] = [
	{ name: "desktop", width: 1440, height: 1000 },
	{ name: "ipad", width: 929, height: 1194 },
];

const CUSTOMER_RISK_TERMS = [
	"TODO",
	"undefined",
	"NaN",
	"null",
	"Mock",
	"Lorem",
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
	"rev ",
	"Error loading",
	"Invalid project ID",
	"Review imported dialogue",
	"Page 1 -",
	"Page 2 -",
	"Copy link",
	"Open recent project",
	"No project",
	"พื้นที่ปก AI",
	"No queue",
	"Open recent",
	"No session",
	"Trial",
	"Upgrade",
	"Plan",
	"updated",
	" ago",
	"3p",
	"2p",
	"Updated Name",
	"Sales Demo",
	"#proj",
	"Chapter ล่าสุด",
	"ยังไม่มีล่าสุด",
	"ยังไม่ได้เปิด Chapter",
	"เปิดโฟลเดอร์ Chapter",
	"โหมดทดลอง",
	"ยังไม่ผูกบัญชี",
	"สร้างบัญชี Editor",
	"เข้าใช้งานเพื่อบันทึกงานจริง",
	"flow208-project",
	"AI marker accepted",
	"Export blocked",
	"The Player Hides His Past",
	"ตั้งค่า Chapter",
	"สร้าง Chapter",
	"เข้า Canvas",
	"Choose File",
	"No file chosen",
	"provider returned",
	"image cleanup provider",
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

async function openAiReviewWithTwoMarkers(page: Page): Promise<void> {
	await seedProject(page);
	await page.evaluate(async () => {
		await window.__mangaWorkflowDebug!.openPage(1);
		window.__mangaWorkflowDebug!.markAiProviderFailure();
		await window.__mangaWorkflowDebug!.openPage(0);
	});
	await page.locator([
		`button[aria-label^="เปิดแผง AI:"]:visible`,
		`button[aria-label^="เปิดแผงถัดไป: AI:"]:visible`,
	].join(", ")).first().click();
	await clickOpeners(page, ["ตอน 2"]);
}

async function openAdminSettings(page: Page): Promise<void> {
	await seedProject(page);
	await page.locator("button[aria-label='ตั้งค่า']").first().click({ timeout: 2_000 }).catch(() => undefined);
}

async function openAccountMenu(page: Page): Promise<void> {
	await seedProject(page);
	await page.locator("button[aria-label^='บัญชี']").first().click({ timeout: 2_000 }).catch(() => undefined);
}

async function openRecentProjectPicker(page: Page): Promise<void> {
	await seedProject(page);
	await page.getByRole("button", { name: "เปิดตอนล่าสุด" }).click({ timeout: 2_000 }).catch(() => undefined);
}

async function openChapterSetupDialog(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: "สร้างตอนใหม่ (Hero)" }).click({ timeout: 2_000 });
	await page.locator(".chapter-dialog").waitFor({ state: "visible", timeout: 5_000 });
}

async function openCustomerLayersPanel(page: Page): Promise<void> {
	await ensureInspectorOpen(page);
	await clickOpeners(page, ["เลือกแผง เลเยอร์", "เครดิต", "รูปเสริม", "กล่องข้อความ", "เอฟเฟกต์"]);
}

async function openCreditWorkflow(page: Page): Promise<void> {
	await seedProject(page);
	await ensureInspectorOpen(page);
	await clickOpeners(page, ["เลือกแผง เลเยอร์", "เครดิต", "ตั้งค่ารูปเครดิต"]);
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
	if (toggled) await page.waitForTimeout(250);
}

async function clickOpeners(page: Page, labels: string[] = []): Promise<string[]> {
	const clicked: string[] = [];
	for (const label of labels) {
		const didClick = await page.evaluate((needle) => {
			const candidate = Array.from(document.querySelectorAll("button, [role='button'], summary")).find((element) => {
				const text = (element.textContent || element.getAttribute("aria-label") || "").trim();
				const rect = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				return text.includes(needle)
					&& rect.width > 0
					&& rect.height > 0
					&& style.display !== "none"
					&& style.visibility !== "hidden";
			});
			if (!candidate) return false;
			(candidate as HTMLElement).click();
			return true;
		}, label);
		if (didClick) {
			clicked.push(label);
			await page.waitForTimeout(250);
		}
	}
	return clicked;
}

async function collectCustomerMetrics(page: Page) {
	return page.evaluate((riskTerms) => {
		const matchesRiskTerm = (bodyText: string, term: string) => {
			if (term === "2p" || term === "3p") {
				const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(bodyText);
			}
			return bodyText.includes(term);
		};
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
			if (element instanceof HTMLSelectElement) {
				const selectedText = element.selectedOptions[0]?.textContent || element.getAttribute("aria-label") || "";
				return selectedText.trim().replace(/\s+/g, " ");
			}
			const renderedText = element instanceof HTMLElement ? element.innerText : "";
			return (renderedText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "")
				.trim()
				.replace(/\s+/g, " ");
		};
		const body = document.body.innerText;
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
			.filter(visible)
			.filter(inActiveOverlay)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					text: visibleControlText(element).slice(0, 90),
					tag: element.tagName,
					type: element instanceof HTMLInputElement ? element.type : null,
					width: Math.round(rect.width),
					height: Math.round(rect.height),
					x: Math.round(rect.x),
					y: Math.round(rect.y),
				};
			});
		const isControlElement = (element: Element) => element.matches("button, a, input, select, textarea, summary, [role='button']");
		const roleRegions = Array.from(document.querySelectorAll("[role='region'], section, details, dialog, [aria-label]"))
			.filter(visible)
			.filter(inActiveOverlay)
			.filter((element) => element.matches("[role='region'], section, details, dialog") || !isControlElement(element))
			.length;
		const focusable = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
			.filter(visible)
			.filter(inActiveOverlay)
			.length;
		const tiny = controls.filter((control) => (control.width < 36 || control.height < 36) && control.type !== "range");
		const touchRisk = controls.filter((control) => (control.width < 40 || control.height < 40) && control.type !== "range");
		const sliderTiny = controls.filter((control) => control.type === "range" && (control.width < 36 || control.height < 36));
		const sliderTouchRisk = controls.filter((control) => control.type === "range" && (control.width < 40 || control.height < 40));
		const riskMatches = riskTerms.filter((term) => matchesRiskTerm(body, term));
		const longButtons = controls.filter((control) => control.text.length > 44 && control.width < 180 && control.height < 96);
		const disabledButtons = Array.from(document.querySelectorAll("button:disabled"))
			.filter(visible)
			.filter(inActiveOverlay)
			.map((element) => visibleControlText(element).slice(0, 90));
		const boundedOverlay = (selector: string) => {
			const element = document.querySelector(selector);
			if (!element || !visible(element)) return null;
			const rect = element.getBoundingClientRect();
			return {
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				insideViewport: rect.x >= 0
					&& rect.y >= 0
					&& rect.right <= window.innerWidth
					&& rect.bottom <= window.innerHeight,
			};
		};

		return {
			title: document.title,
			url: location.pathname,
			riskMatches,
			tiny,
			touchRisk: touchRisk.slice(0, 12),
			sliderTiny: sliderTiny.slice(0, 12),
			sliderTouchRisk: sliderTouchRisk.slice(0, 12),
			longButtons: longButtons.slice(0, 12),
			disabledButtons: disabledButtons.slice(0, 12),
			controlCount: controls.length,
			focusableCount: focusable,
			regionCount: roleRegions,
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			viewport: { width: innerWidth, height: innerHeight },
			statusText: document.querySelector("[role='status']")?.textContent?.trim().replace(/\s+/g, " ") ?? "",
			recentMenuBox: boundedOverlay(".recent-menu"),
			accountPopoverBox: boundedOverlay(".account-popover"),
			adminDialogBox: boundedOverlay("dialog.modal-open"),
			chapterDialogBox: boundedOverlay(".chapter-dialog"),
		};
	}, CUSTOMER_RISK_TERMS);
}

async function collectCustomerMetricsStable(page: Page) {
	try {
		return await collectCustomerMetrics(page);
	} catch (error) {
		if (error instanceof Error && /Execution context was destroyed|navigation/i.test(error.message)) {
			await page.waitForTimeout(300);
			return collectCustomerMetrics(page);
		}
		throw error;
	}
}

const SURFACES: CustomerAuditSurface[] = [
	{ name: "root-empty-dashboard", path: "/" },
	{ name: "open-chapter-dialog", path: "/", prepare: openChapterSetupDialog },
	{ name: "library-empty", path: "/library" },
	{ name: "library-title", path: "/library/flow208-prototype-journey", openers: ["TH", "Moonlit"] },
	{ name: "project-dashboard", path: "/projects/flow208-project" },
	{ name: "pages", path: "/projects/flow208-project/pages", openers: ["ประวัติ Export", "หน้าในตอน"] },
	{ name: "work", path: "/projects/flow208-project/work", openers: ["งานด่วน", "ตรวจผล AI", "เช็กคุณภาพ"] },
	{ name: "focus", path: "/projects/flow208-project/focus/review-task-flow208-review-p1", openers: ["รายการ Focus", "รายละเอียด", "คิว"] },
	{ name: "import", path: "/projects/flow208-project/import", openers: ["เครื่องมือนำเข้า", "จับคู่รูป"] },
	{ name: "editor-layers-open", path: "/projects/flow208-project/pages/1/editor", prepare: openCustomerLayersPanel },
	{
		name: "editor-credit-workflow",
		path: "/projects/flow208-project/pages/1/editor",
		prepare: openCreditWorkflow,
		requiredText: ["ยังไม่สร้างข้อความ", "ใช้รูปเครดิต", "นำเข้ารูปเครดิต", "ซ้ำเครดิตทุก px", "ลบเครดิต", "ยังไม่มีเครดิตให้ลบ"],
		forbiddenText: ["ลบเครดิตทุกหน้า"],
	},
	{ name: "editor-ai-review-chapter", path: "/projects/flow208-project/pages/1/editor", prepare: openAiReviewWithTwoMarkers },
	{
		name: "editor-brush-miss-hud",
		path: "/projects/flow208-project/pages/1/editor",
		prepare: openBrushMissHud,
		requiredText: ["ขยับแปรง", "นอกเลเยอร์ที่เลือก", "แปรง"],
	},
	{ name: "recent-open", path: "/projects/flow208-project/pages/1/editor", prepare: openRecentProjectPicker, viewports: ["desktop"] },
	{ name: "admin-settings-open", path: "/projects/flow208-project/pages/1/editor", prepare: openAdminSettings },
	{ name: "account-open", path: "/projects/flow208-project/pages/1/editor", prepare: openAccountMenu, viewports: ["desktop"] },
	{ name: "quick-tools", path: "/tools" },
	{ name: "import-json-guide", path: "/tools/import-json" },
];

test.describe("customer-ready prototype audit", () => {
	test("captures customer-readiness evidence for core surfaces", async ({ page }) => {
		test.skip(!test.info().project.name.includes("desktop"), "This audit drives its own desktop and iPad viewport sizes.");
		test.setTimeout(180_000);
		mkdirSync(AUDIT_DIR, { recursive: true });

		const report: Array<{
			viewport: string;
			surface: string;
			path: string;
			screenshot: string;
			clickedOpeners: string[];
			metrics: Awaited<ReturnType<typeof collectCustomerMetrics>>;
			consoleIssues: string[];
			customerFindings: string[];
		}> = [];
		const hardFailures: unknown[] = [];
		await installLocalPreauthBackendFallbacks(page);

		for (const viewport of AUDIT_VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			for (const surface of SURFACES) {
				if (surface.viewports && !surface.viewports.includes(viewport.name)) continue;
				const consoleIssues: string[] = [];
				const consoleHandler = (message: { type(): string; text(): string }) => {
					if (message.type() === "error" || message.type() === "warning") {
						consoleIssues.push(`${message.type()}: ${message.text()}`);
					}
				};
				const pageErrorHandler = (error: Error) => {
					consoleIssues.push(`pageerror: ${error.message}`);
				};
				page.on("console", consoleHandler);
				page.on("pageerror", pageErrorHandler);

				await page.goto(surface.path, { waitUntil: "domcontentloaded" });
				await page.waitForTimeout(800);
				if (surface.prepare) {
					await surface.prepare(page);
					await page.waitForTimeout(500);
				}
				let clickedOpeners = await clickOpeners(page, surface.openers);
				let metrics = await collectCustomerMetricsStable(page);
				let bodyText = await page.locator("body").innerText();
				if (metrics.controlCount === 0 && bodyText.trim().length === 0) {
					await page.goto(surface.path, { waitUntil: "domcontentloaded" });
					await page.waitForTimeout(800);
					if (surface.prepare) {
						await surface.prepare(page);
						await page.waitForTimeout(500);
					}
					clickedOpeners = await clickOpeners(page, surface.openers);
					metrics = await collectCustomerMetricsStable(page);
					bodyText = await page.locator("body").innerText();
				}
				const screenshot = `${viewport.name}-${surface.name}.png`;
				await page.screenshot({ path: resolve(AUDIT_DIR, screenshot), fullPage: false });

				page.off("console", consoleHandler);
				page.off("pageerror", pageErrorHandler);

				const customerFindings: string[] = [];
				const targetOverlayUnavailable = (surface.name === "recent-open" && !metrics.recentMenuBox)
					|| (surface.name === "account-open" && !metrics.accountPopoverBox)
					|| (surface.name === "admin-settings-open" && !metrics.adminDialogBox);
				const controlCountLimit = surface.name.startsWith("editor-") ? 65 : 55;
				if (!targetOverlayUnavailable && metrics.controlCount > controlCountLimit) customerFindings.push(`high control count: ${metrics.controlCount}`);
				if (!targetOverlayUnavailable && metrics.regionCount > 75) customerFindings.push(`high visible region count: ${metrics.regionCount}`);
				if (metrics.touchRisk.length) customerFindings.push(`touch-risk controls below 40px: ${metrics.touchRisk.length}`);
				if (metrics.sliderTouchRisk.length) customerFindings.push(`slider touch-risk controls below 40px: ${metrics.sliderTouchRisk.length}`);
				if (metrics.longButtons.length) customerFindings.push(`long button labels in compact controls: ${metrics.longButtons.length}`);
				if (metrics.disabledButtons.length > 8) customerFindings.push(`many disabled actions visible: ${metrics.disabledButtons.length}`);
				if (metrics.riskMatches.length) customerFindings.push(`customer-risk copy: ${metrics.riskMatches.join(", ")}`);
				const missingRequiredText = (surface.requiredText ?? []).filter((text) => !bodyText.includes(text));
				if (missingRequiredText.length) customerFindings.push(`missing required text: ${missingRequiredText.join(", ")}`);
				const presentForbiddenText = (surface.forbiddenText ?? []).filter((text) => bodyText.includes(text));
				if (presentForbiddenText.length) customerFindings.push(`forbidden text visible: ${presentForbiddenText.join(", ")}`);

				const entry = {
					viewport: viewport.name,
					surface: surface.name,
					path: surface.path,
					screenshot,
					clickedOpeners,
					metrics,
					consoleIssues,
					customerFindings,
				};
				report.push(entry);

					if (metrics.recentMenuBox && !metrics.recentMenuBox.insideViewport) {
						customerFindings.push("recent menu clipped outside viewport");
					}
					if (metrics.accountPopoverBox && !metrics.accountPopoverBox.insideViewport) {
						customerFindings.push("account popover clipped outside viewport");
					}
					if (metrics.adminDialogBox && !metrics.adminDialogBox.insideViewport) {
						customerFindings.push("admin settings dialog clipped outside viewport");
					}
					if (metrics.chapterDialogBox && !metrics.chapterDialogBox.insideViewport) {
						customerFindings.push("chapter setup dialog clipped outside viewport");
					}
					if (surface.name === "recent-open" && !metrics.recentMenuBox) {
						customerFindings.push("recent menu did not open");
					}
					if (surface.name === "account-open" && !metrics.accountPopoverBox) {
						customerFindings.push("account popover did not open");
					}
					if (surface.name === "admin-settings-open" && !metrics.adminDialogBox) {
						customerFindings.push("admin settings dialog did not open");
					}
					if (surface.name === "open-chapter-dialog" && !metrics.chapterDialogBox) {
						customerFindings.push("chapter setup dialog did not open");
					}

				if (
					metrics.tiny.length
					|| metrics.touchRisk.length
					|| metrics.overflowX
					|| metrics.bodyOverflowX
					|| metrics.riskMatches.length
					|| metrics.sliderTouchRisk.length
					|| consoleIssues.length
					|| missingRequiredText.length
					|| presentForbiddenText.length
					|| (metrics.recentMenuBox && !metrics.recentMenuBox.insideViewport)
					|| (metrics.accountPopoverBox && !metrics.accountPopoverBox.insideViewport)
					|| (metrics.adminDialogBox && !metrics.adminDialogBox.insideViewport)
					|| (metrics.chapterDialogBox && !metrics.chapterDialogBox.insideViewport)
					|| (surface.name === "recent-open" && !metrics.recentMenuBox)
					|| (surface.name === "account-open" && !metrics.accountPopoverBox)
					|| (surface.name === "admin-settings-open" && !metrics.adminDialogBox)
					|| (surface.name === "open-chapter-dialog" && !metrics.chapterDialogBox)
				) {
					hardFailures.push({
						viewport: viewport.name,
						surface: surface.name,
						path: surface.path,
						tiny: metrics.tiny.slice(0, 8),
						touchRisk: metrics.touchRisk.slice(0, 8),
						sliderTouchRisk: metrics.sliderTouchRisk.slice(0, 8),
						overflowX: metrics.overflowX,
						bodyOverflowX: metrics.bodyOverflowX,
						riskMatches: metrics.riskMatches,
						recentMenuBox: metrics.recentMenuBox,
						accountPopoverBox: metrics.accountPopoverBox,
						adminDialogBox: metrics.adminDialogBox,
						chapterDialogBox: metrics.chapterDialogBox,
						consoleIssues: consoleIssues.slice(0, 8),
						missingRequiredText,
						presentForbiddenText,
					});
				}
			}
		}

		writeFileSync(resolve(AUDIT_DIR, "customer-ready-audit-report.json"), JSON.stringify(report, null, 2));
		writeFileSync(
			resolve(AUDIT_DIR, "customer-ready-audit-summary.md"),
			[
				"# Flow374 Customer-Ready Audit Summary",
				"",
				...report.map((entry) => [
					`## ${entry.viewport} / ${entry.surface}`,
					`- path: ${entry.path}`,
					`- screenshot: ${entry.screenshot}`,
					`- controls: ${entry.metrics.controlCount}`,
					`- regions: ${entry.metrics.regionCount}`,
					`- overflowX: ${entry.metrics.overflowX}`,
					`- tiny: ${entry.metrics.tiny.length}`,
					`- console: ${entry.consoleIssues.length}`,
					`- findings: ${entry.customerFindings.length ? entry.customerFindings.join("; ") : "none"}`,
					"",
				].join("\n")),
			].join("\n"),
		);

		expect(hardFailures).toEqual([]);
	});
});
