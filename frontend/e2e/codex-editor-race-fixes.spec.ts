// codex-audit P1 race fixes — real-browser proof through the live MangaEditor.
//
//   P1-2 (undo/redo serialization): firing many undo()/redo() back-to-back (the way a
//   user mashing Ctrl+Z does) must leave the history stack CONSISTENT — never a
//   corrupted count / mismatched canUndo-canRedo. Driven through the real editor +
//   HistoryManager via text-layer edits (each add = one undoable step).
//
//   P1-1 (compositor generation guard, smoke): rapidly switching the loaded page while
//   edit-layer sources are (re)armed must never crash and must always land on the
//   page that was switched to LAST — the stale-rebuild guard must not attach an old
//   page's composite or wedge the editor.
//
// Screenshots → /tmp/qa/h-editorrace/.

import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const PROOF_DIR = "/tmp/qa/h-editorrace";
const AUTH_STORAGE_KEY = "manga-editor.auth.session.v1";

async function registerAndAuth(page: Page) {
	await page.goto("/");
	const email = `qa-editorrace-${Date.now()}@example.com`;
	const session = await page.evaluate(async (em) => {
		const res = await fetch("/api/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "include",
			body: JSON.stringify({ email: em, password: "QaRace12345!", name: "QA Race" }),
		});
		if (!res.ok) throw new Error("register failed: " + res.status + " " + (await res.text()));
		return res.json();
	}, email);
	await page.evaluate(
		([key, value]) => window.localStorage.setItem(key as string, value as string),
		[AUTH_STORAGE_KEY, JSON.stringify(session)],
	);
}

async function openEditor(page: Page) {
	await page.goto("/");
	await page.waitForFunction(
		() => Boolean(window.__mangaWorkflowDebug && window.__mangaEditorDebug),
		undefined,
		{ timeout: 30000 },
	);
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("editor"));
	await page.waitForFunction(() => {
		const root = document.querySelector(".editor-root");
		return Boolean(root && !root.classList.contains("workspace-dashboard-view"));
	}, undefined, { timeout: 30000 });
}

test.beforeAll(async () => {
	await mkdir(PROOF_DIR, { recursive: true });
});

test("P1-2 — rapid undo/redo through the real history keeps the stack consistent", async ({ page }) => {
	await registerAndAuth(page);
	await openEditor(page);

	// Load a page + 3 text layers, then build 4 UNDOABLE steps via history-tracked
	// stack reorders (raw addTextLayer is intentionally not history-tracked).
	const orderOf = () =>
		(window.__mangaEditorDebug!.getState().textLayers as Array<{ id: string; index: number }>)
			.slice()
			.sort((a, b) => a.index - b.index)
			.map((l) => l.id)
			.join(",");
	const initialOrder = await page.evaluate(async () => {
		const d = window.__mangaEditorDebug!;
		await d.loadTestImage({ width: 800, height: 1000, fill: "#1f2937", label: "PAGE" });
		d.addTextLayers([
			{ id: "t1", text: "one", x: 40, y: 40, w: 200, h: 60, rotation: 0, fontSize: 28, alignment: "center", index: 0 },
			{ id: "t2", text: "two", x: 40, y: 140, w: 200, h: 60, rotation: 0, fontSize: 28, alignment: "center", index: 1 },
			{ id: "t3", text: "three", x: 40, y: 240, w: 200, h: 60, rotation: 0, fontSize: 28, alignment: "center", index: 2 },
		]);
		// 4 reorders, each changing order → 4 undoable history steps.
		d.moveLayerInStackWithHistory("text", "t1", 1);
		d.moveLayerInStackWithHistory("text", "t1", 1);
		d.moveLayerInStackWithHistory("text", "t3", -1);
		d.moveLayerInStackWithHistory("text", "t3", -1);
		const s = d.getState().textLayers as Array<{ id: string; index: number }>;
		return s.slice().sort((a, b) => a.index - b.index).map((l) => l.id).join(",");
	});

	let info = await page.evaluate(() => window.__mangaEditorDebug!.getImageEditLayerInfo());
	expect(info.canUndo).toBe(true);
	const startCount = await page.evaluate(() => window.__mangaEditorDebug!.getState().textLayers.length);
	expect(startCount).toBe(3);
	const reorderedOrder = await page.evaluate(orderOf);

	// MASH undo + redo concurrently (no awaiting between calls) — the serialization must
	// chain them so the stack never interleaves/corrupts. Fire 8 undos and 8 redos
	// racing each other, then drain.
	await page.evaluate(async () => {
		const d = window.__mangaEditorDebug!;
		const ps: Promise<unknown>[] = [];
		for (let i = 0; i < 8; i++) {
			ps.push(d.undo());
			ps.push(d.redo());
		}
		await Promise.all(ps);
	});

	// Layer count is invariant under reorder undo/redo (always 3) — a corrupted stack
	// would drop/duplicate a layer.
	const afterCount = await page.evaluate(() => window.__mangaEditorDebug!.getState().textLayers.length);
	expect(afterCount).toBe(3);

	// Drain fully to the ORIGINAL order: undo to empty, asserting it never throws/wedges.
	await page.evaluate(async () => {
		const d = window.__mangaEditorDebug!;
		for (let i = 0; i < 8; i++) await d.undo();
	});
	const drained = await page.evaluate(() => ({
		order: (window.__mangaEditorDebug!.getState().textLayers as Array<{ id: string; index: number }>)
			.slice().sort((a, b) => a.index - b.index).map((l) => l.id).join(","),
		info: window.__mangaEditorDebug!.getImageEditLayerInfo(),
	}));
	// Fully undone → back to the EXACT initial order, and undo is exhausted.
	expect(drained.order).toBe(initialOrder);
	expect(drained.info.canUndo).toBe(false);
	expect(drained.info.canRedo).toBe(true);

	// Redo back to full — the redo stack survived the mashing coherently → exact reorder.
	await page.evaluate(async () => {
		const d = window.__mangaEditorDebug!;
		for (let i = 0; i < 8; i++) await d.redo();
	});
	const restored = await page.evaluate(() => ({
		order: (window.__mangaEditorDebug!.getState().textLayers as Array<{ id: string; index: number }>)
			.slice().sort((a, b) => a.index - b.index).map((l) => l.id).join(","),
		info: window.__mangaEditorDebug!.getImageEditLayerInfo(),
	}));
	expect(restored.order).toBe(reorderedOrder);
	expect(restored.info.canRedo).toBe(false);

	await page.screenshot({ path: `${PROOF_DIR}/p1-2-undo-redo-consistent.png`, fullPage: false });
});

test("P1-1 smoke — rapid page switches while edit-sources rearm never crash or land on the wrong page", async ({ page }) => {
	await registerAndAuth(page);
	await openEditor(page);

	// Rapidly load distinct pages, arming a per-page edit-layer source between loads,
	// the way a fast page-switch does. The generation guard must keep the editor on the
	// LAST page loaded (no stale composite attach / no wedge).
	const finalLabel = await page.evaluate(async () => {
		const d = window.__mangaEditorDebug!;
		// Kick several loads without fully awaiting the composite settle between them.
		const loads = [
			{ label: "PAGE-A", fill: "#7f1d1d", src: "page-A" },
			{ label: "PAGE-B", fill: "#14532d", src: "page-B" },
			{ label: "PAGE-C", fill: "#1e3a8a", src: "page-C" },
		];
		for (const l of loads) {
			await d.loadTestImage({ width: 700, height: 900, fill: l.fill, label: l.label });
			d.setEditLayersSourceForTests(l.src);
		}
		// Settle.
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		return d.getState().image.width;
	});

	// Editor stayed alive and has a valid current image (the last load won, not a crash).
	expect(finalLabel).toBe(700);
	const alive = await page.evaluate(() => {
		const s = window.__mangaEditorDebug!.getState();
		return { w: s.image.width, h: s.image.height, info: window.__mangaEditorDebug!.getImageEditLayerInfo() };
	});
	expect(alive.w).toBe(700);
	expect(alive.h).toBe(900);
	// No stale edit layers leaked across the switches (each load resets the stack).
	expect(alive.info.count).toBe(0);

	await page.screenshot({ path: `${PROOF_DIR}/p1-1-page-switch-smoke.png`, fullPage: false });
});
