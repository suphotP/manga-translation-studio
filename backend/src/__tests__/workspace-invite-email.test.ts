process.env.RATE_LIMIT_API_PER_MINUTE ||= "100000";
process.env.RATE_LIMIT_API_PER_HOUR ||= "1000000";
process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE ||= "1000";
process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE ||= "10000";
process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR ||= "10000";

const originalAppUrl = process.env.APP_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } from "../services/auth.service.js";
import { authUserStore } from "../services/auth-users.js";
import type { SendResult } from "../services/mailer.js";
import type { NotifyInput, NotifyResult } from "../services/notification-dispatch.js";
import {
	workspaceAccessStore,
	type CreatedWorkspaceInvite,
	type WorkspaceMemberRecord,
	type WorkspaceRecord,
	type WorkspaceRole,
	type WorkspaceScope,
} from "../services/workspace-access.js";
import type { User } from "../types/auth.js";

type WorkspacesRouteModule = typeof import("../routes/workspaces.js");

let app: Hono;
let setWorkspaceInviteEmailSenderForTesting: WorkspacesRouteModule["setWorkspaceInviteEmailSenderForTesting"];
let setWorkspaceInviteNotifierForTesting: WorkspacesRouteModule["setWorkspaceInviteNotifierForTesting"];

const createdUserIds: string[] = [];
const sentEmails: Array<{ template: string; data: any; locale: string; options: any }> = [];
const notifyCalls: NotifyInput[] = [];
const store = workspaceAccessStore!;
const nowIso = "2026-06-12T08:00:00.000Z";

let restoreStoreDoubles: () => void = () => undefined;
let restoreAuthLookup: () => void = () => undefined;

beforeAll(async () => {
	const routes = await import("../routes/workspaces.js");
	setWorkspaceInviteEmailSenderForTesting = routes.setWorkspaceInviteEmailSenderForTesting;
	setWorkspaceInviteNotifierForTesting = routes.setWorkspaceInviteNotifierForTesting;
	app = (await import("../index.js")).app as unknown as Hono;
});

beforeEach(() => {
	process.env.APP_URL = "https://workspace.example.test";
});

afterEach(() => {
	restoreStoreDoubles();
	restoreStoreDoubles = () => undefined;
	restoreAuthLookup();
	restoreAuthLookup = () => undefined;
	setWorkspaceInviteEmailSenderForTesting();
	setWorkspaceInviteNotifierForTesting();
	sentEmails.length = 0;
	notifyCalls.length = 0;
	if (originalAppUrl === undefined) {
		delete process.env.APP_URL;
	} else {
		process.env.APP_URL = originalAppUrl;
	}
});

afterAll(async () => {
	for (const userId of createdUserIds.splice(0)) {
		await deleteUser(userId).catch(() => undefined);
	}
});

function sendResult(overrides: Partial<SendResult> = {}): SendResult {
	return {
		success: true,
		// A REAL provider: the null mailer's "success" is log-and-skip and must
		// surface as inviteEmailSendFailed (covered by its own test below).
		provider: "resend",
		status: "sent",
		messageId: "test-email",
		retryable: false,
		...overrides,
	};
}

function recordingEmailSender(result: SendResult = sendResult()): Parameters<typeof setWorkspaceInviteEmailSenderForTesting>[0] {
	return (async (template: string, data: unknown, locale = "en", options: unknown) => {
		sentEmails.push({ template, data, locale, options });
		return result;
	}) as never;
}

function throwingEmailSender(): Parameters<typeof setWorkspaceInviteEmailSenderForTesting>[0] {
	return (async () => {
		throw new Error("mailer exploded");
	}) as never;
}

function recordingNotifier(): Parameters<typeof setWorkspaceInviteNotifierForTesting>[0] {
	return (async (input: NotifyInput): Promise<NotifyResult> => {
		notifyCalls.push(input);
		return { inAppDelivered: true, emailAttempted: false, skipped: [] };
	}) as never;
}

async function makeVerifiedUser(prefix: string): Promise<{ id: string; email: string; name: string; token: string }> {
	const name = `${prefix} User`;
	const created = await createUser({
		email: `${prefix}-${crypto.randomUUID()}@example.com`,
		password: "StrongP@ss123",
		name,
	});
	createdUserIds.push(created.user.id);
	await markEmailVerified(created.user.id);
	const user = await loadUser(created.user.id);
	const tokens = await generateTokens(user!);
	return { id: user!.id, email: user!.email, name: user!.name, token: tokens.accessToken };
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function workspaceRecord(workspaceId: string): WorkspaceRecord {
	return {
		workspaceId,
		name: "Moon Studio",
		planId: "creator",
		storageIncludedBytes: 0,
		storageExtraBytes: 0,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
}

function memberRecord(workspaceId: string, userId: string): WorkspaceMemberRecord {
	return {
		workspaceId,
		userId,
		role: "owner",
		memberStudioRole: "owner",
		scope: {},
		createdAt: nowIso,
		updatedAt: nowIso,
	};
}

function installWorkspaceStoreDoubles(options: {
	inviteId?: string;
	inviteToken?: string;
	expiresAt?: string;
} = {}): { createInviteInputs: Array<{ email: string; role: WorkspaceRole; scope?: WorkspaceScope; ttlSeconds?: number }> } {
	const createInviteInputs: Array<{ email: string; role: WorkspaceRole; scope?: WorkspaceScope; ttlSeconds?: number }> = [];
	const originalRequirePermission = store.requirePermission;
	const originalCreateInvite = store.createInvite;
	const originalGetWorkspace = store.getWorkspace;

	(store as typeof store & { requirePermission: typeof store.requirePermission }).requirePermission = async (
		workspaceId: string,
		userId: string,
	) => memberRecord(workspaceId, userId);
	(store as typeof store & { getWorkspace: typeof store.getWorkspace }).getWorkspace = async (workspaceId: string) => workspaceRecord(workspaceId);
	(store as typeof store & { createInvite: typeof store.createInvite }).createInvite = async (input) => {
		createInviteInputs.push({
			email: input.email,
			role: input.role,
			scope: input.scope,
			ttlSeconds: input.ttlSeconds,
		});
		const invite: CreatedWorkspaceInvite = {
			inviteId: options.inviteId ?? "inv-email-1",
			workspaceId: input.workspaceId,
			email: input.email.trim().toLowerCase(),
			role: input.role,
			scope: input.scope ?? {},
			status: "pending",
			invitedByUserId: input.invitedByUserId,
			expiresAt: options.expiresAt ?? "2026-06-19T08:00:00.000Z",
			createdAt: nowIso,
			updatedAt: nowIso,
			inviteToken: options.inviteToken ?? "plain-token-123",
		};
		return invite;
	};

	restoreStoreDoubles = () => {
		(store as typeof store & { requirePermission: typeof store.requirePermission }).requirePermission = originalRequirePermission;
		(store as typeof store & { createInvite: typeof store.createInvite }).createInvite = originalCreateInvite;
		(store as typeof store & { getWorkspace: typeof store.getWorkspace }).getWorkspace = originalGetWorkspace;
	};
	return { createInviteInputs };
}

function installInviteeLookup(invitee: User | null): void {
	const originalFindByEmail = authUserStore.findByEmail;
	(authUserStore as typeof authUserStore & { findByEmail: typeof authUserStore.findByEmail }).findByEmail = async () => invitee;
	restoreAuthLookup = () => {
		(authUserStore as typeof authUserStore & { findByEmail: typeof authUserStore.findByEmail }).findByEmail = originalFindByEmail;
	};
}

async function postInvite(token: string, email: string): Promise<Response> {
	return app.request("/api/workspaces/ws-mail/invites", {
		method: "POST",
		headers: authHeaders(token),
		body: JSON.stringify({ email, role: "editor" }),
	});
}

describe("POST /api/workspaces/:workspaceId/invites email dispatch", () => {
	test("the null mailer reports inviteEmailSendFailed (log-and-skip is not delivery)", async () => {
		const owner = await makeVerifiedUser("owner-nullmail");
		installWorkspaceStoreDoubles();
		installInviteeLookup(null);
		setWorkspaceInviteEmailSenderForTesting((async () => sendResult({ provider: "null" })) as never);
		setWorkspaceInviteNotifierForTesting(recordingNotifier());
		const response = await postInvite(owner.token, "nullmail@example.com");
		expect(response.status).toBe(201);
		const body = await response.json() as { inviteEmailSendFailed: boolean };
		// Send "succeeded" but nothing will arrive → the panel must keep the
		// manual copy-link flow primary (review #589 r2).
		expect(body.inviteEmailSendFailed).toBe(true);
	});

	test("sends the workspace-invite email to the invited address with the one-time accept link", async () => {
		const owner = await makeVerifiedUser("owner-mail");
		const { createInviteInputs } = installWorkspaceStoreDoubles();
		installInviteeLookup(null);
		setWorkspaceInviteEmailSenderForTesting(recordingEmailSender());
		setWorkspaceInviteNotifierForTesting(recordingNotifier());

		const response = await postInvite(owner.token, "Invitee+One@Example.com");
		expect(response.status).toBe(201);
		const body = await response.json();

		expect(body.inviteEmailSendFailed).toBe(false);
		expect(body.invite.inviteId).toBe("inv-email-1");
		expect(createInviteInputs[0]?.email).toBe("Invitee+One@Example.com");
		expect(sentEmails).toHaveLength(1);
		expect(sentEmails[0]?.template).toBe("workspace-invite");
		expect(sentEmails[0]?.locale).toBe("en");
		expect(sentEmails[0]?.data.invitee).toEqual({ name: "invitee+one@example.com", email: "invitee+one@example.com" });
		expect(sentEmails[0]?.data.workspaceName).toBe("Moon Studio");
		expect(sentEmails[0]?.data.inviterName).toBe(owner.name);
		expect(sentEmails[0]?.data.acceptUrl).toBe("https://workspace.example.test/invite/inv-email-1?token=plain-token-123");
		expect(sentEmails[0]?.options.idempotencyKey).toBe("workspace-invite:inv-email-1");
		expect(notifyCalls).toHaveLength(0);
	});

	test("keeps the create response at 201 and flags inviteEmailSendFailed when the mailer throws", async () => {
		const owner = await makeVerifiedUser("owner-fail");
		installWorkspaceStoreDoubles();
		installInviteeLookup(null);
		setWorkspaceInviteEmailSenderForTesting(throwingEmailSender());
		setWorkspaceInviteNotifierForTesting(recordingNotifier());

		const response = await postInvite(owner.token, "broken-mail@example.com");
		expect(response.status).toBe(201);
		const body = await response.json();

		expect(body.invite.inviteId).toBe("inv-email-1");
		expect(body.inviteEmailSendFailed).toBe(true);
		expect(notifyCalls).toHaveLength(0);
	});

	test("sends an in-app invite notification for an existing account without exposing account existence or persisting the token", async () => {
		const owner = await makeVerifiedUser("owner-notify");
		const invitee = await makeVerifiedUser("invitee-notify");
		const inviteeUser = await loadUser(invitee.id);
		installWorkspaceStoreDoubles({ inviteToken: "notify-token-secret" });
		installInviteeLookup(inviteeUser);
		setWorkspaceInviteEmailSenderForTesting(recordingEmailSender());
		setWorkspaceInviteNotifierForTesting(recordingNotifier());

		const response = await postInvite(owner.token, invitee.email);
		expect(response.status).toBe(201);
		const body = await response.json();

		expect(body.inviteEmailSendFailed).toBe(false);
		expect(JSON.stringify(body)).not.toContain(invitee.id);
		expect(sentEmails[0]?.data.acceptUrl).toBe("https://workspace.example.test/invite/inv-email-1?token=notify-token-secret");
		expect(sentEmails[0]?.data.invitee).toEqual({ name: invitee.name, email: invitee.email });
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0]).toMatchObject({
			userId: invitee.id,
			type: "invite_received",
			channels: ["in_app"],
			inAppDedupeKey: "workspace-invite:inv-email-1:in-app",
			// workspace travels in metadata only: a top-level workspaceId would be
			// membership-filtered away from the PENDING invitee (review #589 r2).
			metadata: expect.objectContaining({ workspaceId: "ws-mail" }),
		});
		expect((notifyCalls[0] as { workspaceId?: string }).workspaceId).toBeUndefined();
		expect(JSON.stringify(notifyCalls[0])).not.toContain("notify-token-secret");
	});
});
