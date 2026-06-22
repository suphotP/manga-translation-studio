// Collab v1 — soft presence client store.
//
// Best-effort "X is editing" signal. NOT hard locking — it never blocks editing.
// While a page/task scope is "watched", we heartbeat the backend in-memory TTL
// store every HEARTBEAT_MS and surface the live pings from OTHER users in
// `others`. Stale pings expire server-side (TTL), so a closed tab disappears on
// its own. Degrades gracefully: any network error just leaves `others` empty.
//
// Works in file-mode: when there is no authed user we send a stable client
// identity (a per-tab id + the auth display name when known). A QA/test harness
// can call `pingAs(...)` to simulate a SECOND user without any auth wiring.

import { clearPresence, listPresence, sendPresenceHeartbeat, type PresenceEntry, type PresenceScope } from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";

const HEARTBEAT_MS = 20_000;

function makeClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `tab-${crypto.randomUUID()}`;
	}
	return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

interface PresenceScopeRef {
	projectId: string;
	scope: PresenceScope;
	scopeId: string;
}

class PresenceStore {
	/** Pings from OTHER users on the currently-watched scope (most-recent-first). */
	others = $state<PresenceEntry[]>([]);

	// Stable per-tab identity used only in file-mode (no JWT). With a JWT the
	// server keys on the authed user and ignores this.
	private readonly clientId = makeClientId();
	private watched: PresenceScopeRef | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;

	private identity(): { userId?: string; name?: string } {
		const user = authStore.user;
		if (user) return { userId: user.id, name: user.name || user.email };
		return { userId: this.clientId, name: "You" };
	}

	/**
	 * Start (or switch) heartbeating a page/task scope. Idempotent for the same
	 * scope. Immediately fires one heartbeat, then repeats on an interval.
	 */
	watch(ref: PresenceScopeRef): void {
		if (
			this.watched
			&& this.watched.projectId === ref.projectId
			&& this.watched.scope === ref.scope
			&& this.watched.scopeId === ref.scopeId
		) {
			return;
		}
		this.stop();
		this.watched = ref;
		this.others = [];
		void this.beat();
		if (typeof setInterval === "function") {
			this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
		}
	}

	/** Stop heartbeating and clear our own ping for the watched scope. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		const ref = this.watched;
		this.watched = null;
		this.others = [];
		if (ref) {
			const { userId } = this.identity();
			void clearPresence({ ...ref, userId }).catch(() => {});
		}
	}

	private async beat(): Promise<void> {
		const ref = this.watched;
		if (!ref) return;
		try {
			const { userId, name } = this.identity();
			const result = await sendPresenceHeartbeat({ ...ref, userId, name });
			// Guard against a scope switch that happened while the request was in flight.
			if (this.watched === ref) this.others = result.others;
		} catch {
			// Best-effort: leave whatever we last had; never surface an error.
		}
	}

	/** Refresh `others` without writing a heartbeat (e.g. on focus). */
	async refresh(): Promise<void> {
		const ref = this.watched;
		if (!ref) return;
		try {
			const { userId } = this.identity();
			const result = await listPresence({ ...ref, userId });
			if (this.watched === ref) this.others = result.others;
		} catch {
			// ignore
		}
	}

	/**
	 * Simulate ANOTHER user's heartbeat on a scope — used by QA/tests to prove the
	 * badge appears when a non-self recent ping exists (file-mode is single-user).
	 */
	async pingAs(input: PresenceScopeRef & { userId: string; name: string }): Promise<void> {
		await sendPresenceHeartbeat(input).catch(() => {});
		await this.refresh();
	}
}

export const presenceStore = new PresenceStore();

// Expose for browser QA in dev so a second user's ping can be simulated from the
// console without auth wiring.
if (typeof window !== "undefined") {
	(window as unknown as { __presence?: PresenceStore }).__presence = presenceStore;
}
