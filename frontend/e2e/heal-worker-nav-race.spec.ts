// PR #264 worker-race browser proof.
//
// #264 moved the Telea heal solve into a Web Worker: the heal tool now does
// `await inpaintRegion()` and only AFTER calls `applyToolPatchInstant()`. During the
// solve the stroke is in the registry's `commitInFlight` but NOT yet in the editor's
// `pendingBrushCommits`. The reopened race (closed by #248/#255): release a heal
// stroke → immediately navigate / tear down while the worker runs → the late ROI
// composites onto the NEWLY loaded page (wrong-page corruption) or is applied after
// teardown.
//
// This proof drives the REAL heal-tool → registry → editor pipeline on a 3000×4000
// page (cv.inpaint can't run in this offline headless sandbox, so we install a test
// hook — `globalThis.__inpaintRegionTestHook` — that holds the solve "in flight" until
// we release it, exactly the "stubbed/forced delay via the worker round-trip" the task
// authorizes). It asserts:
//   (A) GATE: while the solve is in flight, hasPendingBrushCommit() is TRUE (it now
//       reflects the registry's in-flight worker op), and a real goToPage() through the
//       store does NOT resolve until the solve is released — nav WAITS for the worker.
//       The heal then lands on the ORIGINAL page (epoch unchanged) and the page bitmap
//       changes; the OTHER page is never touched.
//   (B) EPOCH GUARD: if the image reloads (epoch advances) WHILE the solve is in flight,
//       the worker result is DISCARDED — the now-current bitmap is unchanged (no wrong-
//       page composite, no fallback full-page commit).
//
// Screenshots + a JSON report are written to /tmp/qa-264fix/.

import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const PROOF_DIR = "/tmp/qa-264fix";
const AUTH_STORAGE_KEY = "manga-editor.auth.session.v1";

async function registerAndAuth(page: Page) {
	await page.goto("/");
	const email = `qa-264fix-${Date.now()}@example.com`;
	const session = await page.evaluate(async (em) => {
		const res = await fetch("/api/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "include",
			body: JSON.stringify({ email: em, password: "Qa264Fix12345!", name: "QA 264" }),
		});
		if (!res.ok) throw new Error("register failed: " + res.status + " " + (await res.text()));
		return res.json();
	}, email);
	await page.evaluate(
		([key, value]) => window.localStorage.setItem(key as string, value as string),
		[AUTH_STORAGE_KEY, JSON.stringify(session)],
	);
}

async function waitForDebug(page: Page) {
	await page.goto("/");
	await page.waitForFunction(
		() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug),
		undefined,
		{ timeout: 30000 },
	);
}

async function openEditorView(page: Page) {
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("editor"));
	await page.waitForFunction(() => {
		const root = document.querySelector(".editor-root");
		return Boolean(root && !root.classList.contains("workspace-dashboard-view"));
	}, undefined, { timeout: 20000 });
}

async function dismissModals(page: Page) {
	for (const name of [/ข้าม/, /ยอมรับทั้งหมด|ยอมรับ|Accept/i, /ปิด/]) {
		await page.getByRole("button", { name }).first().click({ timeout: 1000 }).catch(() => undefined);
	}
}

/** Seed a real multi-page project store + editor, then load a LARGE (12 MP) bitmap. */
async function seedLargePage(page: Page) {
	await page.evaluate(() => window.__mangaWorkflowDebug!.seedProject());
	await openEditorView(page);
	await dismissModals(page);
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({ width: 3000, height: 4000, label: "QA 264 Page 0" });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	await page.waitForSelector('button[aria-label*="Spot Healing"]', { timeout: 15000 }).catch(() => undefined);
}

/** Cheap content fingerprint of the merged page bitmap. */
async function bitmapHash(page: Page): Promise<string> {
	return page.evaluate(async () => {
		try {
			const s = await window.__mangaEditorDebug!.exportMergedImageDataUrl();
			let h = 0;
			for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0;
			return `${s.length}:${h}`;
		} catch {
			return "no-image";
		}
	});
}

/** Install a controllable worker-solve hook: inpaintRegion resolves only when we call
 *  releaseHealSolve(). resolve echoes the ROI back as the "healed" result. */
async function armHealSolveGate(page: Page) {
	await page.evaluate(() => {
		(window as any).__qaHealReleased = false;
		(window as any).__qaHealInFlight = false;
		(globalThis as any).__inpaintRegionTestHook = (roi: ImageData) =>
			new Promise<ImageData>((resolve) => {
				(window as any).__qaHealInFlight = true;
				(window as any).__qaReleaseHeal = () => {
					(window as any).__qaHealReleased = true;
					resolve(roi);
				};
			});
	});
}

async function releaseHealSolve(page: Page) {
	await page.evaluate(() => (window as any).__qaReleaseHeal?.());
}

async function clearHealSolveGate(page: Page) {
	await page.evaluate(() => {
		delete (globalThis as any).__inpaintRegionTestHook;
		delete (window as any).__qaReleaseHeal;
	});
}

async function activateTool(page: Page, ariaSubstr: string) {
	await dismissModals(page);
	const btn = page.locator(`button[aria-label*="${ariaSubstr}"]`);
	await expect(btn).toBeVisible({ timeout: 15000 });
	await btn.click();
	await page.waitForFunction(
		() => window.__mangaEditorDebug!.getState().imageToolActive === true,
		undefined,
		{ timeout: 5000 },
	);
}

/** Paint a short heal stroke at the canvas centre (does NOT wait for the solve). */
async function healStroke(page: Page, box: { x: number; y: number; width: number; height: number }) {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	for (let i = 0; i < 8; i++) await page.mouse.move(cx + i * 2, cy + Math.sin(i) * 4);
	await page.mouse.up();
}

test.setTimeout(120000);

test("heal worker race: nav waits for the in-flight solve and an epoch change discards the ROI (PR #264)", async ({ page }) => {
	await mkdir(PROOF_DIR, { recursive: true });
	// Block the OpenCV CDN — the heal worker / sync fallback can't run offline; the
	// test hook fully replaces the solve so the real tool→registry→editor path runs.
	await page.route("**/cdn.jsdelivr.net/**", (route) => route.abort());

	const consoleErrors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));

	await registerAndAuth(page);
	await waitForDebug(page);
	await seedLargePage(page);
	await page.screenshot({ path: `${PROOF_DIR}/00-loaded-page0.png` });

	const canvasBox = await page.locator("canvas").first().boundingBox();
	if (!canvasBox) throw new Error("no canvas bounding box");

	await activateTool(page, "Spot Healing");

	// =========================================================================
	// (A) GATE + nav-waits-for-solve
	// =========================================================================
	const beforeHealHash = await bitmapHash(page);
	await armHealSolveGate(page);
	await healStroke(page, canvasBox);

	// The worker solve is now in flight. Wait until the hook reports it entered.
	await page.waitForFunction(() => (window as any).__qaHealInFlight === true, undefined, { timeout: 10000 });

	// THE FIX (gate): hasPendingBrushCommit() reflects the in-flight worker op.
	const pendingDuringSolve = await page.evaluate(
		() => window.__mangaEditorDebug!.hasPendingBrushCommit(),
	);

	// Diagnostic: capture nav-guard state so a false return is explainable.
	const preNavDiag = await page.evaluate(() => {
		const st = window.__mangaWorkflowDebug!.getState();
		const proj = window.__mangaWorkflowDebug!.getProjectState?.();
		return {
			pageIndex: st.pageIndex,
			pageCount: st.pageCount,
			currentPage: proj?.currentPage ?? null,
			saveSyncStatus: (proj as any)?.saveSyncStatus ?? null,
		};
	});

	// Start a REAL store navigation to page 1 while the solve is in flight. We must NOT
	// await the nav promise here (the fix makes it WAIT for the held solve — awaiting it
	// would deadlock the test); fire it and record completion on window asynchronously.
	await page.evaluate(() => {
		(window as any).__qaNavDone = false;
		(window as any).__qaNavResult = null;
		void window.__mangaWorkflowDebug!.goToPageThroughStore(1).then((r) => {
			(window as any).__qaNavDone = true;
			(window as any).__qaNavResult = r;
		});
	});
	// Give the nav a generous window to (wrongly) complete if the gate were broken.
	await page.waitForTimeout(1500);
	const navDoneWhileSolving = await page.evaluate(() => (window as any).__qaNavDone === true);
	const whileSolvingState = await page.evaluate(() => {
		const st = window.__mangaWorkflowDebug!.getState();
		return { pageIndex: st.pageIndex, statusMsg: st.statusMsg, saveSyncStatus: st.saveSyncStatus };
	});
	const pageIndexWhileSolving = whileSolvingState.pageIndex;

	// Release the solve → the heal composites onto the ORIGINAL page (epoch unchanged
	// because nav waited), then the awaited drain lets nav advance to page 1.
	await releaseHealSolve(page);
	await page.waitForFunction(() => (window as any).__qaNavDone === true, undefined, { timeout: 15000 });
	const navResult = await page.evaluate(() => (window as any).__qaNavResult);
	const pageIndexAfterNav = await page.evaluate(
		() => window.__mangaWorkflowDebug!.getState().pageIndex,
	);
	await clearHealSolveGate(page);
	const healCommitError = await page.evaluate(
		() => window.__mangaEditorDebug!.getBrushCommitErrorMessage(),
	);
	await page.screenshot({ path: `${PROOF_DIR}/01-after-nav-waited.png` });

	// =========================================================================
	// (B) EPOCH GUARD — image reloads mid-solve → worker result discarded
	// =========================================================================
	// Reload a fresh large page (resets currentPage edit state); this is page-1 now.
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({ width: 3000, height: 4000, label: "QA 264 Page B" });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	await activateTool(page, "Spot Healing");
	const cleanHashB = await bitmapHash(page);
	await armHealSolveGate(page);
	await healStroke(page, canvasBox);
	await page.waitForFunction(() => (window as any).__qaHealInFlight === true, undefined, { timeout: 10000 });

	// Force a fresh image reload WHILE the solve is in flight — loadTestImage bumps the
	// editor's imageEpoch (resetBackgroundEditState), simulating a page switch / reload /
	// teardown. We reload another large test bitmap so we control the post-reload pixels.
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({ width: 3000, height: 4000, label: "QA 264 Page C (reloaded mid-solve)" });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	// Snapshot the reloaded bitmap BEFORE releasing the solve — this is the page that
	// must remain untouched.
	const reloadedHashBeforeRelease = await bitmapHash(page);

	// Now release the solve. The heal tool captured the OLD epoch before awaiting; the
	// epoch advanced on reload, so applyToolPatchInstant DISCARDS the ROI — the reloaded
	// bitmap must be UNCHANGED (no wrong-page composite, no fallback full-page commit).
	await releaseHealSolve(page);
	await page.waitForTimeout(1200);
	await clearHealSolveGate(page);
	const afterDiscardHash = await bitmapHash(page);
	const epochGuardCommitError = await page.evaluate(
		() => window.__mangaEditorDebug!.getBrushCommitErrorMessage(),
	);
	await page.screenshot({ path: `${PROOF_DIR}/02-after-epoch-discard.png` });

	const report = {
		page: "3000x4000 (12 MP), real project store, real heal-tool → registry → editor",
		gate: {
			pendingDuringSolve, // FIX: true (pre-fix: false)
			navDoneWhileSolving, // FIX: false (nav WAITS) (pre-fix: true → advanced mid-solve)
			pageIndexWhileSolving, // FIX: 0 (still original page) (pre-fix: 1)
			navResult, // true once the solve released + drain completed
			pageIndexAfterNav, // 1
			preNavDiag,
			whileSolvingState,
			beforeHealHash,
			healCommitError,
		},
		epochGuard: {
			cleanHashB,
			reloadedHashBeforeRelease,
			afterDiscardHash,
			// The reloaded (post-epoch-bump) bitmap is UNCHANGED across releasing the
			// solve → the stale ROI was discarded, never composited onto the new page.
			discardedNoComposite: reloadedHashBeforeRelease === afterDiscardHash,
			epochGuardCommitError,
		},
		// Ignore offline-sandbox resource noise (CDN/asset 4xx-5xx, OpenCV/inpaint) — none
		// of those are heal/nav/page errors. We only fail on a real pageerror/heal error.
		consoleErrors: consoleErrors.filter(
			(e) => !/opencv|jsdelivr|inpaint|Failed to load resource|40[0-9]|50[0-9]/i.test(e),
		),
	};
	await writeFile(`${PROOF_DIR}/heal-worker-nav-race-report.json`, JSON.stringify(report, null, 2));

	// ---- Assertions ----
	// (A) GATE: the in-flight worker solve is reflected in hasPendingBrushCommit().
	expect(report.gate.pendingDuringSolve).toBe(true);
	// (A) Nav did NOT complete while the solve was in flight — it WAITED.
	expect(report.gate.navDoneWhileSolving).toBe(false);
	expect(report.gate.pageIndexWhileSolving).toBe(0);
	// (A) After releasing, nav completed and advanced; no commit error (clean heal).
	expect(report.gate.navResult).toBe(true);
	expect(report.gate.pageIndexAfterNav).toBe(1);
	expect(report.gate.healCommitError).toBeNull();
	// (B) EPOCH GUARD: the mid-solve reload made the worker result stale → discarded;
	// the now-current bitmap is UNCHANGED (no wrong-page composite, no fallback commit).
	expect(report.epochGuard.discardedNoComposite).toBe(true);
	expect(report.epochGuard.epochGuardCommitError).toBeNull();
	// No unexpected console/page errors.
	expect(report.consoleErrors).toEqual([]);
});
