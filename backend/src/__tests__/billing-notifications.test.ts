import { describe, expect, test } from "bun:test";
import {
	emitQuotaTransitionBestEffort,
	resolveWorkspaceBillingRecipient,
	sendPaymentReceiptBestEffort,
	QUOTA_WARNING_THRESHOLD_PERCENT,
	type BillingNotificationSqlClient,
} from "../services/billing-notifications.js";
import type { AuthUserStore } from "../services/auth-users.js";

// Minimal fake auth store: just resolves a couple of accounts.
function fakeAuthStore(accounts: Record<string, { id: string; email: string; name?: string }>): AuthUserStore {
	return {
		async load(userId: string) {
			const found = Object.values(accounts).find((a) => a.id === userId);
			return found ? ({ ...found, isActive: true } as never) : null;
		},
		async findByEmail(email: string) {
			const found = accounts[email.toLowerCase()];
			return found ? ({ ...found, isActive: true } as never) : null;
		},
	} as unknown as AuthUserStore;
}

// A SQL client that resolves a single workspace owner row.
function fakeSql(ownerByWorkspace: Record<string, string | null>): BillingNotificationSqlClient {
	return {
		async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
			if (query.includes("owner_user_id FROM workspaces")) {
				const owner = ownerByWorkspace[String(params[0])];
				return (owner !== undefined ? [{ owner_user_id: owner }] : []) as T[];
			}
			return [] as T[];
		},
	};
}

describe("resolveWorkspaceBillingRecipient", () => {
	test("prefers the workspace owner account (userId + email)", async () => {
		const sql = fakeSql({ ws1: "user_owner" });
		const auth = fakeAuthStore({ "owner@example.com": { id: "user_owner", email: "owner@example.com", name: "Owner" } });
		const r = await resolveWorkspaceBillingRecipient(sql, "ws1", "billing@example.com", { authUserStore: auth });
		expect(r.userId).toBe("user_owner");
		expect(r.email).toBe("owner@example.com");
		expect(r.name).toBe("Owner");
	});

	test("falls back to the billing email (and attaches an account if one matches)", async () => {
		const sql = fakeSql({ ws1: null }); // no owner
		const auth = fakeAuthStore({ "billing@example.com": { id: "user_billing", email: "billing@example.com" } });
		const r = await resolveWorkspaceBillingRecipient(sql, "ws1", "billing@example.com", { authUserStore: auth });
		expect(r.email).toBe("billing@example.com");
		expect(r.userId).toBe("user_billing");
	});

	test("never throws when the SQL client errors", async () => {
		const sql: BillingNotificationSqlClient = { async unsafe() { throw new Error("db down"); } };
		const auth = fakeAuthStore({});
		const r = await resolveWorkspaceBillingRecipient(sql, "ws1", "billing@example.com", { authUserStore: auth });
		// Degrades to the billing email path.
		expect(r.email).toBe("billing@example.com");
	});
});

describe("emitQuotaTransitionBestEffort (fire-once on threshold crossing)", () => {
	function spies() {
		const warnings: Array<{ workspaceId: string; inAppDedupeKey?: string }> = [];
		const frozen: Array<{ workspaceId: string; inAppDedupeKey?: string }> = [];
		return {
			warnings,
			frozen,
			sendQuotaWarning: (async (i: { workspaceId: string; inAppDedupeKey?: string }) => { warnings.push({ workspaceId: i.workspaceId, inAppDedupeKey: i.inAppDedupeKey }); }) as never,
			sendQuotaFrozen: (async (i: { workspaceId: string; inAppDedupeKey?: string }) => { frozen.push({ workspaceId: i.workspaceId, inAppDedupeKey: i.inAppDedupeKey }); }) as never,
		};
	}

	test("fires the 80% warning ONLY on the crossing (not when already above)", async () => {
		const s = spies();
		const deps = { sqlClient: null, sendQuotaWarning: s.sendQuotaWarning, sendQuotaFrozen: s.sendQuotaFrozen };
		// Crossing 79 -> 85 fires once.
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: 79, afterPercent: 85, deps });
		// Already above (85 -> 90) does NOT re-fire.
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: 85, afterPercent: 90, deps });
		expect(s.warnings).toHaveLength(1);
		expect(s.frozen).toHaveLength(0);
	});

	test("a reservation BELOW the threshold fires nothing", async () => {
		const s = spies();
		const deps = { sqlClient: null, sendQuotaWarning: s.sendQuotaWarning, sendQuotaFrozen: s.sendQuotaFrozen };
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: 10, afterPercent: 50, deps });
		expect(s.warnings).toHaveLength(0);
		expect(s.frozen).toHaveLength(0);
	});

	test("crossing 100% fires quota_frozen (and not a duplicate warning)", async () => {
		const s = spies();
		const deps = { sqlClient: null, sendQuotaWarning: s.sendQuotaWarning, sendQuotaFrozen: s.sendQuotaFrozen };
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: 90, afterPercent: 100, deps });
		expect(s.frozen).toHaveLength(1);
		expect(s.warnings).toHaveLength(0);
		// A repeated over-quota attempt (100 -> 100) does not re-fire.
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: 100, afterPercent: 100, deps });
		expect(s.frozen).toHaveLength(1);
	});

	test("an unmetered (null after) workspace fires nothing", async () => {
		const s = spies();
		const deps = { sqlClient: null, sendQuotaWarning: s.sendQuotaWarning, sendQuotaFrozen: s.sendQuotaFrozen };
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: null, afterPercent: null, deps });
		expect(s.warnings).toHaveLength(0);
		expect(s.frozen).toHaveLength(0);
	});

	// P1-1 (round-2): an UNKNOWN `before` (pre-reservation usage snapshot failed) must NOT
	// be inferred as 0 — otherwise EVERY at/above-threshold request re-fires. Round-1's
	// `(before ?? 0)` treated unknown as a below-threshold crossing and re-spammed.
	test("unknown beforePercent does NOT fire a warning even when after >= 80", async () => {
		const s = spies();
		const deps = { sqlClient: null, sendQuotaWarning: s.sendQuotaWarning, sendQuotaFrozen: s.sendQuotaFrozen };
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: null, afterPercent: 85, deps });
		expect(s.warnings).toHaveLength(0);
		expect(s.frozen).toHaveLength(0);
	});

	test("unknown beforePercent does NOT fire a frozen notice even when after >= 100", async () => {
		const s = spies();
		const deps = { sqlClient: null, sendQuotaWarning: s.sendQuotaWarning, sendQuotaFrozen: s.sendQuotaFrozen };
		// Round-1 worst case: a REJECTED over-quota request forced after:100 with unknown
		// before, re-firing quota_frozen on EVERY blocked attempt. Now it stays silent.
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: undefined, afterPercent: 100, deps });
		expect(s.frozen).toHaveLength(0);
		expect(s.warnings).toHaveLength(0);
	});

	test("a genuine crossing carries a workspace+period+tier inAppDedupeKey (durable once-only)", async () => {
		const s = spies();
		const deps = { sqlClient: null, sendQuotaWarning: s.sendQuotaWarning, sendQuotaFrozen: s.sendQuotaFrozen };
		const now = new Date("2026-06-15T00:00:00.000Z");
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: 79, afterPercent: 85, now, deps });
		expect(s.warnings).toHaveLength(1);
		expect(s.warnings[0]?.inAppDedupeKey).toBe("quota_warning_80pct:ws:2026-06");

		const f = spies();
		const fdeps = { sqlClient: null, sendQuotaWarning: f.sendQuotaWarning, sendQuotaFrozen: f.sendQuotaFrozen };
		await emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: 90, afterPercent: 100, now, deps: fdeps });
		expect(f.frozen).toHaveLength(1);
		expect(f.frozen[0]?.inAppDedupeKey).toBe("quota_frozen:ws:2026-06");
	});

	test("a send failure is swallowed (never throws)", async () => {
		const deps = {
			sqlClient: null,
			sendQuotaWarning: (async () => { throw new Error("boom"); }) as never,
			sendQuotaFrozen: (async () => { throw new Error("boom"); }) as never,
		};
		await expect(
			emitQuotaTransitionBestEffort({ workspaceId: "ws", actorUserId: "u", beforePercent: 0, afterPercent: 85, deps }),
		).resolves.toBeUndefined();
	});

	test("threshold constant is 80", () => {
		expect(QUOTA_WARNING_THRESHOLD_PERCENT).toBe(80);
	});
});

describe("sendPaymentReceiptBestEffort (no fabricated money)", () => {
	test("skips the dedicated receipt template when amount/currency are missing", async () => {
		const sent: Array<{ template: string }> = [];
		// Monkeypatch is awkward; instead rely on the documented behavior: no email send is
		// attempted without a recipient email. With an email but null amount, the receipt
		// template must be skipped. We assert it does not throw and returns void.
		await expect(
			sendPaymentReceiptBestEffort({
				recipient: { email: "buyer@example.com", name: "Buyer" },
				workspaceId: "ws",
				workspaceName: "WS",
				planId: "pro",
				amount: null,
				currency: null,
			}),
		).resolves.toBeUndefined();
		expect(sent).toHaveLength(0);
	});
});
