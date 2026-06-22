export type HistoryStackEffect = () => void | Promise<void>;

export interface HistoryStackCommand {
	label: string;
	do: HistoryStackEffect;
	undo: HistoryStackEffect;
	coalesceKey?: string;
	sizeBytes?: number;
}

export interface HistoryStackOptions {
	/** Commands with the same coalesceKey merge only inside this adjacent-push window. */
	windowMs?: number;
	/** Total retained command payload budget. A single oversized newest entry is kept. */
	maxBytes?: number;
	/** Injected clock keeps coalescing deterministic in tests and playback harnesses. */
	now?: () => number;
}

export interface HistoryStackEntrySnapshot {
	id: number;
	label: string;
	kind: "command" | "transaction";
	coalesceKey: string | null;
	commandCount: number;
	sizeBytes: number;
	applied: boolean;
}

export interface HistoryStackSnapshot {
	canUndo: boolean;
	canRedo: boolean;
	undoLabel: string | null;
	redoLabel: string | null;
	cursor: number;
	totalBytes: number;
	maxBytes: number;
	entries: readonly HistoryStackEntrySnapshot[];
}

export type HistoryStackChangeListener = (snapshot: HistoryStackSnapshot) => void;

type StackAction = "none" | "push" | "transaction" | "undo" | "redo" | "clear";

type MaybePromise<T> = T | PromiseLike<T>;

interface BaseEntry {
	id: number;
	label: string;
	kind: "command" | "transaction";
	coalesceKey: string | null;
	commandCount: number;
	sizeBytes: number;
	createdAt: number;
	updatedAt: number;
	do(): MaybePromise<void>;
	undo(): MaybePromise<void>;
}

interface CommandEntry<TCommand extends HistoryStackCommand> extends BaseEntry {
	kind: "command";
	coalesceKey: string | null;
	doCommand: TCommand;
	undoCommand: TCommand;
}

interface TransactionEntry<TCommand extends HistoryStackCommand> extends BaseEntry {
	kind: "transaction";
	coalesceKey: null;
	commands: readonly TCommand[];
}

type StackEntry<TCommand extends HistoryStackCommand> =
	| CommandEntry<TCommand>
	| TransactionEntry<TCommand>;

interface PendingTransaction<TCommand extends HistoryStackCommand> {
	label: string;
	commands: TCommand[];
}

const DEFAULT_COALESCE_WINDOW_MS = 500;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

function isPromiseLike<T>(value: MaybePromise<T>): value is PromiseLike<T> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function commandSize(command: HistoryStackCommand): number {
	const size = command.sizeBytes ?? 0;
	if (!Number.isFinite(size) || size <= 0) return 0;
	return Math.floor(size);
}

function runEffectsSequentially(effects: readonly HistoryStackEffect[]): MaybePromise<void> {
	let index = 0;
	const runNext = (): MaybePromise<void> => {
		while (index < effects.length) {
			const result = effects[index++]();
			if (isPromiseLike(result)) return result.then(runNext);
		}
	};
	return runNext();
}

export class HistoryStack<TCommand extends HistoryStackCommand = HistoryStackCommand> {
	private readonly windowMs: number;
	private readonly maxBytes: number;
	private readonly now: () => number;
	private readonly listeners = new Set<HistoryStackChangeListener>();
	private entries: StackEntry<TCommand>[] = [];
	private cursor = 0;
	private totalBytes = 0;
	private nextEntryId = 1;
	private lastAction: StackAction = "none";
	private activeTransaction: PendingTransaction<TCommand> | null = null;

	constructor(options: HistoryStackOptions = {}) {
		this.windowMs = Math.max(0, options.windowMs ?? DEFAULT_COALESCE_WINDOW_MS);
		this.maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
		this.now = options.now ?? Date.now;
	}

	push(command: TCommand): void {
		if (this.activeTransaction) {
			this.activeTransaction.commands.push(command);
			return;
		}
		this.appendEntry(this.createCommandEntry(command, this.now()), { allowCoalesce: true });
	}

	transaction<TResult>(label: string, run: () => TResult): TResult {
		if (this.activeTransaction) {
			throw new Error("Nested history transactions are not supported.");
		}

		const transaction: PendingTransaction<TCommand> = { label, commands: [] };
		this.activeTransaction = transaction;

		try {
			const result = run();
			if (isPromiseLike(result)) {
				return Promise.resolve(result).finally(() => {
					this.finishTransaction(transaction);
				}) as TResult;
			}
			this.finishTransaction(transaction);
			return result;
		} catch (error) {
			// Commands are pushed only after the caller has already changed editor state;
			// keep partial work undoable even when the grouping callback fails.
			this.finishTransaction(transaction);
			throw error;
		}
	}

	undo(): MaybePromise<boolean> {
		this.assertNoOpenTransaction("undo");
		this.lastAction = "undo";
		if (!this.canUndo()) return false;

		const entry = this.entries[this.cursor - 1];
		const result = entry.undo();
		if (isPromiseLike(result)) {
			return result.then(() => {
				this.cursor -= 1;
				this.emitChange();
				return true;
			});
		}

		this.cursor -= 1;
		this.emitChange();
		return true;
	}

	redo(): MaybePromise<boolean> {
		this.assertNoOpenTransaction("redo");
		this.lastAction = "redo";
		if (!this.canRedo()) return false;

		const entry = this.entries[this.cursor];
		const result = entry.do();
		if (isPromiseLike(result)) {
			return result.then(() => {
				this.cursor += 1;
				this.emitChange();
				return true;
			});
		}

		this.cursor += 1;
		this.emitChange();
		return true;
	}

	canUndo(): boolean {
		return this.cursor > 0;
	}

	canRedo(): boolean {
		return this.cursor < this.entries.length;
	}

	clear(): void {
		this.assertNoOpenTransaction("clear");
		if (this.entries.length === 0 && this.cursor === 0) return;
		this.entries = [];
		this.cursor = 0;
		this.totalBytes = 0;
		this.lastAction = "clear";
		this.emitChange();
	}

	onChange(listener: HistoryStackChangeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): HistoryStackSnapshot {
		const undoEntry = this.cursor > 0 ? this.entries[this.cursor - 1] : null;
		const redoEntry = this.cursor < this.entries.length ? this.entries[this.cursor] : null;
		return {
			canUndo: this.canUndo(),
			canRedo: this.canRedo(),
			undoLabel: undoEntry?.label ?? null,
			redoLabel: redoEntry?.label ?? null,
			cursor: this.cursor,
			totalBytes: this.totalBytes,
			maxBytes: this.maxBytes,
			entries: this.entries.map((entry, index) => ({
				id: entry.id,
				label: entry.label,
				kind: entry.kind,
				coalesceKey: entry.coalesceKey,
				commandCount: entry.commandCount,
				sizeBytes: entry.sizeBytes,
				applied: index < this.cursor,
			})),
		};
	}

	private createCommandEntry(command: TCommand, timestamp: number): CommandEntry<TCommand> {
		const sizeBytes = commandSize(command);
		return {
			id: this.nextEntryId++,
			label: command.label,
			kind: "command",
			coalesceKey: command.coalesceKey ?? null,
			commandCount: 1,
			sizeBytes,
			createdAt: timestamp,
			updatedAt: timestamp,
			doCommand: command,
			undoCommand: command,
			do: () => command.do(),
			undo: () => command.undo(),
		};
	}

	private createTransactionEntry(label: string, commands: readonly TCommand[], timestamp: number): TransactionEntry<TCommand> {
		const retainedCommands = [...commands];
		const sizeBytes = retainedCommands.reduce((sum, command) => sum + commandSize(command), 0);
		return {
			id: this.nextEntryId++,
			label,
			kind: "transaction",
			coalesceKey: null,
			commandCount: retainedCommands.length,
			sizeBytes,
			createdAt: timestamp,
			updatedAt: timestamp,
			commands: retainedCommands,
			do: () => runEffectsSequentially(retainedCommands.map((command) => command.do)),
			undo: () => runEffectsSequentially([...retainedCommands].reverse().map((command) => command.undo)),
		};
	}

	private appendEntry(entry: StackEntry<TCommand>, options: { allowCoalesce: boolean }): void {
		this.dropRedoBranch();

		const coalesced = options.allowCoalesce && this.tryCoalesce(entry);
		if (!coalesced) {
			this.entries.push(entry);
			this.totalBytes += entry.sizeBytes;
			this.cursor = this.entries.length;
		}

		this.enforceMemoryBudget();
		this.lastAction = options.allowCoalesce ? "push" : "transaction";
		this.emitChange();
	}

	private tryCoalesce(entry: StackEntry<TCommand>): boolean {
		if (entry.kind !== "command" || !entry.coalesceKey) return false;
		if (this.lastAction !== "push" || this.cursor !== this.entries.length) return false;

		const previous = this.entries[this.entries.length - 1];
		if (!previous || previous.kind !== "command") return false;
		if (previous.coalesceKey !== entry.coalesceKey) return false;
		if (entry.updatedAt - previous.updatedAt > this.windowMs) return false;

		const previousSize = previous.sizeBytes;
		previous.label = entry.label;
		previous.doCommand = entry.doCommand;
		previous.do = () => entry.doCommand.do();
		previous.updatedAt = entry.updatedAt;
		previous.commandCount += 1;
		previous.sizeBytes = previous.undoCommand === previous.doCommand
			? commandSize(previous.undoCommand)
			: commandSize(previous.undoCommand) + commandSize(previous.doCommand);
		this.totalBytes += previous.sizeBytes - previousSize;
		return true;
	}

	private finishTransaction(transaction: PendingTransaction<TCommand>): void {
		if (this.activeTransaction !== transaction) return;
		this.activeTransaction = null;
		if (transaction.commands.length === 0) return;
		this.appendEntry(this.createTransactionEntry(transaction.label, transaction.commands, this.now()), {
			allowCoalesce: false,
		});
	}

	private dropRedoBranch(): void {
		if (this.cursor >= this.entries.length) return;
		const dropped = this.entries.splice(this.cursor);
		for (const entry of dropped) this.totalBytes -= entry.sizeBytes;
	}

	private enforceMemoryBudget(): void {
		while (this.totalBytes > this.maxBytes && this.entries.length > 1) {
			const evicted = this.entries.shift();
			if (!evicted) break;
			this.totalBytes -= evicted.sizeBytes;
			if (this.cursor > 0) this.cursor -= 1;
		}
	}

	private emitChange(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) listener(snapshot);
	}

	private assertNoOpenTransaction(action: string): void {
		if (this.activeTransaction) {
			throw new Error(`Cannot ${action} while a history transaction is open.`);
		}
	}
}
