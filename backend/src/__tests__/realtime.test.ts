// Realtime SSE phase-1 tests — token mint/verify, SSE handshake, scope
// enforcement, publish→subscribe round-trip, and Last-Event-ID replay.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { sign } from "jsonwebtoken";
import { realtime } from "../routes/realtime.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { optionalAuth } from "../middleware/auth.middleware.js";
import { mintRealtimeToken, verifyRealtimeToken } from "../services/realtime-token.js";
import {
	createInMemoryRealtimeBus,
	setRealtimeBusForTesting,
	publishRealtimeEvent,
	publishPageSetChangedEvent,
	getRealtimeBus,
	readSseKeepaliveSec,
	readSseIdleTimeoutSec,
	readSseTokenTtlSec,
	readRealtimeStreamMaxLen,
	readSseSubscriberMaxQueue,
	readSseSubscriberMaxBytes,
	isRealtimeEventKind,
	userScopedChannel,
	publishUserScopedEvent,
} from "../services/realtime-bus.js";
import {
	emitAiJobStatusEvent,
	seedWorkspaceLookupForTesting,
	clearWorkspaceLookupCacheForTesting,
} from "../services/realtime-emitters.js";
import { notify } from "../services/notification-dispatch.js";
import { createUser, generateTokens, loadUser, updateUser } from "../services/auth.service.js";
import { workspaceAccessStore } from "../services/workspace-access.js";
import { serverConfig } from "../config.js";
import { redactSensitiveUrl, redactSensitiveQuery, redactSensitiveHeaders } from "../middleware/sentry.js";

function uniqueEmail(label: string): string {
	return `realtime-${label}-${crypto.randomUUID()}@example.com`;
}

function buildApp(): Hono {
	const app = new Hono();
	app.use("*", optionalAuth);
	app.route("/api/realtime", realtime);
	return app;
}

describe("realtime-token", () => {
	it("mints a token with scope='sse' and the expected workspace+user", () => {
		const minted = mintRealtimeToken({ userId: "user-123", workspaceId: "ws-abc" });
		expect(minted.token.length).toBeGreaterThan(20);
		expect(minted.expiresAt).toBeGreaterThan(Date.now());
		const payload = verifyRealtimeToken(minted.token);
		expect(payload).not.toBeNull();
		expect(payload?.sub).toBe("user-123");
		expect(payload?.ws).toBe("ws-abc");
		expect(payload?.scope).toBe("sse");
	});

	it("rejects an expired token", async () => {
		// Issue a token with a 1s TTL, then wait for it to expire.
		const minted = mintRealtimeToken({ userId: "u", workspaceId: "ws", ttlSeconds: 1 });
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(verifyRealtimeToken(minted.token)).toBeNull();
	});

	it("rejects a token whose scope is not 'sse'", () => {
		// Manually craft a JWT with the wrong scope; it must be refused.
		const badToken = sign({ sub: "u", ws: "ws", scope: "api" }, serverConfig.jwtSecret, { expiresIn: "60s" });
		expect(verifyRealtimeToken(badToken)).toBeNull();
	});

	it("rejects a token with a missing workspace claim", () => {
		const badToken = sign({ sub: "u", scope: "sse" }, serverConfig.jwtSecret, { expiresIn: "60s" });
		expect(verifyRealtimeToken(badToken)).toBeNull();
	});

	it("rejects a garbage token", () => {
		expect(verifyRealtimeToken("not-a-jwt")).toBeNull();
		expect(verifyRealtimeToken("")).toBeNull();
	});
});

describe("realtime-bus (in-memory)", () => {
	let bus: ReturnType<typeof createInMemoryRealtimeBus>;

	beforeEach(() => {
		bus = createInMemoryRealtimeBus(50);
		setRealtimeBusForTesting(bus);
	});

	afterEach(() => {
		setRealtimeBusForTesting(null);
	});

	it("subscribers receive a published event within 100ms", async () => {
		const subscription = bus.subscribe("ws-1", {});
		const iterator = subscription[Symbol.asyncIterator]();
		const nextPromise = iterator.next();

		await publishRealtimeEvent("ws-1", "comment_new", { commentId: "c-1", excerpt: "hello" });

		const start = Date.now();
		const result = await Promise.race([
			nextPromise,
			new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 1000)),
		]);
		const elapsed = Date.now() - start;

		expect(result.done).toBe(false);
		expect(elapsed).toBeLessThan(200);
		const event = (result as { value: unknown }).value as { kind: string; data: { commentId: string } };
		expect(event.kind).toBe("comment_new");
		expect(event.data.commentId).toBe("c-1");

		subscription.close();
	});

	it("scopes events per workspaceId — other workspaces don't see them", async () => {
		const subscriptionA = bus.subscribe("ws-a", {});
		const subscriptionB = bus.subscribe("ws-b", {});
		const iteratorA = subscriptionA[Symbol.asyncIterator]();
		const iteratorB = subscriptionB[Symbol.asyncIterator]();

		const promiseA = iteratorA.next();
		const promiseB = Promise.race([
			iteratorB.next(),
			new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 300)),
		]);

		await publishRealtimeEvent("ws-a", "presence_ping", { userId: "u1" });

		const resultA = await promiseA;
		expect(resultA.done).toBe(false);
		expect((resultA.value as { workspaceId: string }).workspaceId).toBe("ws-a");

		const resultB = await promiseB;
		expect(resultB.done).toBe(true); // workspace B did not receive workspace A's event

		subscriptionA.close();
		subscriptionB.close();
	});

	it("publishes page_set_changed with the exact project payload", async () => {
		const subscription = bus.subscribe("ws-pages", {});
		const iterator = subscription[Symbol.asyncIterator]();
		const nextPromise = iterator.next();

		await publishPageSetChangedEvent("ws-pages", {
			projectId: "project-1",
			changedBy: "user-1",
			pageCount: 7,
		});

		const result = await Promise.race([
			nextPromise,
			new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 1000)),
		]);
		expect(result.done).toBe(false);
		const event = (result as { value: { kind: string; data: Record<string, unknown> } }).value;
		expect(event.kind).toBe("page_set_changed");
		expect(event.data).toEqual({ projectId: "project-1", changedBy: "user-1", pageCount: 7 });
		subscription.close();
	});

	it("Last-Event-ID replay returns events emitted while the client was disconnected", async () => {
		// Publish three events before any subscriber exists.
		const e1 = await bus.publish("ws-replay", { kind: "activity_feed", data: { n: 1 } });
		const e2 = await bus.publish("ws-replay", { kind: "activity_feed", data: { n: 2 } });
		const e3 = await bus.publish("ws-replay", { kind: "activity_feed", data: { n: 3 } });

		// Resume from e1 — replay should yield e2 and e3.
		const subscription = bus.subscribe("ws-replay", { lastEventId: e1.id });
		const iterator = subscription[Symbol.asyncIterator]();

		const r2 = await iterator.next();
		expect(r2.done).toBe(false);
		expect((r2.value as { id: string }).id).toBe(e2.id);

		const r3 = await iterator.next();
		expect(r3.done).toBe(false);
		expect((r3.value as { id: string }).id).toBe(e3.id);

		subscription.close();
	});

	it("subscribing with lastEventId='$' returns no replay (tail mode)", async () => {
		await bus.publish("ws-tail", { kind: "activity_feed", data: {} });
		const subscription = bus.subscribe("ws-tail", { lastEventId: "$" });
		const iterator = subscription[Symbol.asyncIterator]();

		const result = await Promise.race([
			iterator.next(),
			new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 200)),
		]);
		expect(result.done).toBe(true);
		subscription.close();
	});
});

// ── AI SSE error sanitization (Bug1) — no raw provider text on the wire ──────
// The persist layer + GET /api/ai/status/:jobId sanitize AI errors via
// ai-error-sanitizer; the realtime emitter MUST enforce the same allowlist so a
// failed-job SSE event never leaks raw provider/internal text to subscribers.
describe("AI job status SSE error sanitization", () => {
	let bus: ReturnType<typeof createInMemoryRealtimeBus>;

	beforeEach(() => {
		bus = createInMemoryRealtimeBus(50);
		setRealtimeBusForTesting(bus);
		clearWorkspaceLookupCacheForTesting();
	});
	afterEach(() => {
		setRealtimeBusForTesting(null);
		clearWorkspaceLookupCacheForTesting();
	});

	const nextEvent = (sub: ReturnType<typeof bus.subscribe>) => {
		const iterator = sub[Symbol.asyncIterator]();
		return Promise.race([
			iterator.next(),
			new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 1000)),
		]);
	};

	it("a failed-job SSE event carries the SANITIZED category message, NOT the raw key/401 text", async () => {
		seedWorkspaceLookupForTesting("proj-leak", "ws-leak");
		const sub = bus.subscribe("ws-leak", {});
		const pending = nextEvent(sub);

		// Raw provider text that, before the fix, would have been published verbatim.
		const rawLeak = "Incorrect API key provided: sk-proj-DEADBEEF2VAA (request id req_123). 401 Unauthorized";
		await emitAiJobStatusEvent({
			jobId: "job-1",
			projectId: "proj-leak",
			status: "error",
			error: rawLeak,
		});

		const result = await pending;
		expect(result.done).toBe(false);
		const event = (result as { value: { kind: string; data: { status: string; error?: string } } }).value;
		expect(event.kind).toBe("ai_job_status");
		expect(event.data.status).toBe("error");
		// Allowlisted friendly category message — never the raw text/key/401.
		expect(event.data.error).toBe("บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ");
		expect(event.data.error).not.toContain("sk-proj");
		expect(event.data.error).not.toContain("401");
		expect(event.data.error).not.toContain("API key");
		sub.close();
	});

	it("an unrecognised internal error is reduced to the GENERIC fallback, not echoed", async () => {
		seedWorkspaceLookupForTesting("proj-generic", "ws-generic");
		const sub = bus.subscribe("ws-generic", {});
		const pending = nextEvent(sub);

		const rawInternal = "System: You are a manga translator. User: <secret prompt body> :: TypeError at line 42";
		await emitAiJobStatusEvent({
			jobId: "job-2",
			projectId: "proj-generic",
			status: "error",
			error: rawInternal,
		});

		const result = await pending;
		expect(result.done).toBe(false);
		const event = (result as { value: { data: { error?: string } } }).value;
		expect(event.data.error).toBe("เกิดข้อผิดพลาดกับบริการ AI (ดูบันทึกระบบ)");
		expect(event.data.error).not.toContain("System:");
		expect(event.data.error).not.toContain("secret prompt");
		sub.close();
	});

	it("a non-error event (no error field) emits no fabricated error", async () => {
		seedWorkspaceLookupForTesting("proj-ok", "ws-ok");
		const sub = bus.subscribe("ws-ok", {});
		const pending = nextEvent(sub);

		await emitAiJobStatusEvent({
			jobId: "job-3",
			projectId: "proj-ok",
			status: "done",
			resultImageId: "result_job-3.png",
		});

		const result = await pending;
		expect(result.done).toBe(false);
		const event = (result as { value: { data: { status: string; error?: string } } }).value;
		expect(event.data.status).toBe("done");
		expect(event.data.error).toBeUndefined();
		sub.close();
	});
});

// ── a16 re-review P1 #1 — per-user notification routing (no wire leak) ────────
describe("realtime per-user notification channel isolation", () => {
	let bus: ReturnType<typeof createInMemoryRealtimeBus>;

	beforeEach(() => {
		bus = createInMemoryRealtimeBus(50);
		setRealtimeBusForTesting(bus);
	});
	afterEach(() => {
		setRealtimeBusForTesting(null);
	});

	it("userScopedChannel namespaces userId under the workspace and is per-user distinct", () => {
		expect(userScopedChannel("ws-A", "user-1")).toBe("ws-A::u::user-1");
		expect(userScopedChannel("ws-A", "user-1")).not.toBe(userScopedChannel("ws-A", "user-2"));
		// The per-user channel is NOT the bare workspace channel — private payloads
		// never share the workspace fan-out stream.
		expect(userScopedChannel("ws-A", "user-1")).not.toBe("ws-A");
	});

	it("a per-user notification is delivered to the target user ONLY — another member's subscriber gets NOTHING", async () => {
		const wsId = "ws-shared";
		// Two members of the SAME workspace. Each SSE connection subscribes to the
		// workspace channel AND its OWN per-user channel (exactly what the route does).
		const userASubs = [
			bus.subscribe(wsId, {}),
			bus.subscribe(userScopedChannel(wsId, "user-A"), {}),
		];
		const userBSubs = [
			bus.subscribe(wsId, {}),
			bus.subscribe(userScopedChannel(wsId, "user-B"), {}),
		];

		const next = (sub: ReturnType<typeof bus.subscribe>) =>
			Promise.race([
				sub[Symbol.asyncIterator]().next(),
				new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), 300),
				),
			]);

		// Arm reads on EVERY connection before publishing.
		const aWorkspace = next(userASubs[0]!);
		const aPrivate = next(userASubs[1]!);
		const bWorkspace = next(userBSubs[0]!);
		const bPrivate = next(userBSubs[1]!);

		// Dispatch a PRIVATE notification addressed to user-B.
		await publishUserScopedEvent(wsId, "user-B", "notification_new", {
			userId: "user-B",
			notification: { id: "n-1", title: "B's private balance alert" },
		});

		// user-B's per-user channel receives it…
		const bGot = await bPrivate;
		expect(bGot.done).toBe(false);
		const bEvent = (bGot as { value: { kind: string; data: { userId: string } } }).value;
		expect(bEvent.kind).toBe("notification_new");
		expect(bEvent.data.userId).toBe("user-B");

		// …and NOBODY else does. user-A's per-user channel AND both workspace-channel
		// subscriptions must time out with NOTHING — the private frame never rode the
		// shared workspace stream, so user-A can't read it off the wire.
		expect((await aPrivate).done).toBe(true);
		expect((await aWorkspace).done).toBe(true);
		expect((await bWorkspace).done).toBe(true);

		for (const sub of [...userASubs, ...userBSubs]) sub.close();
	});

	it("notify() dispatches a notification_new ONLY to the recipient's per-user channel, not the workspace stream", async () => {
		const wsId = "ws-dispatch";
		// Subscribe BOTH the workspace channel and a foreign member's per-user channel.
		const workspaceSub = bus.subscribe(wsId, {});
		const foreignUserSub = bus.subscribe(userScopedChannel(wsId, "intruder"), {});
		const recipientSub = bus.subscribe(userScopedChannel(wsId, "owner"), {});

		const next = (sub: ReturnType<typeof bus.subscribe>) =>
			Promise.race([
				sub[Symbol.asyncIterator]().next(),
				new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), 300),
				),
			]);

		const onWorkspace = next(workspaceSub);
		const onForeign = next(foreignUserSub);
		const onRecipient = next(recipientSub);

		// Route through the REAL notify() so we exercise the production dispatch path.
		await notify({
			userId: "owner",
			workspaceId: wsId,
			type: "payment_succeeded",
			title: "Your receipt",
			channels: ["in_app"],
		});

		// Only the recipient's per-user channel sees it.
		const got = await onRecipient;
		expect(got.done).toBe(false);
		expect((got as { value: { kind: string } }).value.kind).toBe("notification_new");

		// The shared workspace stream and a foreign member's channel see NOTHING.
		expect((await onWorkspace).done).toBe(true);
		expect((await onForeign).done).toBe(true);

		workspaceSub.close();
		foreignUserSub.close();
		recipientSub.close();
	});
});

describe("POST /api/realtime/token", () => {
	beforeEach(() => {
		setRealtimeBusForTesting(createInMemoryRealtimeBus(50));
	});
	afterEach(() => {
		setRealtimeBusForTesting(null);
	});

	it("rejects unauthenticated requests with 401", async () => {
		const app = buildApp();
		const response = await app.request("/api/realtime/token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1" }),
		});
		expect(response.status).toBe(401);
	});

	it("rejects an invalid body with 400", async () => {
		const app = buildApp();
		const user = await createUser({
			email: uniqueEmail("token-invalid"),
			password: "StrongP@ss123",
			name: "Tok",
		});
		const tokens = await generateTokens((await loadUser(user.user.id))!);
		const response = await app.request("/api/realtime/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${tokens.accessToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(400);
	});

	it("returns a signed SSE token for a member of the requested workspace (file-mode)", async () => {
		const app = buildApp();
		const created = await createUser({
			email: uniqueEmail("token-mint"),
			password: "StrongP@ss123",
			name: "Mint",
		});
		// File-mode auto-provisions a personal workspace for the user on first list;
		// the realtime token route verifies membership against the (now non-null)
		// workspace store, so mint the token for the user's real workspace.
		const workspaces = await workspaceAccessStore.listUserWorkspaces(created.user.id);
		const workspaceId = workspaces[0]!.workspaceId;
		const tokens = await generateTokens((await loadUser(created.user.id))!);
		const response = await app.request("/api/realtime/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${tokens.accessToken}`,
			},
			body: JSON.stringify({ workspaceId }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.token).toBeDefined();
		expect(body.expiresAt).toBeDefined();
		const payload = verifyRealtimeToken(body.token);
		expect(payload?.ws).toBe(workspaceId);
		expect(payload?.sub).toBe(created.user.id);
	});
});

describe("GET /api/realtime/workspaces/:id/events (SSE)", () => {
	beforeEach(() => {
		setRealtimeBusForTesting(createInMemoryRealtimeBus(50));
	});
	afterEach(() => {
		setRealtimeBusForTesting(null);
	});

	it("rejects a missing token with 401", async () => {
		const app = buildApp();
		const response = await app.request("/api/realtime/workspaces/ws-1/events");
		expect(response.status).toBe(401);
	});

	it("rejects an expired token with 401", async () => {
		const app = buildApp();
		const minted = mintRealtimeToken({ userId: "u", workspaceId: "ws-1", ttlSeconds: 1 });
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const response = await app.request(`/api/realtime/workspaces/ws-1/events?token=${minted.token}`);
		expect(response.status).toBe(401);
	});

	it("rejects a workspace mismatch with 403", async () => {
		const app = buildApp();
		const minted = mintRealtimeToken({ userId: "u", workspaceId: "ws-other" });
		const response = await app.request(`/api/realtime/workspaces/ws-1/events?token=${minted.token}`);
		expect(response.status).toBe(403);
	});

	it("returns 200 + text/event-stream for a valid token and streams a published event", async () => {
		const app = buildApp();
		// The SSE connect re-verifies workspace membership against the (file-mode)
		// store, so use a real user + their auto-provisioned workspace.
		const created = await createUser({
			email: uniqueEmail("sse-stream"),
			password: "StrongP@ss123",
			name: "SSE",
		});
		const workspaces = await workspaceAccessStore.listUserWorkspaces(created.user.id);
		const workspaceId = workspaces[0]!.workspaceId;
		const minted = mintRealtimeToken({ userId: created.user.id, workspaceId });
		// Drive the SSE response with a short-lived AbortController so we don't
		// hang the test process on the keepalive timer.
		const controller = new AbortController();
		const responsePromise = app.request(`/api/realtime/workspaces/${workspaceId}/events?token=${minted.token}`, {
			signal: controller.signal,
		});

		const response = await responsePromise;
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		// Read the initial ":connected" comment so we know the stream has flushed.
		const firstChunk = await Promise.race([
			reader.read(),
			new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as unknown as Uint8Array }), 1000)),
		]);
		expect(firstChunk.done ?? false).toBe(false);
		const text = decoder.decode(firstChunk.value!);
		expect(text).toContain(":connected");

		// Publish an event and read the next chunk.
		await publishRealtimeEvent(workspaceId, "activity_feed", { hello: "world" });
		const next = await Promise.race([
			reader.read(),
			new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as unknown as Uint8Array }), 1000)),
		]);
		expect(next.done ?? false).toBe(false);
		const sseFrame = decoder.decode(next.value!);
		expect(sseFrame).toContain("event: activity_feed");
		expect(sseFrame).toContain("hello");

		controller.abort();
		try {
			await reader.cancel();
		} catch {/* socket already closed */}
	});

	it("delivers the connection's OWN per-user notification frame through the merged stream (a16 re-review P1 #1)", async () => {
		const app = buildApp();
		const created = await createUser({
			email: uniqueEmail("sse-own-notif"),
			password: "StrongP@ss123",
			name: "Own",
		});
		const workspaces = await workspaceAccessStore.listUserWorkspaces(created.user.id);
		const workspaceId = workspaces[0]!.workspaceId;
		const minted = mintRealtimeToken({ userId: created.user.id, workspaceId });

		const controller = new AbortController();
		const response = await app.request(`/api/realtime/workspaces/${workspaceId}/events?token=${minted.token}`, {
			signal: controller.signal,
		});
		expect(response.status).toBe(200);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		// Drain the initial ":connected" comment.
		await reader.read();

		// Publish a PRIVATE notification to THIS user's per-user channel.
		await publishUserScopedEvent(workspaceId, created.user.id, "notification_new", {
			userId: created.user.id,
			notification: { id: "own-1", title: "your own notification" },
		});

		const next = await Promise.race([
			reader.read(),
			new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as unknown as Uint8Array }), 1000)),
		]);
		expect(next.done ?? false).toBe(false);
		const frame = decoder.decode(next.value!);
		// The merged stream delivers the user's own per-user notification frame.
		expect(frame).toContain("event: notification_new");
		expect(frame).toContain("own-1");

		controller.abort();
		try { await reader.cancel(); } catch {/* closed */}
	});
});

describe("realtime config readers", () => {
	const originalKeepalive = process.env.SSE_KEEPALIVE_SEC;
	const originalIdle = process.env.SSE_IDLE_TIMEOUT_SEC;
	const originalTtl = process.env.SSE_TOKEN_TTL_SEC;
	const originalMaxLen = process.env.SSE_REPLAY_STREAM_LEN;

	afterEach(() => {
		process.env.SSE_KEEPALIVE_SEC = originalKeepalive;
		process.env.SSE_IDLE_TIMEOUT_SEC = originalIdle;
		process.env.SSE_TOKEN_TTL_SEC = originalTtl;
		process.env.SSE_REPLAY_STREAM_LEN = originalMaxLen;
	});

	it("returns defaults when env vars are unset", () => {
		delete process.env.SSE_KEEPALIVE_SEC;
		delete process.env.SSE_IDLE_TIMEOUT_SEC;
		delete process.env.SSE_TOKEN_TTL_SEC;
		delete process.env.SSE_REPLAY_STREAM_LEN;
		expect(readSseKeepaliveSec()).toBe(30);
		expect(readSseIdleTimeoutSec()).toBe(600);
		expect(readSseTokenTtlSec()).toBe(60);
		expect(readRealtimeStreamMaxLen()).toBe(1000);
	});

	it("parses positive integer overrides", () => {
		process.env.SSE_KEEPALIVE_SEC = "15";
		process.env.SSE_IDLE_TIMEOUT_SEC = "900";
		process.env.SSE_TOKEN_TTL_SEC = "120";
		process.env.SSE_REPLAY_STREAM_LEN = "500";
		expect(readSseKeepaliveSec()).toBe(15);
		expect(readSseIdleTimeoutSec()).toBe(900);
		expect(readSseTokenTtlSec()).toBe(120);
		expect(readRealtimeStreamMaxLen()).toBe(500);
	});

	it("falls back to defaults on garbage overrides", () => {
		process.env.SSE_KEEPALIVE_SEC = "0";
		process.env.SSE_IDLE_TIMEOUT_SEC = "abc";
		process.env.SSE_TOKEN_TTL_SEC = "-5";
		process.env.SSE_REPLAY_STREAM_LEN = "0";
		expect(readSseKeepaliveSec()).toBe(30);
		expect(readSseIdleTimeoutSec()).toBe(600);
		expect(readSseTokenTtlSec()).toBe(60);
		expect(readRealtimeStreamMaxLen()).toBe(1000);
	});
});

describe("isRealtimeEventKind", () => {
	it("accepts the documented kinds", () => {
		for (const kind of [
			"activity_feed",
			"ai_job_status",
			"comment_new",
			"lock_acquired",
			"lock_released",
			"page_set_changed",
			"workflow_transition",
			"presence_ping",
		]) {
			expect(isRealtimeEventKind(kind)).toBe(true);
		}
	});

	it("rejects everything else", () => {
		expect(isRealtimeEventKind("garbage")).toBe(false);
		expect(isRealtimeEventKind(null)).toBe(false);
		expect(isRealtimeEventKind(undefined)).toBe(false);
		expect(isRealtimeEventKind(42)).toBe(false);
	});
});

describe("SSE token redaction for observability", () => {
	it("redacts the SSE ?token= from a full URL", () => {
		const minted = mintRealtimeToken({ userId: "u", workspaceId: "ws-1" });
		const url = `https://api.example.com/api/realtime/workspaces/ws-1/events?token=${minted.token}&lastEventId=12-0`;
		const safe = redactSensitiveUrl(url);
		expect(safe).not.toContain(minted.token);
		expect(safe).toContain("token=%5Bredacted%5D");
		// lastEventId is also scrubbed (cursor, not secret, but treated as sensitive list)
		expect(safe).not.toContain("12-0");
	});

	it("leaves non-sensitive URLs untouched", () => {
		const url = "https://api.example.com/api/project/abc?page=2";
		expect(redactSensitiveUrl(url)).toBe(url);
	});

	it("redacts tokens from a relative/malformed URL via regex fallback", () => {
		const safe = redactSensitiveUrl("/api/realtime/workspaces/ws/events?token=secret-abc&x=1");
		expect(safe).not.toContain("secret-abc");
		expect(safe).toContain("token=[redacted]");
		expect(safe).toContain("x=1");
	});

	it("redacts sensitive query map values", () => {
		const safe = redactSensitiveQuery({ token: "secret", page: "1" });
		expect(safe.token).toBe("[redacted]");
		expect(safe.page).toBe("1");
	});

	it("strips credential headers including x-realtime-token", () => {
		const safe = redactSensitiveHeaders({
			Authorization: "Bearer x",
			"X-Realtime-Token": "secret-token",
			"content-type": "application/json",
		});
		expect(safe["X-Realtime-Token"]).toBeUndefined();
		expect(safe["Authorization"]).toBeUndefined();
		expect(safe["content-type"]).toBe("application/json");
	});
});

// ── P1 fixes: bounded queues, token-expiry/revocation cutoff, debug lockdown ──

describe("realtime-bus slow-consumer caps", () => {
	const originalMaxQueue = process.env.SSE_SUBSCRIBER_MAX_QUEUE;
	const originalMaxBytes = process.env.SSE_SUBSCRIBER_MAX_BYTES;

	afterEach(() => {
		process.env.SSE_SUBSCRIBER_MAX_QUEUE = originalMaxQueue;
		process.env.SSE_SUBSCRIBER_MAX_BYTES = originalMaxBytes;
		setRealtimeBusForTesting(null);
	});

	it("reads count + byte caps with sane defaults and overrides", () => {
		delete process.env.SSE_SUBSCRIBER_MAX_QUEUE;
		delete process.env.SSE_SUBSCRIBER_MAX_BYTES;
		expect(readSseSubscriberMaxQueue()).toBe(1000);
		expect(readSseSubscriberMaxBytes()).toBe(8 * 1024 * 1024);
		process.env.SSE_SUBSCRIBER_MAX_QUEUE = "5";
		process.env.SSE_SUBSCRIBER_MAX_BYTES = "4096";
		expect(readSseSubscriberMaxQueue()).toBe(5);
		expect(readSseSubscriberMaxBytes()).toBe(4096);
	});

	it("force-closes a slow subscriber once its queue exceeds the count cap (no unbounded growth)", async () => {
		// Tiny cap so a non-draining subscriber overflows after a few publishes.
		process.env.SSE_SUBSCRIBER_MAX_QUEUE = "3";
		delete process.env.SSE_SUBSCRIBER_MAX_BYTES;
		const bus = createInMemoryRealtimeBus(100);
		setRealtimeBusForTesting(bus);

		// Subscribe but DON'T drain the iterator → events buffer in the queue.
		const subscription = bus.subscribe("ws-slow", {});

		for (let i = 0; i < 10; i += 1) {
			await publishRealtimeEvent("ws-slow", "activity_feed", { n: i });
		}

		// Overflow must be flagged and the subscription closed — the buffer cannot
		// have grown to hold all 10 events.
		expect(subscription.overflowReason).toBe("slow_consumer");

		// The iterator ends immediately rather than draining the over-cap backlog.
		const iterator = subscription[Symbol.asyncIterator]();
		const result = await iterator.next();
		expect(result.done).toBe(true);

		subscription.close();
	});

	it("a draining subscriber is never flagged as slow", async () => {
		process.env.SSE_SUBSCRIBER_MAX_QUEUE = "3";
		const bus = createInMemoryRealtimeBus(100);
		setRealtimeBusForTesting(bus);

		const subscription = bus.subscribe("ws-fast", {});
		const iterator = subscription[Symbol.asyncIterator]();

		// Publish + immediately drain each event so the queue never grows past 1.
		for (let i = 0; i < 10; i += 1) {
			const nextPromise = iterator.next();
			await publishRealtimeEvent("ws-fast", "activity_feed", { n: i });
			const r = await nextPromise;
			expect(r.done).toBe(false);
		}
		expect(subscription.overflowReason).toBeNull();
		subscription.close();
	});
});

describe("GET SSE token-expiry / revocation cutoff", () => {
	beforeEach(() => {
		setRealtimeBusForTesting(createInMemoryRealtimeBus(50));
	});
	afterEach(() => {
		setRealtimeBusForTesting(null);
	});

	it("ends the stream no later than the token exp (idle window capped to TTL)", async () => {
		const app = buildApp();
		const created = await createUser({
			email: uniqueEmail("sse-exp"),
			password: "StrongP@ss123",
			name: "Exp",
		});
		const workspaces = await workspaceAccessStore.listUserWorkspaces(created.user.id);
		const workspaceId = workspaces[0]!.workspaceId;
		// 2s token → the idle window is capped to ~2s, so the server emits a
		// server_idle_timeout and ends the stream well before the default 600s.
		const minted = mintRealtimeToken({ userId: created.user.id, workspaceId, ttlSeconds: 2 });

		const controller = new AbortController();
		const response = await app.request(`/api/realtime/workspaces/${workspaceId}/events?token=${minted.token}`, {
			signal: controller.signal,
		});
		expect(response.status).toBe(200);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let sawIdleTimeout = false;
		const deadline = Date.now() + 5000;
		try {
			while (Date.now() < deadline) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as unknown as Uint8Array }), 4000)),
				]);
				if (chunk.done) break;
				const text = decoder.decode(chunk.value!);
				if (text.includes("server_idle_timeout")) {
					sawIdleTimeout = true;
					break;
				}
			}
		} finally {
			controller.abort();
			try { await reader.cancel(); } catch {/* closed */}
		}
		// The token's 2s exp capped the idle window, so the stream self-terminated.
		expect(sawIdleTimeout).toBe(true);
	}, 10_000);
});

describe("POST /api/realtime/.../debug/publish lockdown", () => {
	const originalEnabled = process.env.SSE_DEBUG_PUBLISH_ENABLED;
	beforeEach(() => {
		setRealtimeBusForTesting(createInMemoryRealtimeBus(50));
	});
	afterEach(() => {
		process.env.SSE_DEBUG_PUBLISH_ENABLED = originalEnabled;
		setRealtimeBusForTesting(null);
	});

	async function memberContext(label: string): Promise<{ token: string; workspaceId: string; userId: string }> {
		const created = await createUser({ email: uniqueEmail(label), password: "StrongP@ss123", name: label });
		const workspaces = await workspaceAccessStore.listUserWorkspaces(created.user.id);
		const workspaceId = workspaces[0]!.workspaceId;
		const tokens = await generateTokens((await loadUser(created.user.id))!);
		return { token: tokens.accessToken, workspaceId, userId: created.user.id };
	}

	it("is hard-disabled (404) unless SSE_DEBUG_PUBLISH_ENABLED=true", async () => {
		delete process.env.SSE_DEBUG_PUBLISH_ENABLED;
		const app = buildApp();
		const ctx = await memberContext("debug-disabled");
		const response = await app.request(`/api/realtime/workspaces/${ctx.workspaceId}/debug/publish`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
			body: JSON.stringify({ kind: "lock_acquired", data: { lockId: "l1", scope: "page", scopeId: "p1" } }),
		});
		expect(response.status).toBe(404);
	});

	it("rejects a non-platform-admin member with 403 even when enabled", async () => {
		process.env.SSE_DEBUG_PUBLISH_ENABLED = "true";
		const app = buildApp();
		// A freshly created user is a workspace owner but an ordinary platform role
		// (editor/viewer), not a platform admin — so debug publish is forbidden.
		const ctx = await memberContext("debug-nonadmin");
		const response = await app.request(`/api/realtime/workspaces/${ctx.workspaceId}/debug/publish`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
			body: JSON.stringify({ kind: "lock_acquired", data: { lockId: "l1", scope: "page", scopeId: "p1" } }),
		});
		expect(response.status).toBe(403);
		const body = await response.json();
		expect(body.code).toBe("platform_admin_required");
	});

	it("rejects an invalid per-kind payload with 400 (no arbitrary data) for an admin", async () => {
		process.env.SSE_DEBUG_PUBLISH_ENABLED = "true";
		const app = buildApp();
		const created = await createUser({ email: uniqueEmail("debug-admin-bad"), password: "StrongP@ss123", name: "Admin" });
		// Promote to platform admin (stored role — authMiddleware reads the loaded
		// user, not the JWT) so we exercise the payload validation, not the role gate.
		await updateUser(created.user.id, { role: "admin" });
		const tokens = await generateTokens((await loadUser(created.user.id))!);
		const workspaces = await workspaceAccessStore.listUserWorkspaces(created.user.id);
		const workspaceId = workspaces[0]!.workspaceId;
		// lock_acquired requires lockId/scope/scopeId — omit them → 400.
		const response = await app.request(`/api/realtime/workspaces/${workspaceId}/debug/publish`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.accessToken}` },
			body: JSON.stringify({ kind: "lock_acquired", data: { unexpected: true } }),
		});
		expect(response.status).toBe(400);
	});
});

describe("in-memory bus state hygiene", () => {
	const ENV_KEY = "REALTIME_MAX_STREAM_BUFFERS";
	let savedCap: string | undefined;

	beforeEach(() => {
		savedCap = process.env[ENV_KEY];
	});

	afterEach(() => {
		if (savedCap === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = savedCap;
	});

	it("drops the listeners map entry when the last subscriber closes", async () => {
		const bus = createInMemoryRealtimeBus(10);
		const sub = bus.subscribe("ws-hygiene-1", {});
		const listeners = (bus as unknown as { listeners: Map<string, Set<unknown>> }).listeners;
		expect(listeners.has("ws-hygiene-1")).toBe(true);
		sub.close();
		expect(listeners.has("ws-hygiene-1")).toBe(false);
	});

	it("evicts the stalest listener-free stream buffers past the cap", async () => {
		process.env[ENV_KEY] = "3";
		const bus = createInMemoryRealtimeBus(10);
		for (const ws of ["ws-a", "ws-b", "ws-c", "ws-d", "ws-e"]) {
			await bus.publish(ws, { kind: "presence_ping", data: {} });
		}
		const streams = (bus as unknown as { streams: Map<string, unknown[]> }).streams;
		expect(streams.size).toBe(3);
		// Oldest (ws-a, ws-b) evicted; the three most recently published survive.
		expect([...streams.keys()]).toEqual(["ws-c", "ws-d", "ws-e"]);
	});

	it("re-runs eviction when a closing subscriber unpins buffers", async () => {
		process.env[ENV_KEY] = "1";
		const bus = createInMemoryRealtimeBus(10);
		const subA = bus.subscribe("ws-pin-a", {});
		const subB = bus.subscribe("ws-pin-b", {});
		await bus.publish("ws-pin-a", { kind: "presence_ping", data: {} });
		await bus.publish("ws-pin-b", { kind: "presence_ping", data: {} });
		const streams = (bus as unknown as { streams: Map<string, unknown[]> }).streams;
		// Both pinned by live subscribers: publish-time eviction must skip both.
		expect(streams.size).toBe(2);
		// Closing B unpins its buffer; the close path must sweep immediately —
		// no future publish is required to get back under the cap.
		subB.close();
		expect(streams.size).toBe(1);
		expect(streams.has("ws-pin-a")).toBe(true);
		subA.close();
	});

	it("never evicts a buffer whose workspace has a live subscriber", async () => {
		process.env[ENV_KEY] = "2";
		const bus = createInMemoryRealtimeBus(10);
		const sub = bus.subscribe("ws-live", {});
		await bus.publish("ws-live", { kind: "presence_ping", data: {} });
		await bus.publish("ws-cold-1", { kind: "presence_ping", data: {} });
		await bus.publish("ws-cold-2", { kind: "presence_ping", data: {} });
		await bus.publish("ws-cold-3", { kind: "presence_ping", data: {} });
		const streams = (bus as unknown as { streams: Map<string, unknown[]> }).streams;
		// ws-live is stalest but pinned by its live subscriber; cold buffers churn.
		expect(streams.has("ws-live")).toBe(true);
		expect(streams.size).toBe(2);
		sub.close();
	});
});

// Suppress unused import warnings in test compilation.
void authMiddleware;
void getRealtimeBus;
