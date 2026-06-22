// PR #264 P1 DEADLOCK browser proof.
//
// #264 moved the Telea heal solve into a Web Worker and (correctly) made nav/save/
// export gate on the registry's in-flight heal commit. Codex found a P1: the heal
// client did `await postToWorker()` with NO timeout. If the worker spawns but NEVER
// replies (e.g. OpenCV's onRuntimeInitialized never fires inside the worker), the
// heal promise never settles → `commitInFlight` stays non-null forever →
// `hasPendingBrushCommit()` stays true forever → every gated nav/save/export BLOCKS
// PERMANENTLY.
//
// The fix wraps the worker round-trip in a BOUNDED TIMEOUT: on expiry it rejects the
// request, tears down + disables the wedged worker, and falls back to the synchronous
// main-thread inpaint, so `inpaintRegion()` ALWAYS settles in bounded time.
//
// This proof drives the REAL heal-tool → registry → editor pipeline AND the REAL
// `inpaintRegion` worker spawn → post → timeout → teardown → fall-through code. We
// install a hung `Worker` global (spawns, never posts back) to model the init-hang,
// shrink the worker timeout to a few hundred ms via the editor debug seam, and supply
// a deterministic offline result for the sync fallback (OpenCV can't load in the
// offline headless sandbox). It asserts:
//   (A) DEADLOCK CASE: with the hung worker, a heal stroke STILL completes via the
//       sync fallback within the timeout; hasPendingBrushCommit() RELEASES; and a real
//       goToPage()/save through the store is NOT blocked (no permanent deadlock).
//   (B) HEALTHY WORKER: a worker that DOES reply resolves from the worker (sync
//       fallback never runs), and the heal lands — the no-freeze win is preserved.
//
// Screenshots + a JSON report are written to /tmp/qa-264deadlock/.

import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const PROOF_DIR = "/tmp/qa-264deadlock";
const AUTH_STORAGE_KEY = "manga-editor.auth.session.v1";

async function registerAndAuth(page: Page) {
	await page.goto("/");
	const email = `qa-264dl-${Date.now()}@example.com`;
	const session = await page.evaluate(async (em) => {
		const res = await fetch("/api/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "include",
			body: JSON.stringify({ email: em, password: "Qa264Dl12345!", name: "QA 264 DL" }),
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

async function seedLargePage(page: Page) {
	await page.evaluate(() => window.__mangaWorkflowDebug!.seedProject());
	await openEditorView(page);
	await dismissModals(page);
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({ width: 3000, height: 4000, label: "QA 264DL Page 0" });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	await page.waitForSelector('button[aria-label*="Spot Healing"]', { timeout: 15000 }).catch(() => undefined);
}

/**
 * Install a HUNG Worker global (spawns fine, never posts back — models OpenCV
 * init-hang in the worker) + an offline sync-fallback solver (the real OpenCV path
 * can't load offline). Also strip the "jsdom"-style guard isn't needed in a real
 * browser; canUseWorker() already returns true. The worker-timeout + teardown +
 * fall-through logic under test is the REAL production code.
 */
async function armHungWorker(page: Page, timeoutMs: number) {
	await page.evaluate((tmo) => {
		(window as any).__qaSyncFallbackRan = false;
		(window as any).__qaWorkerSpawns = 0;
		(window as any).__qaWorkerPosts = 0;
		// Replace Worker with a stub that NEVER replies (no onmessage callback ever).
		const RealWorker = (window as any).Worker;
		(window as any).__qaRealWorker = RealWorker;
		(window as any).Worker = class HungWorker {
			onmessage: any = null;
			onerror: any = null;
			constructor() {
				(window as any).__qaWorkerSpawns += 1;
			}
			postMessage() {
				(window as any).__qaWorkerPosts += 1; // ...and then silence forever.
			}
			terminate() {}
		};
		// Offline sync fallback: echo the ROI back, marking the first pixel so we can
		// prove the result surfaced (the real solver is unavailable offline).
		(globalThis as any).__inpaintSyncFallbackTestHook = (roi: ImageData) => {
			(window as any).__qaSyncFallbackRan = true;
			const out = new Uint8ClampedArray(roi.data);
			out[0] = 99;
			return new ImageData(out, roi.width, roi.height);
		};
	}, timeoutMs);
	await page.evaluate((tmo) => window.__mangaEditorDebug!.setInpaintWorkerTimeout(tmo), timeoutMs);
}

/** Install a HEALTHY Worker global that replies on the next macrotask with the ROI. */
async function armHealthyWorker(page: Page) {
	// Re-enable the worker — case (A)'s timeout disabled it for the session (correct
	// session-sticky behaviour). This proof seam restores it so we can exercise a
	// healthy worker next.
	await page.evaluate(() => window.__mangaEditorDebug!.resetInpaintWorker());
	await page.evaluate(() => {
		(window as any).__qaSyncFallbackRan = false;
		(window as any).__qaWorkerReplied = false;
		(window as any).Worker = class HealthyWorker {
			onmessage: ((e: any) => void) | null = null;
			onerror: any = null;
			constructor() {}
			postMessage(req: any) {
				setTimeout(() => {
					(window as any).__qaWorkerReplied = true;
					const out = new Uint8ClampedArray(req.width * req.height * 4);
					out[1] = 55;
					this.onmessage?.({ data: { id: req.id, ok: true, rgba: out.buffer } });
				}, 10);
			}
			terminate() {}
		};
		// If the sync fallback runs, it would set this — for a healthy worker it must NOT.
		(globalThis as any).__inpaintSyncFallbackTestHook = (roi: ImageData) => {
			(window as any).__qaSyncFallbackRan = true;
			return roi;
		};
	});
	await page.evaluate(() => window.__mangaEditorDebug!.setInpaintWorkerTimeout(2000));
}

async function clearWorkerHooks(page: Page) {
	await page.evaluate(() => {
		if ((window as any).__qaRealWorker) (window as any).Worker = (window as any).__qaRealWorker;
		delete (globalThis as any).__inpaintSyncFallbackTestHook;
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

async function healStroke(page: Page, box: { x: number; y: number; width: number; height: number }) {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	for (let i = 0; i < 8; i++) await page.mouse.move(cx + i * 2, cy + Math.sin(i) * 4);
	await page.mouse.up();
}

test.setTimeout(120000);

test("heal worker timeout: a wedged worker falls back to sync, nav/save are NOT blocked (PR #264 P1 deadlock)", async ({ page }) => {
	await mkdir(PROOF_DIR, { recursive: true });
	// Block the OpenCV CDN — neither the worker nor the (real) sync fallback can fetch
	// it offline. The hung-worker stub + sync-fallback hook fully cover the solve so the
	// REAL worker-timeout/teardown/fall-through code under test runs.
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
	// (A) DEADLOCK CASE — wedged worker, bounded timeout → sync fallback, nav frees
	// =========================================================================
	const WORKER_TIMEOUT = 600; // ms — short so the proof is quick (prod default ~10s)
	await armHungWorker(page, WORKER_TIMEOUT);

	const tHeal0 = Date.now();
	await healStroke(page, canvasBox);

	// While the worker is "solving" (it never will), the gate should be engaged briefly.
	// Then, within ~WORKER_TIMEOUT + slack, the timeout fires → sync fallback → the heal
	// settles → the gate RELEASES. Wait for that release (proves no permanent deadlock).
	await page.waitForFunction(
		() => window.__mangaEditorDebug!.hasPendingBrushCommit() === false,
		undefined,
		{ timeout: WORKER_TIMEOUT + 8000 },
	);
	const healSettleMs = Date.now() - tHeal0;

	const fallbackState = await page.evaluate(() => ({
		syncFallbackRan: (window as any).__qaSyncFallbackRan === true,
		workerSpawns: (window as any).__qaWorkerSpawns,
		workerPosts: (window as any).__qaWorkerPosts,
		pendingNow: window.__mangaEditorDebug!.hasPendingBrushCommit(),
		healCommitError: window.__mangaEditorDebug!.getBrushCommitErrorMessage(),
	}));
	await page.screenshot({ path: `${PROOF_DIR}/01-heal-settled-via-fallback.png` });

	// Now PROVE nav is not blocked: a real store navigation completes promptly (the gate
	// already released). We bound the await — a deadlock would make this hang/time out.
	const navOutcome = await page.evaluate(async () => {
		const nav = window.__mangaWorkflowDebug!.goToPageThroughStore(1);
		const done = await Promise.race([
			nav.then((r) => ({ ok: true as const, result: r })),
			new Promise<{ ok: false }>((res) => setTimeout(() => res({ ok: false }), 8000)),
		]);
		return done;
	});
	const pageIndexAfterNav = await page.evaluate(
		() => window.__mangaWorkflowDebug!.getState().pageIndex,
	);
	await page.screenshot({ path: `${PROOF_DIR}/02-after-nav-not-blocked.png` });

	// And PROVE save is not blocked either (it gates on the same in-flight commit).
	const saveOutcome = await page.evaluate(async () => {
		const fn = (window as any).__mangaWorkflowDebug?.saveProjectThroughStore;
		if (typeof fn !== "function") return { skipped: true as const };
		const save = fn();
		const done = await Promise.race([
			Promise.resolve(save).then(() => ({ ok: true as const })),
			new Promise<{ ok: false }>((res) => setTimeout(() => res({ ok: false }), 8000)),
		]);
		return done;
	});

	await clearWorkerHooks(page);

	// =========================================================================
	// (B) HEALTHY WORKER — replies fast, resolves from worker, no sync fallback
	// =========================================================================
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({ width: 3000, height: 4000, label: "QA 264DL Page B" });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	await activateTool(page, "Spot Healing");
	await armHealthyWorker(page);
	const tHealthy0 = Date.now();
	await healStroke(page, canvasBox);
	await page.waitForFunction(
		() => window.__mangaEditorDebug!.hasPendingBrushCommit() === false,
		undefined,
		{ timeout: 15000 },
	);
	const healthySettleMs = Date.now() - tHealthy0;
	const healthyState = await page.evaluate(() => ({
		workerReplied: (window as any).__qaWorkerReplied === true,
		syncFallbackRan: (window as any).__qaSyncFallbackRan === true,
		healCommitError: window.__mangaEditorDebug!.getBrushCommitErrorMessage(),
	}));
	await clearWorkerHooks(page);
	await page.screenshot({ path: `${PROOF_DIR}/03-healthy-worker.png` });

	const report = {
		page: "3000x4000 (12 MP), real project store, real heal-tool → registry → editor → inpaintRegion worker timeout",
		deadlockCase: {
			workerTimeoutMs: WORKER_TIMEOUT,
			...fallbackState,
			// The heal settled within (timeout + slack) — bounded, NOT forever.
			healSettleMs,
			settledBounded: healSettleMs < WORKER_TIMEOUT + 8000,
			navOutcome, // { ok:true, result:true } — nav NOT blocked
			pageIndexAfterNav, // 1
			saveOutcome, // { ok:true } or { skipped:true } — save NOT blocked
		},
		healthyWorker: {
			...healthyState,
			healthySettleMs,
		},
		// Ignore offline-sandbox resource noise (CDN/asset 4xx-5xx, OpenCV/inpaint).
		consoleErrors: consoleErrors.filter(
			(e) => !/opencv|jsdelivr|inpaint|Failed to load resource|40[0-9]|50[0-9]/i.test(e),
		),
	};
	await writeFile(`${PROOF_DIR}/heal-worker-timeout-deadlock-report.json`, JSON.stringify(report, null, 2));

	// ---- Assertions ----
	// (A) The hung worker WAS spawned + posted to (so we exercised the real worker path)...
	expect(report.deadlockCase.workerSpawns).toBeGreaterThanOrEqual(1);
	expect(report.deadlockCase.workerPosts).toBeGreaterThanOrEqual(1);
	// ...the timeout fired → the SYNC FALLBACK ran → the heal settled (bounded, not forever).
	expect(report.deadlockCase.syncFallbackRan).toBe(true);
	expect(report.deadlockCase.settledBounded).toBe(true);
	// ...the gate RELEASED (no permanent deadlock) + no commit error.
	expect(report.deadlockCase.pendingNow).toBe(false);
	expect(report.deadlockCase.healCommitError).toBeNull();
	// ...and nav was NOT blocked (it completed and advanced the page).
	expect(report.deadlockCase.navOutcome.ok).toBe(true);
	expect(report.deadlockCase.pageIndexAfterNav).toBe(1);
	// ...and save was NOT blocked either (when the seam exists).
	if (!("skipped" in report.deadlockCase.saveOutcome)) {
		expect(report.deadlockCase.saveOutcome.ok).toBe(true);
	}
	// (B) HEALTHY worker resolved from the worker — the sync fallback NEVER ran.
	expect(report.healthyWorker.workerReplied).toBe(true);
	expect(report.healthyWorker.syncFallbackRan).toBe(false);
	expect(report.healthyWorker.healCommitError).toBeNull();
	// No unexpected console/page errors.
	expect(report.consoleErrors).toEqual([]);
});
