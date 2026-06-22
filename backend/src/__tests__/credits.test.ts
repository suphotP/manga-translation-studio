import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import { CreditService, CreditServiceError } from "../services/credits.js";

async function withCredits(fn: (service: CreditService) => Promise<void>, dailyAllocationCap = 50): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "manga-credits-"));
	try {
		await fn(new CreditService(join(dir, "credits.json"), dailyAllocationCap));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("credits sharing service", () => {
	test("grants shareable workspace credits and personal user credits", async () => {
		await withCredits(async (service) => {
			const shareable = await service.grantCredits({
				workspaceId: "ws-1",
				ownerScope: "workspace",
				ownerId: "ws-1",
				creditClass: "shareable",
				amount: 100,
				source: "plan_monthly",
			});
			const personal = await service.grantCredits({
				workspaceId: "ws-1",
				ownerScope: "user",
				ownerId: "buyer-1",
				creditClass: "personal",
				amount: 25,
				source: "addon_purchase",
			});

			expect(shareable.creditClass).toBe("shareable");
			expect(personal.creditClass).toBe("personal");
			expect(service.getBalance("workspace", "ws-1")).toEqual({ shareable: 100, personal: 25, total: 125 });
			expect(service.listLedger("ws-1").map((entry) => entry.reason)).toEqual(["grant:plan_monthly", "grant:addon_purchase"]);
		});
	});

	test("allocates shareable credits to members and pages", async () => {
		await withCredits(async (service) => {
			const grant = await service.grantCredits({
				workspaceId: "ws-2",
				ownerScope: "workspace",
				ownerId: "ws-2",
				creditClass: "shareable",
				amount: 80,
				source: "plan_monthly",
			});

			const memberAllocation = await service.allocate(grant.id, "member", "user-a", 20, "lead-1");
			const pageAllocation = await service.allocate(grant.id, "page", "page-9", 10, "lead-1");

			expect(memberAllocation.allocatedToScope).toBe("member");
			expect(pageAllocation.allocatedToScope).toBe("page");
			// Only the member allocation is reserved out of the workspace pool. The
			// page allocation is an advisory earmark and stays spendable from the pool
			// (AI submission has no page spend path), so it is not locked away.
			expect(service.getBalance("workspace", "ws-2").shareable).toBe(60);
			// user-a sees their 20 allocation plus the remaining 60 workspace pool.
			expect(service.getBalance("member", "user-a", "ws-2").shareable).toBe(80);
			// The page earmark is still surfaced for the page/chapter balance view.
			expect(service.getBalance("page", "page-9", "ws-2").shareable).toBe(10);
		});
	});

	test("page-allocated shareable credits remain spendable and are not locked", async () => {
		await withCredits(async (service) => {
			const grant = await service.grantCredits({
				workspaceId: "ws-2b",
				ownerScope: "workspace",
				ownerId: "ws-2b",
				creditClass: "shareable",
				amount: 40,
				source: "plan_monthly",
			});
			// Earmark most of the grant to a page; without the fix these credits
			// would be subtracted from the pool and locked (unspendable by anyone).
			await service.allocate(grant.id, "page", "page-1", 35, "lead-1");
			// A member can still spend the workspace shareable pool, including the
			// earmarked credits, because page allocations no longer lock the pool.
			const result = await service.consume("ws-2b", "worker-1", 40, "ai_job_submitted", "job-x");
			expect(result.consumed).toEqual([{ creditClass: "shareable", amount: 40 }]);
			expect(service.getBalance("workspace", "ws-2b").shareable).toBe(0);
		});
	});

	test("rejects allocation attempts against personal credits with 403", async () => {
		await withCredits(async (service) => {
			const personal = await service.grantCredits({
				workspaceId: "ws-3",
				ownerScope: "user",
				ownerId: "buyer-1",
				creditClass: "personal",
				amount: 30,
				source: "addon_purchase",
			});

			await expect(service.allocate(personal.id, "member", "user-a", 5, "lead-1")).rejects.toThrow(CreditServiceError);
			try {
				await service.allocate(personal.id, "member", "user-a", 5, "lead-1");
			} catch (error) {
				expect(error).toBeInstanceOf(CreditServiceError);
				expect((error as CreditServiceError).status).toBe(403);
				expect((error as CreditServiceError).code).toBe("personal_credit_not_allocatable");
			}
		});
	});

	test("consumes personal add-on credits before shareable plan credits", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({
				workspaceId: "ws-4",
				ownerScope: "workspace",
				ownerId: "ws-4",
				creditClass: "shareable",
				amount: 100,
				source: "plan_monthly",
			});
			await service.grantCredits({
				workspaceId: "ws-4",
				ownerScope: "user",
				ownerId: "heavy-user",
				creditClass: "personal",
				amount: 30,
				source: "addon_purchase",
			});

			const result = await service.consume("ws-4", "heavy-user", 45, "ai_job_submitted", "job-1");

			expect(result.consumed).toEqual([
				{ creditClass: "personal", amount: 30 },
				{ creditClass: "shareable", amount: 15 },
			]);
			expect(result.balance).toEqual({ personal: 0, shareable: 85, total: 85 });
			expect(service.getBalance("workspace", "ws-4").shareable).toBe(85);
		});
	});

	test("only the buyer can consume personal credits", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({
				workspaceId: "ws-5",
				ownerScope: "user",
				ownerId: "buyer-1",
				creditClass: "personal",
				amount: 10,
				source: "addon_purchase",
			});

			await expect(service.consume("ws-5", "other-user", 1, "ai_job_submitted", "job-other")).rejects.toThrow(CreditServiceError);
			expect((await service.consume("ws-5", "buyer-1", 1, "ai_job_submitted", "job-buyer")).consumed).toEqual([
				{ creditClass: "personal", amount: 1 },
			]);
		});
	});

	test("revokes allocations inside the 24 hour undo window", async () => {
		await withCredits(async (service) => {
			const now = new Date("2026-06-02T00:00:00.000Z");
			const grant = await service.grantCredits({
				workspaceId: "ws-6",
				ownerScope: "workspace",
				ownerId: "ws-6",
				creditClass: "shareable",
				amount: 50,
				source: "plan_monthly",
				now,
			});
			const allocation = await service.allocate(grant.id, "chapter", "ch-1", 15, "lead-1", now);
			const revoked = await service.revokeAllocation(allocation.id, "lead-1", new Date("2026-06-02T23:59:00.000Z"));

			expect(revoked.revokedAt).toBeDefined();
			expect(service.getBalance("workspace", "ws-6").shareable).toBe(50);
		});
	});

	test("blocks allocation revoke after the 24 hour undo window", async () => {
		await withCredits(async (service) => {
			const now = new Date("2026-06-02T00:00:00.000Z");
			const grant = await service.grantCredits({
				workspaceId: "ws-7",
				ownerScope: "workspace",
				ownerId: "ws-7",
				creditClass: "shareable",
				amount: 50,
				source: "plan_monthly",
				now,
			});
			const allocation = await service.allocate(grant.id, "member", "user-a", 10, "lead-1", now);

			await expect(service.revokeAllocation(allocation.id, "lead-1", new Date("2026-06-03T00:01:00.000Z"))).rejects.toThrow(CreditServiceError);
		});
	});

	test("enforces a daily allocation cap per allocator", async () => {
		await withCredits(async (service) => {
			const grant = await service.grantCredits({
				workspaceId: "ws-8",
				ownerScope: "workspace",
				ownerId: "ws-8",
				creditClass: "shareable",
				amount: 50,
				source: "plan_monthly",
			});

			await service.allocate(grant.id, "member", "user-a", 1, "lead-1", new Date("2026-06-02T01:00:00.000Z"));
			await service.allocate(grant.id, "member", "user-b", 1, "lead-1", new Date("2026-06-02T02:00:00.000Z"));

			await expect(service.allocate(grant.id, "member", "user-c", 1, "lead-1", new Date("2026-06-02T03:00:00.000Z"))).rejects.toThrow(CreditServiceError);
		}, 2);
	});

	// Finding #2: insufficient consume must be atomic (no partial debit).
	test("rejects oversized consume atomically without spending any credits", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({ workspaceId: "ws-9", ownerScope: "workspace", ownerId: "ws-9", creditClass: "shareable", amount: 10, source: "plan_monthly" });
			await service.grantCredits({ workspaceId: "ws-9", ownerScope: "user", ownerId: "heavy", creditClass: "personal", amount: 30, source: "addon_purchase" });

			await expect(service.consume("ws-9", "heavy", 45, "ai_job_submitted", "job-big")).rejects.toThrow(CreditServiceError);
			try {
				await service.consume("ws-9", "heavy", 45, "ai_job_submitted", "job-big-2");
			} catch (error) {
				expect((error as CreditServiceError).status).toBe(402);
				expect((error as CreditServiceError).code).toBe("insufficient_credits");
			}
			// Balances are untouched: no personal or shareable debit was recorded.
			// "heavy" has no allocation, so member shareable == workspace pool (10).
			expect(service.getBalance("member", "heavy", "ws-9")).toEqual({ personal: 30, shareable: 10, total: 40 });
			expect(service.getBalance("workspace", "ws-9")).toEqual({ personal: 30, shareable: 10, total: 40 });
			expect(service.listLedger("ws-9").every((entry) => entry.delta > 0)).toBe(true);
		});
	});

	// Finding #3: a member's shareable spend must draw down their allocation, not
	// let them spend the allocation amount repeatedly out of the workspace pool.
	test("subtracts a member's shareable consumption from their allocation bucket", async () => {
		await withCredits(async (service) => {
			const grant = await service.grantCredits({ workspaceId: "ws-10", ownerScope: "workspace", ownerId: "ws-10", creditClass: "shareable", amount: 100, source: "plan_monthly" });
			await service.allocate(grant.id, "member", "alloc-user", 20, "lead-1");

			// Member starts with 20 allocation + 80 unallocated pool = 100 available.
			expect(service.getBalance("member", "alloc-user", "ws-10").shareable).toBe(100);

			// First 20-credit spend exhausts the allocation; the pool is untouched.
			await service.consume("ws-10", "alloc-user", 20, "ai_job_submitted", "job-a");
			expect(service.getBalance("member", "alloc-user", "ws-10").shareable).toBe(80);
			expect(service.getBalance("workspace", "ws-10").shareable).toBe(80);

			// Next 20-credit spend overflows into the workspace-unallocated pool.
			await service.consume("ws-10", "alloc-user", 20, "ai_job_submitted", "job-b");
			expect(service.getBalance("member", "alloc-user", "ws-10").shareable).toBe(60);
			expect(service.getBalance("workspace", "ws-10").shareable).toBe(60);
		});
	});

	// Finding #4: a failed/cancelled job's consumed credits can be refunded by ref.
	test("releases consumed credits by ref idempotently", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({ workspaceId: "ws-11", ownerScope: "workspace", ownerId: "ws-11", creditClass: "shareable", amount: 50, source: "plan_monthly" });
			await service.grantCredits({ workspaceId: "ws-11", ownerScope: "user", ownerId: "buyer", creditClass: "personal", amount: 10, source: "addon_purchase" });

			const result = await service.consume("ws-11", "buyer", 25, "ai_job_submitted", "job-x");
			expect(result.consumed).toEqual([
				{ creditClass: "personal", amount: 10 },
				{ creditClass: "shareable", amount: 15 },
			]);
			expect(service.getBalance("member", "buyer", "ws-11")).toEqual({ personal: 0, shareable: 35, total: 35 });

			const released = await service.releaseConsumptionsByRef("job-x", "job_cancelled");
			expect(released).toEqual([
				{ creditClass: "personal", amount: 10 },
				{ creditClass: "shareable", amount: 15 },
			]);
			expect(service.getBalance("member", "buyer", "ws-11")).toEqual({ personal: 10, shareable: 50, total: 60 });

			// Idempotent: a second release for the same ref is a no-op.
			expect(await service.releaseConsumptionsByRef("job-x", "job_cancelled")).toEqual([]);
			expect(service.getBalance("member", "buyer", "ws-11")).toEqual({ personal: 10, shareable: 50, total: 60 });
		});
	});

	// Finding #7: workspace personal balance must subtract spent add-on credits.
	test("subtracts spent personal credits from the workspace balance", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({ workspaceId: "ws-12", ownerScope: "workspace", ownerId: "ws-12", creditClass: "shareable", amount: 40, source: "plan_monthly" });
			await service.grantCredits({ workspaceId: "ws-12", ownerScope: "user", ownerId: "buyer", creditClass: "personal", amount: 30, source: "addon_purchase" });

			expect(service.getBalance("workspace", "ws-12")).toEqual({ shareable: 40, personal: 30, total: 70 });
			await service.consume("ws-12", "buyer", 10, "ai_job_submitted", "job-p");
			// Personal drops to 20, shareable untouched (personal consumed first).
			expect(service.getBalance("workspace", "ws-12")).toEqual({ shareable: 40, personal: 20, total: 60 });
		});
	});

	// Finding #8: reject workspace-owned personal grants (unspendable dead credits).
	test("rejects personal credits without a user owner", async () => {
		await withCredits(async (service) => {
			await expect(service.grantCredits({
				workspaceId: "ws-13",
				ownerScope: "workspace",
				ownerId: "ws-13",
				creditClass: "personal",
				amount: 20,
				source: "addon_purchase",
			})).rejects.toThrow(CreditServiceError);
			try {
				await service.grantCredits({ workspaceId: "ws-13", ownerScope: "workspace", ownerId: "ws-13", creditClass: "personal", amount: 20, source: "addon_purchase" });
			} catch (error) {
				expect((error as CreditServiceError).status).toBe(400);
				expect((error as CreditServiceError).code).toBe("personal_credit_requires_user_owner");
			}
			// No dead credits were minted into the workspace balance.
			expect(service.getBalance("workspace", "ws-13")).toEqual({ shareable: 0, personal: 0, total: 0 });
		});
	});

	// Finding #1: grant/allocation workspace can be resolved for authorization.
	test("resolves the owning workspace for a grant and its allocation", async () => {
		await withCredits(async (service) => {
			const grant = await service.grantCredits({ workspaceId: "ws-14", ownerScope: "workspace", ownerId: "ws-14", creditClass: "shareable", amount: 30, source: "plan_monthly" });
			const allocation = await service.allocate(grant.id, "member", "user-a", 5, "lead-1");

			expect(service.getGrantWorkspaceId(grant.id)).toBe("ws-14");
			expect(service.getAllocationWorkspaceId(allocation.id)).toBe("ws-14");
			expect(service.getGrantWorkspaceId("missing")).toBeNull();
			expect(service.getAllocationWorkspaceId("missing")).toBeNull();
		});
	});

	test("hasCreditSystem gates enforcement to provisioned workspaces/users", async () => {
		await withCredits(async (service) => {
			// No grants anywhere: credit enforcement is off (falls through to usage ledger).
			expect(service.hasCreditSystem("ws-15", "user-a")).toBe(false);

			await service.grantCredits({ workspaceId: "ws-15", ownerScope: "workspace", ownerId: "ws-15", creditClass: "shareable", amount: 10, source: "plan_monthly" });
			// A workspace shareable grant turns on enforcement for any user in it.
			expect(service.hasCreditSystem("ws-15", "user-a")).toBe(true);
			expect(service.hasCreditSystem("ws-15", "user-b")).toBe(true);

			// A personal grant only turns on enforcement for its owner.
			await service.grantCredits({ workspaceId: "ws-16", ownerScope: "user", ownerId: "buyer-1", creditClass: "personal", amount: 5, source: "addon_purchase" });
			expect(service.hasCreditSystem("ws-16", "buyer-1")).toBe(true);
			expect(service.hasCreditSystem("ws-16", "other-user")).toBe(false);
		});
	});

	test("reverseGrant deducts a full unspent personal grant, idempotently", async () => {
		await withCredits(async (service) => {
			const grant = await service.grantCredits({ workspaceId: "ws-rv", ownerScope: "user", ownerId: "u-rv", creditClass: "personal", amount: 100, source: "goodwill" });
			expect(service.getBalance("member", "u-rv", "ws-rv").personal).toBe(100);

			const r = await service.reverseGrant(grant.id, "owner clawback");
			expect(r.reversed).toBe(100);
			expect(r.unrecoverable).toBe(0);
			expect(r.alreadyReversed).toBe(false);
			expect(service.getBalance("member", "u-rv", "ws-rv").personal).toBe(0);

			// Idempotent: a second reverse deducts nothing more.
			const again = await service.reverseGrant(grant.id, "owner clawback");
			expect(again.reversed).toBe(100);
			expect(again.alreadyReversed).toBe(true);
			expect(service.getBalance("member", "u-rv", "ws-rv").personal).toBe(0);
		});
	});

	test("reverseGrant clamps to the unspent remainder when credits were already spent", async () => {
		await withCredits(async (service) => {
			const grant = await service.grantCredits({ workspaceId: "ws-rv2", ownerScope: "user", ownerId: "u-rv2", creditClass: "personal", amount: 100, source: "goodwill" });
			await service.consume("ws-rv2", "u-rv2", 60, "ai_job", "job-1");
			expect(service.getBalance("member", "u-rv2", "ws-rv2").personal).toBe(40);

			const r = await service.reverseGrant(grant.id, "owner clawback");
			expect(r.reversed).toBe(40);
			expect(r.unrecoverable).toBe(60);
			// Balance floored at 0 (never negative / no debt).
			expect(service.getBalance("member", "u-rv2", "ws-rv2").personal).toBe(0);
		});
	});

	test("reverseGrant on an unknown grant throws", async () => {
		await withCredits(async (service) => {
			await expect(service.reverseGrant("missing-grant", "x")).rejects.toBeInstanceOf(CreditServiceError);
		});
	});

	test("reverseGrant of a FULLY-SPENT grant never debits an UNRELATED later grant/topup", async () => {
		await withCredits(async (service) => {
			// A 100-credit goodwill grant, then the customer spends ALL 100 of it.
			const goodwill = await service.grantCredits({ workspaceId: "ws-x", ownerScope: "user", ownerId: "u-x", creditClass: "personal", amount: 100, source: "goodwill" });
			await service.consume("ws-x", "u-x", 100, "ai_job", "job-spend-goodwill");
			expect(service.getBalance("member", "u-x", "ws-x").personal).toBe(0);

			// LATER the customer buys 100 UNRELATED personal credits (a top-up add-on).
			await service.grantCredits({ workspaceId: "ws-x", ownerScope: "user", ownerId: "u-x", creditClass: "personal", amount: 100, source: "addon_purchase" });
			expect(service.getBalance("member", "u-x", "ws-x").personal).toBe(100);

			// Clawing back the goodwill grant must touch NONE of the unrelated top-up: the
			// goodwill grant's own unspent remainder is 0, so reversed=0, unrecoverable=100.
			const r = await service.reverseGrant(goodwill.id, "owner clawback");
			expect(r.reversed).toBe(0);
			expect(r.unrecoverable).toBe(100);
			// The unrelated top-up is UNTOUCHED — no silent value loss.
			expect(service.getBalance("member", "u-x", "ws-x").personal).toBe(100);
		});
	});

	test("reverseGrant of a PARTIALLY-spent grant reverses only THAT grant's remainder (not a later grant)", async () => {
		await withCredits(async (service) => {
			// Goodwill grant of 100; customer spends 70 of it (30 of the goodwill remains).
			const goodwill = await service.grantCredits({ workspaceId: "ws-y", ownerScope: "user", ownerId: "u-y", creditClass: "personal", amount: 100, source: "goodwill" });
			await service.consume("ws-y", "u-y", 70, "ai_job", "job-spend-y");
			// A later unrelated top-up of 50.
			await service.grantCredits({ workspaceId: "ws-y", ownerScope: "user", ownerId: "u-y", creditClass: "personal", amount: 50, source: "addon_purchase" });
			expect(service.getBalance("member", "u-y", "ws-y").personal).toBe(80); // 30 goodwill + 50 topup

			// Clawback reverses ONLY the goodwill grant's own 30-credit remainder.
			const r = await service.reverseGrant(goodwill.id, "owner clawback");
			expect(r.reversed).toBe(30);
			expect(r.unrecoverable).toBe(70);
			// Only the goodwill remainder was debited; the 50-credit top-up is intact.
			expect(service.getBalance("member", "u-y", "ws-y").personal).toBe(50);
		});
	});

	test("reverseGrant of a SHAREABLE grant reverses only its own remainder within the workspace pool", async () => {
		await withCredits(async (service) => {
			// Two shareable workspace grants; the workspace spends 30 against the pool.
			const goodwill = await service.grantCredits({ workspaceId: "ws-sh", ownerScope: "workspace", ownerId: "ws-sh", creditClass: "shareable", amount: 50, source: "goodwill" });
			await service.grantCredits({ workspaceId: "ws-sh", ownerScope: "workspace", ownerId: "ws-sh", creditClass: "shareable", amount: 50, source: "plan_monthly" });
			await service.consume("ws-sh", "member-1", 30, "ai_job", "job-sh");
			expect(service.getBalance("workspace", "ws-sh").shareable).toBe(70);

			// FIFO: the 30 spend drains the older goodwill grant (50) first, leaving 20 of it.
			const r = await service.reverseGrant(goodwill.id, "owner clawback");
			expect(r.reversed).toBe(20);
			expect(r.unrecoverable).toBe(30);
			// The other 50-credit grant is untouched (70 - 20 reversed = 50 remains).
			expect(service.getBalance("workspace", "ws-sh").shareable).toBe(50);
		});
	});

	test("reverseGrant of grant A does not shrink the recoverable remainder of unrelated grant B", async () => {
		await withCredits(async (service) => {
			// Two independent unspent goodwill grants of 40 each, no consumption.
			const a = await service.grantCredits({ workspaceId: "ws-z", ownerScope: "user", ownerId: "u-z", creditClass: "personal", amount: 40, source: "goodwill" });
			const b = await service.grantCredits({ workspaceId: "ws-z", ownerScope: "user", ownerId: "u-z", creditClass: "personal", amount: 40, source: "goodwill" });
			expect(service.getBalance("member", "u-z", "ws-z").personal).toBe(80);

			// Reverse A fully (40), then reverse B fully (40) — B is unaffected by A's clawback.
			const ra = await service.reverseGrant(a.id, "owner clawback A");
			expect(ra.reversed).toBe(40);
			expect(ra.unrecoverable).toBe(0);
			expect(service.getBalance("member", "u-z", "ws-z").personal).toBe(40);

			const rb = await service.reverseGrant(b.id, "owner clawback B");
			expect(rb.reversed).toBe(40);
			expect(rb.unrecoverable).toBe(0);
			expect(service.getBalance("member", "u-z", "ws-z").personal).toBe(0);
		});
	});

	test("cross-process-safe stores reload shared state before consuming, preventing double-spend", async () => {
		const dir = mkdtempSync(join(tmpdir(), "manga-credits-mp-"));
		try {
			const filePath = join(dir, "credits.json");
			// Two independent CreditService instances over the SAME file model two prod
			// API replicas sharing api-prod-data:/app/data.
			const replicaA = new CreditService(filePath, 50, { crossProcessSafe: true });
			const replicaB = new CreditService(filePath, 50, { crossProcessSafe: true });

			// Replica A grants 10 personal credits to the buyer.
			await replicaA.grantCredits({ workspaceId: "ws-mp", ownerScope: "user", ownerId: "buyer-1", creditClass: "personal", amount: 10, source: "addon_purchase" });

			// Replica A debits 8. Replica B started with a stale empty in-memory snapshot
			// (it never saw the grant), but every MUTATION reloads from disk under the
			// exclusive lock and re-checks the balance against fresh state.
			await replicaA.consume("ws-mp", "buyer-1", 8, "ai_job", "job-a");

			// The key property: replica B cannot double-spend the already-debited pool.
			// It reloads, sees only 2 remaining, and a request for 3 fails closed (402)
			// — instead of passing a stale balance check and running an AI job for free.
			await expect(replicaB.consume("ws-mp", "buyer-1", 3, "ai_job", "job-b")).rejects.toThrow(CreditServiceError);

			// Replica B can still spend exactly the 2 that remain.
			const result = await replicaB.consume("ws-mp", "buyer-1", 2, "ai_job", "job-b");
			expect(result.balance.total).toBe(0);

			// A third replica reading fresh state confirms the pool is fully exhausted —
			// no lost grant, no lost debit across the two writers.
			const replicaC = new CreditService(filePath, 50, { crossProcessSafe: true });
			expect(replicaC.getBalance("member", "buyer-1", "ws-mp").total).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("credits pre-commit fencing (stale-reclaim double-write defense)", () => {
	test("a stalled holder whose lock was stale-reclaimed does NOT commit its in-flight write (fences out, then re-runs against fresh peer state)", async () => {
		// Scenario the fence defends against: holder A acquires the O_EXCL credit lock
		// (token tA) then STALLS past CREDIT_LOCK_STALE_MS (GC/CPU stall / SIGSTOP).
		// Peer B stale-reclaims the abandoned lock, re-acquires it (token tB), reloads,
		// and commits its OWN debit — B is the legitimate writer on disk. When A resumes
		// it must NOT save() the snapshot it computed under the now-lost lock (that would
		// double-write money state over B). The rename-adjacent fence sees tB ≠ tA and
		// ABORTS A's commit; A then rolls back, re-acquires, reloads B's committed state,
		// and re-runs against FRESH state — so the net result is exactly one debit per
		// peer, no lost update, no double-write.
		const dir = mkdtempSync(join(tmpdir(), "manga-credits-fence-"));
		try {
			const filePath = join(dir, "credits.json");
			const lockPath = `${filePath}.lock`;

			// Seed: replica B grants + already debits, establishing the legitimate on-disk
			// state. (Done on B so its committed snapshot is what A must not clobber.)
			const replicaB = new CreditService(filePath, 50, { crossProcessSafe: true });
			await replicaB.grantCredits({ workspaceId: "ws-f", ownerScope: "user", ownerId: "buyer-1", creditClass: "personal", amount: 10, source: "addon_purchase" });
			await replicaB.consume("ws-f", "buyer-1", 4, "ai_job", "job-b"); // disk: 6 remaining

			// Holder A: model it resuming AFTER a stale-reclaim. We make the rename-adjacent
			// fence observe a FOREIGN token EXACTLY ONCE — exactly what a peer's stale-
			// reclaim+re-acquire writes while A is stalled — by interposing readLockToken so
			// the fence's first re-read returns a foreign token (without corrupting the real
			// on-disk lock, so acquire/release stay healthy and A's bounded retry can
			// re-acquire and commit cleanly against fresh state).
			const replicaA = new CreditService(filePath, 50, { crossProcessSafe: true });
			const internal = replicaA as unknown as {
				readLockToken: () => string | null;
				lockToken: string | null;
				save: (b?: () => void) => void;
			};
			const originalReadToken = internal.readLockToken.bind(internal);
			let fenceReads = 0;
			let publishedWhileForeign = false;
			const originalSave = internal.save.bind(internal);
			// readLockToken is called BOTH by the fence and by acquire/release. We only want
			// to spoof the FENCE's first read. The fence runs inside save()'s beforeCommit,
			// so arm the spoof for the duration of the first save() only.
			let inSave = false;
			let foreignObservedThisSave = false;
			internal.readLockToken = () => {
				if (inSave && fenceReads === 0) {
					fenceReads += 1;
					foreignObservedThisSave = true;
					return "99999:foreign-token"; // peer stale-reclaimed → A no longer owns it
				}
				return originalReadToken();
			};
			internal.save = (beforeCommit?: () => void) => {
				inSave = true;
				foreignObservedThisSave = false;
				try {
					originalSave(beforeCommit);
					// Reaching here means save PUBLISHED (renamed). If the fence had just
					// observed a foreign token, that is exactly the double-write we forbid.
					if (foreignObservedThisSave) publishedWhileForeign = true;
				} finally {
					inSave = false;
				}
			};

			// A debits 5. Attempt 1: A computes a debit on fresh state but its rename-
			// adjacent fence reads the (spoofed) foreign token → aborts (no write). A rolls
			// back + retries; the spoof is one-shot, so A re-acquires, reloads (6 remaining),
			// and legitimately debits 5 → commits.
			const result = await replicaA.consume("ws-f", "buyer-1", 5, "ai_job", "job-a");
			internal.readLockToken = originalReadToken;
			internal.save = originalSave;

			// The fence DID fire (spoofed foreign token re-read during A's first commit) and
			// A NEVER published a write while the fence saw a foreign token.
			expect(fenceReads).toBe(1);
			expect(publishedWhileForeign).toBe(false);
			// A's eventual commit ran against FRESH state (6 remaining − 5 = 1).
			expect(result.balance.total).toBe(1);

			// On-disk: both B's job-b debit and A's (single, post-fence) job-a debit, no
			// duplicate job-a, file is a complete parseable atomic snapshot.
			const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as {
				consumptions: Array<{ refId?: string }>;
			};
			expect(onDisk.consumptions.filter((c) => c.refId === "job-a").length).toBe(1);
			expect(onDisk.consumptions.filter((c) => c.refId === "job-b").length).toBe(1);
			const replicaC = new CreditService(filePath, 50, { crossProcessSafe: true });
			expect(replicaC.getBalance("member", "buyer-1", "ws-f").total).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the fence re-read is rename-adjacent: it runs as writeFileAtomic's beforeCommit, back-to-back with the rename", async () => {
		// Proves the fence's token re-read sits IMMEDIATELY before the renameSync (not before
		// serialize), so no async yield / own-I/O sits between the check and the commit —
		// the property that makes the stale-reclaim TOCTOU window unhittable. We assert this
		// by observing that the fence callback fires AFTER the temp file is fully written but
		// BEFORE the target is published, on a normal (non-fenced) commit.
		const dir = mkdtempSync(join(tmpdir(), "manga-credits-adjacent-"));
		try {
			const filePath = join(dir, "credits.json");
			const replica = new CreditService(filePath, 50, { crossProcessSafe: true });
			const internal = replica as unknown as { assertLockOwnership: () => void };
			const originalAssert = internal.assertLockOwnership.bind(internal);
			let fenceFiredWithTargetAbsent = false;
			let fenceFired = false;
			internal.assertLockOwnership = () => {
				originalAssert();
				fenceFired = true;
				// At the instant the fence runs, the durable target has NOT yet been
				// published by the rename (a temp file holds the bytes). On the very first
				// write the target file does not exist yet → proves rename-adjacency.
				if (!existsSync(filePath)) fenceFiredWithTargetAbsent = true;
			};
			await replica.grantCredits({ workspaceId: "ws-t", ownerScope: "user", ownerId: "buyer-1", creditClass: "personal", amount: 10, source: "addon_purchase" });
			internal.assertLockOwnership = originalAssert;

			expect(fenceFired).toBe(true);
			expect(fenceFiredWithTargetAbsent).toBe(true);
			// And the write still committed normally (fence passed → rename published).
			expect(existsSync(filePath)).toBe(true);
			const replicaC = new CreditService(filePath, 50, { crossProcessSafe: true });
			expect(replicaC.getBalance("member", "buyer-1", "ws-t").total).toBe(10);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the peer that stale-reclaims is the SOLE winner; a genuinely crashed holder is still reclaimed", async () => {
		// Two properties in one: (1) when A is fenced out, peer B's mutation is the only
		// one that commits (sole winner — no double-spend, no lost update); (2) a crashed
		// holder that left a stale lock is still reclaimed so billing never wedges.
		const dir = mkdtempSync(join(tmpdir(), "manga-credits-winner-"));
		try {
			const filePath = join(dir, "credits.json");
			const lockPath = `${filePath}.lock`;

			// (2) Simulate a CRASHED holder: a leftover lock file with a foreign token and a
			// stale mtime. A live mutation must reclaim it rather than block forever.
			writeFileSync(lockPath, "00000:dead-holder");
			const stale = Date.now() / 1000 - 3600; // 1h ago, well past CREDIT_LOCK_STALE_MS
			const { utimesSync } = await import("fs");
			utimesSync(lockPath, stale, stale);

			const replica = new CreditService(filePath, 50, { crossProcessSafe: true });
			// This mutation must SUCCEED: the dead holder's stale lock is reclaimed.
			const grant = await replica.grantCredits({ workspaceId: "ws-w", ownerScope: "user", ownerId: "buyer-1", creditClass: "personal", amount: 10, source: "addon_purchase" });
			expect(grant.amount).toBe(10);
			// The lock is released after the successful mutation (no wedge).
			expect(existsSync(lockPath)).toBe(false);

			// (1) Sole-winner: model A fenced on EVERY commit attempt (a persistent foreign
			// owner) so A exhausts its bounded retries and fails closed — never publishing a
			// debit. The peer (the foreign-token owner) is the sole legitimate holder; A's
			// "job-a" must not reach disk. We spoof the fence's read to ALWAYS see a foreign
			// token without corrupting the real lock file (so acquire/release stay healthy).
			const replicaA = new CreditService(filePath, 50, { crossProcessSafe: true });
			const internal = replicaA as unknown as { readLockToken: () => string | null; save: (b?: () => void) => void };
			const originalReadToken = internal.readLockToken.bind(internal);
			let inSave = false;
			let everPublishedWhileForeign = false;
			const originalSave = internal.save.bind(internal);
			internal.readLockToken = () => (inSave ? "77777:peer-B-token" : originalReadToken());
			internal.save = (beforeCommit?: () => void) => {
				inSave = true;
				try {
					originalSave(beforeCommit);
					everPublishedWhileForeign = true; // reached only if the fence wrongly passed
				} finally {
					inSave = false;
				}
			};
			await expect(replicaA.consume("ws-w", "buyer-1", 3, "ai_job", "job-a")).rejects.toThrow(CreditServiceError);
			internal.readLockToken = originalReadToken;
			internal.save = originalSave;

			// A never committed while the fence saw a foreign owner: the peer is sole winner.
			expect(everPublishedWhileForeign).toBe(false);
			// Exactly the original grant remains; A's debit was fenced out → still 10.
			const replicaC = new CreditService(filePath, 50, { crossProcessSafe: true });
			expect(replicaC.getBalance("member", "buyer-1", "ws-w").total).toBe(10);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// P0 (money): an EXPIRED grant's own past consumption must stay attributed to that
// grant and must NOT bleed into the live balance of still-ACTIVE grants. The naive
// `sum(activeGranted) − sum(allConsumption)` over-subtracted an expired grant's spend
// from the active pool. These prove the active balance survives intact.
describe("credits — expired-grant consumption does not drain active balance", () => {
	const PAST = new Date(Date.now() - 60_000); // a grant minted in the past
	const EXPIRES_SOON = new Date(Date.now() - 1_000).toISOString(); // already expired NOW
	const NOW = new Date(); // evaluation time — the soon-expiry grant is expired here

	test("personal: expired (partially-spent) grant + active grant → active intact", async () => {
		await withCredits(async (service) => {
			// Expired personal grant of 50, granted in the past, expiring before NOW.
			// Consume 30 of it while it was still active (consume time before expiry).
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "user", ownerId: "u1", creditClass: "personal",
				amount: 50, source: "addon_purchase", expiresAt: EXPIRES_SOON, now: PAST,
			});
			await service.consume("ws", "u1", 30, "ai-job", "ref-old", PAST);
			// Active personal grant of 100 (no expiry).
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "user", ownerId: "u1", creditClass: "personal",
				amount: 100, source: "addon_purchase",
			});
			// At NOW the first grant is expired: its 30 of spend stays on it, so the
			// active grant's full 100 is available (NOT 70).
			expect(service.getBalance("member", "u1", "ws", NOW).personal).toBe(100);
		});
	});

	test("shareable: expired (partially-spent) grant + active grant → active intact", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 50, source: "plan_monthly", expiresAt: EXPIRES_SOON, now: PAST,
			});
			await service.consume("ws", "u1", 30, "ai-job", "ref-old", PAST);
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 100, source: "plan_monthly",
			});
			expect(service.getBalance("workspace", "ws", undefined, NOW).shareable).toBe(100);
		});
	});

	test("personal: spend that exceeds the expired grant still draws the active grant", async () => {
		await withCredits(async (service) => {
			// Expired grant of 50, fully (60) attempted — but only 50 was ever spendable
			// while active, so cap consume at 50. Then active grant 100, spend 20 of it.
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "user", ownerId: "u1", creditClass: "personal",
				amount: 50, source: "addon_purchase", expiresAt: EXPIRES_SOON, now: PAST,
			});
			await service.consume("ws", "u1", 50, "ai-job", "ref-a", PAST); // drains the expired grant
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "user", ownerId: "u1", creditClass: "personal",
				amount: 100, source: "addon_purchase",
			});
			await service.consume("ws", "u1", 20, "ai-job", "ref-b"); // spends from the active grant
			// 50 of spend is absorbed by the expired grant; only the 20 reaches the active
			// grant → 100 − 20 = 80.
			expect(service.getBalance("member", "u1", "ws", NOW).personal).toBe(80);
		});
	});
});

// ── refund/chargeback clawback (NEGATIVE-allowed, idempotent) ──────────────────
describe("credits clawback (refund/chargeback, negative-allowed)", () => {
	test("clawbackGrantByKey fully reverses a grant even when spent, driving the signed balance NEGATIVE", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 50, source: "addon_purchase", idempotencyKey: "dodo-addon:pay_1:credits-50:0",
			});
			// Spend 40 of the 50, then refund/claw back the whole 50.
			await service.consume("ws", "u1", 40, "ai-job", "ref-1");
			const result = await service.clawbackGrantByKey("dodo-addon:pay_1:credits-50:0", "refund:payment.refunded");

			expect(result.found).toBe(true);
			expect(result.clawedBack).toBe(50);
			// Spendable (floored) is 0 — a debt is never spendable.
			expect(service.getBalance("workspace", "ws").shareable).toBe(0);
			// Signed balance shows the DEBT: granted 50 − (40 spent + 50 clawback) = −40.
			expect(service.getSignedWorkspaceShareableBalance("ws")).toBe(-40);
		});
	});

	test("clawbackGrantByKey is idempotent: a webhook replay does not double-reverse", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 50, source: "addon_purchase", idempotencyKey: "dodo-addon:pay_2:credits-50:0",
			});
			const first = await service.clawbackGrantByKey("dodo-addon:pay_2:credits-50:0", "refund");
			const second = await service.clawbackGrantByKey("dodo-addon:pay_2:credits-50:0", "refund");

			expect(first.alreadyClawedBack).toBe(false);
			expect(second.alreadyClawedBack).toBe(true);
			expect(service.getSignedWorkspaceShareableBalance("ws")).toBe(0); // 50 − 50, once only
		});
	});

	test("a future grant pays the debt down first (signed balance rises toward 0)", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 50, source: "addon_purchase", idempotencyKey: "dodo-addon:pay_3:credits-50:0",
			});
			await service.consume("ws", "u1", 50, "ai-job", "ref-3"); // fully spent
			await service.clawbackGrantByKey("dodo-addon:pay_3:credits-50:0", "refund"); // debt −50
			expect(service.getSignedWorkspaceShareableBalance("ws")).toBe(-50);
			expect(service.getBalance("workspace", "ws").shareable).toBe(0);

			// A new 30-credit grant: signed balance rises to −20; still no spendable credit
			// (the grant pays the debt down first), so floored available stays 0.
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 30, source: "plan_monthly",
			});
			expect(service.getSignedWorkspaceShareableBalance("ws")).toBe(-20);
			expect(service.getBalance("workspace", "ws").shareable).toBe(0);

			// A further 40-credit grant clears the debt and leaves 20 spendable.
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 40, source: "plan_monthly",
			});
			expect(service.getSignedWorkspaceShareableBalance("ws")).toBe(20);
			expect(service.getBalance("workspace", "ws").shareable).toBe(20);
		});
	});

	test("clawbackGrantsByKeyPrefix claws back every credit pack bought on a payment", async () => {
		await withCredits(async (service) => {
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 50, source: "addon_purchase", idempotencyKey: "dodo-addon:pay_x:credits-50:0",
			});
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 200, source: "addon_purchase", idempotencyKey: "dodo-addon:pay_x:credits-200:1",
			});
			// An unrelated payment's grant must NOT be touched.
			await service.grantCredits({
				workspaceId: "ws", ownerScope: "workspace", ownerId: "ws", creditClass: "shareable",
				amount: 50, source: "addon_purchase", idempotencyKey: "dodo-addon:pay_other:credits-50:0",
			});

			const results = await service.clawbackGrantsByKeyPrefix("dodo-addon:pay_x:", "refund");
			expect(results).toHaveLength(2);
			// 50 + 200 (pay_x) clawed back; pay_other's 50 survives → signed = 50.
			expect(service.getSignedWorkspaceShareableBalance("ws")).toBe(50);
		});
	});

	test("clawbackGrantByKey on an unknown key is a safe no-op", async () => {
		await withCredits(async (service) => {
			const result = await service.clawbackGrantByKey("dodo-addon:nope:credits-50:0", "refund");
			expect(result.found).toBe(false);
		});
	});
});
