import { describe, expect, it, vi } from "vitest";
import {
	HistoryStack,
	type HistoryStackCommand,
	type HistoryStackSnapshot,
} from "../../editor-tools/history-stack.ts";

function command(
	label: string,
	log: string[],
	options: Partial<HistoryStackCommand> = {},
): HistoryStackCommand {
	return {
		label,
		coalesceKey: options.coalesceKey,
		sizeBytes: options.sizeBytes,
		do: options.do ?? (() => {
			log.push(`do:${label}`);
		}),
		undo: options.undo ?? (() => {
			log.push(`undo:${label}`);
		}),
	};
}

describe("HistoryStack", () => {
	it("pushes commands without running do, then undo and redo move the active cursor", () => {
		const log: string[] = [];
		const stack = new HistoryStack();

		stack.push(command("Add text", log));

		expect(log).toEqual([]);
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			canRedo: false,
			undoLabel: "Add text",
			redoLabel: null,
			cursor: 1,
		});
		expect(stack.getSnapshot().entries).toEqual([
			expect.objectContaining({
				label: "Add text",
				kind: "command",
				commandCount: 1,
				applied: true,
			}),
		]);

		expect(stack.undo()).toBe(true);
		expect(log).toEqual(["undo:Add text"]);
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: false,
			canRedo: true,
			undoLabel: null,
			redoLabel: "Add text",
			cursor: 0,
		});
		expect(stack.getSnapshot().entries[0]?.applied).toBe(false);

		expect(stack.redo()).toBe(true);
		expect(log).toEqual(["undo:Add text", "do:Add text"]);
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			canRedo: false,
			undoLabel: "Add text",
			redoLabel: null,
			cursor: 1,
		});
	});

	it("returns false without notifying listeners when undo or redo is unavailable", () => {
		const stack = new HistoryStack();
		const listener = vi.fn();
		stack.onChange(listener);

		expect(stack.undo()).toBe(false);
		expect(stack.redo()).toBe(false);

		expect(listener).not.toHaveBeenCalled();
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: false,
			canRedo: false,
			cursor: 0,
			totalBytes: 0,
		});
	});

	it("evicts oldest entries to stay within the configured byte budget", () => {
		const log: string[] = [];
		const stack = new HistoryStack({ maxBytes: 10 });

		stack.push(command("A", log, { sizeBytes: 4 }));
		stack.push(command("B", log, { sizeBytes: 4 }));
		stack.push(command("C", log, { sizeBytes: 4 }));

		const snapshot = stack.getSnapshot();
		expect(snapshot.totalBytes).toBe(8);
		expect(snapshot.cursor).toBe(2);
		expect(snapshot.entries.map((entry) => entry.label)).toEqual(["B", "C"]);
		expect(snapshot.entries.every((entry) => entry.applied)).toBe(true);

		expect(stack.undo()).toBe(true);
		expect(stack.undo()).toBe(true);
		expect(stack.undo()).toBe(false);
		expect(log).toEqual(["undo:C", "undo:B"]);
	});

	it("keeps one oversized newest entry so the latest action remains undoable", () => {
		const log: string[] = [];
		const stack = new HistoryStack({ maxBytes: 5 });

		stack.push(command("Paste bitmap", log, { sizeBytes: 25 }));

		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			cursor: 1,
			totalBytes: 25,
			maxBytes: 5,
		});
		expect(stack.getSnapshot().entries.map((entry) => entry.label)).toEqual(["Paste bitmap"]);

		expect(stack.undo()).toBe(true);
		expect(log).toEqual(["undo:Paste bitmap"]);
	});

	it("drops the redo branch and its byte accounting when pushing after undo", () => {
		const log: string[] = [];
		const stack = new HistoryStack({ maxBytes: 50 });

		stack.push(command("A", log, { sizeBytes: 6 }));
		stack.push(command("B", log, { sizeBytes: 7 }));

		expect(stack.undo()).toBe(true);
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			canRedo: true,
			undoLabel: "A",
			redoLabel: "B",
			cursor: 1,
			totalBytes: 13,
		});

		stack.push(command("C", log, { sizeBytes: 8 }));

		const snapshot = stack.getSnapshot();
		expect(snapshot).toMatchObject({
			canUndo: true,
			canRedo: false,
			undoLabel: "C",
			redoLabel: null,
			cursor: 2,
			totalBytes: 14,
		});
		expect(snapshot.entries.map((entry) => entry.label)).toEqual(["A", "C"]);
		expect(stack.redo()).toBe(false);
		expect(log).toEqual(["undo:B"]);
	});

	it("accounts for coalesced commands by retaining the first undo and latest redo payloads", () => {
		const log: string[] = [];
		let now = 1_000;
		const stack = new HistoryStack({ windowMs: 200, now: () => now });

		stack.push(command("Move start", log, { coalesceKey: "move:layer-1", sizeBytes: 6 }));
		now += 50;
		stack.push(command("Move end", log, { coalesceKey: "move:layer-1", sizeBytes: 8 }));

		const snapshot = stack.getSnapshot();
		expect(snapshot.totalBytes).toBe(14);
		expect(snapshot.entries).toEqual([
			expect.objectContaining({
				label: "Move end",
				coalesceKey: "move:layer-1",
				commandCount: 2,
				sizeBytes: 14,
			}),
		]);

		expect(stack.undo()).toBe(true);
		expect(stack.redo()).toBe(true);
		expect(log).toEqual(["undo:Move start", "do:Move end"]);
	});

	it("notifies subscribed listeners with snapshots and stops after unsubscribe", () => {
		const log: string[] = [];
		const stack = new HistoryStack();
		const snapshots: HistoryStackSnapshot[] = [];
		const listener = vi.fn((snapshot: HistoryStackSnapshot) => {
			snapshots.push(snapshot);
		});
		const unsubscribe = stack.onChange(listener);

		stack.push(command("A", log));
		unsubscribe();
		stack.push(command("B", log));
		stack.undo();

		expect(listener).toHaveBeenCalledTimes(1);
		expect(snapshots).toEqual([
			expect.objectContaining({
				canUndo: true,
				canRedo: false,
				undoLabel: "A",
				cursor: 1,
			}),
		]);
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			canRedo: true,
			undoLabel: "A",
			redoLabel: "B",
			cursor: 1,
		});
	});
});
