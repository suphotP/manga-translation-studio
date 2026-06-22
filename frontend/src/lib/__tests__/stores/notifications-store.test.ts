// Notification store — unread-count derivation (a16 #2) + live SSE per-user
// delivery (a16 #1/#3). The badge must derive from the SAME source of truth as
// the list, and an SSE notification_new event must reach ONLY the targeted user.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RealtimeEvent, RealtimeListener } from "$lib/stores/realtime.svelte.ts";

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock("$lib/api/client.ts", () => ({
	listNotifications: vi.fn(async () => ({ items: [], hasMore: false })),
	getUnreadNotificationCount: vi.fn(async () => ({ count: 0 })),
	markNotificationRead: vi.fn(async (id: string) => ({ notification: { id, readAt: new Date().toISOString() } })),
	markAllNotificationsRead: vi.fn(async () => ({ updated: 0 })),
}));

vi.mock("$lib/stores/auth.svelte.ts", () => ({
	authStore: { isAuthenticated: true },
}));

// Capture the realtime listener the store registers so we can drive SSE events.
let capturedListener: RealtimeListener | null = null;
vi.mock("$lib/stores/realtime.svelte.ts", () => ({
	realtimeStore: {
		on: (_kind: string, listener: RealtimeListener) => {
			capturedListener = listener;
			return () => {
				capturedListener = null;
			};
		},
	},
}));

import * as api from "$lib/api/client.ts";
import { notificationsStore } from "$lib/stores/notifications.svelte.ts";

function notif(overrides: Record<string, unknown> = {}) {
	return {
		id: `n-${Math.random().toString(36).slice(2)}`,
		userId: "user-1",
		type: "comment_new",
		title: "Hi",
		createdAt: new Date().toISOString(),
		category: "tasks",
		...overrides,
	} as any;
}

function emit(data: Record<string, unknown>): void {
	const event: RealtimeEvent = { id: "e1", kind: "notification_new", workspaceId: "ws-1", emittedAt: Date.now(), data };
	capturedListener?.(event);
}

beforeEach(() => {
	notificationsStore.reset();
	capturedListener = null;
	vi.clearAllMocks();
});

describe("unread count derives from the list source of truth (a16 #2)", () => {
	it("badge = unread items in the list + reconciled remainder; marking read updates it idempotently", async () => {
		(api.listNotifications as any).mockResolvedValueOnce({
			items: [notif({ id: "a" }), notif({ id: "b" }), notif({ id: "c", readAt: new Date().toISOString() })],
			hasMore: false,
		});
		// Server says 2 unread total (a + b); c is read.
		(api.getUnreadNotificationCount as any).mockResolvedValue({ count: 2 });

		await notificationsStore.load();
		// 2 unread in list, remainder reconciles to 0 → badge 2.
		expect(notificationsStore.unreadCount).toBe(2);

		// Marking one read flips the list item → badge derives down to 1.
		await notificationsStore.markRead("a");
		expect(notificationsStore.unreadCount).toBe(1);

		// Idempotent: re-marking the same (now-read) item does NOT drift the badge.
		await notificationsStore.markRead("a");
		expect(notificationsStore.unreadCount).toBe(1);
	});

	it("counts unread beyond the loaded page without ever undercounting the visible list", async () => {
		(api.listNotifications as any).mockResolvedValueOnce({
			items: [notif({ id: "a" }), notif({ id: "b" })],
			hasMore: true,
		});
		// Server total 5 unread; only 2 are loaded → remainder 3, badge 5.
		(api.getUnreadNotificationCount as any).mockResolvedValue({ count: 5 });

		await notificationsStore.load();
		expect(notificationsStore.unreadCount).toBe(5);

		// markAllRead zeroes both the list and the remainder.
		await notificationsStore.markAllRead();
		expect(notificationsStore.unreadCount).toBe(0);
	});

	it("a stale/lower server count never makes the badge drop below the visible unread list", async () => {
		(api.listNotifications as any).mockResolvedValueOnce({
			items: [notif({ id: "a" }), notif({ id: "b" })],
			hasMore: false,
		});
		// A racing/stale count of 0 must not hide the 2 unread the list clearly shows.
		(api.getUnreadNotificationCount as any).mockResolvedValue({ count: 0 });

		await notificationsStore.load();
		expect(notificationsStore.unreadCount).toBe(2);
	});
});

describe("live SSE delivery is strictly per-user (a16 #1/#3)", () => {
	it("delivers a notification_new event addressed to this user into the cache", () => {
		notificationsStore.subscribeRealtime("user-1");
		expect(capturedListener).toBeTypeOf("function");

		emit({ userId: "user-1", notification: notif({ id: "live-1" }) });
		expect(notificationsStore.items.map((n) => n.id)).toContain("live-1");
		expect(notificationsStore.unreadCount).toBe(1);
	});

	it("IGNORES a notification_new event addressed to a DIFFERENT user (no leak)", () => {
		notificationsStore.subscribeRealtime("user-1");
		emit({ userId: "user-2", notification: notif({ id: "other-user", userId: "user-2" }) });
		expect(notificationsStore.items).toHaveLength(0);
		expect(notificationsStore.unreadCount).toBe(0);
	});

	it("a replayed/duplicate live event is idempotent (no double count)", () => {
		notificationsStore.subscribeRealtime("user-1");
		const payload = notif({ id: "dupe" });
		emit({ userId: "user-1", notification: payload });
		emit({ userId: "user-1", notification: payload });
		expect(notificationsStore.items.filter((n) => n.id === "dupe")).toHaveLength(1);
		expect(notificationsStore.unreadCount).toBe(1);
	});
});
