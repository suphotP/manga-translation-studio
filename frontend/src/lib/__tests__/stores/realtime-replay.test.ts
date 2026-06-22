// Realtime store reconnect-replay tests (W4.9 in-flight job continuity).
//
// On a zero-downtime/rolling deploy the SSE stream drops and the client
// reconnects. These tests verify the store resumes from the LAST seen event id
// per workspace (?lastEventId=) so events emitted during the deploy gap are
// replayed and not silently lost, and that a foreign workspace's cursor is never
// leaked into another workspace's stream.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { realtimeStore } from "$lib/stores/realtime.svelte.ts";

interface OpenedSource {
	url: string;
	listeners: Map<string, Array<(ev: any) => void>>;
	close: ReturnType<typeof vi.fn>;
}

const opened: OpenedSource[] = [];

class FakeEventSource {
	url: string;
	listeners = new Map<string, Array<(ev: any) => void>>();
	close = vi.fn();
	constructor(url: string) {
		this.url = url;
		opened.push({ url, listeners: this.listeners, close: this.close });
	}
	addEventListener(type: string, cb: (ev: any) => void): void {
		const arr = this.listeners.get(type) ?? [];
		arr.push(cb);
		this.listeners.set(type, arr);
	}
	removeEventListener(): void {/* noop */}
	dispatch(type: string, ev: any): void {
		for (const cb of this.listeners.get(type) ?? []) cb(ev);
	}
}

function lastOpened(): OpenedSource {
	return opened[opened.length - 1]!;
}

function fireOpen(source: OpenedSource): void {
	for (const cb of source.listeners.get("open") ?? []) cb(new Event("open"));
}

function fireEvent(source: OpenedSource, kind: string, payload: Record<string, unknown>, id: string): void {
	const ev = { data: JSON.stringify({ kind, ...payload }), lastEventId: id } as MessageEvent;
	for (const cb of source.listeners.get(kind) ?? []) cb(ev);
}

describe("RealtimeStore reconnect replay (W4.9)", () => {
	beforeEach(() => {
		opened.length = 0;
		// Token mint endpoint always returns a token.
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			json: async () => ({ token: "tok-123" }),
		})) as unknown as typeof fetch);
		// Provide a window.location.origin for the URL constructor.
		vi.stubGlobal("window", { location: { origin: "http://localhost" } });
		vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
		realtimeStore.__resetForTesting();
	});

	afterEach(() => {
		realtimeStore.__resetForTesting();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("resumes from the last event id after a deploy-style reconnect", async () => {
		await realtimeStore.connect("ws-1");
		const first = lastOpened();
		expect(first.url).toContain("/realtime/workspaces/ws-1/events");
		// First connect has no cursor yet.
		expect(first.url).not.toContain("lastEventId=");
		fireOpen(first);

		// Server delivers an event; the store records its id as the resume cursor.
		fireEvent(first, "ai_job_status", { workspaceId: "ws-1", data: { jobId: "j-1", status: "processing" } }, "1700-5");
		expect(realtimeStore.lastEventId).toBe("1700-5");

		// Simulate a deploy: stream drops, then the app reconnects to the SAME ws.
		realtimeStore.disconnect();
		await realtimeStore.connect("ws-1");
		const second = lastOpened();
		expect(second).not.toBe(first);
		// The reconnect MUST carry the resume cursor so the gap is replayed.
		expect(second.url).toContain(`lastEventId=${encodeURIComponent("1700-5")}`);
	});

	it("never replays one workspace's cursor into a different workspace", async () => {
		await realtimeStore.connect("ws-1");
		fireOpen(lastOpened());
		fireEvent(lastOpened(), "comment_new", { workspaceId: "ws-1", data: {} }, "ws1-9");

		// Switch to a different workspace (no prior cursor for it).
		realtimeStore.disconnect();
		await realtimeStore.connect("ws-2");
		const wsTwo = lastOpened();
		expect(wsTwo.url).toContain("/realtime/workspaces/ws-2/events");
		expect(wsTwo.url).not.toContain("lastEventId=");

		// Returning to ws-1 still resumes from ws-1's own cursor.
		realtimeStore.disconnect();
		await realtimeStore.connect("ws-1");
		expect(lastOpened().url).toContain(`lastEventId=${encodeURIComponent("ws1-9")}`);
	});
});
