// Wave 2 W2.5 — Notifications store.
//
// Backs the topbar bell badge + the NotificationPanel slide-in + the
// /(workspace)/notifications full-page browser.
//
// Polling now, SSE later (W2.7): the store exposes a `subscribeRealtime` hook
// that the SSE layer can call to inject realtime events without polling. Until
// W2.7 lands we fall back to a 30s poll while authenticated.
//
// A note on isolation: every load/mutate path no-ops when there is no auth
// token, so an unauthenticated visitor never hits /api/notifications.

import * as api from "$lib/api/client.ts";
import type { NotificationPayload } from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { realtimeStore, type RealtimeEvent } from "$lib/stores/realtime.svelte.ts";

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 20;
const RECENT_UNREAD_LIMIT = 5;

/**
 * Server-backed list filters. `all` lists everything; `unread` asks the server
 * for unread-only so paginated tabs are not limited to the cached first page.
 * Category filtering stays client-side for now (no server param yet) but the
 * panel/page keep loading while `hasMore` is true before declaring a tab empty.
 */
export type NotificationFilter = "all" | "unread";

class NotificationsStore {
	items = $state<NotificationPayload[]>([]);
	loading = $state(false);
	loadingMore = $state(false);
	hasMore = $state(false);
	error = $state<string | null>(null);
	lastLoadedAt = $state<number | null>(null);
	filter = $state<NotificationFilter>("all");

	/**
	 * Unread notifications that exist on the server but are NOT in the loaded
	 * `items` window (the list is paginated). The badge = unread-in-list +
	 * this remainder, so the count ALWAYS derives from the same source of truth as
	 * the list and can never drift below what the list actually shows (a16 #2).
	 * Reconciled from the authoritative server count on every refresh; never
	 * negative. A read transition on a LOADED item changes `items` (and so the
	 * badge) directly — it does NOT touch this remainder, so the two can't race.
	 */
	unreadBeyondLoaded = $state(0);

	/** Unread items currently present in the loaded list window. */
	private get unreadInList(): number {
		let count = 0;
		for (const entry of this.items) if (!entry.readAt) count += 1;
		return count;
	}

	/**
	 * The bell badge. DERIVED from the list source of truth (unread items in the
	 * list) plus the reconciled remainder for unread items beyond the loaded page.
	 * Because the list drives it, the badge can never disagree with the visible
	 * unread items, and an idempotent read transition (already-read item re-marked)
	 * leaves it unchanged.
	 */
	get unreadCount(): number {
		return this.unreadInList + Math.max(0, this.unreadBeyondLoaded);
	}

	/** Latest unread notifications, capped for the topbar peek. */
	get recentUnread(): NotificationPayload[] {
		return this.items.filter((entry) => !entry.readAt).slice(0, RECENT_UNREAD_LIMIT);
	}

	/** Unread count grouped by category for tab badges. */
	get unreadByCategory(): Record<"tasks" | "support" | "billing" | "system", number> {
		const tally = { tasks: 0, support: 0, billing: 0, system: 0 };
		for (const entry of this.items) {
			if (entry.readAt) continue;
			tally[entry.category] = (tally[entry.category] ?? 0) + 1;
		}
		return tally;
	}

	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private pollingFor: string | null = null;
	/** Teardown for the realtime SSE subscription (W2.7); null when not subscribed. */
	private realtimeUnsub: (() => void) | null = null;

	/**
	 * Switch the server-backed list filter. Reloads the feed from the first page
	 * so paginated tabs (e.g. Unread) reflect server state rather than only the
	 * already-cached items. No-op if the filter is unchanged.
	 */
	async setFilter(filter: NotificationFilter): Promise<void> {
		if (this.filter === filter) return;
		this.filter = filter;
		await this.load();
	}

	async load(): Promise<void> {
		if (!this.canCall()) return;
		this.loading = true;
		this.error = null;
		const requestedFilter = this.filter;
		try {
			const page = await api.listNotifications({ limit: PAGE_SIZE, unreadOnly: requestedFilter === "unread" });
			// Guard against a filter switch landing while this fetch was in flight.
			if (this.filter !== requestedFilter) return;
			this.items = page.items;
			this.hasMore = page.hasMore;
			this.lastLoadedAt = Date.now();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "โหลดการแจ้งเตือนไม่สำเร็จ";
		} finally {
			this.loading = false;
		}
		await this.refreshUnreadCount();
	}

	async loadMore(): Promise<void> {
		if (!this.canCall() || this.loadingMore || !this.hasMore) return;
		const cursor = this.items.at(-1)?.id;
		if (!cursor) return;
		this.loadingMore = true;
		const requestedFilter = this.filter;
		try {
			const page = await api.listNotifications({ limit: PAGE_SIZE, before: cursor, unreadOnly: requestedFilter === "unread" });
			// Guard against a filter switch landing while this fetch was in flight.
			if (this.filter !== requestedFilter) return;
			// Append + dedupe by id to be safe against overlapping fetches.
			const seen = new Set(this.items.map((entry) => entry.id));
			const next = page.items.filter((entry) => !seen.has(entry.id));
			this.items = [...this.items, ...next];
			this.hasMore = page.hasMore;
		} catch (err) {
			this.error = err instanceof Error ? err.message : "โหลดเพิ่มไม่สำเร็จ";
		} finally {
			this.loadingMore = false;
		}
	}

	async markRead(id: string): Promise<void> {
		if (!this.canCall()) return;
		// Optimistic update so the UI feels instant. The badge is DERIVED from the
		// list, so flipping the item's readAt updates the count idempotently — no
		// separate counter to decrement (and so nothing to drift). Re-marking an
		// already-read item is a no-op on both the list and the badge.
		const previous = this.items;
		const previousBeyond = this.unreadBeyondLoaded;
		const now = new Date().toISOString();
		this.items = this.items.map((entry) => {
			if (entry.id !== id) return entry;
			if (entry.readAt) return entry;
			return { ...entry, readAt: now };
		});
		try {
			const result = await api.markNotificationRead(id);
			// Reconcile with server's authoritative readAt timestamp.
			this.items = this.items.map((entry) => (entry.id === id ? { ...entry, readAt: result.notification.readAt } : entry));
		} catch (err) {
			this.items = previous;
			this.unreadBeyondLoaded = previousBeyond;
			await this.refreshUnreadCount();
			throw err;
		}
	}

	async markAllRead(): Promise<void> {
		if (!this.canCall()) return;
		const previous = this.items;
		const previousBeyond = this.unreadBeyondLoaded;
		const now = new Date().toISOString();
		this.items = this.items.map((entry) => (entry.readAt ? entry : { ...entry, readAt: now }));
		// Everything is read server-side too, so there is nothing unread beyond the
		// loaded window either. unreadCount (derived) is now 0.
		this.unreadBeyondLoaded = 0;
		try {
			await api.markAllNotificationsRead();
		} catch (err) {
			this.items = previous;
			this.unreadBeyondLoaded = previousBeyond;
			throw err;
		}
	}

	async refreshUnreadCount(): Promise<void> {
		if (!this.canCall()) return;
		try {
			const result = await api.getUnreadNotificationCount();
			// Reconcile the authoritative server TOTAL with the list source of truth:
			// the remainder is whatever the server counts beyond what the list already
			// shows as unread. Clamped at 0 so the derived badge (unreadInList +
			// remainder) never undercounts the visible list nor goes negative.
			this.unreadBeyondLoaded = Math.max(0, result.count - this.unreadInListCount());
		} catch {
			// Soft-fail: a transient count refresh failure should not surface as a
			// user-visible error — the next poll will retry.
		}
	}

	/** Same computation as the private getter, callable from async methods. */
	private unreadInListCount(): number {
		let count = 0;
		for (const entry of this.items) if (!entry.readAt) count += 1;
		return count;
	}

	/**
	 * Lifecycle. Wired from the layout via an $effect so it follows the auth state
	 * without needing layout teardown. SSE is the live path (W2.7): a new
	 * notification is pushed into the cache the instant it is created. Polling is
	 * the FALLBACK only — a slow background reconcile of the unread count for
	 * personal (workspace-less) notifications and any SSE gap. Both run together so
	 * the bell is correct whether or not realtime is connected for this deployment.
	 */
	startPolling(userId: string): void {
		if (this.pollingFor === userId && this.pollTimer) return;
		this.stopPolling();
		this.pollingFor = userId;
		// Live SSE bridge: deliver workspace notifications addressed to THIS user as
		// they are created. The realtime store fans out workspace events; we filter
		// to the current user and inject into the cache (no poll roundtrip).
		this.subscribeRealtime(userId);
		// First load happens immediately; the interval is the fallback reconcile.
		void this.load();
		if (typeof window === "undefined") return;
		this.pollTimer = setInterval(() => {
			void this.refreshUnreadCount();
		}, POLL_INTERVAL_MS);
	}

	stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.unsubscribeRealtime();
		this.pollingFor = null;
	}

	/**
	 * Subscribe to the realtime SSE bus for live notification delivery. Idempotent:
	 * an existing subscription is torn down first.
	 *
	 * PRIVACY: `notification_new` is delivered SERVER-SIDE on a per-user channel, so
	 * the wire only ever carries THIS user's notifications — another member's frame
	 * never reaches this connection (a16 re-review P1 #1). The `data.userId` check
	 * below is defense-in-depth (a stale subscription after a user switch), NOT the
	 * privacy boundary, which is enforced by the backend channel routing.
	 */
	subscribeRealtime(userId: string): void {
		this.unsubscribeRealtime();
		this.realtimeUnsub = realtimeStore.on("notification_new", (event) => {
			this.handleRealtimeNotification(userId, event);
		});
	}

	unsubscribeRealtime(): void {
		if (this.realtimeUnsub) {
			this.realtimeUnsub();
			this.realtimeUnsub = null;
		}
	}

	/** Deliver an SSE `notification_new` event to the cache iff it targets `userId`. */
	private handleRealtimeNotification(userId: string, event: RealtimeEvent): void {
		const data = event.data as { userId?: string; notification?: NotificationPayload } | undefined;
		if (!data) return;
		// Defense-in-depth: the server already routes this frame on a per-user
		// channel, so it is addressed to THIS user. Re-check the id anyway to guard a
		// stale subscription left over from a user switch within the same tab.
		if (data.userId !== userId) return;
		const notification = data.notification;
		if (!notification || typeof notification.id !== "string") return;
		this.receiveRealtime(notification);
	}

	reset(): void {
		this.stopPolling();
		this.items = [];
		this.unreadBeyondLoaded = 0;
		this.loading = false;
		this.loadingMore = false;
		this.hasMore = false;
		this.error = null;
		this.lastLoadedAt = null;
		this.filter = "all";
	}

	/**
	 * Push a server-originated notification into the local cache without a polling
	 * roundtrip (W2.7 SSE bridge). The bell badge is DERIVED from the list, so
	 * inserting/replacing the item is all that's needed — there is no separate
	 * counter to keep in sync, which is exactly what makes a delivery retry / SSE
	 * replay idempotent: re-receiving the same id REPLACES the item in place (the
	 * derived count is unchanged), and a never-seen id is prepended (the count goes
	 * up by exactly one because the list now has one more unread row). A new unread
	 * arriving live is already counted by the server total too, so we drop the
	 * remainder by one (clamped) to avoid double-counting it once a poll reconciles.
	 */
	receiveRealtime(notification: NotificationPayload): void {
		const existing = this.items.findIndex((entry) => entry.id === notification.id);
		if (existing >= 0) {
			// Idempotent replace-in-place; derived badge re-computes from the new list.
			this.items = this.items.map((entry, idx) => (idx === existing ? notification : entry));
			return;
		}
		this.items = [notification, ...this.items];
		// The server's unread total already includes this brand-new unread row; since
		// it is now IN the list, shrink the "beyond loaded" remainder by one so the
		// derived badge counts it once, not twice, until the next reconcile.
		if (!notification.readAt && this.unreadBeyondLoaded > 0) {
			this.unreadBeyondLoaded -= 1;
		}
	}

	private canCall(): boolean {
		return authStore.isAuthenticated;
	}
}

export const notificationsStore = new NotificationsStore();
