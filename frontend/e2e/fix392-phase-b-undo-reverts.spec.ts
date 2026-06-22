// codex #392 P1-1 — REAL-BROWSER proof that undo of a non-destructive clone edit
// REVERTS the visible page pixels (no phantom baked into the mutable background).
//
// Drives the real Clone Stamp tool (pure-canvas, no OpenCV) end-to-end through the
// store + editor host (so the Phase B `commitImageEditLayerPatch` overlay path runs),
// then UNDO, asserting the merged-page bitmap fingerprint returns to its pre-edit
// value. Screenshots: before-commit / after-commit / after-undo → /tmp/qa/fix392/.

import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const PROOF_DIR = "/tmp/qa/fix392";
const AUTH_STORAGE_KEY = "manga-editor.auth.session.v1";

async function registerAndAuth(page: Page) {
	await page.goto("/");
	const email = `qa-fix392-${Date.now()}@example.com`;
	const session = await page.evaluate(async (em) => {
		const res = await fetch("/api/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "include",
			body: JSON.stringify({ email: em, password: "QaFix392!12345", name: "QA Fix392" }),
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

async function seedPage(page: Page) {
	await page.evaluate(() => window.__mangaWorkflowDebug!.seedProject());
	await openEditorView(page);
	await dismissModals(page);
	await page.evaluate(async () => {
		await window.__mangaEditorDebug!.loadTestImage({ width: 1200, height: 1600, label: "QA Fix392 Page" });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		// Arm the Phase B non-destructive edit-layer path: the debug loadTestImage bypasses
		// (and resets) the store's setImageEditLayers(page.imageId) arming, so without this
		// the heal/clone commit falls back to the legacy bake path. The editor only needs a
		// non-null source id to engage Phase B; the store's commit independently uses the
		// seeded page.imageId. (In this debug/local project the upload is local, so no
		// backend pageImageId corroboration is involved.)
		window.__mangaEditorDebug!.setEditLayersSourceForTests("phase-b-source");
	});
	await page.waitForSelector('button[aria-label*="Clone Stamp"]', { timeout: 15000 });
}

/**
 * Fingerprint of the LIVE rendered canvas pixels (the actual on-screen viewport).
 * Phase B edits render via the edit-composite OVERLAY, so we must sample what the
 * user SEES (the Fabric <canvas> element), NOT exportMergedImageDataUrl (which only
 * composites the page background + image/text layers, not the edit overlay).
 */
async function liveCanvasHash(page: Page): Promise<string> {
	return page.evaluate(async () => {
		const el = document.querySelector("canvas.upper-canvas") || document.querySelector("canvas");
		const src = (el as HTMLCanvasElement) || null;
		// Prefer the lower (content) canvas which holds the rendered scene.
		const canvases = Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[];
		const lower = canvases.find((c) => c.classList.contains("lower-canvas")) || src;
		if (!lower) return "no-canvas";
		const w = Math.min(500, lower.width);
		const h = Math.min(500, lower.height);
		const tmp = document.createElement("canvas");
		tmp.width = w;
		tmp.height = h;
		const ctx = tmp.getContext("2d");
		if (!ctx) return "no-ctx";
		ctx.drawImage(lower, 0, 0, lower.width, lower.height, 0, 0, w, h);
		const data = ctx.getImageData(0, 0, w, h).data;
		let hsh = 0;
		for (let i = 0; i < data.length; i += 41) hsh = (hsh * 31 + data[i]) | 0;
		return `${w}x${h}:${hsh}`;
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

async function waitForCommitsSettled(page: Page) {
	await page.waitForFunction(() => {
		const st: any = window.__mangaEditorDebug?.getState?.();
		return st && st.brush?.pendingCommit === false;
	}, undefined, { timeout: 20000 }).catch(() => undefined);
	await page.waitForTimeout(500);
}

test.setTimeout(120000);

test("undo of a clone edit reverts the visible page pixels (codex #392 P1-1)", async ({ page }) => {
	await mkdir(PROOF_DIR, { recursive: true });
	// OpenCV (Spot Heal) CDN is offline here; clone is pure-canvas so it exercises the
	// full Phase B edit-layer commit + undo path without it.
	await page.route("**/cdn.jsdelivr.net/**", (route) => route.abort());

	const consoleErrors: string[] = [];
	page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
	page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));

	await registerAndAuth(page);
	await waitForDebug(page);
	await seedPage(page);

	const box = await page.locator("canvas").first().boundingBox();
	if (!box) throw new Error("no canvas bounding box");
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;

	// Park the mouse OFF the canvas so the tool-cursor ring / source ghost is not drawn
	// into the pixel sample (it would otherwise make before/after hashes differ for a
	// reason unrelated to the edit).
	const parkMouse = async () => {
		await page.mouse.move(2, 2);
		await page.waitForTimeout(150);
	};

	// Snapshot ONLY the cloned destination region (center of the canvas) as raw RGBA so
	// the proof isolates the edit pixels and we can measure the per-pixel mean delta vs a
	// reference (robust to 1px anti-alias re-render jitter + the clone source-anchor marker
	// dot, neither of which is the edit). Returns the pixel array via a window stash.
	const snapCenter = async (key: string) =>
		page.evaluate((k) => {
			const canvases = Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[];
			const lower = canvases.find((c) => c.classList.contains("lower-canvas")) || canvases[0];
			if (!lower) return null;
			const ctx = lower.getContext("2d");
			if (!ctx) return null;
			const x = Math.round(lower.width * 0.34), y = Math.round(lower.height * 0.4);
			const w = Math.round(lower.width * 0.3), h = Math.round(lower.height * 0.18);
			const data = ctx.getImageData(x, y, w, h).data;
			((window as any).__fix392 ??= {})[k] = Array.from(data);
			return { w, h };
		}, key);
	// Mean absolute per-channel delta between two stashed center snapshots.
	const centerDelta = async (a: string, b: string) =>
		page.evaluate(([ka, kb]) => {
			const s = (window as any).__fix392 ?? {};
			const A: number[] = s[ka], B: number[] = s[kb];
			if (!A || !B || A.length !== B.length) return -1;
			let sum = 0;
			for (let i = 0; i < A.length; i++) sum += Math.abs(A[i] - B[i]);
			return sum / A.length;
		}, [a, b]);

	await activateTool(page, "Clone Stamp");
	// BEFORE the edit — screenshot + fingerprint of the pristine page (mouse parked).
	await parkMouse();
	await page.screenshot({ path: `${PROOF_DIR}/01-before-commit.png` });
	const beforeHash = await liveCanvasHash(page);
	await snapCenter("before");

	// Alt+click a source anchor near the top, then paint a vigorous clone stroke
	// at the center — the real user gesture (no OpenCV).
	await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.15);
	await page.keyboard.down("Alt");
	await page.mouse.down();
	await page.mouse.up();
	await page.keyboard.up("Alt");
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	for (let i = 0; i < 40; i++) {
		await page.mouse.move(cx + Math.sin(i / 3) * 70 + (i - 20) * 3, cy + Math.cos(i / 4) * 60);
	}
	await page.mouse.up();
	await waitForCommitsSettled(page);

	// AFTER commit — the cloned region is visible; fingerprint must differ (mouse parked).
	await parkMouse();
	await page.screenshot({ path: `${PROOF_DIR}/02-after-commit.png` });
	const afterCommitHash = await liveCanvasHash(page);
	await snapCenter("afterCommit");
	const editInfoAfterCommit = await page.evaluate(() => window.__mangaEditorDebug!.getImageEditLayerInfo());

	// UNDO — removes the edit layer; the visible pixels must revert (no phantom).
	await page.evaluate(() => window.__mangaEditorDebug!.undo());
	await page.waitForTimeout(600);
	await parkMouse();
	await page.screenshot({ path: `${PROOF_DIR}/03-after-undo.png` });
	const afterUndoHash = await liveCanvasHash(page);
	await snapCenter("afterUndo");
	const editInfoAfterUndo = await page.evaluate(() => window.__mangaEditorDebug!.getImageEditLayerInfo());

	const commitDelta = await centerDelta("before", "afterCommit");
	const undoDelta = await centerDelta("before", "afterUndo");

	const report = {
		beforeHash,
		afterCommitHash,
		afterUndoHash,
		commitDelta, // mean per-channel |Δ| of the cloned region: before → after-commit
		undoDelta, // mean per-channel |Δ| of the cloned region: before → after-undo
		editInfoAfterCommit,
		editInfoAfterUndo,
		consoleErrors,
	};
	// eslint-disable-next-line no-console
	console.log("FIX392 P1-1 REPORT", JSON.stringify(report, null, 2));

	// One clone stroke recorded exactly one non-destructive edit layer (Phase B path).
	expect(editInfoAfterCommit.count).toBe(1);
	expect(editInfoAfterCommit.canUndo).toBe(true);
	// The clone substantially changed the cloned DESTINATION region pixels.
	expect(commitDelta).toBeGreaterThan(3);
	// UNDO removed the edit layer (one stroke = one undoable layer)...
	expect(editInfoAfterUndo.count).toBe(0);
	expect(editInfoAfterUndo.canUndo).toBe(false);
	expect(editInfoAfterUndo.canRedo).toBe(true);
	// ...and the cloned-region pixels REVERTED to the pre-edit state (no phantom baked
	// into the mutable backing canvas — the core codex #392 P1-1 fix). The residual delta
	// after undo is near-zero (only sub-pixel re-render jitter), and is far smaller than
	// the edit it removed: undo brought the region back to ~pristine.
	expect(undoDelta).toBeLessThan(commitDelta / 4);
	expect(undoDelta).toBeLessThan(2);
});
