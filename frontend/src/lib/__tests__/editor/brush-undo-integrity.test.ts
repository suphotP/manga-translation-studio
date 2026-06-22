// P1 undo-integrity + footprint fixes (codex audit), editor.ts level.
//
//   #1 Destructive background heal/clone strokes are UNDOABLE: one coalesced stroke
//      = ONE history command; undo restores the prior bitmap, redo re-applies it.
//   #5 Non-uniform scaled image-layer brush footprint matches the round preview
//      (per-axis source radii, not a single min-axis scalar).
//   #6 Bounded brush history: a command evicted from history disposes its pinned
//      full-resolution bitmaps so count and byte budgets can't grow without bound.

import { describe, it, expect, vi } from "vitest";
import {
	imageLayerBrushSourceRadii,
	__test_HistoryManager as HistoryManager,
	__test_BrushBackgroundCommand as BrushBackgroundCommand,
	type __test_Command as Command,
} from "$lib/canvas/editor.ts";

vi.mock("$lib/config.js", () => ({
	config: {
		defaultFontFamily: "Tahoma, sans-serif",
		defaultFontSize: 24,
		defaultText: "ข้อความ",
		canvas: { minZoom: 0.1, maxZoom: 5 },
	},
}));

describe("#5 non-uniform image-layer brush footprint matches the round preview", () => {
	it("returns per-axis source radii (sceneRadius/scaleX, sceneRadius/scaleY)", () => {
		// A round scene-space preview of radius 10 on a layer scaled 2x on X, 0.5x on Y.
		const { radius, radiusX, radiusY } = imageLayerBrushSourceRadii({
			sceneRadius: 10,
			scaleX: 2,
			scaleY: 0.5,
		});
		// Source-space footprint is an ELLIPSE: tight on the up-scaled axis (X), wide on
		// the down-scaled axis (Y) — the source preimage of the round on-screen circle.
		expect(radiusX).toBeCloseTo(5, 5); // 10 / 2
		expect(radiusY).toBeCloseTo(20, 5); // 10 / 0.5
		// `radius` (segment-spacing base) is the smaller of the two.
		expect(radius).toBeCloseTo(5, 5);
		// The OLD behaviour (10 / min(2,0.5) = 20) over-erased the X axis 4x — guard it.
		expect(radiusX).not.toBeCloseTo(20, 1);
	});

	it("collapses to a circle when the layer is uniformly scaled", () => {
		const r = imageLayerBrushSourceRadii({ sceneRadius: 8, scaleX: 1.5, scaleY: 1.5 });
		expect(r.radiusX).toBeCloseTo(r.radiusY, 6);
		expect(r.radius).toBeCloseTo(r.radiusX, 6);
	});

	it("clamps tiny radii and guards against zero/negative scale", () => {
		const r = imageLayerBrushSourceRadii({ sceneRadius: 0.1, scaleX: 0, scaleY: -2 });
		expect(r.radiusX).toBeGreaterThanOrEqual(1);
		expect(r.radiusY).toBeGreaterThanOrEqual(1);
		expect(Number.isFinite(r.radiusX)).toBe(true);
		expect(Number.isFinite(r.radiusY)).toBe(true);
	});
});

/** A minimal editor stub recording every updateBackgroundImage call. */
function makeEditorStub() {
	const loads: string[] = [];
	const editor: any = {
		updateBackgroundImage: vi.fn(async (url: string) => {
			loads.push(url);
			editor.currentImageUrl = url;
		}),
		currentImageUrl: null,
	};
	return { editor, loads };
}

describe("#1 BrushBackgroundCommand makes a destructive stroke undoable (1 gesture = 1 step)", () => {
	it("undo restores the prior bitmap; redo re-applies the post-stroke bitmap", async () => {
		const { editor, loads } = makeEditorStub();
		const before = "data:image/png;base64,BEFORE";
		const after = "data:image/png;base64,AFTER";
		const cmd = new BrushBackgroundCommand(editor as any, before, after);

		// The pixels are already on the canvas when registered, so the command is NOT
		// executed on push. undo() must restore `before`.
		await cmd.undo();
		expect(loads).toEqual([before]);

		// redo() (execute) re-applies `after`.
		await cmd.execute();
		expect(loads).toEqual([before, after]);
	});

	it("a null prior url (page had no durable bitmap) undoes to a no-op", async () => {
		const { editor, loads } = makeEditorStub();
		const cmd = new BrushBackgroundCommand(editor as any, null, "data:after");
		await cmd.undo();
		// Nothing to restore → no background load.
		expect(loads).toEqual([]);
	});

	it("a brush stroke registers as exactly ONE undo step on the history stack", () => {
		const { editor } = makeEditorStub();
		const history = new HistoryManager();
		// One coalesced stroke → one command pushed (the editor coalesces a continuous
		// stroke into a single debounced persist → a single executeCommand call).
		history.executeCommand(new BrushBackgroundCommand(editor as any, "data:a", "data:b"));
		expect(history.canUndo()).toBe(true);
		expect(history.canRedo()).toBe(false);
		const popped = history.undo();
		expect(popped).toBeTruthy();
		expect(history.canUndo()).toBe(false);
		expect(history.canRedo()).toBe(true);
	});

	it("exposes a read-only ordered snapshot for the UI history panel", () => {
		const { editor } = makeEditorStub();
		const history = new HistoryManager();
		const first = new BrushBackgroundCommand(editor as any, "data:a", "data:b");
		const second: Command = {
			execute: vi.fn(),
			undo: vi.fn(),
		};

		history.executeCommand(first);
		history.executeCommand(second);
		history.undo();

		const snapshot = history.snapshot();

		expect(snapshot.currentIndex).toBe(0);
		expect(snapshot.entries.map((entry) => entry.label)).toEqual(["แก้ภาพด้วยแปรง", "แก้ไขหน้า"]);
		expect(snapshot.entries[0].id).toBe("history-1");
		expect(snapshot.entries[1].id).toBe("history-2");
		expect(snapshot.entries.every((entry) => Number.isFinite(entry.at))).toBe(true);
	});
});

describe("#6 bounded brush history disposes evicted commands' pinned bitmaps", () => {
	function disposableCommand(estimatedBytes = 0): Command & { disposed: boolean } {
		const cmd: any = {
			disposed: false,
			execute: vi.fn(),
			undo: vi.fn(),
			estimatedBytes: vi.fn(() => estimatedBytes),
			dispose: vi.fn(() => {
				cmd.disposed = true;
			}),
		};
		return cmd;
	}

	it("disposes the OLDEST command when the 20-entry cap overflows", () => {
		const history = new HistoryManager();
		const commands = Array.from({ length: 22 }, () => disposableCommand());
		for (const c of commands) history.executeCommand(c);
		// The first two (over the 20 cap) were evicted + disposed.
		expect(commands[0].disposed).toBe(true);
		expect(commands[1].disposed).toBe(true);
		// The rest (still reachable for undo/redo) are NOT disposed.
		expect(commands[2].disposed).toBe(false);
		expect(commands[21].disposed).toBe(false);
	});

	it("disposes redo-stack commands dropped by a new command", () => {
		const history = new HistoryManager();
		const a = disposableCommand();
		const b = disposableCommand();
		history.executeCommand(a);
		history.undo(); // a → redo stack
		expect(history.canRedo()).toBe(true);
		// A new command clears (and disposes) the redo stack.
		history.executeCommand(b);
		expect(a.disposed).toBe(true);
		expect(history.canRedo()).toBe(false);
	});

	it("clear() disposes every retained command", () => {
		const history = new HistoryManager();
		const a = disposableCommand();
		const b = disposableCommand();
		history.executeCommand(a);
		history.executeCommand(b);
		history.clear();
		expect(a.disposed).toBe(true);
		expect(b.disposed).toBe(true);
		expect(history.canUndo()).toBe(false);
	});

	it("evicts the oldest command when the byte budget overflows before the 20-entry cap", () => {
		const history = new HistoryManager({ maxEntries: 20, maxEstimatedBytes: 100 });
		const oldLarge = disposableCommand(80);
		const nextLarge = disposableCommand(40);

		history.executeCommand(oldLarge);
		expect(history.estimatedBytes()).toBe(80);
		history.executeCommand(nextLarge);

		expect(oldLarge.disposed).toBe(true);
		expect(nextLarge.disposed).toBe(false);
		expect(history.estimatedBytes()).toBe(40);
		expect(history.canUndo()).toBe(true);
	});

	it("keeps the newest command even when a single stroke exceeds the byte budget", () => {
		const history = new HistoryManager({ maxEntries: 20, maxEstimatedBytes: 10 });
		const hugeStroke = disposableCommand(500);
		const smallStroke = disposableCommand(1);

		history.executeCommand(hugeStroke);
		expect(hugeStroke.disposed).toBe(false);
		expect(history.estimatedBytes()).toBe(500);

		history.executeCommand(smallStroke);
		expect(hugeStroke.disposed).toBe(true);
		expect(smallStroke.disposed).toBe(false);
		expect(history.estimatedBytes()).toBe(1);
	});

	it("counts redo-stack bytes until a new command drops that redo history", () => {
		const history = new HistoryManager({ maxEntries: 20, maxEstimatedBytes: 1_000 });
		const a = disposableCommand(45);
		const b = disposableCommand(55);
		const c = disposableCommand(5);

		history.executeCommand(a);
		history.executeCommand(b);
		history.undo();
		expect(history.estimatedBytes()).toBe(100);
		expect(b.disposed).toBe(false);

		history.executeCommand(c);
		expect(b.disposed).toBe(true);
		expect(history.estimatedBytes()).toBe(50);
	});

	it("BrushBackgroundCommand.dispose releases its URLs and is idempotent", async () => {
		const { editor, loads } = makeEditorStub();
		const cmd = new BrushBackgroundCommand(editor as any, "data:before", "data:after");
		cmd.dispose();
		cmd.dispose(); // idempotent — no throw
		// After disposal the pinned urls are gone, so undo/redo can no longer load them
		// (the command is unreachable in history once evicted, so this is expected).
		await cmd.undo();
		await cmd.execute();
		expect(loads).toEqual([]);
	});

	it("BrushBackgroundCommand memory estimate drops to zero after disposal", () => {
		const { editor } = makeEditorStub();
		const before = `data:image/png;base64,${"A".repeat(128)}`;
		const after = `data:image/png;base64,${"B".repeat(256)}`;
		const cmd = new BrushBackgroundCommand(editor as any, before, after);

		expect(cmd.estimatedBytes()).toBeGreaterThan(before.length + after.length);
		cmd.dispose();
		expect(cmd.estimatedBytes()).toBe(0);
	});
});
