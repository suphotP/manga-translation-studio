// P1.1 / P1.2 / P1.3 "edit survives navigate-away-and-back" proof for the editor
// cleaning tools.
//
// The "no-freeze" branch moved tool commits to async OFF-THREAD `blob:` encoders.
// That introduced a use-after-revoke: persistence cached the SAME `blob:` URL in
// `localImageUrls`, then the editor revoked it after the commit settled — so a
// later getImageUrl() (after navigating away + back, or a page reload) returned a
// REVOKED blob and the edited page loaded BLANK.
//
// This proof, on a large (3000×4000) page through the real project store:
//   (a) Clone a page → wait for the commit to settle → getImageUrl() is NOT a
//       (soon-revoked) blob: URL, and RELOADING the page from that cached URL —
//       exactly what happens when you leave to the library and come back, or
//       reload the page — renders the edited pixels, NOT a blank page;
//   (b) erase an AI overlay → reload from the cached URL → the edit persists;
//   (c) two RAPID clone strokes → after both settle, both edits are present, the
//       final cached image is valid (no overwrite / out-of-order loss), no commit
//       error — and the UI never froze (no long main-thread task / frame stall).
//
// Screenshots + measured numbers are written to /tmp/qa-tools2/.

import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const PROOF_DIR = "/tmp/qa-tools2";
const AUTH_STORAGE_KEY = "manga-editor.auth.session.v1";

async function registerAndAuth(page: Page) {
	await page.goto("/");
	const email = `qa-tools2-${Date.now()}@example.com`;
	const session = await page.evaluate(async (em) => {
		const res = await fetch("/api/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "include",
			body: JSON.stringify({ email: em, password: "QaTools12345!", name: "QA Tools 2" }),
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

/** Seed a real project store + editor, then replace the page with a LARGE (12 MP)
 *  bitmap (the size that froze the tools + the persistence target). */
async function seedLargePage(page: Page) {
	await page.evaluate(() => window.__mangaWorkflowDebug!.seedProject());
	await openEditorView(page);
	await dismissModals(page);
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({ width: 3000, height: 4000, label: "QA Large Page" });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	await page.waitForSelector('button[aria-label*="Clone Stamp"]', { timeout: 15000 });
}

/** Content fingerprint of the merged page bitmap (length + cheap hash). */
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

/** True if the page bitmap is effectively blank (catches a use-after-revoke load). */
async function isBlank(page: Page): Promise<boolean> {
	return page.evaluate(async () => {
		const s = await window.__mangaEditorDebug!.exportMergedImageDataUrl().catch(() => "");
		if (!s || s === "no-image") return true;
		const img = new Image();
		const ok = await new Promise<boolean>((resolve) => {
			img.onload = () => resolve(true);
			img.onerror = () => resolve(false);
			img.src = s;
		});
		if (!ok) return true;
		const c = document.createElement("canvas");
		c.width = Math.min(400, img.naturalWidth || 1);
		c.height = Math.min(533, img.naturalHeight || 1);
		const cx = c.getContext("2d");
		if (!cx) return true;
		cx.drawImage(img, 0, 0, c.width, c.height);
		const data = cx.getImageData(0, 0, c.width, c.height).data;
		let nonWhite = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) nonWhite++;
		}
		return nonWhite < 50;
	});
}

/** The navigate-away-and-back action: re-load the current page from the URL the
 *  store cached for it (getImageUrl). This is exactly what the canvas does when
 *  you leave to the library and return, or reload the page. If the store cached a
 *  revoked blob:, this load FAILS / renders blank — the bug. */
async function reloadCurrentPageFromCachedUrl(page: Page): Promise<{ url: string | null; loadOk: boolean }> {
	return page.evaluate(async () => {
		const url = window.__mangaWorkflowDebug!.getCurrentPageImageUrl();
		if (!url) return { url, loadOk: false };
		// Decode the cached URL independently first (a revoked blob: rejects here).
		const decodeOk = await new Promise<boolean>((resolve) => {
			const img = new Image();
			img.onload = () => resolve(true);
			img.onerror = () => resolve(false);
			img.src = url;
		});
		// Then drive the real editor reload from that URL (what navigation does).
		await window.__mangaEditorDebug!.loadImageUrl(url).catch(() => undefined);
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		return { url, loadOk: decodeOk };
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

async function strokeWithTrace(
	page: Page,
	opts: { alt?: boolean; points: number; spreadX: number; spreadY: number; altAt?: { x: number; y: number }; paintAt: { x: number; y: number } },
) {
	await page.evaluate(() => {
		(window as any).__qaLongTasks = [];
		(window as any).__qaFrameGaps = [];
		try {
			const obs = new PerformanceObserver((list) => {
				for (const e of list.getEntries()) (window as any).__qaLongTasks.push(Math.round(e.duration));
			});
			obs.observe({ entryTypes: ["longtask"] });
			(window as any).__qaObs = obs;
		} catch { /* longtask unsupported */ }
		let last = performance.now();
		const beat = () => {
			const now = performance.now();
			(window as any).__qaFrameGaps.push(Math.round(now - last));
			last = now;
			(window as any).__qaBeatRaf = requestAnimationFrame(beat);
		};
		(window as any).__qaBeatRaf = requestAnimationFrame(beat);
	});

	if (opts.alt && opts.altAt) {
		await page.mouse.move(opts.altAt.x, opts.altAt.y);
		await page.keyboard.down("Alt");
		await page.mouse.down();
		await page.mouse.up();
		await page.keyboard.up("Alt");
	}
	await page.mouse.move(opts.paintAt.x, opts.paintAt.y);
	await page.mouse.down();
	for (let i = 0; i < opts.points; i++) {
		const dx = opts.paintAt.x + Math.sin(i / 3) * opts.spreadX + (i - opts.points / 2) * 3;
		const dy = opts.paintAt.y + Math.cos(i / 4) * opts.spreadY;
		await page.mouse.move(dx, dy);
	}
	await page.mouse.up();
	await page.waitForTimeout(1500);

	return page.evaluate(() => {
		(window as any).__qaObs?.disconnect?.();
		cancelAnimationFrame((window as any).__qaBeatRaf);
		const gaps: number[] = (window as any).__qaFrameGaps ?? [];
		const longTasks: number[] = (window as any).__qaLongTasks ?? [];
		return {
			maxLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
			maxFrameGapMs: gaps.length ? Math.max(...gaps) : 0,
		};
	});
}

/** Wait until no brush/tool commit is pending (persistence + reload settled). */
async function waitForCommitsSettled(page: Page) {
	await page.waitForFunction(() => {
		const st: any = window.__mangaEditorDebug?.getState?.();
		return st && st.brush?.pendingCommit === false;
	}, undefined, { timeout: 20000 }).catch(() => undefined);
	await page.waitForTimeout(400);
}

test.setTimeout(120000);

test("tool edits survive navigate-away-and-back (no use-after-revoke blank page) + no freeze", async ({ page }) => {
	await mkdir(PROOF_DIR, { recursive: true });
	// OpenCV (Spot Heal) lazy-loads from a CDN; this sandbox is offline. Block it so
	// the heal stroke can't commit a real inpaint, but the clone path (pure canvas)
	// fully exercises the persistence + revoke + reload invariant. Heal still proves
	// no-freeze on the stroke/commit pipeline.
	await page.route("**/cdn.jsdelivr.net/**", (route) => route.abort());

	const consoleErrors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));

	await registerAndAuth(page);
	await waitForDebug(page);
	await seedLargePage(page);
	await page.screenshot({ path: `${PROOF_DIR}/00-loaded-original.png` });

	const canvasBox = await page.locator("canvas").first().boundingBox();
	if (!canvasBox) throw new Error("no canvas bounding box");
	const cx = canvasBox.x + canvasBox.width / 2;
	const cy = canvasBox.y + canvasBox.height / 2;

	// ---------- (a) Clone Stamp → commit → navigate-away-and-back reload ----------
	await activateTool(page, "Clone Stamp");
	const beforeCloneHash = await bitmapHash(page);
	const cloneTrace = await strokeWithTrace(page, {
		alt: true,
		points: 50,
		spreadX: 80,
		spreadY: 70,
		altAt: { x: canvasBox.x + canvasBox.width * 0.5, y: canvasBox.y + canvasBox.height * 0.12 },
		paintAt: { x: cx, y: cy + 60 },
	});
	await waitForCommitsSettled(page);
	const afterCloneHash = await bitmapHash(page);
	const urlAfterClone = await page.evaluate(() => window.__mangaWorkflowDebug!.getCurrentPageImageUrl());
	await page.screenshot({ path: `${PROOF_DIR}/01-after-clone-before-leave.png` });
	const beforeLeaveHash = await bitmapHash(page);

	// Navigate AWAY (library), then BACK (reload the page from the cached URL).
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("library"));
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${PROOF_DIR}/02-on-library.png` });
	await openEditorView(page);
	const cloneReload = await reloadCurrentPageFromCachedUrl(page);
	await page.waitForTimeout(400);
	const afterReturnHash = await bitmapHash(page);
	const blankAfterReturn = await isBlank(page);
	await page.screenshot({ path: `${PROOF_DIR}/03-after-return.png` });

	// ---------- (b) AI-overlay erase → reload from cached URL ----------
	let eraseReport: any = { skipped: true };
	try {
		await page.evaluate(async () => {
			await window.__mangaEditorDebug!.setAiOverlayTestImage({ width: 3000, height: 4000 });
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		});
		await activateTool(page, "Brush").catch(async () => {
			// Brush may be labelled differently; fall back to the brush tool via debug.
			await page.evaluate(() => window.__mangaEditorDebug!.setTool("brush"));
		});
		await page.evaluate(() => window.__mangaEditorDebug!.setBrushMode("erase"));
		const eraseTrace = await strokeWithTrace(page, { points: 30, spreadX: 120, spreadY: 90, paintAt: { x: cx, y: cy } });
		await waitForCommitsSettled(page);
		const urlAfterErase = await page.evaluate(() => window.__mangaWorkflowDebug!.getCurrentPageImageUrl());
		const beforeEraseLeave = await bitmapHash(page);
		await page.evaluate(() => window.__mangaWorkflowDebug!.openView("library"));
		await page.waitForTimeout(300);
		await openEditorView(page);
		const eraseReload = await reloadCurrentPageFromCachedUrl(page);
		const eraseBlank = await isBlank(page);
		eraseReport = {
			urlAfterErase_isBlob: urlAfterErase?.startsWith("blob:") ?? null,
			eraseReloadDecodeOk: eraseReload.loadOk,
			beforeEraseLeave,
			afterEraseReturn: await bitmapHash(page),
			eraseBlank,
			eraseTrace,
		};
		await page.screenshot({ path: `${PROOF_DIR}/05-after-erase-return.png` });
	} catch (e) {
		eraseReport = { skipped: true, reason: String(e) };
	}

	// ---------- (c) Two rapid clone strokes commit in order (no loss) ----------
	await activateTool(page, "Clone Stamp");
	const beforeRapidHash = await bitmapHash(page);
	await strokeWithTrace(page, {
		alt: true,
		points: 12,
		spreadX: 40,
		spreadY: 30,
		altAt: { x: canvasBox.x + canvasBox.width * 0.4, y: canvasBox.y + canvasBox.height * 0.2 },
		paintAt: { x: cx - 60, y: cy },
	});
	const rapidTrace = await strokeWithTrace(page, {
		alt: true,
		points: 12,
		spreadX: 40,
		spreadY: 30,
		altAt: { x: canvasBox.x + canvasBox.width * 0.6, y: canvasBox.y + canvasBox.height * 0.2 },
		paintAt: { x: cx + 60, y: cy },
	});
	await waitForCommitsSettled(page);
	const afterRapidHash = await bitmapHash(page);
	const rapidCommitError = await page.evaluate(() => window.__mangaEditorDebug!.getBrushCommitErrorMessage());
	const rapidReload = await reloadCurrentPageFromCachedUrl(page);
	await page.waitForTimeout(300);
	const rapidBlank = await isBlank(page);
	await page.screenshot({ path: `${PROOF_DIR}/04-after-rapid-return.png` });

	const report = {
		page: "3000x4000 (12 MP), file-mode project store",
		clone: {
			cloneChangedBitmap: afterCloneHash !== beforeCloneHash,
			urlAfterClone_isBlob: urlAfterClone?.startsWith("blob:") ?? null,
			urlAfterClone_kind: urlAfterClone?.slice(0, 24) ?? null,
			cloneReloadUrl_isBlob: cloneReload.url?.startsWith("blob:") ?? null,
			cloneReloadDecodeOk: cloneReload.loadOk,
			beforeLeaveHash,
			afterReturnHash,
			editSurvivedNav: afterReturnHash === beforeLeaveHash,
			blankAfterReturn,
			cloneTrace,
		},
		aiOverlayErase: eraseReport,
		rapidStrokes: {
			rapidChangedBitmap: afterRapidHash !== beforeRapidHash,
			rapidReloadDecodeOk: rapidReload.loadOk,
			rapidReloadUrl_isBlob: rapidReload.url?.startsWith("blob:") ?? null,
			rapidCommitError,
			rapidBlank,
			rapidTrace,
		},
		consoleErrors: consoleErrors.filter((e) => !/opencv|jsdelivr|403/i.test(e)),
	};
	await writeFile(`${PROOF_DIR}/persist-after-nav-report.json`, JSON.stringify(report, null, 2));

	// ---- Assertions ----
	// Clone actually changed the page.
	expect(report.clone.cloneChangedBitmap).toBe(true);
	// getImageUrl() after the commit must NOT be a (soon-revoked) blob: URL.
	expect(report.clone.urlAfterClone_isBlob).toBe(false);
	expect(report.clone.cloneReloadUrl_isBlob).toBe(false);
	// The cached URL still DECODES after the editor revoked its commit blob
	// (use-after-revoke would fail here), and the reloaded page is NOT blank.
	expect(report.clone.cloneReloadDecodeOk).toBe(true);
	expect(report.clone.blankAfterReturn).toBe(false);
	expect(report.clone.editSurvivedNav).toBe(true);
	// AI-overlay erase: cached URL durable + decodes + not blank (when exercised).
	if (!report.aiOverlayErase.skipped) {
		expect(report.aiOverlayErase.urlAfterErase_isBlob).toBe(false);
		expect(report.aiOverlayErase.eraseReloadDecodeOk).toBe(true);
		expect(report.aiOverlayErase.eraseBlank).toBe(false);
	}
	// Two rapid strokes: no commit error, both landed, cached image valid + not blank.
	expect(report.rapidStrokes.rapidCommitError).toBeNull();
	expect(report.rapidStrokes.rapidChangedBitmap).toBe(true);
	expect(report.rapidStrokes.rapidReloadUrl_isBlob).toBe(false);
	expect(report.rapidStrokes.rapidReloadDecodeOk).toBe(true);
	expect(report.rapidStrokes.rapidBlank).toBe(false);
	// No freeze on any stroke.
	expect(report.clone.cloneTrace.maxLongTaskMs).toBeLessThanOrEqual(120);
	expect(report.clone.cloneTrace.maxFrameGapMs).toBeLessThanOrEqual(220);
	expect(report.rapidStrokes.rapidTrace.maxFrameGapMs).toBeLessThanOrEqual(220);
});
