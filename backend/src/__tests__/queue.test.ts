// Tests for job queue

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { QueueSnapshot, QueueSnapshotStore } from "../services/queue.js";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = previous;
	}
}

describe("JobQueue", () => {
	test("queue stats returns correct structure", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const queue = new JobQueue();
		const stats = await queue.stats();
		expect(stats).toHaveProperty("total");
		expect(stats).toHaveProperty("open");
		expect(stats).toHaveProperty("pending");
		expect(stats).toHaveProperty("processing");
		expect(stats).toHaveProperty("done");
		expect(stats).toHaveProperty("error");
		expect(stats).toHaveProperty("draining");
		expect(typeof stats.total).toBe("number");
	});

	test("default queue concurrency matches the SFX Pro account cap", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		let running = 0;
		let maxRunning = 0;
		const releases: Array<() => void> = [];

		queue.onProcess(async () => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await new Promise<void>((resolve) => releases.push(resolve));
			running -= 1;
		});

		for (let index = 0; index < 3; index += 1) {
			await queue.add({
				jobId: uuid(),
				projectId: uuid(),
				imageId: `${uuid()}.png`,
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(maxRunning).toBe(2);
		expect(queue.activeCount()).toBe(2);

		for (let index = 0; index < 3; index += 1) {
			while (releases.length > 0) {
				releases.shift()?.();
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(await queue.waitForIdle(1000)).toBe(true);
	});

	test("queue admission rejects new project work when the project pending limit is full", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const projectId = uuid();
		const firstJob = {
			jobId: uuid(),
			projectId,
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const secondJob = { ...firstJob, jobId: uuid(), imageId: `${uuid()}.png` };

		await queue.add(firstJob, { idempotencyKey: "same-project-1" });
		const decision = await queue.checkAdmission(secondJob, {
			maxOpenJobs: 10,
			maxPendingJobs: 10,
			maxProjectOpenJobs: 10,
			maxProjectPendingJobs: 1,
			maxProjectReservedThb: 1000,
			maxTierOpenJobs: { "sfx-pro": 10 },
			retryAfterSeconds: 7,
		});

		expect((await queue.getByIdempotencyKey("same-project-1"))?.jobId).toBe(firstJob.jobId);
		expect(decision.accepted).toBe(false);
		expect(decision.reason).toBe("project_pending_limit");
		expect(decision.retryAfterSeconds).toBe(7);
		expect(decision.snapshot.projectPendingJobs).toBe(1);
	});

	test("queue admission tracks reserved project budget before accepting expensive jobs", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const projectId = uuid();
		const baseJob = {
			projectId,
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			creditReservation: {
				status: "reserved" as const,
				amountThb: 6,
				currency: "THB" as const,
				createdAt: Date.now(),
			},
		};

		await queue.add({ ...baseJob, jobId: uuid() });
		const decision = await queue.checkAdmission({
			...baseJob,
			jobId: uuid(),
			creditReservation: { ...baseJob.creditReservation, amountThb: 5 },
		}, {
			maxOpenJobs: 10,
			maxPendingJobs: 10,
			maxProjectOpenJobs: 10,
			maxProjectPendingJobs: 10,
			maxProjectReservedThb: 10,
			maxTierOpenJobs: { "sfx-pro": 10 },
			retryAfterSeconds: 30,
		});

		expect(decision.accepted).toBe(false);
		expect(decision.reason).toBe("project_reserved_budget_limit");
		expect(decision.snapshot.projectReservedThb).toBe(6);
	});

	test("adding a job and getting it back", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();

		const jobId = uuid();
		const job = {
			jobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test prompt",
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		await queue.add(job);
		const retrieved = await queue.get(jobId);
		expect(retrieved).toBeDefined();
		expect(retrieved!.jobId).toBe(jobId);
		expect(retrieved!.projectId).toBe(job.projectId);
	});

	test("processor non-retryable failures stay terminal errors and block retry", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const jobId = uuid();
		const providerError = new Error("OpenAI image edit error 401 (invalid_api_key): Invalid API key") as Error & {
			code: string;
			retryable: boolean;
			retryAfterSeconds: number;
		};
		providerError.code = "invalid_api_key";
		providerError.retryable = false;
		providerError.retryAfterSeconds = 0;

		queue.onProcess(async () => {
			throw providerError;
		});

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test prompt",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		let failed = await queue.get(jobId);
		for (let attempt = 0; attempt < 50 && failed?.status !== "error"; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			failed = await queue.get(jobId);
		}
		// Defense-at-write: the persisted `job.error` is the allowlisted friendly
		// auth-category message, NOT the raw provider text (which echoed
		// "invalid_api_key"/"API key" and could carry a key fragment).
		expect(failed).toEqual(expect.objectContaining({
			status: "error",
			retryable: false,
			failureCode: "invalid_api_key",
			retryAfterSeconds: 0,
		}));
		expect(failed?.error).not.toContain(providerError.message);
		expect(failed?.error).not.toContain("invalid_api_key");
		expect(failed?.error).not.toContain("API key");
		expect(failed?.error).toBe("บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ");
		expect(await queue.retry(jobId)).toBeNull();
	});

	test("updating a job", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();

		const jobId = uuid();
		const job = {
			jobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		await queue.add(job);
		await queue.update(jobId, { status: "done", resultImageId: "result.png" });

		const updated = await queue.get(jobId);
		expect(updated).toBeDefined();
		expect(updated!.status).toBe("done");
		expect(updated!.resultImageId).toBe("result.png");
	});

	test("settles prototype credit reservations on terminal status", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();

		const doneJobId = uuid();
		const errorJobId = uuid();
		const baseJob = {
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			creditReservation: {
				status: "reserved" as const,
				amountThb: 5.75,
				currency: "THB" as const,
				createdAt: Date.now(),
			},
		};

		await queue.add({ ...baseJob, jobId: doneJobId });
		await queue.add({ ...baseJob, jobId: errorJobId, creditReservation: { ...baseJob.creditReservation } });

		await queue.update(doneJobId, { status: "done" });
		await queue.update(errorJobId, { status: "error", error: "provider failed" });

		expect((await queue.get(doneJobId))?.creditReservation?.status).toBe("captured");
		expect((await queue.get(errorJobId))?.creditReservation?.status).toBe("released");
		expect((await queue.eventsFor(doneJobId)).some((event) => event.type === "credit:captured")).toBe(true);
		expect((await queue.eventsFor(errorJobId)).some((event) => event.type === "credit:released")).toBe(true);
	});

	test("releases consumed shared credits when a job reaches a terminal failure", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const releaseCalls: Array<{ refId: string; reason: string }> = [];
		// 5th ctor arg: the credit-sharing release callback (refunds consumed credits by refId).
		const queue = new JobQueue(1, undefined, undefined, async () => null, (refId: string, reason: string) => {
			releaseCalls.push({ refId, reason });
			return [{ creditClass: "shareable" as const, amount: 5 }];
		});

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		await queue.update(jobId, { status: "error", error: "boom" });

		expect(releaseCalls).toEqual([{ refId: jobId, reason: "job_error" }]);
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:shared_released")).toBe(true);
	});

	test("concurrent queue mutations that take credit/usage locks inside the mutex complete without deadlock (lock order, money P1 #2)", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		// Inject credit/usage callbacks that YIELD the event loop while the queue
		// mutation lock is held — maximizing the chance for a second mutation to
		// interleave. The canonical order is queue-mutex → credit/usage locks (these
		// callbacks), and NONE of them re-acquire the queue mutex, so no opposite-order
		// nesting can form. Two concurrent terminal updates must therefore both SETTLE
		// rather than wedge; a regression that took the locks in conflicting orders
		// would hang past the timeout below.
		// A FILE-backed store provides the real per-file mutation lock (memory mode has
		// none), so the two concurrent updates genuinely serialize through the queue
		// mutex — the lock whose acquisition order #2 is about.
		const previousMode = process.env.AI_QUEUE_STORE;
		process.env.AI_QUEUE_STORE = "file";
		const dir = mkdtempSync(join(tmpdir(), "queue-lockorder-"));
		const persistPath = join(dir, "ai-jobs.json");
		try {
			const settleCalls: string[] = [];
			const queue = new JobQueue(
				1,
				persistPath,
				undefined,
				// settleUsageCredit — runs inside applyJobUpdate's withMutation (queue → usage).
				async (input: { jobId: string }) => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					settleCalls.push(input.jobId);
					return null;
				},
				// releaseSharedCredits — also inside the mutex (queue → credit).
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return [];
				},
			);

			const baseJob = {
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro" as const,
				status: "pending" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				creditReservation: { status: "reserved" as const, amountThb: 9, currency: "THB" as const, createdAt: Date.now() },
			};
			const jobA = uuid();
			const jobB = uuid();
			await queue.add({ ...baseJob, jobId: jobA });
			await queue.add({ ...baseJob, jobId: jobB, creditReservation: { ...baseJob.creditReservation } });

			// Fire two terminal transitions concurrently; each acquires the queue mutex
			// then the injected usage/credit locks (yielding mid-hold). Race against a
			// timeout so a deadlock surfaces as a rejection instead of hanging the suite.
			await Promise.race([
				Promise.all([
					queue.update(jobA, { status: "done" }),
					queue.update(jobB, { status: "error", error: "boom" }),
				]),
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("deadlock: concurrent queue mutations did not settle")), 5_000),
				),
			]);

			// Both settled — no deadlock — and each ran its usage settlement exactly once.
			expect(settleCalls.sort()).toEqual([jobA, jobB].sort());
		} finally {
			restoreEnv("AI_QUEUE_STORE", previousMode);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("does not release shared credits when a job completes successfully", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const releaseCalls: string[] = [];
		const queue = new JobQueue(1, undefined, undefined, async () => null, (refId: string) => {
			releaseCalls.push(refId);
			return [];
		});

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		await queue.update(jobId, { status: "done", resultImageId: "out.png" });

		expect(releaseCalls).toEqual([]);
	});

	test("re-charges shared credits when a refunded job is retried", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const previousDailyLimit = process.env.USAGE_DAILY_AI_CREDIT_THB;
		const previousMonthlyLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
		process.env.USAGE_DAILY_AI_CREDIT_THB = "1000";
		process.env.USAGE_MONTHLY_AI_CREDIT_THB = "1000";
		const jobId = uuid();
		const consumeCalls: Array<{ workspaceId: string; userId: string; amount: number; reason: string; refId?: string }> = [];
		// ctor args: maxConcurrent, persistPath, store, settleUsageCredit,
		// releaseSharedCredits, consumeSharedCredits.
		const queue = new JobQueue(
			1,
			undefined,
			undefined,
			async () => null,
			() => [],
			(workspaceId: string, userId: string, amount: number, reason: string, refId?: string) => {
				consumeCalls.push({ workspaceId, userId, amount, reason, refId });
				return { consumed: [{ creditClass: "shareable" as const, amount }], balance: { shareable: 0, personal: 0, total: 0 } };
			},
		);

		try {
			await queue.add({
				jobId,
				projectId: uuid(),
				imageId: `${uuid()}.png`,
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				creditReservation: { status: "reserved", amountThb: 5, currency: "THB", createdAt: Date.now() },
				// Credit bucket charged the size-flat per-op credit price (3), NOT the THB
				// reserve; the retry must re-consume the SAME credit price.
				creditConsumption: { workspaceId: "ws-r", userId: "user-r", consumedCredits: 3 },
			});

			await queue.update(jobId, { status: "error", error: "boom", retryable: true });
			const retry = await queue.retry(jobId);

			expect(retry).not.toBeNull();
			expect(consumeCalls).toHaveLength(1);
			expect(consumeCalls[0]).toMatchObject({ workspaceId: "ws-r", userId: "user-r", amount: 3, reason: "ai_job_retry", refId: retry!.jobId });
			expect(retry!.creditConsumption).toMatchObject({ workspaceId: "ws-r", userId: "user-r", consumedCredits: 3 });
		} finally {
			restoreEnv("USAGE_DAILY_AI_CREDIT_THB", previousDailyLimit);
			restoreEnv("USAGE_MONTHLY_AI_CREDIT_THB", previousMonthlyLimit);
		}
	});

	test("does NOT partially refund the credit bucket on capture (size-flat per-op price, no padding)", async () => {
		// The credit bucket is debited the size-flat per-op CREDIT price (1/9/36), not a
		// padded THB reserve, so a successful capture refunds NOTHING to the bucket — the
		// quoted credit price is the final charge. (Only the usage-ledger THB reservation
		// settles to its captured amount.) Regression guard for the over-/under-charge fix.
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const releaseCalls: Array<{ refId: string; reason: string }> = [];
		const queue = new JobQueue(
			1,
			undefined,
			undefined,
			async () => null,
			(refId: string, reason: string) => {
				releaseCalls.push({ refId, reason });
				return [];
			},
			() => ({ consumed: [], balance: { shareable: 0, personal: 0, total: 0 } }),
		);

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			costEstimate: { provider: "sfx-pro", currency: "THB", estimatedThb: 4, reserveThb: 10, creditUnits: 1, pricingVersion: "v1" } as any,
			creditReservation: { status: "reserved", amountThb: 10, reservedAmountThb: 10, currency: "THB", createdAt: Date.now() },
			creditConsumption: { workspaceId: "ws-c", userId: "user-c", consumedCredits: 1 },
		});

		await queue.update(jobId, { status: "done", resultImageId: "out.png" });

		// No bucket release on a successful capture, and no reserve-refund event.
		expect(releaseCalls).toHaveLength(0);
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:reserve_refunded")).toBe(false);
	});

	// --- LEGACY back-compat (pre-deploy in-flight jobs charged in THB) ---------
	// Jobs persisted BEFORE the size-flat credit-unit deploy recorded their bucket
	// debit as `consumedThb` (no `consumedCredits`). They MUST settle on their
	// ORIGINAL THB basis: re-charged on retry (not skipped) and reserve-refunded on
	// capture. Remove these tests once the pre-deploy in-flight queue drains.
	test("LEGACY consumedThb job: retry re-charges the THB basis (not skipped)", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const previousDailyLimit = process.env.USAGE_DAILY_AI_CREDIT_THB;
		const previousMonthlyLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
		process.env.USAGE_DAILY_AI_CREDIT_THB = "1000";
		process.env.USAGE_MONTHLY_AI_CREDIT_THB = "1000";
		const jobId = uuid();
		const consumeCalls: Array<{ workspaceId: string; userId: string; amount: number; reason: string; refId?: string }> = [];
		const queue = new JobQueue(
			1,
			undefined,
			undefined,
			async () => null,
			() => [],
			(workspaceId: string, userId: string, amount: number, reason: string, refId?: string) => {
				consumeCalls.push({ workspaceId, userId, amount, reason, refId });
				return { consumed: [{ creditClass: "shareable" as const, amount }], balance: { shareable: 0, personal: 0, total: 0 } };
			},
		);

		try {
			await queue.add({
				jobId,
				projectId: uuid(),
				imageId: `${uuid()}.png`,
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				creditReservation: { status: "reserved", amountThb: 5, currency: "THB", createdAt: Date.now() },
				// LEGACY: bucket was debited the THB reserve (4.3), no consumedCredits.
				creditConsumption: { workspaceId: "ws-l", userId: "user-l", consumedThb: 4.3 } as any,
			});

			await queue.update(jobId, { status: "error", error: "boom", retryable: true });
			const retry = await queue.retry(jobId);

			expect(retry).not.toBeNull();
			// MUST re-charge (not skip), on the SAME THB basis the source was charged.
			expect(consumeCalls).toHaveLength(1);
			expect(consumeCalls[0]).toMatchObject({ workspaceId: "ws-l", userId: "user-l", amount: 4.3, reason: "ai_job_retry", refId: retry!.jobId });
			// The retry preserves the legacy THB unit so its own capture reconciles correctly.
			expect(retry!.creditConsumption).toMatchObject({ workspaceId: "ws-l", userId: "user-l", consumedThb: 4.3 });
			expect((retry!.creditConsumption as any).consumedCredits).toBeUndefined();
		} finally {
			restoreEnv("USAGE_DAILY_AI_CREDIT_THB", previousDailyLimit);
			restoreEnv("USAGE_MONTHLY_AI_CREDIT_THB", previousMonthlyLimit);
		}
	});

	test("LEGACY consumedThb job: capture refunds the unused THB reserve padding", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const partialReleaseCalls: Array<{ refId: string; amount: number; reason: string }> = [];
		const queue = new JobQueue(
			1,
			undefined,
			undefined,
			async () => null,
			// releaseSharedCredits (terminal full refund) — unused here.
			() => [],
			// consumeSharedCredits — unused here.
			() => ({ consumed: [], balance: { shareable: 0, personal: 0, total: 0 } }),
			// releaseSharedReserve (legacy partial refund) — capture what is returned.
			(refId: string, amount: number, reason: string) => {
				partialReleaseCalls.push({ refId, amount, reason });
				return [{ creditClass: "shareable" as const, amount }];
			},
		);

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			// Captured 4 of a 10 THB reserve → 6 THB padding must be refunded.
			costEstimate: { provider: "sfx-pro", currency: "THB", estimatedThb: 4, reserveThb: 10, creditUnits: 1, pricingVersion: "v1" } as any,
			creditReservation: { status: "reserved", amountThb: 4, reservedAmountThb: 10, currency: "THB", createdAt: Date.now() },
			// LEGACY: bucket debited 10 THB (the reserve), no consumedCredits.
			creditConsumption: { workspaceId: "ws-lc", userId: "user-lc", consumedThb: 10 } as any,
		});

		await queue.update(jobId, { status: "done", resultImageId: "out.png" });

		// The unused 6 THB padding is refunded exactly once, on the THB basis.
		expect(partialReleaseCalls).toHaveLength(1);
		expect(partialReleaseCalls[0]).toMatchObject({ refId: jobId, amount: 6, reason: "ai_job_reserve_refund" });
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:reserve_refunded")).toBe(true);
	});

	test("persists terminal jobs and retries credit settlement after ledger failures", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		let settlementAttempts = 0;
		const queue = new JobQueue(1, undefined, undefined, async () => {
			settlementAttempts += 1;
			if (settlementAttempts === 1) throw new Error("ledger unavailable");
			return null;
		});

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			creditReservation: {
				status: "reserved",
				amountThb: 5,
				currency: "THB",
				createdAt: Date.now(),
			},
		});

		await queue.update(jobId, { status: "done", resultImageId: "result.png" });

		const afterFailure = await queue.get(jobId);
		expect(afterFailure?.status).toBe("done");
		expect(afterFailure?.resultImageId).toBe("result.png");
		expect(afterFailure?.creditReservation?.status).toBe("reserved");
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:settlement_failed")).toBe(true);

		await queue.update(jobId, { status: "done" });

		expect(settlementAttempts).toBe(2);
		expect((await queue.get(jobId))?.creditReservation?.status).toBe("captured");
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:captured")).toBe(true);
	});

	test("reconciler captures a done job whose reservation is still reserved after a capture outage (money P1)", async () => {
		// Regression (codex money P1 #2): if the credit CAPTURE at the `done`
		// transition fails (ledger outage → credit:settlement_failed), the job is
		// still marked `done` while its reservation stays `reserved`. `done` is not a
		// release-reconcile state and fires no further transition, so the reservation
		// would leak forever (never captured, never refunded). The reconciler must
		// retry the capture for done+reserved jobs so the invariant holds: every
		// settled job ends captured or released.
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		let captureAttempts = 0;
		// settleUsageCredit throws on the first (transition-time) capture, succeeds after.
		const queue = new JobQueue(
			1,
			undefined,
			undefined,
			async () => {
				captureAttempts += 1;
				if (captureAttempts === 1) throw new Error("ledger unavailable");
				return null;
			},
			() => [],
			() => ({ consumed: [], balance: { shareable: 0, personal: 0, total: 0 } }),
		);

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			// Reserve 10, estimate 4 → usage ledger captures the lower 4. The credit bucket
			// was charged the size-flat per-op price (1) and is NOT refunded on capture.
			costEstimate: { provider: "sfx-pro", currency: "THB", estimatedThb: 4, reserveThb: 10, creditUnits: 1, pricingVersion: "v1" } as any,
			creditReservation: { status: "reserved", amountThb: 10, reservedAmountThb: 10, currency: "THB", createdAt: Date.now() },
			creditConsumption: { workspaceId: "ws-x", userId: "user-x", consumedCredits: 1 },
		});

		// Capture fails at the done transition: job is done but reservation reserved.
		await queue.update(jobId, { status: "done", resultImageId: "out.png" });
		const afterOutage = await queue.get(jobId);
		expect(afterOutage?.status).toBe("done");
		expect(afterOutage?.creditReservation?.status).toBe("reserved");
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:settlement_failed")).toBe(true);

		// Reconciler retries the capture (no manual re-transition needed). The done job
		// must NOT be left with a dangling reserved reservation.
		await queue.reconcilePendingReservationReleases();
		expect(captureAttempts).toBe(2);
		const reconciled = await queue.get(jobId);
		expect(reconciled?.status).toBe("done");
		expect(reconciled?.creditReservation?.status).toBe("captured");
		expect(reconciled?.creditReservation?.amountThb).toBe(4);
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:captured")).toBe(true);
		// No credit-bucket refund on capture: the size-flat per-op price is the final charge.
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:reserve_refunded")).toBe(false);

		// Idempotent: a second reconcile finds no done+reserved job and does not re-capture.
		await queue.reconcilePendingReservationReleases();
		expect(captureAttempts).toBe(2);
	});

	test("reconciler retries needs_review reservation releases left pending by a ledger outage", async () => {
		// Regression (codex): a parked needs_review job is never claimed and fires no
		// later status transition, so if the one-shot release fails (ledger outage)
		// the reservation must be retried by the reconciler rather than leaking.
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		let attempts = 0;
		const queue = new JobQueue(1, undefined, undefined, async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("ledger unavailable");
			return null;
		});

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			creditReservation: {
				status: "reserved",
				amountThb: 5,
				currency: "THB",
				createdAt: Date.now(),
			},
		});

		// Park as needs_review; the terminal-release attempt fails (ledger down),
		// leaving the reservation reserved.
		await queue.update(jobId, { status: "needs_review" });
		expect((await queue.get(jobId))?.status).toBe("needs_review");
		expect((await queue.get(jobId))?.creditReservation?.status).toBe("reserved");
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:settlement_failed")).toBe(true);

		// Reconciler retries: ledger now succeeds, reservation is released.
		await queue.reconcilePendingReservationReleases();
		expect(attempts).toBe(2);
		expect((await queue.get(jobId))?.creditReservation?.status).toBe("released");
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "credit:released")).toBe(true);

		// Idempotent: a second reconcile finds nothing reserved and does not re-call.
		await queue.reconcilePendingReservationReleases();
		expect(attempts).toBe(2);
	});

	test("captures only estimated AI credit and leaves the reserve buffer unused", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const jobId = uuid();

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			costEstimate: {
				tier: "sfx-pro",
				providerHint: "openai-gpt-image-2",
				currency: "THB",
				quality: "low",
				megapixels: 0.01,
				estimatedThb: 6.25,
				reserveThb: 10,
				pricingVersion: "test",
			},
			creditReservation: {
				status: "reserved",
				amountThb: 10,
				currency: "THB",
				createdAt: Date.now(),
			},
		});

		await queue.update(jobId, { status: "done", resultImageId: "result.png" });
		const job = await queue.get(jobId);
		const capturedEvent = (await queue.eventsFor(jobId)).find((event) => event.type === "credit:captured");

		expect(job?.creditReservation).toEqual(expect.objectContaining({
			status: "captured",
			amountThb: 6.25,
			reservedAmountThb: 10,
		}));
		expect(capturedEvent?.metadata).toEqual(expect.objectContaining({
			amountThb: 6.25,
			reservedAmountThb: 10,
			releasedAmountThb: 3.75,
		}));
	});

	test("cancelled jobs stay cancelled when a late processor update arrives", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const jobId = uuid();

		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			creditReservation: {
				status: "reserved",
				amountThb: 5,
				currency: "THB",
				createdAt: Date.now(),
			},
		});

		expect(await queue.cancel(jobId)).toBe(true);
		await queue.update(jobId, { status: "done", resultImageId: "late-result.png" });

		const job = await queue.get(jobId);
		expect(job?.status).toBe("cancelled");
		expect(job?.resultImageId).toBeUndefined();
		expect(job?.creditReservation?.status).toBe("released");
		expect((await queue.eventsFor(jobId)).some((event) => event.type === "status:ignored_after_cancel")).toBe(true);
	});

	test("cancel supports pre-processing policy and credit wait statuses", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();

		for (const status of ["policy_checking", "waiting_credit"] as const) {
			const jobId = uuid();
			await queue.add({
				jobId,
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			expect(await queue.cancel(jobId)).toBe(true);
			expect((await queue.get(jobId))?.status).toBe("cancelled");
		}
	});

	test("cancel fires the registered cleanup hook with the cancelled job (pending path)", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		queue.clearCancelCleanupHooksForTesting();

		const seen: Array<{ projectId: string; jobId: string; status: string }> = [];
		queue.onCancelCleanup((job) => {
			seen.push({ projectId: job.projectId, jobId: job.jobId, status: job.status });
		});

		const jobId = uuid();
		const projectId = uuid();
		await queue.add({
			jobId,
			projectId,
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		expect(await queue.cancel(jobId)).toBe(true);
		expect(seen).toEqual([{ projectId, jobId, status: "cancelled" }]);
	});

	test("a throwing cleanup hook never breaks cancel (best-effort)", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		queue.clearCancelCleanupHooksForTesting();
		queue.onCancelCleanup(() => {
			throw new Error("boom");
		});

		const jobId = uuid();
		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		expect(await queue.cancel(jobId)).toBe(true);
		expect((await queue.get(jobId))?.status).toBe("cancelled");
	});

	test("cancelling a job that parked a provider checkpoint reaps aijob_provider_<jobId>.png", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { registerAiJobCancelCleanup, providerCheckpointImageId } = await import("../services/ai-router.js");
		const { objectStorage } = await import("../services/storage.js");
		const { v4: uuid } = await import("uuid");

		const queue = new JobQueue();
		queue.clearCancelCleanupHooksForTesting();
		// `registerAiJobCancelCleanup` is idempotent across the process (module-level
		// guard), so wire the reaper onto THIS queue directly to keep the test hermetic.
		queue.onCancelCleanup(async (job) => {
			const { cleanupProviderCheckpointArtifact } = await import("../services/ai-router.js");
			await cleanupProviderCheckpointArtifact(job.projectId, job.jobId);
		});
		void registerAiJobCancelCleanup; // referenced for the wiring under test

		const jobId = uuid();
		const projectId = uuid();
		const checkpointImageId = providerCheckpointImageId(jobId);
		expect(checkpointImageId).toBe(`aijob_provider_${jobId}.png`);

		// A processing job that has already parked its provider checkpoint artifact.
		await objectStorage.putProjectImage({ projectId, imageId: checkpointImageId, buffer: Buffer.from("checkpoint-bytes") });
		expect(objectStorage.hasProjectImage({ projectId, imageId: checkpointImageId })).toBe(true);

		await queue.add({
			jobId,
			projectId,
			imageId: "src.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "processing",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		expect(await queue.cancel(jobId)).toBe(true);
		expect((await queue.get(jobId))?.status).toBe("cancelled");
		// Bug2: the orphaned provider checkpoint is reaped on cancel.
		expect(objectStorage.hasProjectImage({ projectId, imageId: checkpointImageId })).toBe(false);

		// Idempotent: cleaning up an already-gone artifact must not throw.
		const { cleanupProviderCheckpointArtifact } = await import("../services/ai-router.js");
		await cleanupProviderCheckpointArtifact(projectId, jobId);
		expect(objectStorage.hasProjectImage({ projectId, imageId: checkpointImageId })).toBe(false);
	});

	test("cancelling an active processor does not free the concurrency slot early", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue(1);
		const releases: Array<() => void> = [];

		queue.onProcess(async () => {
			await new Promise<void>((resolve) => releases.push(resolve));
		});

		const firstJobId = uuid();
		const secondJobId = uuid();
		const baseJob = {
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		await queue.add({ ...baseJob, jobId: firstJobId });
		await queue.add({ ...baseJob, jobId: secondJobId });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect((await queue.get(firstJobId))?.status).toBe("processing");
		expect((await queue.get(secondJobId))?.status).toBe("pending");
		expect(queue.activeCount()).toBe(1);

		expect(await queue.cancel(firstJobId)).toBe(true);
		expect((await queue.get(firstJobId))?.status).toBe("cancelled");
		expect((await queue.get(secondJobId))?.status).toBe("pending");
		expect(queue.activeCount()).toBe(1);

		releases.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect((await queue.get(secondJobId))?.status).toBe("processing");
		expect(queue.activeCount()).toBe(1);
		releases.shift()?.();
		expect(await queue.waitForIdle(1000)).toBe(true);
	});

	test("getting non-existent job returns undefined", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const queue = new JobQueue();
		const result = await queue.get("non-existent-id");
		expect(result).toBeUndefined();
	});

	test("updating non-existent job does nothing", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const queue = new JobQueue();
		await expect(queue.update("non-existent", { status: "done" })).resolves.toBe(false);
	});

	test("draining queue stops accepting and starting jobs", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		queue.pause();

		expect(queue.isDraining()).toBe(true);
		expect((await queue.stats()).draining).toBe(true);
		expect(queue.activeCount()).toBe(0);
		expect(await queue.waitForIdle(10)).toBe(true);
		await expect(queue.add({
			jobId: uuid(),
			projectId: uuid(),
			imageId: `${uuid()}.png`,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})).rejects.toThrow("draining");
	});

	test("idempotency key returns the existing job", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const baseJob = {
			jobId: uuid(),
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const duplicateJob = { ...baseJob, jobId: uuid() };

		const first = await queue.add(baseJob, { idempotencyKey: "same-request" });
		const second = await queue.add(duplicateJob, { idempotencyKey: "same-request" });

		expect(first.jobId).toBe(baseJob.jobId);
		expect(second.jobId).toBe(baseJob.jobId);
		expect((await queue.stats()).total).toBe(1);
		expect((await queue.eventsFor(baseJob.jobId)).length).toBeGreaterThan(0);
	});

	test("claimIdempotency: first caller claims, a concurrent peer sees pending, then reuse after add (money P1 #1)", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const key = "ai-submit:race";
		const winnerJobId = uuid();
		const loserJobId = uuid();

		// Winner claims the key exclusively.
		const winnerClaim = await queue.claimIdempotency([key], winnerJobId);
		expect(winnerClaim.status).toBe("claimed");

		// A concurrent peer (different jobId) that tries to claim the SAME key while the
		// winner has not yet added its job must NOT get its own claim — it learns a peer
		// owns the key and is told to wait for that jobId. This is what stops the loser
		// from charging credits / reserving usage in parallel.
		const loserClaim = await queue.claimIdempotency([key], loserJobId);
		expect(loserClaim.status).toBe("pending");
		expect(loserClaim.status === "pending" && loserClaim.jobId).toBe(winnerJobId);

		// The dangling claim does NOT masquerade as a real job.
		expect(await queue.getByIdempotencyKey(key)).toBeUndefined();

		// Winner materializes its real job under the claimed key.
		const job = {
			jobId: winnerJobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const added = await queue.add(job, { idempotencyKey: key });
		expect(added.jobId).toBe(winnerJobId);

		// Now a re-claim resolves to the REAL winning job (reused), and exactly one job exists.
		const afterAdd = await queue.claimIdempotency([key], uuid());
		expect(afterAdd.status).toBe("reused");
		expect(afterAdd.status === "reused" && afterAdd.job.jobId).toBe(winnerJobId);
		expect((await queue.stats()).total).toBe(1);
	});

	test("releaseIdempotencyClaim frees a claim whose owner failed before add, and never deletes a real job's mapping (money P1 #1)", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const key = "ai-submit:release";
		const ownerJobId = uuid();

		expect((await queue.claimIdempotency([key], ownerJobId)).status).toBe("claimed");
		// Owner failed before add → release its claim. A fresh caller can now claim.
		await queue.releaseIdempotencyClaim([key], ownerJobId);
		const reclaim = await queue.claimIdempotency([key], uuid());
		expect(reclaim.status).toBe("claimed");

		// Materialize a real job under the same key, then a spurious release MUST NOT
		// delete the live mapping (the key now points at a real job, not a claim).
		const realJobId = uuid();
		await queue.add({
			jobId: realJobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}, { idempotencyKey: key });
		await queue.releaseIdempotencyClaim([key], realJobId); // job exists → must NOT delete
		expect((await queue.getByIdempotencyKey(key))?.jobId).toBe(realJobId);
	});

	test("takeOverStaleIdempotencyClaim reports the dead owner CHARGED, fences its late add, and reassigns the key (money P1 #2)", async () => {
		const { JobQueue, QueueClaimStolenError } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const key = "ai-submit:takeover";
		const deadJobId = uuid();
		const takerJobId = uuid();

		// Dead owner claims, then "charges" (marks charged) but never adds.
		expect((await queue.claimIdempotency([key], deadJobId)).status).toBe("claimed");
		await queue.markIdempotencyClaimCharged([key], deadJobId);

		// Taker takes over the stale claim: learns it was CHARGED (so must reconcile
		// billing) and the key is reassigned to the taker (fencing the dead/slow owner).
		const takeover = await queue.takeOverStaleIdempotencyClaim([key], deadJobId, takerJobId);
		expect(takeover.status).toBe("taken");
		expect(takeover.status === "taken" && takeover.charged).toBe(true);
		expect(takeover.status === "taken" && takeover.staleJobId).toBe(deadJobId);

		// FENCE: the late/slow original owner's add() with its own fencing token is
		// rejected (claim stolen) instead of materializing a SECOND active job.
		const lateJob = {
			jobId: deadJobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		let thrown: unknown;
		try {
			await queue.add(lateJob, { idempotencyKey: key, expectClaimJobId: deadJobId });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(QueueClaimStolenError);
		expect((await queue.stats()).total).toBe(0);

		// The taker, owning the claim, can materialize its real job under the key.
		const added = await queue.add({ ...lateJob, jobId: takerJobId }, { idempotencyKey: key, expectClaimJobId: takerJobId });
		expect(added.jobId).toBe(takerJobId);
		expect((await queue.stats()).total).toBe(1);
	});

	test("takeOverStaleIdempotencyClaim yields to a real job that materialized while waiting (no takeover)", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const key = "ai-submit:takeover-reused";
		const winnerJobId = uuid();

		await queue.add({
			jobId: winnerJobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}, { idempotencyKey: key });

		const takeover = await queue.takeOverStaleIdempotencyClaim([key], uuid(), uuid());
		expect(takeover.status).toBe("reused");
		expect(takeover.status === "reused" && takeover.job.jobId).toBe(winnerJobId);
	});

	test("a not-yet-charged stale claim is taken over with charged=false (nothing to reconcile)", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const key = "ai-submit:takeover-uncharged";
		const deadJobId = uuid();
		expect((await queue.claimIdempotency([key], deadJobId)).status).toBe("claimed");
		// No markIdempotencyClaimCharged — owner died before charging.
		const takeover = await queue.takeOverStaleIdempotencyClaim([key], deadJobId, uuid());
		expect(takeover.status).toBe("taken");
		expect(takeover.status === "taken" && takeover.charged).toBe(false);
	});

	test("idempotency aliases resolve to the same queued job", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const baseJob = {
			jobId: uuid(),
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const duplicateJob = { ...baseJob, jobId: uuid() };

		const first = await queue.add(baseJob, {
			idempotencyKey: "hashed-request",
			idempotencyAliases: ["legacy-request"],
		});
		const replay = await queue.add(duplicateJob, { idempotencyKey: "legacy-request" });

		expect(first.jobId).toBe(baseJob.jobId);
		expect(replay.jobId).toBe(baseJob.jobId);
		expect((await queue.getByIdempotencyKey("hashed-request"))?.jobId).toBe(baseJob.jobId);
		expect((await queue.getByIdempotencyKey("legacy-request"))?.jobId).toBe(baseJob.jobId);
		expect((await queue.stats()).total).toBe(1);
	});

	test("idempotency alias registration backfills existing queued jobs", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const baseJob = {
			jobId: uuid(),
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		await queue.add(baseJob, { idempotencyKey: "hashed-request" });
		const aliased = await queue.registerIdempotencyAlias(baseJob.jobId, "legacy-request");

		expect(aliased?.jobId).toBe(baseJob.jobId);
		expect((await queue.getByIdempotencyKey("hashed-request"))?.jobId).toBe(baseJob.jobId);
		expect((await queue.getByIdempotencyKey("legacy-request"))?.jobId).toBe(baseJob.jobId);
		expect((await queue.stats()).total).toBe(1);
	});

	test("retry creates a new queued job with a fresh credit reservation", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { estimateAiJobCost } = await import("../services/cost-estimator.js");
		const { v4: uuid } = await import("uuid");
		const previousDailyLimit = process.env.USAGE_DAILY_AI_CREDIT_THB;
		const previousMonthlyLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
		process.env.USAGE_DAILY_AI_CREDIT_THB = "1000";
		process.env.USAGE_MONTHLY_AI_CREDIT_THB = "1000";
		const queue = new JobQueue();
		const sourceJobId = uuid();
		const staleCostEstimate = estimateAiJobCost({ tier: "sfx-pro", crop: { w: 100, h: 100 }, quality: "low" });
		const retryCostEstimate = estimateAiJobCost({ tier: "sfx-pro", crop: { w: 1024, h: 1024 }, quality: "high", prompt: "retry with current pricing" });

		try {
			await queue.add({
				jobId: sourceJobId,
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				quality: "low",
				costEstimate: {
					...staleCostEstimate,
					pricingVersion: "legacy-stale-pricing",
					reserveThb: 5,
				},
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				creditReservation: {
					status: "reserved",
					amountThb: 5,
					currency: "THB",
					createdAt: Date.now(),
				},
			});
			await queue.update(sourceJobId, { status: "error", error: "provider failed" });

			const retry = await queue.retry(sourceJobId, { costEstimate: retryCostEstimate });

			expect(retry?.jobId).toBeDefined();
			expect(retry?.jobId).not.toBe(sourceJobId);
			expect(retry?.status).toBe("pending");
			expect(retry?.creditReservation?.status).toBe("reserved");
			expect(retry?.quality).toBe(retryCostEstimate.quality);
			expect(retry?.costEstimate?.pricingVersion).toBe(retryCostEstimate.pricingVersion);
			expect(retry?.creditReservation?.amountThb).toBe(retryCostEstimate.reserveThb);
			expect(retry?.creditReservation?.amountThb).not.toBe(5);
			expect((await queue.eventsFor(sourceJobId)).some((event) => event.type === "retry:created")).toBe(true);
			expect((await queue.eventsFor(retry!.jobId)).some((event) => event.type === "retry:from")).toBe(true);
		} finally {
			if (previousDailyLimit === undefined) {
				delete process.env.USAGE_DAILY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_DAILY_AI_CREDIT_THB = previousDailyLimit;
			}
			if (previousMonthlyLimit === undefined) {
				delete process.env.USAGE_MONTHLY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_MONTHLY_AI_CREDIT_THB = previousMonthlyLimit;
			}
		}
	});

	test("retrying a BYO-queued job stays on the no-credit path", async () => {
		// Regression for the BYO retry finding: a job admitted on the BYO path has
		// no credit reservation; retrying it (even with a recomputed cost estimate,
		// which the retry route always passes) must NOT reserve workspace credits.
		const { JobQueue } = await import("../services/queue.js");
		const { estimateAiJobCost } = await import("../services/cost-estimator.js");
		const { v4: uuid } = await import("uuid");
		const previousDailyLimit = process.env.USAGE_DAILY_AI_CREDIT_THB;
		const previousMonthlyLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
		process.env.USAGE_DAILY_AI_CREDIT_THB = "1000";
		process.env.USAGE_MONTHLY_AI_CREDIT_THB = "1000";
		const queue = new JobQueue();
		const sourceJobId = uuid();
		const byoCostEstimate = estimateAiJobCost({ tier: "sfx-pro", crop: { w: 100, h: 100 }, quality: "low" });
		const retryCostEstimate = estimateAiJobCost({ tier: "sfx-pro", crop: { w: 1024, h: 1024 }, quality: "high", prompt: "retry with current pricing" });

		try {
			await queue.add({
				jobId: sourceJobId,
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				quality: "low",
				costEstimate: byoCostEstimate,
				byoQueued: true,
				creditReservation: undefined,
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await queue.update(sourceJobId, { status: "error", error: "provider failed" });

			const retry = await queue.retry(sourceJobId, { costEstimate: retryCostEstimate });

			expect(retry?.jobId).toBeDefined();
			expect(retry?.jobId).not.toBe(sourceJobId);
			expect(retry?.status).toBe("pending");
			expect(retry?.byoQueued).toBe(true);
			// The key assertion: NO credit reservation despite a passed cost estimate.
			expect(retry?.creditReservation).toBeUndefined();
			// Cost estimate is still preserved for display.
			expect(retry?.costEstimate?.pricingVersion).toBe(retryCostEstimate.pricingVersion);
		} finally {
			if (previousDailyLimit === undefined) {
				delete process.env.USAGE_DAILY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_DAILY_AI_CREDIT_THB = previousDailyLimit;
			}
			if (previousMonthlyLimit === undefined) {
				delete process.env.USAGE_MONTHLY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_MONTHLY_AI_CREDIT_THB = previousMonthlyLimit;
			}
		}
	});

	test("retry is idempotent for repeated retry requests", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const previousDailyLimit = process.env.USAGE_DAILY_AI_CREDIT_THB;
		const previousMonthlyLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
		process.env.USAGE_DAILY_AI_CREDIT_THB = "1000";
		process.env.USAGE_MONTHLY_AI_CREDIT_THB = "1000";
		const queue = new JobQueue();
		const sourceJobId = uuid();

		try {
			await queue.add({
				jobId: sourceJobId,
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				creditReservation: {
					status: "reserved",
					amountThb: 5,
					currency: "THB",
					createdAt: Date.now(),
				},
			});
			await queue.update(sourceJobId, { status: "error", error: "provider failed" });

			const first = await queue.retry(sourceJobId);
			const second = await queue.retry(sourceJobId);

			expect(first?.jobId).toBeDefined();
			expect(second?.jobId).toBe(first?.jobId);
			expect((await queue.stats()).total).toBe(2);
		} finally {
			if (previousDailyLimit === undefined) {
				delete process.env.USAGE_DAILY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_DAILY_AI_CREDIT_THB = previousDailyLimit;
			}
			if (previousMonthlyLimit === undefined) {
				delete process.env.USAGE_MONTHLY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_MONTHLY_AI_CREDIT_THB = previousMonthlyLimit;
			}
		}
	});

	test("retry idempotency keys cannot reuse a job from another source project", async () => {
		const { JobQueue, QueueIdempotencyConflictError } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const previousDailyLimit = process.env.USAGE_DAILY_AI_CREDIT_THB;
		const previousMonthlyLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
		process.env.USAGE_DAILY_AI_CREDIT_THB = "1000";
		process.env.USAGE_MONTHLY_AI_CREDIT_THB = "1000";
		const queue = new JobQueue();
		const sharedKey = "client-retry-key";
		const firstSourceId = uuid();
		const secondSourceId = uuid();

		try {
			for (const sourceId of [firstSourceId, secondSourceId]) {
				await queue.add({
					jobId: sourceId,
					projectId: uuid(),
					imageId: "test.png",
					crop: { x: 0, y: 0, w: 100, h: 100 },
					lang: "th",
					prompt: "test",
					tier: "sfx-pro",
					status: "pending",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				await queue.update(sourceId, { status: "error", error: "provider failed" });
			}

			const firstRetry = await queue.retry(firstSourceId, { idempotencyKey: sharedKey });
			await expect(queue.retry(secondSourceId, { idempotencyKey: sharedKey })).rejects.toBeInstanceOf(QueueIdempotencyConflictError);
			expect((await queue.getByIdempotencyKey(sharedKey))?.jobId).toBe(firstRetry?.jobId);
		} finally {
			if (previousDailyLimit === undefined) {
				delete process.env.USAGE_DAILY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_DAILY_AI_CREDIT_THB = previousDailyLimit;
			}
			if (previousMonthlyLimit === undefined) {
				delete process.env.USAGE_MONTHLY_AI_CREDIT_THB;
			} else {
				process.env.USAGE_MONTHLY_AI_CREDIT_THB = previousMonthlyLimit;
			}
		}
	});

	test("retry applies admission limits before creating a reserved job", async () => {
		const { JobQueue, QueueAdmissionError } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue();
		const sourceJobId = uuid();

		await queue.add({
			jobId: sourceJobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			creditReservation: {
				status: "reserved",
				amountThb: 5,
				currency: "THB",
				createdAt: Date.now(),
			},
		});
		await queue.update(sourceJobId, { status: "error", error: "provider failed" });

		await expect(queue.retry(sourceJobId, {
			admissionLimits: {
				maxOpenJobs: 0,
				maxPendingJobs: 10,
				maxProjectOpenJobs: 10,
				maxProjectPendingJobs: 10,
				maxProjectReservedThb: 1000,
				maxTierOpenJobs: { "sfx-pro": 10 },
				retryAfterSeconds: 11,
			},
		})).rejects.toBeInstanceOf(QueueAdmissionError);
		expect((await queue.stats()).total).toBe(1);
		expect(await queue.getByIdempotencyKey(`retry:${sourceJobId}`)).toBeUndefined();
	});

	test("redis-style mutation locks preserve concurrent queue updates", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		let snapshot: QueueSnapshot = { jobs: [], events: [], idempotency: [] };
		let lock = Promise.resolve();
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				await new Promise((resolve) => setTimeout(resolve, 2));
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				await new Promise((resolve) => setTimeout(resolve, 2));
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				const previous = lock;
				let release!: () => void;
				lock = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
				try {
					return await operation();
				} finally {
					release();
				}
			},
		};

		const queueA = new JobQueue(1, undefined, store);
		const queueB = new JobQueue(1, undefined, store);
		const projectId = uuid();
		const baseJob = {
			projectId,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		await Promise.all([
			queueA.add({ ...baseJob, jobId: uuid(), imageId: "a.png" }),
			queueB.add({ ...baseJob, jobId: uuid(), imageId: "b.png" }),
		]);

		const recovered = new JobQueue(1, undefined, store);
		expect((await recovered.stats()).total).toBe(2);
	});

	test("redis-backed queues do not recover live processing jobs on startup", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const snapshot: QueueSnapshot = {
			jobs: [{
				jobId,
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "processing",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}],
			events: [],
			idempotency: [],
		};
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save() {
				throw new Error("redis startup recovery should not rewrite live processing jobs");
			},
		};

		const recovered = new JobQueue(1, undefined, store);
		expect((await recovered.get(jobId))?.status).toBe("processing");
	});

	test("redis-backed queues recover expired processing leases when claiming work", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		let snapshot: QueueSnapshot = {
			jobs: [{
				jobId,
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "processing",
				processorId: "dead-worker",
				leaseExpiresAt: Date.now() - 1000,
				heartbeatAt: Date.now() - 10_000,
				createdAt: Date.now(),
				updatedAt: Date.now() - 10_000,
			}],
			events: [],
			idempotency: [],
		};
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				return operation();
			},
		};
		const queue = new JobQueue(1, undefined, store);
		queue.onProcess(async () => {});

		await new Promise((resolve) => setTimeout(resolve, 20));
		const recoveredJob = snapshot.jobs.find((job) => job.jobId === jobId);
		expect(recoveredJob?.status).toBe("processing");
		expect(recoveredJob?.processorId).toBeDefined();
		expect((snapshot.events.find(([id]) => id === jobId)?.[1] ?? []).some((event) => event.type === "status:pending")).toBe(true);
	});

	test("redis-backed queues recover expired processing leases without a new queue event", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const previousRecoveryInterval = process.env.AI_QUEUE_RECOVERY_INTERVAL_MS;
		process.env.AI_QUEUE_RECOVERY_INTERVAL_MS = "10";
		const jobId = uuid();
		let snapshot: QueueSnapshot = {
			jobs: [{
				jobId,
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "processing",
				processorId: "dead-worker",
				leaseExpiresAt: Date.now() + 25,
				heartbeatAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}],
			events: [],
			idempotency: [],
		};
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				return operation();
			},
		};

		try {
			let processed = 0;
			const queue = new JobQueue(1, undefined, store);
			queue.onProcess(async () => {
				processed += 1;
			});

			const deadline = Date.now() + 250;
			while (processed === 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			const recoveredJob = snapshot.jobs.find((job) => job.jobId === jobId);
			expect(processed).toBe(1);
			expect(recoveredJob?.status).toBe("processing");
			expect(recoveredJob?.processorId).toBeDefined();
			expect(recoveredJob?.processorId).not.toBe("dead-worker");
			expect((snapshot.events.find(([id]) => id === jobId)?.[1] ?? []).some((event) => event.type === "status:pending")).toBe(true);
		} finally {
			if (previousRecoveryInterval === undefined) {
				delete process.env.AI_QUEUE_RECOVERY_INTERVAL_MS;
			} else {
				process.env.AI_QUEUE_RECOVERY_INTERVAL_MS = previousRecoveryInterval;
			}
		}
	});

	test("redis-backed queues keep cancelled in-flight jobs leased until the processor exits", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		let snapshot: QueueSnapshot = { jobs: [], events: [], idempotency: [] };
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				return operation();
			},
		};
		const projectId = uuid();
		const firstJobId = uuid();
		const secondJobId = uuid();
		const baseJob = {
			projectId,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const releaseFirst: Array<() => void> = [];
		const queueA = new JobQueue(1, undefined, store);
		queueA.onProcess(async () => {
			await new Promise<void>((resolve) => releaseFirst.push(resolve));
		});
		await queueA.add({ ...baseJob, jobId: firstJobId, imageId: "first.png" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		let queueBStarted = false;
		const queueB = new JobQueue(1, undefined, store);
		queueB.onProcess(async () => {
			queueBStarted = true;
		});
		await queueB.add({ ...baseJob, jobId: secondJobId, imageId: "second.png" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(snapshot.jobs.find((job) => job.jobId === firstJobId)?.status).toBe("processing");
		expect(snapshot.jobs.find((job) => job.jobId === secondJobId)?.status).toBe("pending");

		expect(await queueB.cancel(firstJobId)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const cancelled = snapshot.jobs.find((job) => job.jobId === firstJobId);
		expect(cancelled?.status).toBe("cancelled");
		expect(cancelled?.processorId).toBeDefined();
		expect(cancelled?.leaseExpiresAt).toBeGreaterThan(Date.now());
		expect(snapshot.jobs.find((job) => job.jobId === secondJobId)?.status).toBe("pending");
		expect(queueBStarted).toBe(false);

		releaseFirst.shift()?.();
		const deadline = Date.now() + 250;
		while (snapshot.jobs.find((job) => job.jobId === secondJobId)?.status !== "processing" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(snapshot.jobs.find((job) => job.jobId === firstJobId)?.processorId).toBeUndefined();
		expect(snapshot.jobs.find((job) => job.jobId === secondJobId)?.status).toBe("processing");
	});

	test("redis-backed queues ignore stale processor updates after a lease changes", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const projectId = uuid();
		let snapshot: QueueSnapshot = {
			jobs: [{
				jobId,
				projectId,
				imageId: "stale.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "processing",
				attempts: 2,
				processorId: "processor-new",
				leaseExpiresAt: Date.now() + 60_000,
				heartbeatAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}],
			events: [],
			idempotency: [],
		};
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				return operation();
			},
		};

		const queue = new JobQueue(1, undefined, store);
		const applied = await queue.updateFromProcessor({
			...snapshot.jobs[0],
			attempts: 1,
			processorId: "processor-old",
		}, { status: "done", resultImageId: "late-result.png" });

		expect(applied).toBe(false);
		expect(snapshot.jobs[0].status).toBe("processing");
		expect(snapshot.jobs[0].resultImageId).toBeUndefined();
		expect(snapshot.events[0][1].some((event) => event.type === "status:ignored_stale_processor")).toBe(true);
	});

	test("redis-backed queues refresh cancelled leases owned by the active processor", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const projectId = uuid();
		let snapshot: QueueSnapshot = { jobs: [], events: [], idempotency: [] };
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				return operation();
			},
		};
		const queue = new JobQueue(1, undefined, store);
		const processorId = (queue as unknown as { processorId: string }).processorId;
		const previousLeaseExpiresAt = Date.now() + 10;
		snapshot.jobs = [{
			jobId,
			projectId,
			imageId: "cancelled.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "cancelled",
			attempts: 1,
			processorId,
			leaseExpiresAt: previousLeaseExpiresAt,
			heartbeatAt: previousLeaseExpiresAt - 100,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}];

		await (queue as unknown as { refreshProcessingLease: (id: string) => Promise<void> }).refreshProcessingLease(jobId);

		expect(snapshot.jobs[0].leaseExpiresAt).toBeGreaterThan(previousLeaseExpiresAt);
		expect(snapshot.jobs[0].heartbeatAt).toBeGreaterThan(previousLeaseExpiresAt - 100);
	});

	test("redis snapshot lock release failures do not mask committed mutations", async () => {
		const { RedisQueueSnapshotStore } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const store = new RedisQueueSnapshotStore(undefined, `queue-lock-release-${uuid()}`);
		(store as unknown as { client: { send: (command: string) => Promise<unknown> } }).client = {
			async send(command: string) {
				if (command === "SET") return "OK";
				if (command === "EVAL") throw new Error("release failed");
				return null;
			},
		};

		await expect(store.withMutationLock(async () => "committed")).resolves.toBe("committed");
	});

	test("redis snapshot locks renew while long mutations are active", async () => {
		const { RedisQueueSnapshotStore } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const previousTtl = process.env.AI_QUEUE_REDIS_LOCK_TTL_MS;
		process.env.AI_QUEUE_REDIS_LOCK_TTL_MS = "60";
		const store = new RedisQueueSnapshotStore(undefined, `queue-lock-renew-${uuid()}`);
		let renewals = 0;
		(store as unknown as { client: { send: (command: string, args?: unknown[]) => Promise<unknown> } }).client = {
			async send(command: string, args?: unknown[]) {
				if (command === "SET") return "OK";
				if (command === "EVAL") {
					const script = String(args?.[0] ?? "");
					if (script.includes("PEXPIRE")) renewals += 1;
					return 1;
				}
				return null;
			},
		};

		try {
			await expect(store.withMutationLock(async () => {
				await new Promise((resolve) => setTimeout(resolve, 90));
				return "committed";
			})).resolves.toBe("committed");
		} finally {
			if (previousTtl === undefined) delete process.env.AI_QUEUE_REDIS_LOCK_TTL_MS;
			else process.env.AI_QUEUE_REDIS_LOCK_TTL_MS = previousTtl;
		}
		expect(renewals).toBeGreaterThan(0);
	});

	test("redis store imports a legacy file snapshot before switching stores", async () => {
		const { RedisQueueSnapshotStore } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const dir = mkdtempSync(join(tmpdir(), "manga-queue-legacy-"));
		const legacyPath = join(dir, "ai-jobs.json");
		const jobId = uuid();
		const projectId = uuid();
		writeFileSync(legacyPath, JSON.stringify({
			jobs: [{
				jobId,
				projectId,
				imageId: "legacy.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "legacy",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}],
			events: [[jobId, [{
				jobId,
				type: "queued",
				message: "Job queued",
				createdAt: Date.now(),
			}]]],
			idempotency: [["legacy-key", jobId]],
		}));
		const hashes = new Map<string, Map<string, string>>();
		const strings = new Map<string, string>();
		const store = new RedisQueueSnapshotStore(undefined, `queue-legacy-import-${uuid()}`, legacyPath);
		(store as unknown as { client: { send: (command: string, args?: string[]) => Promise<unknown> } }).client = {
			async send(command: string, args: string[] = []) {
				if (command === "HGETALL") return [...(hashes.get(args[0]) ?? new Map()).entries()].flat();
				if (command === "HGET") return hashes.get(args[0])?.get(args[1]) ?? null;
				if (command === "GET") return strings.get(args[0]) ?? null;
				if (command === "SET") {
					strings.set(args[0], args[1]);
					return "OK";
				}
				if (command === "EVAL") {
					// EVAL args layout: [lua, numKeys, jobsKey, eventsKey, idempotencyKey,
					// idempotencyClaimsKey, legacyKey, lockKey, terminalProjectionsKey,
					// lockToken, jobCount, ...].
					const jobsKey = args[2];
					const eventsKey = args[3];
					const idempotencyKey = args[4];
					const idempotencyClaimsKey = args[5];
					const terminalProjectionsKey = args[8];
					hashes.set(jobsKey, new Map());
					hashes.set(eventsKey, new Map());
					hashes.set(idempotencyKey, new Map());
					hashes.set(idempotencyClaimsKey, new Map());
					hashes.set(terminalProjectionsKey, new Map());
					let offset = 10;
					const jobCount = Number(args[offset]);
					offset += 1;
					for (let index = 0; index < jobCount; index += 1) {
						hashes.get(jobsKey)?.set(args[offset], args[offset + 1]);
						offset += 2;
					}
					const eventCount = Number(args[offset]);
					offset += 1;
					for (let index = 0; index < eventCount; index += 1) {
						hashes.get(eventsKey)?.set(args[offset], args[offset + 1]);
						offset += 2;
					}
					const idemCount = Number(args[offset]);
					offset += 1;
					for (let index = 0; index < idemCount; index += 1) {
						hashes.get(idempotencyKey)?.set(args[offset], args[offset + 1]);
						offset += 2;
					}
					const claimCount = Number(args[offset]);
					offset += 1;
					for (let index = 0; index < claimCount; index += 1) {
						hashes.get(idempotencyClaimsKey)?.set(args[offset], args[offset + 1]);
						offset += 2;
					}
					const projectionCount = Number(args[offset]);
					offset += 1;
					for (let index = 0; index < projectionCount; index += 1) {
						hashes.get(terminalProjectionsKey)?.set(args[offset], args[offset + 1]);
						offset += 2;
					}
					return 1;
				}
				return null;
			},
		};

		try {
			const snapshot = await store.load();
			expect(snapshot.jobs.map((job) => job.jobId)).toEqual([jobId]);
			expect((await store.loadJob(jobId))?.projectId).toBe(projectId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("redis-backed cancel rechecks job status inside the mutation lock", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const projectId = uuid();
		const processingJob = {
			jobId,
			projectId,
			imageId: "race.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "processing" as const,
			attempts: 1,
			processorId: "processor-a",
			leaseExpiresAt: Date.now() + 60_000,
			heartbeatAt: Date.now(),
			createdAt: Date.now(),
			updatedAt: Date.now(),
			creditReservation: { status: "reserved" as const, amountThb: 10, currency: "THB" as const, createdAt: Date.now(), reason: "job_submit" },
		};
		let snapshot: QueueSnapshot = { jobs: [processingJob], events: [], idempotency: [] };
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				snapshot.jobs[0] = {
					...snapshot.jobs[0],
					status: "done",
					resultImageId: "winner.png",
					creditReservation: { ...processingJob.creditReservation, status: "captured", settledAt: Date.now(), reason: "job_done" },
				};
				return operation();
			},
		};

		const queue = new JobQueue(1, undefined, store);
		const cancelled = await queue.cancel(jobId);

		expect(cancelled).toBe(false);
		expect(snapshot.jobs[0].status).toBe("done");
		expect(snapshot.jobs[0].resultImageId).toBe("winner.png");
		expect(snapshot.jobs[0].creditReservation?.status).toBe("captured");
	});

	test("redis-backed queues reschedule pending work after transient claim failures", async () => {
		const previousRetryMs = process.env.AI_QUEUE_PROCESS_RETRY_MS;
		process.env.AI_QUEUE_PROCESS_RETRY_MS = "10";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const { v4: uuid } = await import("uuid");
			let snapshot: QueueSnapshot = { jobs: [], events: [], idempotency: [] };
			let lockCalls = 0;
			const store: QueueSnapshotStore = {
				kind: "redis",
				async load() {
					return JSON.parse(JSON.stringify(snapshot));
				},
				async save(nextSnapshot) {
					snapshot = JSON.parse(JSON.stringify(nextSnapshot));
				},
				async withMutationLock(operation) {
					lockCalls += 1;
					if (lockCalls === 2) throw new Error("transient redis lock failure");
					return operation();
				},
			};
			const queue = new JobQueue(1, undefined, store);
			let processed = false;
			queue.onProcess(async () => {
				processed = true;
			});
			await queue.add({
				jobId: uuid(),
				projectId: uuid(),
				imageId: "retry.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const deadline = Date.now() + 500;
			while (!processed && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(processed).toBe(true);
			expect(lockCalls).toBeGreaterThanOrEqual(3);
		} finally {
			if (previousRetryMs === undefined) {
				delete process.env.AI_QUEUE_PROCESS_RETRY_MS;
			} else {
				process.env.AI_QUEUE_PROCESS_RETRY_MS = previousRetryMs;
			}
		}
	});

	test("redis-backed processor polling claims work queued by another API process", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		let snapshot: QueueSnapshot = { jobs: [], events: [], idempotency: [] };
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				return operation();
			},
		};
		const queue = new JobQueue(1, undefined, store);
		let processedJobId: string | undefined;

		queue.onProcess(async (job) => {
			processedJobId = job.jobId;
			await queue.updateFromProcessor(job, { status: "done", resultImageId: "processed.png" });
		}, { pollIntervalMs: 10 });

		snapshot.jobs.push({
			jobId,
			projectId: uuid(),
			imageId: "external-api.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const deadline = Date.now() + 500;
		while (!processedJobId && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		queue.stopProcessing();

		expect(processedJobId).toBe(jobId);
		expect(snapshot.jobs.find((job) => job.jobId === jobId)?.status).toBe("done");
	});

	test("redis-backed queues can read job status, events, and tier without loading the full snapshot", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const job = {
			jobId,
			projectId: uuid(),
			imageId: "tier.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "cancelled" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				throw new Error("full snapshot should not be loaded for direct job reads");
			},
			async loadJob(requestedJobId) {
				if (requestedJobId !== jobId) return undefined;
				return job;
			},
			async loadEvents(requestedJobId) {
				return requestedJobId === jobId
					? [{ jobId, type: "queued", message: "Job queued", createdAt: Date.now() }]
					: [];
			},
			async save() {
				throw new Error("direct job reads should not persist snapshots");
			},
		};

		const queue = new JobQueue(1, undefined, store);
		expect((await queue.get(jobId))?.status).toBe("cancelled");
		expect((await queue.eventsFor(jobId))[0]?.type).toBe("queued");
		expect(await queue.getTier(jobId)).toBe("sfx-pro");
		expect(await queue.getTier(uuid())).toBeUndefined();
	});

	test("redis-backed queues enforce global processing concurrency from shared state", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		let snapshot: QueueSnapshot = { jobs: [], events: [], idempotency: [] };
		let lock = Promise.resolve();
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
			async withMutationLock(operation) {
				const previous = lock;
				let release!: () => void;
				lock = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
				try {
					return await operation();
				} finally {
					release();
				}
			},
		};
		const projectId = uuid();
		const baseJob = {
			projectId,
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const releaseFirst: Array<() => void> = [];
		let queueAStarted = 0;
		const queueA = new JobQueue(1, undefined, store);
		queueA.onProcess(async () => {
			queueAStarted += 1;
			if (queueAStarted === 1) {
				await new Promise<void>((resolve) => releaseFirst.push(resolve));
			}
		});
		await queueA.add({ ...baseJob, jobId: uuid(), imageId: "a.png" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		const queueB = new JobQueue(1, undefined, store);
		let queueBStarted = false;
		queueB.onProcess(async () => {
			queueBStarted = true;
		});
		const secondJobId = uuid();
		await queueB.add({ ...baseJob, jobId: secondJobId, imageId: "b.png" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(queueBStarted).toBe(false);
		expect(snapshot.jobs.find((job) => job.jobId === secondJobId)?.status).toBe("pending");
		releaseFirst.shift()?.();
		expect(await queueA.waitForIdle(1000)).toBe(true);
	});

	test("redis snapshot store boundary persists jobs, events, and idempotency", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		let snapshot: QueueSnapshot = { jobs: [], events: [], idempotency: [] };
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return snapshot;
			},
			async save(nextSnapshot) {
				snapshot = JSON.parse(JSON.stringify(nextSnapshot));
			},
		};
		const jobId = uuid();

		const queue = new JobQueue(1, undefined, store);
		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}, { idempotencyKey: "same-request" });
		await queue.recordEvent(jobId, "provider:attempt", "Trying provider");

		const recovered = new JobQueue(1, undefined, store);
		expect((await recovered.stats()).store).toBe("redis");
		expect((await recovered.get(jobId))?.status).toBe("pending");
		expect((await recovered.getByIdempotencyKey("same-request"))?.jobId).toBe(jobId);
		expect((await recovered.eventsFor(jobId)).some((event) => event.type === "provider:attempt")).toBe(true);

		const laterJobId = uuid();
		await queue.add({
			jobId: laterJobId,
			projectId: uuid(),
			imageId: "later.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "later",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}, { idempotencyKey: "later-request" });
		expect((await recovered.get(laterJobId))?.status).toBe("pending");
		expect((await recovered.getByIdempotencyKey("later-request"))?.jobId).toBe(laterJobId);
	});

	test("persistent queue recovers processing jobs as pending", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const dir = mkdtempSync(join(tmpdir(), "manga-queue-"));
		const persistPath = join(dir, "queue.json");
		const jobId = uuid();

		try {
			const queue = new JobQueue(1, persistPath);
			await queue.add({
				jobId,
				projectId: uuid(),
				imageId: "test.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await queue.update(jobId, { status: "processing" });

			const recovered = new JobQueue(1, persistPath);
			expect((await recovered.get(jobId))?.status).toBe("pending");
			expect((await recovered.get(jobId))?.error).toContain("Recovered");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("persistent queue loads snapshots written with a UTF-8 BOM", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const dir = mkdtempSync(join(tmpdir(), "manga-queue-bom-"));
		const persistPath = join(dir, "queue.json");
		const jobId = uuid();
		const projectId = uuid();

		try {
			writeFileSync(persistPath, `\uFEFF${JSON.stringify({
				jobs: [{
					jobId,
					projectId,
					imageId: "test.png",
					crop: { x: 0, y: 0, w: 100, h: 100 },
					lang: "th",
					prompt: "test",
					status: "pending",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				}],
				events: [[jobId, []]],
				idempotency: [["same-request", jobId]],
			})}`);

			const queue = new JobQueue(1, persistPath);
			expect((await queue.get(jobId))?.projectId).toBe(projectId);
			expect((await queue.getByIdempotencyKey("same-request"))?.jobId).toBe(jobId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("persistent queue ignores malformed file snapshots during startup", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const dir = mkdtempSync(join(tmpdir(), "manga-queue-malformed-"));
		const persistPath = join(dir, "queue.json");

		try {
			writeFileSync(persistPath, "{not-valid-json");
			const queue = new JobQueue(1, persistPath);
			expect((await queue.stats()).total).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// ── W4.9 in-flight job continuity ────────────────────────────────────────

	function makeRedisStore(initial: QueueSnapshot = { jobs: [], events: [], idempotency: [] }): {
		store: QueueSnapshotStore;
		get snapshot(): QueueSnapshot;
	} {
		let snapshot: QueueSnapshot = JSON.parse(JSON.stringify(initial));
		return {
			store: {
				kind: "redis",
				async load() {
					return JSON.parse(JSON.stringify(snapshot));
				},
				async save(next) {
					snapshot = JSON.parse(JSON.stringify(next));
				},
				async withMutationLock(operation) {
					return operation();
				},
			},
			get snapshot() {
				return snapshot;
			},
		};
	}

	test("recordCheckpoint advances a job checkpoint under the active lease and never regresses", async () => {
		const { JobQueue, checkpointRank } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const harness = makeRedisStore();
		const queue = new JobQueue(1, undefined, harness.store);

		const releases: Array<() => void> = [];
		const seen: Array<string | undefined> = [];
		queue.onProcess(async (job) => {
			// Mirror the processor's checkpoint-and-resume contract.
			seen.push(job.checkpoint?.step);
			await queue.recordCheckpoint(job, { step: "moderated", updatedAt: Date.now() });
			await queue.recordCheckpoint(job, { step: "provider_succeeded", providerResultImageId: `aijob_provider_${job.jobId}.png`, updatedAt: Date.now() });
			// A stale/older write must NOT regress an advanced checkpoint.
			await queue.recordCheckpoint(job, { step: "moderated", updatedAt: Date.now() });
			await new Promise<void>((resolve) => releases.push(resolve));
		});

		const jobId = uuid();
		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: "a.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await new Promise((resolve) => setTimeout(resolve, 30));

		const persisted = harness.snapshot.jobs.find((job) => job.jobId === jobId);
		expect(persisted?.checkpoint?.step).toBe("provider_succeeded");
		expect(checkpointRank(persisted?.checkpoint?.step)).toBe(checkpointRank("provider_succeeded"));
		expect(persisted?.checkpoint?.providerResultImageId).toBe(`aijob_provider_${jobId}.png`);
		expect(seen).toEqual([undefined]);

		releases.shift()?.();
		expect(await queue.waitForIdle(1000)).toBe(true);
	});

	test("checkpoint-resume continues a re-claimed job without a second provider call or credit charge", async () => {
		const { JobQueue, checkpointRank } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const projectId = uuid();
		// Snapshot left behind by a crashed worker: the provider already ran and was
		// checkpointed, but the job never reached `done`. A fresh worker re-claims it.
		const harness = makeRedisStore({
			jobs: [{
				jobId,
				projectId,
				imageId: "a.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "processing",
				processorId: "dead-worker",
				leaseExpiresAt: Date.now() - 1000,
				heartbeatAt: Date.now() - 5000,
				checkpoint: { step: "provider_succeeded", providerResultImageId: `aijob_provider_${jobId}.png`, updatedAt: Date.now() - 5000 },
				createdAt: Date.now() - 10_000,
				updatedAt: Date.now() - 5000,
			}],
			events: [],
			idempotency: [],
		});

		let providerCalls = 0;
		let creditCharges = 0;
		const queue = new JobQueue(1, undefined, harness.store);
		queue.onProcess(async (job) => {
			// The resumed job carries its prior checkpoint.
			const resumeRank = checkpointRank(job.checkpoint?.step);
			if (resumeRank < checkpointRank("provider_succeeded")) {
				providerCalls += 1; // would call (and bill) the provider
				await queue.recordCheckpoint(job, { step: "provider_succeeded", providerResultImageId: `aijob_provider_${job.jobId}.png`, updatedAt: Date.now() });
			}
			// Finalize idempotently; credit capture happens only on this done transition.
			creditCharges += 1;
			await queue.updateFromProcessor(job, { status: "done", resultImageId: `result_${job.jobId}.png` });
		});

		await new Promise((resolve) => setTimeout(resolve, 40));

		const persisted = harness.snapshot.jobs.find((job) => job.jobId === jobId);
		expect(persisted?.status).toBe("done");
		expect(providerCalls).toBe(0); // resumed past the provider step → no double provider call
		expect(creditCharges).toBe(1); // captured exactly once
		expect(await queue.waitForIdle(1000)).toBe(true);
	});

	test("releaseActiveLeasesForShutdown re-queues this processor's in-flight jobs for resume, preserving checkpoint", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const harness = makeRedisStore();
		const queue = new JobQueue(1, undefined, harness.store);

		let released: string[] = [];
		const reachedProcessing = { resolve: undefined as (() => void) | undefined };
		const block = new Promise<void>((resolve) => { reachedProcessing.resolve = resolve; });
		const hold: Array<() => void> = [];
		queue.onProcess(async (job) => {
			await queue.recordCheckpoint(job, { step: "provider_succeeded", providerResultImageId: `aijob_provider_${job.jobId}.png`, updatedAt: Date.now() });
			reachedProcessing.resolve?.();
			await new Promise<void>((resolve) => hold.push(resolve));
		});

		const jobId = uuid();
		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: "a.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await block;

		// Simulate the SIGTERM drain timeout path.
		queue.pause();
		released = await queue.releaseActiveLeasesForShutdown();
		queue.stopProcessing();

		expect(released).toEqual([jobId]);
		const persisted = harness.snapshot.jobs.find((job) => job.jobId === jobId);
		expect(persisted?.status).toBe("pending"); // re-claimable
		expect(persisted?.processorId).toBeUndefined(); // lease cleared
		expect(persisted?.leaseExpiresAt).toBeUndefined();
		expect(persisted?.checkpoint?.step).toBe("provider_succeeded"); // checkpoint preserved for resume
		expect((harness.snapshot.events.find(([id]) => id === jobId)?.[1] ?? []).some(
			(event) => event.type === "status:pending" && event.metadata?.reason === "shutdown_drain_timeout",
		)).toBe(true);

		// Drain the held processor so the test exits cleanly.
		hold.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	test("releaseActiveLeasesForShutdown leaves at-risk jobs (provider call may be in flight) on their lease", async () => {
		// W4.9: a job still at `moderated` (or no checkpoint) may have a provider
		// request DISPATCHED but not yet checkpointed. Fast-reclaiming it would let the
		// replacement worker re-issue (re-bill) the provider while the first call is in
		// flight, so the drain path must leave it on its lease to expire naturally.
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const harness = makeRedisStore();
		const queue = new JobQueue(1, undefined, harness.store);

		let released: string[] = [];
		const reached = { resolve: undefined as (() => void) | undefined };
		const block = new Promise<void>((resolve) => { reached.resolve = resolve; });
		const hold: Array<() => void> = [];
		queue.onProcess(async (job) => {
			// Only the moderation checkpoint landed; provider call would be in flight here.
			await queue.recordCheckpoint(job, { step: "moderated", updatedAt: Date.now() });
			reached.resolve?.();
			await new Promise<void>((resolve) => hold.push(resolve));
		});

		const jobId = uuid();
		await queue.add({
			jobId,
			projectId: uuid(),
			imageId: "a.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await block;

		queue.pause();
		released = await queue.releaseActiveLeasesForShutdown();
		queue.stopProcessing();

		expect(released).toEqual([]); // not fast-reclaimed
		const persisted = harness.snapshot.jobs.find((job) => job.jobId === jobId);
		expect(persisted?.status).toBe("processing"); // still leased
		expect(persisted?.processorId).toBeDefined();
		expect(persisted?.leaseExpiresAt).toBeDefined();
		expect((harness.snapshot.events.find(([id]) => id === jobId)?.[1] ?? []).some(
			(event) => event.type === "shutdown:lease_retained",
		)).toBe(true);

		hold.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	test("claiming a job clears a stale resume/recovery error marker so a successful resume is not reported failed", async () => {
		// W4.9 (P3): the drain path used to stamp `job.error`; if the job then resumes
		// successfully, that text must not linger into the `done` status/SSE payload.
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		// Pre-seed a job re-queued by a prior drain (carries the advisory marker).
		const harness = makeRedisStore({
			jobs: [{
				jobId,
				projectId: uuid(),
				imageId: "a.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				error: "Re-queued for resume after worker shutdown drain timeout",
				checkpoint: { step: "provider_succeeded", providerResultImageId: `aijob_provider_${jobId}.png`, updatedAt: Date.now() },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}],
			events: [],
			idempotency: [],
		});

		let errorAtProcessTime: string | undefined = "unset";
		const queue = new JobQueue(1, undefined, harness.store);
		queue.onProcess(async (job) => {
			errorAtProcessTime = job.error; // should already be cleared by claim
			await queue.updateFromProcessor(job, { status: "done", resultImageId: `result_${job.jobId}.png` });
		});

		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(errorAtProcessTime).toBeUndefined();
		const persisted = harness.snapshot.jobs.find((job) => job.jobId === jobId);
		expect(persisted?.status).toBe("done");
		expect(persisted?.error).toBeUndefined();
		expect(await queue.waitForIdle(1000)).toBe(true);
	});

	test("recordCheckpoint is rejected for a stale processor whose lease was recovered", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const jobId = uuid();
		const harness = makeRedisStore({
			jobs: [{
				jobId,
				projectId: uuid(),
				imageId: "a.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "processing",
				processorId: "live-worker",
				attempts: 2,
				leaseExpiresAt: Date.now() + 60_000,
				heartbeatAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}],
			events: [],
			idempotency: [],
		});
		const queue = new JobQueue(1, undefined, harness.store);
		await queue.ready();

		// A stale processor (wrong processorId / older attempt) tries to checkpoint.
		const staleJob = { jobId, projectId: "x", imageId: "a.png", crop: { x: 0, y: 0, w: 1, h: 1 }, lang: "th", prompt: "p", tier: "sfx-pro" as const, status: "processing" as const, processorId: "dead-worker", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() };
		const applied = await queue.recordCheckpoint(staleJob, { step: "provider_succeeded", updatedAt: Date.now() });
		expect(applied).toBe(false);
		expect(harness.snapshot.jobs.find((job) => job.jobId === jobId)?.checkpoint).toBeUndefined();
	});

	test("retrying a job clears the source checkpoint so the retry re-runs from step zero", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const queue = new JobQueue(1);
		queue.onProcess(async () => {
			throw new Error("processor disabled for retry test");
		});
		const sourceId = uuid();
		await queue.add({
			jobId: sourceId,
			projectId: uuid(),
			imageId: "a.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Force the source into a checkpointed terminal-error state.
		await queue.update(sourceId, { status: "error", retryable: true });
		await queue.recordEvent(sourceId, "noop", "noop");
		const source = await queue.get(sourceId);
		expect(source?.status).toBe("error");

		const retry = await queue.retry(sourceId, { idempotencyKey: `retry:${sourceId}` });
		expect(retry).not.toBeNull();
		expect(retry?.checkpoint).toBeUndefined();
		expect(retry?.jobId).not.toBe(sourceId);
	});

	test("file-backed queue serializes concurrent enqueues across instances and keeps every job", async () => {
		const { JobQueue } = await import("../services/queue.js");
		const { v4: uuid } = await import("uuid");
		const dir = mkdtempSync(join(tmpdir(), "manga-queue-mutex-"));
		const previousStore = process.env.AI_QUEUE_STORE;
		process.env.AI_QUEUE_STORE = "file";
		try {
			const persistPath = join(dir, "ai-jobs.json");
			// Two queue instances sharing ONE on-disk queue file (the API-replica /
			// worker shape). Without the file-mode mutex + reload-under-lock, two
			// concurrent enqueues each load the SAME pre-mutation snapshot, mutate their
			// own in-memory map, and the second save clobbers the first job (last write
			// wins → a lost job). The mutex must serialize the read-modify-write so both
			// jobs survive.
			const queueA = new JobQueue(1, persistPath);
			const queueB = new JobQueue(1, persistPath);
			const projectId = uuid();
			const baseJob = {
				projectId,
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro" as const,
				status: "pending" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const ids = Array.from({ length: 12 }, () => uuid());
			await Promise.all(ids.map((jobId, index) => (index % 2 === 0 ? queueA : queueB).add({
				...baseJob,
				jobId,
				imageId: `${jobId}.png`,
			})));

			// A fresh instance reads the durable file: every enqueued job must be present.
			const recovered = new JobQueue(1, persistPath);
			await recovered.ready();
			expect((await recovered.stats()).total).toBe(ids.length);
			for (const jobId of ids) {
				expect(await recovered.get(jobId)).toBeDefined();
			}

			// The persisted file is complete, parseable JSON (atomic write, no truncation).
			const persisted = JSON.parse(readFileSync(persistPath, "utf-8")) as { jobs: unknown[] };
			expect(persisted.jobs.length).toBe(ids.length);
		} finally {
			restoreEnv("AI_QUEUE_STORE", previousStore);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// ----------------------------------------------------------------------------
	// Terminal-job retention + event caps (memory/snapshot-bloat P1). Terminal jobs
	// and their event arrays used to accumulate forever in the in-process maps and
	// in the WHOLE-snapshot rewrite on every transition. These cover the sweep
	// (by age, by count cap, billing-pending guard), the load-time sweep, the
	// idempotency-mapping cleanup, and the per-job event cap with truncation marker.
	// ----------------------------------------------------------------------------

	// A minimal mutable store that mirrors the redis boundary (deep-copies in/out so
	// the in-process map and the persisted snapshot never share references). Tests
	// seed `snapshot` to simulate a pre-existing on-store snapshot, then read it back
	// after the queue persists.
	function makeMutableStore(initial: QueueSnapshot): { store: QueueSnapshotStore; current: () => QueueSnapshot } {
		let snapshot: QueueSnapshot = JSON.parse(JSON.stringify(initial));
		const store: QueueSnapshotStore = {
			kind: "redis",
			async load() {
				return JSON.parse(JSON.stringify(snapshot));
			},
			async save(next) {
				snapshot = JSON.parse(JSON.stringify(next));
			},
		};
		return { store, current: () => snapshot };
	}

	function terminalJob(overrides: Partial<import("../types/index.js").AiJob> & { jobId: string }): import("../types/index.js").AiJob {
		return {
			projectId: "proj",
			imageId: `${overrides.jobId}.png`,
			crop: { x: 0, y: 0, w: 10, h: 10 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro",
			status: "done",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides,
		} as import("../types/index.js").AiJob;
	}

	test("load-time sweep evicts terminal jobs older than the retention window and shrinks the snapshot", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const oldDone = terminalJob({ jobId: "old-done", status: "done", updatedAt: now - 2 * 60 * 60 * 1000 }); // 2h old
			const freshError = terminalJob({ jobId: "fresh-error", status: "error", error: "boom", updatedAt: now - 60 * 1000 }); // 1m old
			const pending = terminalJob({ jobId: "still-pending", status: "pending", updatedAt: now - 5 * 60 * 60 * 1000 }); // old but NOT terminal
			const { store, current } = makeMutableStore({
				jobs: [oldDone, freshError, pending],
				events: [["old-done", [{ jobId: "old-done", type: "queued", message: "q", createdAt: now }]]],
				idempotency: [["idem-old", "old-done"], ["idem-fresh", "fresh-error"]],
			});

			const queue = new JobQueue(1, undefined, store);
			await queue.ready();

			// The aged terminal job is gone; the fresh terminal job and the (old but
			// non-terminal) pending job remain.
			expect(await queue.get("old-done")).toBeUndefined();
			expect(await queue.get("fresh-error")).toBeDefined();
			expect(await queue.get("still-pending")).toBeDefined();
			// Its events and dangling idempotency mapping were evicted with it; the
			// fresh job's mapping is untouched. The on-store shrink arrives via the
			// LOCKED boot sweep (fire-and-forget) or the first locked mutation —
			// loadSnapshot itself never saves (codex P1/P2).
			await queue.recordEvent("fresh-error", "poke", "trigger a locked persist");
			const persisted = current();
			expect(persisted.jobs.map((j) => j.jobId).sort()).toEqual(["fresh-error", "still-pending"]);
			expect(persisted.events.find(([id]) => id === "old-done")).toBeUndefined();
			expect(persisted.idempotency.find(([key]) => key === "idem-old")).toBeUndefined();
			expect(persisted.idempotency.find(([key]) => key === "idem-fresh")?.[1]).toBe("fresh-error");
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("sweep evicts the oldest terminal jobs when the count cap is exceeded", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		const previousCap = process.env.AI_QUEUE_MAX_TERMINAL_JOBS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "0"; // disable age eviction → count cap only
		process.env.AI_QUEUE_MAX_TERMINAL_JOBS = "2";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			// Five terminal jobs, all within the (disabled) age window, finished at
			// staggered times; with a cap of 2 the three OLDEST must be evicted.
			const jobs = [0, 1, 2, 3, 4].map((i) =>
				terminalJob({ jobId: `done-${i}`, status: "done", updatedAt: now - (5 - i) * 1000 }),
			);
			const { store, current } = makeMutableStore({ jobs, events: [], idempotency: [] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();

			// The two NEWEST survive; the three oldest are evicted (oldest-first).
			expect(await queue.get("done-0")).toBeUndefined();
			expect(await queue.get("done-4")).toBeDefined();
			// Redis loads never persist (unlocked read paths — codex P1); the on-store
			// shrink rides the first locked mutation.
			await queue.recordEvent("done-4", "poke", "trigger a locked persist");
			expect(current().jobs.map((j) => j.jobId).sort()).toEqual(["done-3", "done-4"]);
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
			restoreEnv("AI_QUEUE_MAX_TERMINAL_JOBS", previousCap);
		}
	});

	test("does NOT evict a terminal job whose credit reservation is still pending (billing guard)", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		const previousCap = process.env.AI_QUEUE_MAX_TERMINAL_JOBS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		process.env.AI_QUEUE_MAX_TERMINAL_JOBS = "1"; // aggressive count cap too
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			// A long-aged terminal job whose reservation never settled (ledger outage):
			// `done` + reservation still `reserved`. The capture reconciler keys off this
			// row, so retention MUST keep it despite being far past both caps.
			const stuck = terminalJob({
				jobId: "billing-pending",
				status: "done",
				updatedAt: now - 10 * 60 * 60 * 1000,
				creditReservation: { status: "reserved", amountThb: 9, currency: "THB", createdAt: now - 10 * 60 * 60 * 1000 },
			});
			// A settled (captured) aged terminal job IS evictable.
			const settled = terminalJob({
				jobId: "settled",
				status: "done",
				updatedAt: now - 10 * 60 * 60 * 1000,
				creditReservation: { status: "captured", amountThb: 9, currency: "THB", createdAt: now - 10 * 60 * 60 * 1000, settledAt: now - 10 * 60 * 60 * 1000 },
			});
			const { store, current } = makeMutableStore({ jobs: [stuck, settled], events: [], idempotency: [] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();

			expect(await queue.get("billing-pending")).toBeDefined();
			expect(await queue.get("settled")).toBeUndefined();
			// On-store shrink rides the first locked mutation (loads never persist).
			await queue.recordEvent("billing-pending", "poke", "trigger a locked persist");
			expect(current().jobs.map((j) => j.jobId)).toEqual(["billing-pending"]);
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
			restoreEnv("AI_QUEUE_MAX_TERMINAL_JOBS", previousCap);
		}
	});

	test("never evicts a parked needs_review job regardless of age (not in the evictable set)", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "1000"; // 1s — anything older ages out
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const review = terminalJob({ jobId: "parked", status: "needs_review", updatedAt: now - 24 * 60 * 60 * 1000 });
			const { store } = makeMutableStore({ jobs: [review], events: [], idempotency: [] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			// needs_review is parked / review-release-able / reconcile state — retained.
			expect(await queue.get("parked")).toBeDefined();
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("a replayed idempotency key whose job was evicted materializes a FRESH job (no conflict)", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const aged = terminalJob({ jobId: "aged", status: "done", updatedAt: now - 5 * 60 * 60 * 1000, idempotencyKey: "shared-key" });
			const { store } = makeMutableStore({ jobs: [aged], events: [], idempotency: [["shared-key", "aged"]] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();

			// The aged job + its mapping are gone, so the key resolves to nothing.
			expect(await queue.get("aged")).toBeUndefined();
			expect(await queue.getByIdempotencyKey("shared-key")).toBeUndefined();

			// Replaying the same key now creates a brand-new job instead of throwing a
			// conflict / de-duping onto the dead row.
			const fresh = await queue.add({
				jobId: "fresh",
				projectId: "proj",
				imageId: "fresh.png",
				crop: { x: 0, y: 0, w: 10, h: 10 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: now,
				updatedAt: now,
			}, { idempotencyKey: "shared-key" });
			expect(fresh.jobId).toBe("fresh");
			expect((await queue.getByIdempotencyKey("shared-key"))?.jobId).toBe("fresh");
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("persist-time sweep trims a terminal job once it crosses the retention window", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			// Seed an already-aged terminal job, but ALSO a fresh non-terminal job so the
			// load-time sweep persists (proving the seeded aged row is evicted on the next
			// persist regardless of which mutation triggers it). Use a `done` job so it is
			// subject to the standard AI_QUEUE_TERMINAL_RETENTION_MS window (retriable
			// statuses now get their own much longer window — codex P2).
			const aged = terminalJob({ jobId: "aged", status: "done", updatedAt: now - 5 * 60 * 60 * 1000 });
			const live = terminalJob({ jobId: "live", status: "pending", updatedAt: now });
			const { store, current } = makeMutableStore({ jobs: [aged, live], events: [], idempotency: [] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			// Trigger another persist via a benign event on the live job.
			await queue.recordEvent("live", "note", "still here");
			expect(current().jobs.map((j) => j.jobId)).toEqual(["live"]);
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("per-job event array is capped with a single truncation marker keeping head + recent tail", async () => {
		const previousCap = process.env.AI_QUEUE_MAX_JOB_EVENTS;
		process.env.AI_QUEUE_MAX_JOB_EVENTS = "30";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const { v4: uuid } = await import("uuid");
			const queue = new JobQueue();
			const jobId = uuid();
			await queue.add({
				jobId,
				projectId: uuid(),
				imageId: `${uuid()}.png`,
				crop: { x: 0, y: 0, w: 10, h: 10 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			// Append well past the cap; each recordEvent is one event row.
			for (let i = 0; i < 100; i += 1) {
				await queue.recordEvent(jobId, `tick-${i}`, `event ${i}`);
			}
			const events = await queue.eventsFor(jobId);
			// Never exceeds the cap, and carries exactly one truncation marker.
			expect(events.length).toBeLessThanOrEqual(30);
			const markers = events.filter((e) => e.type === "events:truncated");
			expect(markers.length).toBe(1);
			// The very first events (creation context) are preserved as the head, and the
			// marker sits before the recent tail so the served history stays in order.
			expect(events[0].type).toBe("queued");
			const markerIndex = events.findIndex((e) => e.type === "events:truncated");
			expect(markerIndex).toBeGreaterThan(0);
			// The most-recent appended event is preserved at the tail.
			expect(events[events.length - 1].type).toBe("tick-99");
			// Shape stays valid: every row is a well-formed AiJobEvent for the status route.
			for (const e of events) {
				expect(typeof e.jobId).toBe("string");
				expect(typeof e.type).toBe("string");
				expect(typeof e.message).toBe("string");
				expect(typeof e.createdAt).toBe("number");
			}
		} finally {
			restoreEnv("AI_QUEUE_MAX_JOB_EVENTS", previousCap);
		}
	});

	test("a small event cap still preserves the newest event (head shrinks before tail)", async () => {
		const previousCap = process.env.AI_QUEUE_MAX_JOB_EVENTS;
		process.env.AI_QUEUE_MAX_JOB_EVENTS = "5";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const { v4: uuid } = await import("uuid");
			const queue = new JobQueue();
			const jobId = uuid();
			await queue.add({
				jobId,
				projectId: uuid(),
				imageId: `${uuid()}.png`,
				crop: { x: 0, y: 0, w: 10, h: 10 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			for (let i = 0; i < 40; i += 1) {
				await queue.recordEvent(jobId, `tick-${i}`, `event ${i}`);
			}
			const events = await queue.eventsFor(jobId);
			expect(events.length).toBeLessThanOrEqual(5);
			// The cap is too small for the default 20-row head: the head allowance must
			// shrink so the JUST-RECORDED event is never silently dropped (codex P3).
			expect(events[events.length - 1].type).toBe("tick-39");
			expect(events.filter((e) => e.type === "events:truncated").length).toBe(1);
		} finally {
			restoreEnv("AI_QUEUE_MAX_JOB_EVENTS", previousCap);
		}
	});

	test("eviction leaves a terminal projection the marker self-heal can still resolve", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const oldDone = terminalJob({
				jobId: "old-done-proj",
				status: "done",
				updatedAt: now - 2 * 60 * 60 * 1000,
				resultImageId: "result-123.png",
			});
			const { store, current } = makeMutableStore({ jobs: [oldDone], events: [], idempotency: [] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();

			// Full row evicted…
			expect(await queue.get("old-done-proj")).toBeUndefined();
			// …but the marker-reconcile view still resolves the terminal outcome, so
			// reconcileProcessingAiReviewMarkers can heal a `processing` marker for a
			// user who returns after the retention window (codex P1).
			const view = await queue.getMarkerReconcileView("old-done-proj");
			expect(view?.status).toBe("done");
			expect(view?.resultImageId).toBe("result-123.png");
			// The projection rides the snapshot: persisted on the next locked
			// mutation and restored across a reload.
			await queue.recordEvent("old-done-proj", "poke", "trigger a locked persist");
			expect(current().terminalProjections?.find(([id]) => id === "old-done-proj")).toBeDefined();
			const queue2 = new JobQueue(1, undefined, store);
			await queue2.ready();
			expect((await queue2.getMarkerReconcileView("old-done-proj"))?.resultImageId).toBe("result-123.png");
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("terminal projections are bounded by their own count cap (oldest-evicted first)", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		const previousCap = process.env.AI_QUEUE_MAX_TERMINAL_PROJECTIONS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000";
		process.env.AI_QUEUE_MAX_TERMINAL_PROJECTIONS = "2";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const jobs = [0, 1, 2, 3].map((i) =>
				terminalJob({ jobId: `proj-${i}`, status: "done", updatedAt: now - (5 + i) * 60 * 60 * 1000 }),
			);
			const { store } = makeMutableStore({ jobs, events: [], idempotency: [] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			// All four evicted in one sweep → projections capped at 2.
			const survivors = (await Promise.all(
				jobs.map(async (j) => [(j as { jobId: string }).jobId, await queue.getMarkerReconcileView((j as { jobId: string }).jobId)] as const),
			)).filter(([, view]) => view !== undefined).map(([id]) => id);
			expect(survivors.length).toBe(2);
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
			restoreEnv("AI_QUEUE_MAX_TERMINAL_PROJECTIONS", previousCap);
		}
	});

	test("marker view point-reads the projection from redis when another replica evicted", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			// Simulate the cross-process case: the projection exists ONLY in the store
			// (another replica evicted the job); this process's in-memory map is empty.
			const projection = {
				jobId: "remote-evicted",
				status: "done",
				resultImageId: "remote-result.png",
				evictedAt: now - 1000,
			};
			const { store } = makeMutableStore({ jobs: [], events: [], idempotency: [] });
			(store as { loadJob?: unknown }).loadJob = async () => undefined; // redis fast path: job gone
			(store as { loadTerminalProjection?: unknown }).loadTerminalProjection = async (jobId: string) =>
				jobId === "remote-evicted" ? projection : undefined;
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			const view = await queue.getMarkerReconcileView("remote-evicted");
			expect(view?.status).toBe("done");
			expect(view?.resultImageId).toBe("remote-result.png");
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("file-backed queues also point-read projections persisted by another instance", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const projection = { jobId: "file-remote", status: "done", resultImageId: "from-disk.png", evictedAt: now - 1000 };
			const { store } = makeMutableStore({ jobs: [], events: [], idempotency: [] });
			// Simulate a FILE store (another instance evicted + persisted to disk).
			(store as { kind: string }).kind = "file";
			(store as { loadTerminalProjection?: unknown }).loadTerminalProjection = async (jobId: string) =>
				jobId === "file-remote" ? projection : undefined;
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			const view = await queue.getMarkerReconcileView("file-remote");
			expect(view?.resultImageId).toBe("from-disk.png");
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("projection retention sweeps even when no live terminal jobs evict", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		const previousProjMs = process.env.AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000";
		process.env.AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS = "1000"; // 1s
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			// Snapshot contains ONLY an ancient projection — no evictable jobs at all.
			const { store } = makeMutableStore({
				jobs: [],
				events: [],
				idempotency: [],
				terminalProjections: [["ancient", { jobId: "ancient", status: "done", evictedAt: now - 60 * 60 * 1000 }]],
			} as Parameters<typeof makeMutableStore>[0]);
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			// The early no-evictable-jobs return must NOT skip the projection sweep.
			expect(await queue.getMarkerReconcileView("ancient")).toBeUndefined();
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
			restoreEnv("AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS", previousProjMs);
		}
	});

	test("memory-store queues never run the periodic reload sweep (it would wipe live jobs)", async () => {
		const previousInterval = process.env.AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS;
		process.env.AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS = "20";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const { v4: uuid } = await import("uuid");
			const queue = new JobQueue(); // default memory snapshot store
			const jobId = uuid();
			await queue.add({
				jobId,
				projectId: uuid(),
				imageId: `${uuid()}.png`,
				crop: { x: 0, y: 0, w: 10, h: 10 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			// Force the timer path that onProcess would take; for a memory store it
			// must refuse to schedule (its load() is EMPTY — a reload would wipe the
			// live pending job; codex P2).
			(queue as unknown as { startRetentionSweepTimer: () => void }).startRetentionSweepTimer();
			expect((queue as unknown as { retentionSweepTimer?: unknown }).retentionSweepTimer).toBeUndefined();
			// And a direct sweep call is a no-op for memory stores.
			await (queue as unknown as { runRetentionSweep: () => Promise<void> }).runRetentionSweep();
			expect(await queue.get(jobId)).toBeDefined();
		} finally {
			restoreEnv("AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS", previousInterval);
		}
	});

	test("file/persistent boot shrink persists through the LOCKED sweep, not the unlocked load", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const oldDone = terminalJob({ jobId: "boot-shrink", status: "done", updatedAt: now - 2 * 60 * 60 * 1000 });
			const { store, current } = makeMutableStore({ jobs: [oldDone], events: [], idempotency: [] });
			// Track lock usage: the boot shrink's persist must happen INSIDE the lock.
			let lockDepth = 0;
			let savedUnderLock = 0;
			(store as { withMutationLock?: <T>(op: () => Promise<T>) => Promise<T> }).withMutationLock = async (op) => {
				lockDepth += 1;
				try {
					return await op();
				} finally {
					lockDepth -= 1;
				}
			};
			const originalSave = store.save.bind(store);
			store.save = async (next) => {
				if (lockDepth > 0) savedUnderLock += 1;
				await originalSave(next);
			};

			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			// The boot shrink is fire-and-forget; give it a tick to run.
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(await queue.get("boot-shrink")).toBeUndefined();
			expect(savedUnderLock).toBeGreaterThanOrEqual(1);
			expect(current().jobs.find((j) => j.jobId === "boot-shrink")).toBeUndefined();
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("redis read paths never persist the sweep from an unlocked load", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const oldDone = terminalJob({ jobId: "old-done-ro", status: "done", updatedAt: now - 2 * 60 * 60 * 1000 });
			const { store, current } = makeMutableStore({ jobs: [oldDone], events: [], idempotency: [] });
			let saves = 0;
			const originalSave = store.save.bind(store);
			store.save = async (next) => { saves += 1; await originalSave(next); };

			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			// The boot shrink may persist ONCE (through the locked sweep path); what
			// must NEVER happen is a persist from plain READ paths afterwards (an
			// unlocked whole-snapshot save could clobber a concurrent locked mutation
			// — codex P1). Let the boot chain settle, then baseline the save count.
			await new Promise((resolve) => setTimeout(resolve, 25));
			const savesAfterBoot = saves;
			expect(await queue.get("old-done-ro")).toBeUndefined();
			expect(await queue.get("old-done-ro")).toBeUndefined();
			expect(saves).toBe(savesAfterBoot);
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
		}
	});

	test("a retriable terminal job survives the 24h window + count cap but is evicted past the 7d window (codex P2)", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		const previousRetriableMs = process.env.AI_QUEUE_RETRIABLE_RETENTION_MS;
		const previousCap = process.env.AI_QUEUE_MAX_TERMINAL_JOBS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "86400000"; // 24h (done window)
		process.env.AI_QUEUE_RETRIABLE_RETENTION_MS = "604800000"; // 7d (retriable window)
		process.env.AI_QUEUE_MAX_TERMINAL_JOBS = "1"; // aggressive count cap
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const hour = 60 * 60 * 1000;
			const day = 24 * hour;
			// A retriable failure (error) older than the 24h `done` window but within the
			// 7d retriable window: it is a valid POST .../retry source, so retention MUST
			// keep it even though the count cap is 1 and several `done` jobs exist.
			const retriable = terminalJob({ jobId: "retriable-fail", status: "error", error: "boom", updatedAt: now - 2 * day });
			// A pile of fresh `done` jobs that would, if retriable were counted, blow the
			// cap and force the retriable source out.
			const done0 = terminalJob({ jobId: "done-0", status: "done", updatedAt: now - 3 * hour });
			const done1 = terminalJob({ jobId: "done-1", status: "done", updatedAt: now - 2 * hour });
			const done2 = terminalJob({ jobId: "done-2", status: "done", updatedAt: now - 1 * hour });
			const { store } = makeMutableStore({ jobs: [retriable, done0, done1, done2], events: [], idempotency: [] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();

			// The retriable source survives both the 24h age pass (it's on the 7d window)
			// and the count cap (retriable jobs are exempt from the `done` count pass).
			expect(await queue.get("retriable-fail")).toBeDefined();
			// The newest `done` survives the cap-of-1; the older `done` rows are evicted.
			expect(await queue.get("done-2")).toBeDefined();
			expect(await queue.get("done-0")).toBeUndefined();
			expect(await queue.get("done-1")).toBeUndefined();

			// Now age the retriable source past the 7d window → it finally evicts.
			const stale = terminalJob({ jobId: "stale-fail", status: "cancelled", error: "x", updatedAt: now - 8 * day });
			const { store: store2 } = makeMutableStore({ jobs: [stale], events: [], idempotency: [] });
			const queue2 = new JobQueue(1, undefined, store2);
			await queue2.ready();
			expect(await queue2.get("stale-fail")).toBeUndefined();
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
			restoreEnv("AI_QUEUE_RETRIABLE_RETENTION_MS", previousRetriableMs);
			restoreEnv("AI_QUEUE_MAX_TERMINAL_JOBS", previousCap);
		}
	});

	test("done jobs still evict at the 24h window even while retriable jobs are retained longer (codex P2)", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		const previousRetriableMs = process.env.AI_QUEUE_RETRIABLE_RETENTION_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "86400000"; // 24h
		process.env.AI_QUEUE_RETRIABLE_RETENTION_MS = "604800000"; // 7d
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const day = 24 * 60 * 60 * 1000;
			// A `done` job 2 days old: past its 24h window → evicted, even though a
			// retriable job of the SAME age is retained (different window).
			const oldDone = terminalJob({ jobId: "old-done", status: "done", updatedAt: now - 2 * day });
			const oldError = terminalJob({ jobId: "old-error", status: "error", error: "boom", updatedAt: now - 2 * day });
			const { store } = makeMutableStore({ jobs: [oldDone, oldError], events: [], idempotency: [] });
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			expect(await queue.get("old-done")).toBeUndefined(); // done evicts at 24h
			expect(await queue.get("old-error")).toBeDefined(); // retriable still within 7d
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
			restoreEnv("AI_QUEUE_RETRIABLE_RETENTION_MS", previousRetriableMs);
		}
	});

	test("periodic retention sweep timer trims expired rows + persists under the lock, and is cleared on drain (codex P2)", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		const previousInterval = process.env.AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		process.env.AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS = "20"; // 20ms — fire quickly in-test
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			const oldDone = terminalJob({ jobId: "old-done-sweep", status: "done", updatedAt: now - 2 * 60 * 60 * 1000 });
			const live = terminalJob({ jobId: "live-sweep", status: "pending", updatedAt: now });

			// Redis-kind store WITH a real mutation lock so the periodic sweep takes the
			// lock + persists exactly like a real locked mutation. Track save() calls and
			// whether the lock wrapped them.
			let snapshot: QueueSnapshot = {
				jobs: [JSON.parse(JSON.stringify(oldDone)), JSON.parse(JSON.stringify(live))],
				events: [],
				idempotency: [],
			};
			const saved: QueueSnapshot[] = [];
			let savesUnderLock = 0;
			let lockDepth = 0;
			const store: QueueSnapshotStore & { loadJob: (id: string) => Promise<unknown> } = {
				kind: "redis",
				async load() {
					return JSON.parse(JSON.stringify(snapshot));
				},
				async save(next) {
					if (lockDepth > 0) savesUnderLock += 1;
					snapshot = JSON.parse(JSON.stringify(next));
					saved.push(JSON.parse(JSON.stringify(next)));
				},
				async loadJob(id: string) {
					return snapshot.jobs.find((j) => j.jobId === id);
				},
				async withMutationLock(operation) {
					lockDepth += 1;
					try {
						return await operation();
					} finally {
						lockDepth -= 1;
					}
				},
			};

			const queue = new JobQueue(1, undefined, store);
			await queue.ready();
			// onProcess registers the periodic sweep timer (among others).
			queue.onProcess(async () => {});

			// Wait for the timer to fire and persist the shrunken snapshot.
			const start = Date.now();
			while (saved.length === 0 && Date.now() - start < 2000) {
				await new Promise((r) => setTimeout(r, 10));
			}

			// The sweep persisted a snapshot with the expired `done` job removed, the
			// live job kept — and it happened UNDER the mutation lock.
			expect(saved.length).toBeGreaterThan(0);
			expect(savesUnderLock).toBeGreaterThan(0);
			const last = saved[saved.length - 1];
			expect(last.jobs.map((j) => j.jobId).sort()).toEqual(["live-sweep"]);

			// Draining clears the timer: no further saves once stopped.
			queue.stopProcessing();
			const savesAtStop = saved.length;
			await new Promise((r) => setTimeout(r, 80)); // > a couple of intervals
			expect(saved.length).toBe(savesAtStop);
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
			restoreEnv("AI_QUEUE_RETENTION_SWEEP_INTERVAL_MS", previousInterval);
		}
	});

	test("projection count cap evicts by evictedAt, not map iteration order (codex P3)", async () => {
		const previousMs = process.env.AI_QUEUE_TERMINAL_RETENTION_MS;
		const previousProjMs = process.env.AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS;
		const previousCap = process.env.AI_QUEUE_MAX_TERMINAL_PROJECTIONS;
		process.env.AI_QUEUE_TERMINAL_RETENTION_MS = "3600000"; // 1h
		process.env.AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS = "9999999999999"; // effectively never (age)
		process.env.AI_QUEUE_MAX_TERMINAL_PROJECTIONS = "2";
		try {
			const { JobQueue } = await import("../services/queue.js");
			const now = Date.now();
			// Seed projections in a map order that is the REVERSE of evictedAt order — i.e.
			// the NEWEST projection appears first. A naive "delete from the front"
			// (insertion-order) cap would wrongly drop the newest. Sorting by evictedAt
			// keeps the two NEWEST and drops the two oldest regardless of map order.
			const projections: [string, import("../services/queue.js").TerminalJobProjection][] = [
				["newest", { jobId: "newest", status: "done", evictedAt: now - 1000 }],
				["newer", { jobId: "newer", status: "done", evictedAt: now - 2000 }],
				["older", { jobId: "older", status: "done", evictedAt: now - 3000 }],
				["oldest", { jobId: "oldest", status: "done", evictedAt: now - 4000 }],
			];
			const { store } = makeMutableStore({
				jobs: [],
				events: [],
				idempotency: [],
				terminalProjections: projections,
			} as Parameters<typeof makeMutableStore>[0]);
			const queue = new JobQueue(1, undefined, store);
			await queue.ready();

			// Cap of 2 → the two NEWEST (smallest age) survive; the two OLDEST evict,
			// even though "oldest"/"older" are LAST in map iteration order.
			expect(await queue.getMarkerReconcileView("newest")).toBeDefined();
			expect(await queue.getMarkerReconcileView("newer")).toBeDefined();
			expect(await queue.getMarkerReconcileView("older")).toBeUndefined();
			expect(await queue.getMarkerReconcileView("oldest")).toBeUndefined();
		} finally {
			restoreEnv("AI_QUEUE_TERMINAL_RETENTION_MS", previousMs);
			restoreEnv("AI_QUEUE_TERMINAL_PROJECTION_RETENTION_MS", previousProjMs);
			restoreEnv("AI_QUEUE_MAX_TERMINAL_PROJECTIONS", previousCap);
		}
	});
});
