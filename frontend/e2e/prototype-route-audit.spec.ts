import { expect, test, type Page } from "@playwright/test";

type AuditRoute = {
	name: string;
	path: string;
	openers?: string[];
};

const AUDIT_VIEWPORTS = [
	{ name: "desktop", width: 1440, height: 1000 },
	{ name: "ipad", width: 929, height: 1194 },
] as const;

const RAW_TERMS = [
	"Quick Tools",
	"Quick Clean",
	"Quick Translate",
	"JSON Import Guide",
	"Back to tools",
	"Upload an image",
	"Choose Image",
	"Processing...",
	"Download",
	"Reset",
	"Unsupported image file",
	"Settings",
	"System Settings",
	"ChatGPT (Primary)",
	"Cancel",
	"Save",
	"Saving...",
	"debug",
	"debug-provider",
	"Flow208",
	"flow208",
	"Prototype Journey",
	"FLOW208 PAGE",
	"AI RESULT",
	"flow208-page",
	"flow208-ai-result",
	"flow208-export",
	"production sample",
	"rev ",
	"Login failed",
	"Registration failed",
	"Invalid credentials",
	"Admin settings",
	"AI jobs",
	"Create projects",
	"Edit workspace",
	"Open recent project",
	"No session",
	"No project",
	"No queue",
	"Error loading",
	"Invalid project ID",
	"Copy link",
	"Copied link",
	"Missing title",
	"Missing page",
	"Missing layer",
	"No page preview",
	"Review imported dialogue",
	"No preview",
	"Task updated",
	"AI marker accepted",
	"Export blocked",
	"Export gate passed",
	"Page 1 -",
	"Page 2 -",
	"TODO",
	"DONE",
	"OWNER",
	"Urgent",
	"High priority",
	"ยังไม่ assign",
];

const ROUTES: AuditRoute[] = [
	{ name: "root", path: "/" },
	{ name: "tools", path: "/tools" },
	{ name: "tools-clean", path: "/tools/clean" },
	{ name: "tools-translate", path: "/tools/translate" },
	{ name: "tools-import-json", path: "/tools/import-json" },
	{ name: "missing-library-title", path: "/library/missing-title" },
	{ name: "flow208-library-title", path: "/library/flow208-prototype-journey" },
	{ name: "flow208-pages", path: "/projects/flow208-project/pages" },
	{ name: "flow208-work", path: "/projects/flow208-project/work", openers: ["งานด่วน", "อัปเดตทีม", "ตรวจผล AI", "เช็กคุณภาพ", "งานทั้งหมด"] },
	{ name: "flow208-focus", path: "/projects/flow208-project/focus/review-task-flow208-review-p1", openers: ["รายการ Focus", "รายละเอียด", "คิว"] },
	{ name: "flow208-import", path: "/projects/flow208-project/import", openers: ["เครื่องมือนำเข้า", "จับคู่รูป"] },
	{ name: "flow208-editor", path: "/projects/flow208-project/pages/1/editor", openers: ["แผงขวา", "เลือกแผง เลเยอร์"] },
];

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

async function collectMetrics(page: Page) {
	return page.evaluate((rawTerms) => {
		const body = document.body.innerText;
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea"))
			.filter((element) => {
				const rect = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				return rect.width > 0
					&& rect.height > 0
					&& style.display !== "none"
					&& style.visibility !== "hidden"
					&& style.opacity !== "0";
			})
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					text: (element.textContent || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim(),
					tag: element.tagName,
					width: Math.round(rect.width * 100) / 100,
					height: Math.round(rect.height * 100) / 100,
					x: Math.round(rect.x),
					y: Math.round(rect.y),
				};
			});

		return {
			rawMatches: rawTerms.filter((term) => body.includes(term)),
			under36: controls.filter((control) => control.width < 36 || control.height < 36),
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
		};
	}, RAW_TERMS);
}

test.describe("prototype route copy and touch audit", () => {
	test("keeps key desktop and iPad routes free of known raw copy and layout regressions", async ({ page }) => {
		test.skip(!test.info().project.name.includes("desktop"), "This audit sets exact desktop and iPad viewport sizes internally.");
		test.setTimeout(90_000);

		const failures: Array<{
			viewport: string;
			route: string;
			path: string;
			rawMatches: string[];
			under36: unknown[];
			overflowX: number;
			bodyOverflowX: number;
			consoleIssues: string[];
		}> = [];

		for (const viewport of AUDIT_VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			for (const route of ROUTES) {
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

				await page.goto(route.path, { waitUntil: "domcontentloaded" });
				await page.waitForTimeout(1000);
				await clickOpeners(page, route.openers);
				const metrics = await collectMetrics(page);

				page.off("console", consoleHandler);
				page.off("pageerror", pageErrorHandler);

				if (
					metrics.rawMatches.length
					|| metrics.under36.length
					|| metrics.overflowX
					|| metrics.bodyOverflowX
					|| consoleIssues.length
				) {
					failures.push({
						viewport: viewport.name,
						route: route.name,
						path: route.path,
						rawMatches: metrics.rawMatches,
						under36: metrics.under36.slice(0, 8),
						overflowX: metrics.overflowX,
						bodyOverflowX: metrics.bodyOverflowX,
						consoleIssues: consoleIssues.slice(0, 8),
					});
				}
			}
		}

		expect(failures).toEqual([]);
	});
});
