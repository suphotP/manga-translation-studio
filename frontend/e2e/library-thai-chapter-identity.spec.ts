import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const NOW = "2026-05-21T00:00:00.000Z";
const TITLE = "Flow610 Real Create";
const PROJECTS = [
	{
		projectId: "flow610-en",
		name: "Flow610 Real Create - ตอน 104 - Real File Smoke",
		targetLang: "en",
		imageId: "flow610-page-104.webp",
		pageCount: 1,
		textLayerCount: 0,
		openTaskCount: 1,
		reviewTaskCount: 1,
	},
	{
		projectId: "flow610-th",
		name: "Flow610 Real Create - ตอน 105 - Second File",
		targetLang: "th",
		imageId: "flow610-page-105.webp",
		pageCount: 2,
		textLayerCount: 3,
		openTaskCount: 1,
		reviewTaskCount: 1,
	},
] as const;

const TRANSPARENT_WEBP = Buffer.from(
	"UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
	"base64",
);

function projectSummary(project: typeof PROJECTS[number]) {
	return {
		projectId: project.projectId,
		name: project.name,
		createdAt: NOW,
		updatedAt: project.projectId === "flow610-th" ? "2026-05-21T00:01:00.000Z" : NOW,
		coverImageId: project.imageId,
		coverOriginalName: `${project.projectId}.webp`,
		targetLang: project.targetLang,
		pageCount: project.pageCount,
		textLayerCount: project.textLayerCount,
		taskCount: 1,
		openTaskCount: project.openTaskCount,
		reviewTaskCount: project.reviewTaskCount,
		commentCount: 0,
		openCommentCount: 0,
	};
}

function projectState(project: typeof PROJECTS[number]) {
	return {
		projectId: project.projectId,
		name: project.name,
		createdAt: NOW,
		coverImageId: project.imageId,
		coverOriginalName: `${project.projectId}.webp`,
		currentPage: 0,
		targetLang: project.targetLang,
		pages: Array.from({ length: project.pageCount }, (_, pageIndex) => ({
			imageId: pageIndex === 0 ? project.imageId : `${project.imageId}-${pageIndex + 1}`,
			imageName: `${project.projectId}-page-${pageIndex + 1}.webp`,
			originalName: `${project.projectId}-page-${pageIndex + 1}.webp`,
			textLayers: [],
			imageLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		})),
		tasks: [
			{
				id: `${project.projectId}-review`,
				type: "review",
				status: "review",
				priority: "urgent",
				pageIndex: 0,
				pageImageId: project.imageId,
				title: `Review ${project.name}`,
				assignee: "solo",
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
		comments: [],
		reviewDecisions: [],
		aiReviewMarkers: [],
		activityLog: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		exportRuns: [],
	};
}

async function installLibraryMocks(page: Page): Promise<void> {
	await page.route("**/api/project**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/project" && request.method() === "GET") {
			await route.fulfill({ json: { projects: PROJECTS.map(projectSummary) } });
			return;
		}
		const match = url.pathname.match(/^\/api\/project\/([^/]+)(?:\/([^/]+))?/);
		if (!match) return route.fallback();
		const [, projectId, section] = match;
		const project = PROJECTS.find((candidate) => candidate.projectId === projectId);
		if (!project) {
			await route.fulfill({ status: 404, json: { error: "not found" } });
			return;
		}
		if (!section && request.method() === "GET") {
			await route.fulfill({ json: projectState(project) });
			return;
		}
		if (section === "versions") {
			await route.fulfill({ json: { versions: [] } });
			return;
		}
		if (section === "workflow") {
			await route.fulfill({ json: { tasks: projectState(project).tasks, activityLog: [] } });
			return;
		}
		if (section === "comments") {
			await route.fulfill({ json: { comments: [] } });
			return;
		}
		if (section === "review-decisions") {
			await route.fulfill({ json: { decisions: [] } });
			return;
		}
		if (section === "workspace-feed") {
			await route.fulfill({ json: { items: [], messages: [], activityLog: [] } });
			return;
		}
		if (section === "ai-markers") {
			await route.fulfill({ json: { markers: [] } });
			return;
		}
		await route.fulfill({ json: {} });
	});

	await page.route("**/api/images/**", async (route) => {
		await route.fulfill({
			body: TRANSPARENT_WEBP,
			headers: { "content-type": "image/webp" },
		});
	});
}

test.describe("Library Thai chapter identity", () => {
	test("keeps Flow610-style long Thai chapter names readable and opens the exact chapter", async ({ page }, testInfo) => {
		await installLibraryMocks(page);
		await page.goto("/library/flow610-real-create");
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));

		const stage = page.getByLabel(`เรื่องที่เลือก ${TITLE}`);
		await expect(stage).toBeVisible();
		await expect(stage).toContainText("ตอน 104");
		await expect(stage).toContainText("ตอน 105");
		await expect(stage).not.toContainText("Flow610 Real Create -");

		await page.getByRole("button", { name: "เลือก ตอน 105 TH ตรวจหน้าที่รอ" }).click();
		await expect(page).toHaveURL(/\/library\/flow610-real-create\/chapters\/flow610-th$/);
		await expect.poll(() => page.evaluate(() => window.__mangaWorkflowDebug!.getProjectState()?.projectId ?? null)).toBe("flow610-th");
		const selectedPath = page.getByLabel("เส้นทางคลังงานที่เลือก");
		await expect(selectedPath).toContainText("ตอน 105 · TH");
		await expect(selectedPath).toContainText("ตรวจหน้าที่รอ");

		await page.locator("details.library-browser-drawer summary").click();
		await page.getByLabel("ค้นเรื่องหรือตอน").fill("Second File");
		const drawer = page.locator("details.library-browser-drawer");
		await expect(drawer.locator(".chapter-list")).toContainText("ตอน 105");
		await expect(drawer.locator(".chapter-list")).not.toContainText("ตอน 104");
		await expect(drawer.locator(".browser-summary")).toContainText("ตอน 1");

		const metrics = await page.evaluate(() => {
			const stageText = document.querySelector(".library-title-stage")?.textContent ?? "";
			const drawerChapterText = document.querySelector(".library-browser-drawer .chapter-list")?.textContent ?? "";
			const packetText = document.querySelector(".chapter-work-packet")?.textContent ?? "";
			const packetActions = Array.from(document.querySelectorAll(".chapter-packet-actions button"))
				.map((element) => element instanceof HTMLElement ? element.innerText.trim().replace(/\s+/g, " ") : "")
				.filter(Boolean);
			const duplicatePacketActions = packetActions.filter((label, index) => packetActions.indexOf(label) !== index);
			const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
				.filter((element) => {
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
				})
				.map((element) => {
					const rect = element.getBoundingClientRect();
					const text = element instanceof HTMLElement ? element.innerText : "";
					return { width: Math.round(rect.width), height: Math.round(rect.height), text: text.trim().replace(/\s+/g, " ") };
				});
			return {
				overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
				under40: controls.filter((control) => control.width < 40 || control.height < 40),
				badHits: [
					stageText.includes("Flow610 Real Create -") ? "stage title still includes chapter suffix" : "",
					drawerChapterText.includes("Flow610 Real Create -") ? "drawer chapter title still includes chapter suffix" : "",
					document.body.innerText.includes("ตอนใหม่") ? "anonymous new chapter copy leaked" : "",
					document.body.innerText.includes("No project") ? "raw no project copy leaked" : "",
					packetText.includes("งานถัดไป") ? "selected chapter packet still reads as vague next work" : "",
					packetText.includes("แก้ภาพหน้าแรก") ? "editor command still says image edit instead of open page" : "",
					packetText.includes("จัดหน้า/Export") ? "page/export command still uses mixed old label" : "",
					stageText.includes("ตอน 104 -") || stageText.includes("ตอน 105 -") ? "chapter row repeats workflow state in the title" : "",
				].filter(Boolean),
				packetActions,
				duplicatePacketActions,
			};
		});

		await mkdir("../.codex-dev-logs/visual-checks/flow613-library-thai-chapter-identity", { recursive: true });
		await page.screenshot({
			path: `../.codex-dev-logs/visual-checks/flow613-library-thai-chapter-identity/${testInfo.project.name}.png`,
			fullPage: true,
		});
		await writeFile(
			`../.codex-dev-logs/visual-checks/flow613-library-thai-chapter-identity/${testInfo.project.name}-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);

		expect(metrics.overflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(metrics.badHits).toEqual([]);
		expect(metrics.duplicatePacketActions).toEqual([]);
		expect(metrics.packetActions).toEqual(expect.arrayContaining(["ตรวจทีละรายการ", "ดูคิวรีวิว", "นำเข้า"]));
		expect(metrics.packetActions.some((label) => label === "เปิดหน้าแรก" || /^เปิดหน้า \d+$/.test(label))).toBe(true);
	});
});
