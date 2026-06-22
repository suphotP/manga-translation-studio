import { describe, expect, it, vi } from "vitest";
import { HistoryStack, type HistoryStackCommand, type HistoryStackSnapshot } from "../history-stack.ts";

function command(label: string, log: string[], options: Partial<HistoryStackCommand> = {}): HistoryStackCommand {
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
	it("records commands without running do(), then undo/redo move the cursor and emit UI snapshots", () => {
		const log: string[] = [];
		const stack = new HistoryStack();
		const snapshots: HistoryStackSnapshot[] = [];
		stack.onChange((snapshot) => snapshots.push(snapshot));

		stack.push(command("Add layer", log));

		expect(log).toEqual([]);
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			canRedo: false,
			undoLabel: "Add layer",
			redoLabel: null,
			cursor: 1,
		});
		expect(snapshots).toHaveLength(1);

		expect(stack.undo()).toBe(true);
		expect(log).toEqual(["undo:Add layer"]);
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: false,
			canRedo: true,
			undoLabel: null,
			redoLabel: "Add layer",
			cursor: 0,
		});

		expect(stack.redo()).toBe(true);
		expect(log).toEqual(["undo:Add layer", "do:Add layer"]);
		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			canRedo: false,
			cursor: 1,
		});
		expect(snapshots).toHaveLength(3);
	});

	it("undo/redo beyond stack limits are no-ops", () => {
		const log: string[] = [];
		const stack = new HistoryStack();
		const listener = vi.fn();
		stack.onChange(listener);

		expect(stack.undo()).toBe(false);
		expect(stack.redo()).toBe(false);
		expect(log).toEqual([]);
		expect(listener).not.toHaveBeenCalled();
	});

	it("push after undo drops the redo branch", () => {
		const log: string[] = [];
		const stack = new HistoryStack();
		stack.push(command("A", log));
		stack.push(command("B", log));

		expect(stack.undo()).toBe(true);
		stack.push(command("C", log));

		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			canRedo: false,
			undoLabel: "C",
			redoLabel: null,
			cursor: 2,
		});
		expect(stack.getSnapshot().entries.map((entry) => entry.label)).toEqual(["A", "C"]);
		expect(stack.redo()).toBe(false);
		expect(log).toEqual(["undo:B"]);
	});

	it("coalesces adjacent commands with the same key inside the window", () => {
		const log: string[] = [];
		let now = 1_000;
		const stack = new HistoryStack({ windowMs: 250, now: () => now });

		stack.push(command("Move 1", log, { coalesceKey: "move:text-1", sizeBytes: 10 }));
		now += 100;
		stack.push(command("Move 2", log, { coalesceKey: "move:text-1", sizeBytes: 12 }));

		const snapshot = stack.getSnapshot();
		expect(snapshot.entries).toHaveLength(1);
		expect(snapshot.entries[0]).toMatchObject({
			label: "Move 2",
			coalesceKey: "move:text-1",
			commandCount: 2,
			sizeBytes: 22,
		});

		expect(stack.undo()).toBe(true);
		expect(stack.redo()).toBe(true);
		expect(log).toEqual(["undo:Move 1", "do:Move 2"]);
	});

	it("does not coalesce across the configured time window", () => {
		const log: string[] = [];
		let now = 10;
		const stack = new HistoryStack({ windowMs: 50, now: () => now });

		stack.push(command("Drag start", log, { coalesceKey: "drag:layer-1" }));
		now += 51;
		stack.push(command("Drag later", log, { coalesceKey: "drag:layer-1" }));

		expect(stack.getSnapshot().entries.map((entry) => entry.label)).toEqual(["Drag start", "Drag later"]);
		expect(stack.undo()).toBe(true);
		expect(stack.undo()).toBe(true);
		expect(log).toEqual(["undo:Drag later", "undo:Drag start"]);
	});

	it("does not coalesce when an undo occurs between pushes", () => {
		const log: string[] = [];
		let now = 100;
		const stack = new HistoryStack({ windowMs: 500, now: () => now });

		stack.push(command("Move 1", log, { coalesceKey: "move:layer" }));
		expect(stack.undo()).toBe(true);
		now += 10;
		stack.push(command("Move 2", log, { coalesceKey: "move:layer" }));

		expect(stack.getSnapshot().entries).toHaveLength(1);
		expect(stack.getSnapshot().entries[0]).toMatchObject({
			label: "Move 2",
			commandCount: 1,
		});
		expect(stack.getSnapshot()).toMatchObject({ canRedo: false, cursor: 1 });
	});

	it("keeps memory under budget by trimming oldest entries without breaking cursor state", () => {
		const log: string[] = [];
		const stack = new HistoryStack({ maxBytes: 12 });

		stack.push(command("A", log, { sizeBytes: 5 }));
		stack.push(command("B", log, { sizeBytes: 5 }));
		stack.push(command("C", log, { sizeBytes: 5 }));

		const snapshot = stack.getSnapshot();
		expect(snapshot.totalBytes).toBe(10);
		expect(snapshot.cursor).toBe(2);
		expect(snapshot.entries.map((entry) => entry.label)).toEqual(["B", "C"]);

		expect(stack.undo()).toBe(true);
		expect(stack.undo()).toBe(true);
		expect(stack.undo()).toBe(false);
		expect(log).toEqual(["undo:C", "undo:B"]);
	});

	it("retains a single oversized newest command instead of dropping the only undo step", () => {
		const log: string[] = [];
		const stack = new HistoryStack({ maxBytes: 4 });

		stack.push(command("Paste large bitmap", log, { sizeBytes: 50 }));

		expect(stack.getSnapshot()).toMatchObject({
			canUndo: true,
			totalBytes: 50,
			cursor: 1,
		});
		expect(stack.getSnapshot().entries).toHaveLength(1);
	});

	it("groups transaction commands into one undo/redo entry", () => {
		const log: string[] = [];
		const stack = new HistoryStack();
		const snapshots: HistoryStackSnapshot[] = [];
		stack.onChange((snapshot) => snapshots.push(snapshot));

		const result = stack.transaction("Paste page setup", () => {
			stack.push(command("Add image", log, { sizeBytes: 3 }));
			stack.push(command("Add text", log, { sizeBytes: 4 }));
			return "done";
		});

		expect(result).toBe("done");
		expect(snapshots).toHaveLength(1);
		expect(stack.getSnapshot().entries).toEqual([
			expect.objectContaining({
				label: "Paste page setup",
				kind: "transaction",
				commandCount: 2,
				sizeBytes: 7,
			}),
		]);

		expect(stack.undo()).toBe(true);
		expect(stack.redo()).toBe(true);
		expect(log).toEqual(["undo:Add text", "undo:Add image", "do:Add image", "do:Add text"]);
	});

	it("waits for async undo/redo commands before moving history state", async () => {
		const log: string[] = [];
		const stack = new HistoryStack();
		stack.push(command("Async command", log, {
			do: async () => {
				log.push("do:start");
				await Promise.resolve();
				log.push("do:end");
			},
			undo: async () => {
				log.push("undo:start");
				await Promise.resolve();
				log.push("undo:end");
			},
		}));

		const undoPromise = stack.undo();
		expect(stack.getSnapshot().cursor).toBe(1);
		await undoPromise;
		expect(stack.getSnapshot().cursor).toBe(0);

		await stack.redo();
		expect(stack.getSnapshot().cursor).toBe(1);
		expect(log).toEqual(["undo:start", "undo:end", "do:start", "do:end"]);
	});

	it("supports unsubscribe for onChange listeners", () => {
		const log: string[] = [];
		const stack = new HistoryStack();
		const listener = vi.fn();
		const unsubscribe = stack.onChange(listener);

		stack.push(command("A", log));
		unsubscribe();
		stack.push(command("B", log));

		expect(listener).toHaveBeenCalledTimes(1);
	});
});
