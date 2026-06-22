// Concurrent-edit Phase 1 — per-tab edit-session identity + same-user tab
// coordination over BroadcastChannel.
//
// Proves: each tab has a stable per-tab clientId; one tab's "editing" broadcast
// is seen by the other as a peer on the same unit; and a release-request to a
// targeted tab triggers that tab's flush+release handler. A single shared fake
// BroadcastChannel bus lets two store instances talk in-process.

import { describe, it, expect, vi, beforeEach } from "vitest";

// In-process BroadcastChannel bus shared by all channels of the same name.
type Listener = (event: { data: unknown }) => void;
const buses = new Map<string, Set<{ self: FakeBroadcastChannel }>>();

class FakeBroadcastChannel {
	onmessage: Listener | null = null;
	private peers: Set<{ self: FakeBroadcastChannel }>;
	private ref = { self: this };
	constructor(public name: string) {
		this.peers = buses.get(name) ?? new Set();
		buses.set(name, this.peers);
		this.peers.add(this.ref);
	}
	postMessage(data: unknown): void {
		for (const peer of this.peers) {
			if (peer.self !== this) peer.self.onmessage?.({ data });
		}
	}
	close(): void {
		this.peers.delete(this.ref);
	}
}

beforeEach(() => {
	buses.clear();
	vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel as unknown as typeof BroadcastChannel);
	vi.resetModules();
});

async function freshStore() {
	// Each import gets its own module instance → its own clientId (simulating a
	// separate tab). Clear sessionStorage first so the per-tab id is regenerated
	// (in one jsdom env sessionStorage is shared; a real second tab has its own).
	try {
		sessionStorage.clear();
	} catch {
		// ignore — no sessionStorage in this env
	}
	const mod = await import("$lib/stores/edit-session.svelte.ts");
	return mod.editSessionStore;
}

describe("editSessionStore", () => {
	it("has a non-empty per-tab clientId", async () => {
		const store = await freshStore();
		expect(store.clientId).toBeTruthy();
		expect(store.clientId.startsWith("tab-")).toBe(true);
	});

	it("two tabs see each other as peers on the same unit", async () => {
		const tabA = await freshStore();
		vi.resetModules();
		const tabB = await freshStore();
		expect(tabA.clientId).not.toBe(tabB.clientId);

		tabA.wire();
		tabB.wire();
		tabA.announceEditing("proj:page:1");

		// Tab B should now see tab A editing that unit.
		const peer = tabB.peerEditing("proj:page:1");
		expect(peer?.clientId).toBe(tabA.clientId);
		// And not a peer for a different unit.
		expect(tabB.peerEditing("proj:page:9")).toBeUndefined();
	});

	it("announceStopped clears the peer", async () => {
		const tabA = await freshStore();
		vi.resetModules();
		const tabB = await freshStore();
		tabA.wire();
		tabB.wire();
		tabA.announceEditing("proj:page:1");
		expect(tabB.peerEditing("proj:page:1")).toBeDefined();
		tabA.announceStopped("proj:page:1");
		expect(tabB.peerEditing("proj:page:1")).toBeUndefined();
	});

	it("a release-request to a tab triggers its flush+release handler", async () => {
		const tabA = await freshStore();
		vi.resetModules();
		const tabB = await freshStore();
		tabA.wire();
		tabB.wire();

		const released = vi.fn();
		tabA.onReleaseRequest(released);
		tabA.announceEditing("proj:page:1");

		// Tab B requests release of that unit (take-over).
		const targetClient = tabB.requestReleaseFromPeer("proj:page:1");
		expect(targetClient).toBe(tabA.clientId);
		expect(released).toHaveBeenCalledWith("proj:page:1");
	});
});
