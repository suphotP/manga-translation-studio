import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { app } from "../index.js";
import { createUser, deleteUser, generateTokens } from "../services/auth.service.js";
import { creditService } from "../services/credits.js";
import { gdprStore } from "../services/gdpr.js";

const runId = randomUUID();
let adminUserId: string;
let authHeaders: Record<string, string>;

beforeAll(async () => {
	const { user } = await createUser({
		email: `credits-route-admin-${runId}@example.com`,
		password: "StrongP@ss123",
		name: "Credits Route Admin",
		role: "admin",
	});
	adminUserId = user.id;
	const tokens = await generateTokens(user);
	authHeaders = {
		"Authorization": `Bearer ${tokens.accessToken}`,
		"Content-Type": "application/json",
	};
});

afterAll(async () => {
	if (adminUserId) await deleteUser(adminUserId).catch(() => undefined);
});

function grantBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const workspaceId = `ws-credits-route-${runId}`;
	return {
		workspaceId,
		ownerScope: "workspace",
		ownerId: workspaceId,
		creditClass: "shareable",
		amount: 100,
		source: "goodwill",
		reason: "admin goodwill adjustment",
		idempotencyKey: `credits-route-${runId}`,
		...overrides,
	};
}

async function postGrant(body: Record<string, unknown>): Promise<Response> {
	return app.request("/api/credits/grant", {
		method: "POST",
		headers: authHeaders,
		body: JSON.stringify(body),
	});
}

describe("/api/credits/grant hardening", () => {
	test("missing idempotencyKey returns 400", async () => {
		const body = grantBody({
			workspaceId: `ws-missing-key-${runId}`,
			ownerId: `ws-missing-key-${runId}`,
		});
		delete body.idempotencyKey;

		const res = await postGrant(body);

		expect(res.status).toBe(400);
		const out = await res.json() as { details: string[] };
		expect(out.details.some((detail) => detail.includes("idempotencyKey"))).toBe(true);
	});

	test("double-submit with the same key mints once and leaves balance unchanged on retry", async () => {
		const workspaceId = `ws-double-submit-${runId}`;
		const body = grantBody({
			workspaceId,
			ownerId: workspaceId,
			amount: 250,
			idempotencyKey: `double-submit-${runId}`,
		});

		const first = await postGrant(body);
		const second = await postGrant(body);

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		const firstGrant = (await first.json() as { grant: { id: string; amount: number } }).grant;
		const secondGrant = (await second.json() as { grant: { id: string; amount: number } }).grant;
		expect(secondGrant.id).toBe(firstGrant.id);
		expect(firstGrant.amount).toBe(250);
		expect(creditService.getBalance("workspace", workspaceId).shareable).toBe(250);
	});

	test("over-cap and non-integer amounts return 400", async () => {
		const previousCap = process.env.CREDITS_GRANT_MAX;
		process.env.CREDITS_GRANT_MAX = "50";
		try {
			const overCap = await postGrant(grantBody({
				workspaceId: `ws-over-cap-${runId}`,
				ownerId: `ws-over-cap-${runId}`,
				amount: 51,
				idempotencyKey: `over-cap-${runId}`,
			}));
			expect(overCap.status).toBe(400);
			const overCapOut = await overCap.json() as { details: string[] };
			expect(overCapOut.details.some((detail) => detail.includes("less than or equal to 50"))).toBe(true);
		} finally {
			if (previousCap === undefined) {
				delete process.env.CREDITS_GRANT_MAX;
			} else {
				process.env.CREDITS_GRANT_MAX = previousCap;
			}
		}

		const nonInteger = await postGrant(grantBody({
			workspaceId: `ws-non-integer-${runId}`,
			ownerId: `ws-non-integer-${runId}`,
			amount: 1.5,
			idempotencyKey: `non-integer-${runId}`,
		}));
		expect(nonInteger.status).toBe(400);
		const nonIntegerOut = await nonInteger.json() as { details: string[] };
		expect(nonIntegerOut.details.some((detail) => detail.includes("positive integer"))).toBe(true);
	});

	test("successful admin grant writes an audit row with actor, target, amount, and reason", async () => {
		const workspaceId = `ws-audit-${runId}`;
		const reason = `audit proof ${runId}`;
		const idempotencyKey = `audit-${runId}`;
		const res = await postGrant(grantBody({
			workspaceId,
			ownerId: workspaceId,
			amount: 125,
			reason,
			idempotencyKey,
		}));

		expect(res.status).toBe(201);
		const { entries } = await gdprStore.listAdminAudit({
			action: "admin.credits.grant",
			targetKind: "workspace",
			targetId: workspaceId,
			limit: 20,
		});
		const audit = entries.find((entry) => entry.detail.idempotencyKey === idempotencyKey);
		expect(audit).toBeDefined();
		expect(audit).toMatchObject({
			adminUserId,
			actorRole: "admin",
			targetKind: "workspace",
			targetId: workspaceId,
		});
		expect(audit?.detail).toMatchObject({
			workspaceId,
			amount: 125,
			reason,
			idempotencyKey,
		});
	});
});
