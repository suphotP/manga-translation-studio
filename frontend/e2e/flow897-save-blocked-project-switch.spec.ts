import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOF_DIR = "../.codex-dev-logs/visual-checks/flow897-save-blocked-project-switch";
const CURRENT_PROJECT_ID = "123e4567-e89b-42d3-a456-426614189700";
const NEXT_PROJECT_ID = "123e4567-e89b-42d3-a456-426614189701";

function currentRemoteBaselineProject() {
	return {
		projectId: CURRENT_PROJECT_ID,
		name: "Current Dirty Chapter",
		createdAt: "2026-05-19T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [{
			imageId: "current-image.webp",
			imageName: "current-image.webp",
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		}],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
	};
}

async function installFailingSaveRoutes(page: Page) {
	const saveRequests: unknown[] = [];
	const nextProjectLoads: string[] = [];

	await page.route(`**/api/project/${CURRENT_PROJECT_ID}/save`, async (route) => {
		saveRequests.push(await route.request().postDataJSON());
		await route.fulfill({
			status: 500,
			contentType: "application/json",
			body: JSON.stringify({ error: "disk is full" }),
		});
	});
	await page.route(`**/api/project/${CURRENT_PROJECT_ID}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(currentRemoteBaselineProject()),
		});
	});
	await page.route(`**/api/project/${NEXT_PROJECT_ID}`, async (route) => {
		nextProjectLoads.push(route.request().url());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ projectId: NEXT_PROJECT_ID, name: "Should Not Open", pages: [] }),
		});
	});
	await page.route("**/api/project", async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
	});
	await page.route("**/api/ai/capabilities", async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tiers: [] }) });
	});

	return {
		get saveRequests() { return saveRequests; },
		get nextProjectLoads() { return nextProjectLoads; },
	};
}

async function collectMetrics(page: Page, consoleIssues: string[], routes: Awaited<ReturnType<typeof installFailingSaveRoutes>>) {
	return page.evaluate((input) => {
		const controls = Array.from(document.querySelectorAll("button, a, input, select, textarea, summary"))
			.filter((control) => {
				const rect = control.getBoundingClientRect();
				const style = getComputedStyle(control);
				return rect.width > 0
					&& rect.height > 0
					&& rect.bottom >= 0
					&& rect.top <= window.innerHeight
					&& style.display !== "none"
					&& style.visibility !== "hidden";
			})
			.map((control) => {
				const rect = control.getBoundingClientRect();
				return {
					text: control.getAttribute("aria-label") ?? control.textContent?.trim().replace(/\s+/g, " ") ?? control.tagName,
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				};
			});
		const project = window.__mangaWorkflowDebug?.getProjectState() ?? null;
		const body = document.body.innerText;
		return {
			...input.routeMetrics,
			path: window.location.pathname,
			projectId: project?.projectId ?? null,
			currentPage: project?.currentPage ?? null,
			currentText: project?.pages?.[0]?.textLayers?.[0]?.text ?? null,
			state: window.__mangaWorkflowDebug?.getState() ?? null,
			recoveryVisible: body.includes("ยังไม่ได้เปิดงานใหม่") && body.includes("งานเดิมยังปลอดภัย"),
			recoveryActionVisible: body.includes("ลองบันทึกงานเดิม"),
			statusRetryButtonCount: document.querySelectorAll("button[aria-label='ลองบันทึกอีกครั้ง']").length,
			oldProjectVisible: body.includes("Current Dirty Chapter"),
			nextProjectVisible: body.includes("Should Not Open"),
			overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
			bodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
			under40: controls.filter((control) => control.width < 40 || control.height < 40),
			consoleIssues: input.consoleIssues,
		};
	}, {
		consoleIssues,
		routeMetrics: {
			saveRequestCount: routes.saveRequests.length,
			nextProjectLoadCount: routes.nextProjectLoads.length,
		},
	});
}

test.describe("Flow897 save-blocked project switch recovery", () => {
	test("keeps the dirty project open and shows a recovery path when switching projects fails to save", async ({ page }, testInfo: TestInfo) => {
		const routes = await installFailingSaveRoutes(page);
		const consoleIssues: string[] = [];
		page.on("console", (message) => {
			const text = message.text();
			const expectedSaveFailureLog = text.includes("[ProjectStore] saveState error:")
				|| text.includes("[ProjectStore] saveBeforeProjectSwitch error:")
				|| text.includes("disk is full")
				|| text.includes("Failed to load resource: the server responded with a status of 500");
			if (["error", "warning"].includes(message.type()) && !expectedSaveFailureLog) {
				consoleIssues.push(`${message.type()}: ${text}`);
			}
		});
		page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

		await page.goto("/");
		await page.waitForFunction(() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug));
		await page.evaluate(async ({ currentId, nextId }) => {
			await window.__mangaWorkflowDebug!.exerciseProjectSwitchSaveFailure(currentId, nextId);
		}, { currentId: CURRENT_PROJECT_ID, nextId: NEXT_PROJECT_ID });

		const recovery = page.getByRole("region", { name: "กู้การบันทึกก่อนเปิดงานใหม่" });
		await expect(recovery).toBeVisible();
		await expect(recovery).toContainText("ยังไม่ได้เปิดงานใหม่");
		await expect(recovery).toContainText("งานเดิมยังปลอดภัย");
		await expect(recovery).toContainText("งานเดิมยังอยู่");
		await expect(recovery.getByRole("button", { name: "ลองบันทึกงานเดิม" })).toBeVisible();
		await expect(page.getByText("Should Not Open")).toHaveCount(0);

		const metrics = await collectMetrics(page, consoleIssues, routes);
		expect(metrics.projectId).toBe(CURRENT_PROJECT_ID);
		expect(metrics.currentPage).toBe(0);
		expect(metrics.currentText).toBe("local edit before switching");
		expect(metrics.state.saveSyncStatus).toBe("error");
		expect(metrics.state.saveErrorKind).toBe("generic");
		expect(metrics.state.statusMsg).toContain("งานเดิมยังอยู่");
		expect(metrics.saveRequestCount).toBe(1);
		expect(metrics.nextProjectLoadCount).toBe(0);
		expect(metrics.recoveryVisible).toBe(true);
		expect(metrics.recoveryActionVisible).toBe(true);
		expect(metrics.statusRetryButtonCount).toBe(0);
		expect(metrics.oldProjectVisible).toBe(true);
		expect(metrics.nextProjectVisible).toBe(false);
		expect(metrics.overflowX).toBe(0);
		expect(metrics.bodyOverflowX).toBe(0);
		expect(metrics.under40).toEqual([]);
		expect(metrics.consoleIssues).toEqual([]);

		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({
			path: `${PROOF_DIR}/${testInfo.project.name}-save-blocked-project-switch.png`,
			fullPage: false,
		});
		await writeFile(
			`${PROOF_DIR}/${testInfo.project.name}-metrics.json`,
			JSON.stringify(metrics, null, 2),
		);
	});
});
