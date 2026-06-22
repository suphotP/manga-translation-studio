// Wave 2 W2.5 — Toast manager.
//
// In-memory toast queue with variant-based auto-dismiss. Mounted once at the
// workspace root via Toast.svelte. Callers:
//
//   toastsStore.show({ title, body, variant: "info" })
//   toastsStore.success({ title })            // sugar
//   toastsStore.warn({ title, body })
//   toastsStore.error({ title, action: { label: "Retry", onClick: ... } })
//
// Variants follow the W2.5 spec:
//   success → 4s
//   info    → 5s
//   warn    → 8s
//   error   → 12s
//
// Callers can pass `durationMs: 0` to keep a toast on screen until manually
// dismissed (e.g. a save-conflict warning that should persist until the user
// acts on it).

export type ToastVariant = "success" | "info" | "warn" | "error";

export interface ToastAction {
	label: string;
	onClick: () => void | Promise<void>;
}

export interface ToastInput {
	title: string;
	body?: string;
	variant?: ToastVariant;
	durationMs?: number;
	action?: ToastAction;
	/**
	 * Optional id for dedupe — if a toast with this id is already shown, the
	 * existing toast is updated in place instead of stacking a duplicate. This
	 * is what e.g. the save-conflict surface uses so we do not pile up.
	 */
	id?: string;
}

export interface Toast {
	id: string;
	title: string;
	body?: string;
	variant: ToastVariant;
	durationMs: number;
	action?: ToastAction;
	createdAt: number;
}

const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
	success: 4000,
	info: 5000,
	warn: 8000,
	error: 12000,
};

const MAX_VISIBLE = 5;

function randomId(): string {
	return `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class ToastsStore {
	items = $state<Toast[]>([]);

	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	// When a toast's auto-dismiss is paused (pointer hovering so the user can finish
	// reading), we stash the ms left so resume() reschedules for exactly that long —
	// keeping the real timer in lockstep with the on-screen countdown bar, which
	// pauses on the same hover via animation-play-state.
	private remaining = new Map<string, number>();
	private expiresAt = new Map<string, number>();

	show(input: ToastInput): string {
		const variant: ToastVariant = input.variant ?? "info";
		const duration = input.durationMs ?? DEFAULT_DURATIONS[variant];
		const id = input.id ?? randomId();

		const toast: Toast = {
			id,
			title: input.title,
			body: input.body,
			variant,
			durationMs: duration,
			action: input.action,
			createdAt: Date.now(),
		};

		// Dedupe-by-id: if a toast with this id exists, replace it in place.
		const existingIndex = this.items.findIndex((entry) => entry.id === id);
		if (existingIndex >= 0) {
			this.items[existingIndex] = toast;
		} else {
			this.items = [...this.items, toast];
			// Cap visible stack so the page does not get drowned in toasts.
			if (this.items.length > MAX_VISIBLE) {
				const overflow = this.items.length - MAX_VISIBLE;
				const removed = this.items.slice(0, overflow);
				for (const entry of removed) this.clearTimer(entry.id);
				this.items = this.items.slice(overflow);
			}
		}

		this.scheduleAutoDismiss(toast);
		return id;
	}

	success(input: Omit<ToastInput, "variant">): string {
		return this.show({ ...input, variant: "success" });
	}

	info(input: Omit<ToastInput, "variant">): string {
		return this.show({ ...input, variant: "info" });
	}

	warn(input: Omit<ToastInput, "variant">): string {
		return this.show({ ...input, variant: "warn" });
	}

	error(input: Omit<ToastInput, "variant">): string {
		return this.show({ ...input, variant: "error" });
	}

	dismiss(id: string): void {
		this.clearTimer(id);
		this.remaining.delete(id);
		this.expiresAt.delete(id);
		this.items = this.items.filter((entry) => entry.id !== id);
	}

	dismissAll(): void {
		for (const id of [...this.timers.keys()]) this.clearTimer(id);
		this.remaining.clear();
		this.expiresAt.clear();
		this.items = [];
	}

	/** Pause a toast's auto-dismiss (pointer entered) — stash the time still owed. */
	pause(id: string): void {
		const expires = this.expiresAt.get(id);
		if (expires === undefined) return; // persistent toast, or already paused
		this.clearTimer(id);
		this.remaining.set(id, Math.max(0, expires - Date.now()));
		this.expiresAt.delete(id);
	}

	/** Resume a paused toast (pointer left) — reschedule for the remaining time. */
	resume(id: string): void {
		if (this.timers.has(id) || this.expiresAt.has(id)) return; // already running
		const left = this.remaining.get(id);
		if (left === undefined) return; // not paused
		this.remaining.delete(id);
		this.armTimer(id, left);
	}

	private scheduleAutoDismiss(toast: Toast): void {
		this.clearTimer(toast.id);
		this.remaining.delete(toast.id);
		this.expiresAt.delete(toast.id);
		if (!toast.durationMs || toast.durationMs <= 0) return;
		this.armTimer(toast.id, toast.durationMs);
	}

	private armTimer(id: string, ms: number): void {
		if (typeof window === "undefined") return;
		this.expiresAt.set(id, Date.now() + ms);
		const timer = setTimeout(() => this.dismiss(id), ms);
		this.timers.set(id, timer);
	}

	private clearTimer(id: string): void {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
	}
}

export const toastsStore = new ToastsStore();
