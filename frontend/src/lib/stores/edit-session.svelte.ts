// Concurrent-edit Phase 1 — per-TAB edit-session identity + same-user tab
// coordination.
//
// Two jobs:
//   1. A STABLE per-tab `clientId` (persisted in sessionStorage so it survives a
//      reload of the SAME tab but is unique per tab/window — a second tab, even
//      of the same user, gets a different id). This is what lets the backend
//      tell two tabs of one user apart so the second can't silently clobber.
//   2. Cross-tab coordination over a BroadcastChannel so same-user tabs can see
//      each other editing the same unit and hand the lease over cleanly. The
//      backend `client_id` + takeover is the durable fallback when
//      BroadcastChannel is unavailable (private windows, older browsers).
//
// Pure identity/coordination only — no network. The lease lifecycle lives in
// edit-lease.svelte.ts and consumes this.

const CLIENT_ID_KEY = "manga-editor:edit-session:client-id";
const CHANNEL_NAME = "manga-editor-edit-session";

function readOrCreateClientId(): string {
	const generate = (): string => {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `tab-${crypto.randomUUID()}`;
		return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
	};
	if (typeof sessionStorage === "undefined") return generate();
	try {
		const existing = sessionStorage.getItem(CLIENT_ID_KEY);
		if (existing && existing.trim()) return existing;
		const fresh = generate();
		sessionStorage.setItem(CLIENT_ID_KEY, fresh);
		return fresh;
	} catch {
		// sessionStorage can throw in private mode — fall back to an ephemeral id.
		return generate();
	}
}

/** A unit another tab of THIS user is actively editing. */
export interface PeerTabEdit {
	clientId: string;
	unitId: string;
	updatedAt: number;
}

type PeerMessage =
	| { type: "editing"; clientId: string; unitId: string }
	| { type: "stopped"; clientId: string; unitId: string }
	| { type: "release-request"; clientId: string; targetClientId: string; unitId: string }
	| { type: "released"; clientId: string; unitId: string };

type ReleaseRequestHandler = (unitId: string) => void;

class EditSessionStore {
	/** Stable identity of THIS browser tab. */
	readonly clientId = readOrCreateClientId();

	/** Units other tabs of the same user report editing, keyed by clientId. */
	peers = $state<Map<string, PeerTabEdit>>(new Map());

	private channel: BroadcastChannel | null = null;
	private wired = false;
	private releaseRequestHandler: ReleaseRequestHandler | null = null;

	wire(): void {
		if (this.wired) return;
		this.wired = true;
		if (typeof BroadcastChannel === "undefined") return;
		try {
			this.channel = new BroadcastChannel(CHANNEL_NAME);
			this.channel.onmessage = (event) => this.handleMessage(event.data as PeerMessage);
		} catch {
			this.channel = null;
		}
	}

	/** Register a callback the active tab uses to flush+release when another tab takes over. */
	onReleaseRequest(handler: ReleaseRequestHandler | null): void {
		this.releaseRequestHandler = handler;
	}

	/** Announce that this tab is now editing `unitId`. */
	announceEditing(unitId: string): void {
		this.post({ type: "editing", clientId: this.clientId, unitId });
	}

	/** Announce that this tab stopped editing `unitId`. */
	announceStopped(unitId: string): void {
		this.post({ type: "stopped", clientId: this.clientId, unitId });
	}

	/**
	 * Ask the peer tab currently holding `unitId` to flush + release it so this
	 * tab can take over cleanly. Returns the peer's clientId if one was found.
	 */
	requestReleaseFromPeer(unitId: string): string | undefined {
		const peer = this.peerEditing(unitId);
		if (!peer) return undefined;
		this.post({ type: "release-request", clientId: this.clientId, targetClientId: peer.clientId, unitId });
		return peer.clientId;
	}

	/** A peer (same user) editing this unit, if any. */
	peerEditing(unitId: string): PeerTabEdit | undefined {
		for (const peer of this.peers.values()) {
			if (peer.unitId === unitId && peer.clientId !== this.clientId) return peer;
		}
		return undefined;
	}

	private handleMessage(message: PeerMessage | undefined): void {
		if (!message || message.clientId === this.clientId) return;
		if (message.type === "editing") {
			const next = new Map(this.peers);
			next.set(message.clientId, { clientId: message.clientId, unitId: message.unitId, updatedAt: Date.now() });
			this.peers = next;
			return;
		}
		if (message.type === "stopped" || message.type === "released") {
			const peer = this.peers.get(message.clientId);
			if (peer && peer.unitId === message.unitId) {
				const next = new Map(this.peers);
				next.delete(message.clientId);
				this.peers = next;
			}
			return;
		}
		if (message.type === "release-request" && message.targetClientId === this.clientId) {
			// Another tab of ours is taking over this unit — flush + release here.
			this.releaseRequestHandler?.(message.unitId);
			this.post({ type: "released", clientId: this.clientId, unitId: message.unitId });
		}
	}

	private post(message: PeerMessage): void {
		this.wire();
		try {
			this.channel?.postMessage(message);
		} catch {
			// Best-effort; the backend client_id + takeover is the durable fallback.
		}
	}

	__resetForTesting(): void {
		this.peers = new Map();
		this.releaseRequestHandler = null;
	}
}

export const editSessionStore = new EditSessionStore();
