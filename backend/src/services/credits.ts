import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";
import { DATA_DIR } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { writeFileAtomic } from "../utils/atomic-file.js";

export type CreditClass = "shareable" | "personal";
export type CreditOwnerScope = "workspace" | "user";
export type CreditGrantSource = "plan_monthly" | "addon_purchase" | "goodwill" | "topup";
export type CreditAllocationScope = "member" | "page" | "chapter";
export type CreditBalanceScope = "workspace" | "member" | "page" | "chapter" | "user";

export interface CreditGrant {
	id: string;
	workspaceId: string;
	ownerScope: CreditOwnerScope;
	ownerId: string;
	creditClass: CreditClass;
	amount: number;
	source: CreditGrantSource;
	expiresAt?: string;
	createdAt: string;
	/**
	 * Optional caller-supplied dedupe key. When a grant is minted with a key, a
	 * later grantCredits() carrying the same key returns the existing grant instead
	 * of minting a second one. This lets a non-transactional caller (e.g. coupon
	 * redemption, whose redemption row lives in Postgres while the grant lives in
	 * this file store) safely RETRY a grant after a crash without double-granting:
	 * the key is the redemption id, so exactly one grant is ever produced per
	 * redemption regardless of how many times the completion path runs.
	 */
	idempotencyKey?: string;
}

export interface CreditAllocation {
	id: string;
	grantId: string;
	allocatedToScope: CreditAllocationScope;
	allocatedToId: string;
	amount: number;
	allocatedBy: string;
	createdAt: string;
	revokedAt?: string;
}

export interface CreditLedgerEntry {
	id: string;
	workspaceId: string;
	userId?: string;
	creditClass: CreditClass;
	delta: number;
	balanceAfter: number;
	reason: string;
	refId?: string;
	createdAt: string;
}

export interface CreditBalance {
	shareable: number;
	personal: number;
	total: number;
}

interface CreditSnapshot {
	grants: CreditGrant[];
	allocations: CreditAllocation[];
	ledger: CreditLedgerEntry[];
	consumptions: CreditConsumption[];
	/**
	 * Credit-unit scale version. Absent/1 = pre-×10-rebase units (one LOW image
	 * = 1 credit); 2 = post-rebase units (LOW = 10). load() upgrades a v1 file
	 * exactly once by multiplying every stored amount ×10 — the file-backed twin
	 * of migration 0087 (review #586 r2 P1: without this, file-mode balances
	 * silently lose 90% of their value when the new charge units go live).
	 */
	unitsVersion?: number;
}

/** Current credit-unit scale (see CreditSnapshot.unitsVersion). */
const CREDIT_UNITS_VERSION = 2;

interface CreditConsumption {
	id: string;
	workspaceId: string;
	userId: string;
	creditClass: CreditClass;
	amount: number;
	reason: string;
	refId?: string;
	createdAt: string;
}

export class CreditServiceError extends Error {
	constructor(message: string, readonly status = 400, readonly code = "credit_service_error") {
		super(message);
		this.name = "CreditServiceError";
	}
}

export interface GrantCreditsInput {
	workspaceId: string;
	ownerScope: CreditOwnerScope;
	ownerId: string;
	creditClass: CreditClass;
	amount: number;
	source: CreditGrantSource;
	expiresAt?: string;
	now?: Date;
	/**
	 * Optional dedupe key. When set, the grant is idempotent on this key: a repeated
	 * grantCredits() with the same key (e.g. a retried coupon-redemption completion)
	 * returns the already-minted grant instead of minting a duplicate. Omit it for
	 * the ordinary "always mint a fresh grant" path.
	 */
	idempotencyKey?: string;
}

export interface ConsumeCreditsResult {
	consumed: Array<{ creditClass: CreditClass; amount: number }>;
	balance: CreditBalance;
}

const DEFAULT_DAILY_ALLOCATION_CAP = 50;
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

// How long to wait for a peer process to release the cross-process credit lock
// before giving up. Credit mutations are short (a single file rewrite), so a
// few seconds is ample; exceeding it fails the request closed (no silent
// double-spend) rather than blocking the event loop forever.
const CREDIT_LOCK_TIMEOUT_MS = 5_000;
// Async backoff interval between contended lock-acquire retries. Each retry yields
// the event loop (via timers/promises delay), so a peer's held lock never blocks
// this process's HTTP handling or health checks.
const CREDIT_LOCK_RETRY_MS = 15;
// A held lock older than this is treated as stale (the holder crashed without
// releasing) and forcibly reclaimed, so a dead process cannot wedge billing.
//
// Raised to 3 minutes (mirrors SUPPORT_CLAIM_LOCK_STALE_MS, #344): a credit
// mutation's actual critical section is microseconds (a reload + an in-memory
// mutation + a temp-write+rename), so a threshold orders of magnitude above it
// makes the stale-reclaim TOCTOU window unhittable in practice — a LIVE holder
// that merely stalled briefly (GC pause / CPU starvation) is NOT reclaimed out
// from under itself and made to fence-abort, while a GENUINELY crashed holder is
// still recovered well within a human-perceptible time so billing never wedges.
// The pre-commit fencing re-read (see mutate()/assertLockOwnership) is the hard
// correctness guarantee; this longer threshold is the belt-and-suspenders that
// keeps the fence from ever needing to fire on a healthy process.
const CREDIT_LOCK_STALE_MS = 180_000;
// Bound on how many times mutate() re-acquires + re-runs after a pre-commit fence
// abort (a peer stale-reclaimed our lock). A genuine stale-reclaim fences us at
// most once; this cap only guards against a pathological reclaim storm so the
// request fails closed (503) instead of spinning forever.
const CREDIT_LOCK_FENCE_MAX_RETRIES = 5;

/**
 * Thrown when a credit mutation discovers, at its pre-commit fence, that this
 * holder's cross-process lock was stale-reclaimed by a peer while it was stalled.
 * The holder no longer owns the critical section and MUST NOT publish its write
 * (doing so would double-write money state over the peer's committed mutation).
 * Caught inside mutate(), which rolls back the in-memory mutation and retries the
 * whole acquire→reload→mutate cycle so the caller still gets a fresh-state result.
 */
class CreditLockLostError extends Error {
	constructor() {
		super("Credit lock was stale-reclaimed by a peer before commit");
		this.name = "CreditLockLostError";
	}
}

export class CreditService {
	private grants: CreditGrant[] = [];
	private allocations: CreditAllocation[] = [];
	private ledger: CreditLedgerEntry[] = [];
	private consumptions: CreditConsumption[] = [];
	private readonly lockPath: string;
	// Token identifying THIS holder's lock instance. Written into the lock file on
	// acquire and verified before release/reclaim so a holder never deletes a lock
	// it no longer owns (e.g. one a peer stale-reclaimed and re-acquired).
	private lockToken: string | null = null;
	// Re-entrancy depth: only the OUTERMOST mutate() acquires the cross-process
	// lock, reloads fresh state, and writes once on exit. Nested mutating calls
	// (e.g. releaseConsumptionsByRef → releaseConsumption) run within the same
	// reloaded snapshot and the same atomic write.
	private mutateDepth = 0;
	// When true, the shared file is reloaded under an exclusive lock before each
	// outermost mutation, and writes are serialized + atomic across processes.
	// This makes the file-backed store safe for the multi-replica prod deployment
	// (replicas share api-prod-data:/app/data) so concurrent debits can neither
	// double-spend a stale balance nor clobber a peer's grant/consumption.
	private readonly crossProcessSafe: boolean;

	constructor(
		private readonly filePath = join(DATA_DIR, "credits.json"),
		private readonly dailyAllocationCap = DEFAULT_DAILY_ALLOCATION_CAP,
		options: { crossProcessSafe?: boolean } = {},
	) {
		this.lockPath = `${this.filePath}.lock`;
		// Default ON outside tests: tests run a single in-process instance and the
		// lock/reload churn is unnecessary (and would serialize the suite on a
		// shared lock file). Prod/dev get the durable cross-process guarantee.
		this.crossProcessSafe = options.crossProcessSafe
			?? !(process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test");
		this.load();
	}

	/**
	 * Run a state mutation under cross-process safety: the outermost call takes an
	 * exclusive file lock, reloads the latest on-disk snapshot (so this process
	 * sees peers' writes before re-checking balances), runs `fn`, then writes the
	 * result atomically and releases the lock. Nested calls reuse the outer
	 * lock/snapshot. With cross-process safety disabled it degrades to the prior
	 * in-memory behavior plus a single save().
	 *
	 * Async so the contended-lock wait yields the event loop (an async backoff
	 * instead of a CPU-burning spin), keeping unrelated HTTP requests and health
	 * checks responsive while a peer replica holds the cross-process lock.
	 */
	private async mutate<T>(fn: () => T): Promise<T> {
		if (!this.crossProcessSafe) {
			const result = fn();
			this.save();
			return result;
		}
		if (this.mutateDepth > 0) {
			// Inner mutation: state is already locked + freshly loaded.
			return fn();
		}
		// Bound the fence-abort retry loop so a pathological reclaim storm surfaces a
		// busy error rather than spinning forever. In practice the fence fires at most
		// once per genuine stale-reclaim; a healthy run never enters the retry path.
		for (let attempt = 0; ; attempt++) {
			const lockFd = await this.acquireLock();
			this.mutateDepth++;
			try {
				this.load();
				const result = fn();
				// FENCING: acquireLock's O_EXCL lock has a stale-reclaim (reclaimIfStale,
				// CREDIT_LOCK_STALE_MS). A LIVE holder that stalls past the stale window
				// (GC pause / CPU starvation / SIGSTOP) can have ITS lock removed and
				// re-acquired by a peer replica, which then performs its OWN reload+mutate
				// and commits a money-state change (a debit/grant/refund). Without a fence
				// this stalled holder would resume here and save() OVER the peer — a lost
				// update / double credit write (the exact money-state corruption this
				// closes). So save() re-reads the on-disk lock token IMMEDIATELY before its
				// atomic rename (writeFileAtomic's beforeCommit hook): if the token no
				// longer matches ours (peer stale-reclaimed), the rename is skipped and a
				// CreditLockLostError is thrown — nothing is published. We then roll back
				// the in-memory mutation by reloading the peer's committed state and retry
				// the whole acquire→reload→mutate so the caller still gets a fresh-state
				// result (mirrors #344's support-claim fence; matches the "reload + retry"
				// handling a contended acquire already uses).
				this.save(() => this.assertLockOwnership());
				return result;
			} catch (error) {
				if (error instanceof CreditLockLostError) {
					// Our write was fenced out: the peer that stale-reclaimed the lock is the
					// legitimate writer. Discard our (now-unpublished) in-memory mutation by
					// reloading the peer's committed snapshot, then retry the full cycle on a
					// fresh lock + fresh state.
					this.load();
					if (attempt >= CREDIT_LOCK_FENCE_MAX_RETRIES) {
						throw new CreditServiceError(
							"Credit ledger is busy; please retry",
							503,
							"credit_ledger_locked",
						);
					}
					continue;
				}
				throw error;
			} finally {
				this.mutateDepth--;
				this.releaseLock(lockFd);
			}
		}
	}

	/**
	 * Pre-commit fence: re-read the on-disk lock token and confirm it still matches
	 * the token this holder stamped on acquire. A mismatch (or a missing/empty file)
	 * means a peer stale-reclaimed our lock while we were stalled, so we no longer own
	 * the critical section and MUST NOT publish our write. Throws CreditLockLostError
	 * on loss. Invoked as writeFileAtomic's `beforeCommit` so the check sits back-to-
	 * back with the rename (no I/O of our own data, no async yield in between).
	 */
	private assertLockOwnership(): void {
		const ownedToken = this.lockToken;
		const onDisk = this.readLockToken();
		if (ownedToken === null || onDisk !== ownedToken) {
			throw new CreditLockLostError();
		}
	}

	private async acquireLock(): Promise<number> {
		mkdirSync(dirname(this.lockPath), { recursive: true });
		const deadline = Date.now() + CREDIT_LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				// O_EXCL: succeeds only if the lock file does not already exist, so at
				// most one process across the shared volume holds it at a time.
				const fd = openSync(this.lockPath, "wx");
				// Stamp a unique fencing token so release/reclaim can verify ownership
				// before deleting the lock file. Persist it on the instance for release.
				const token = `${process.pid}:${randomUUID()}`;
				this.lockToken = token;
				try {
					writeSync(fd, token);
				} catch {
					// Best-effort owner stamp; the lock is held regardless. (A failure
					// here means release falls back to deleting only a missing/own token.)
				}
				return fd;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				this.reclaimIfStale();
				if (Date.now() >= deadline) {
					throw new CreditServiceError(
						"Credit ledger is busy; please retry",
						503,
						"credit_ledger_locked",
					);
				}
				// Async backoff: yield the event loop between retries instead of
				// busy-spinning, so a peer's held lock does not block this process.
				await delay(CREDIT_LOCK_RETRY_MS);
			}
		}
	}

	private reclaimIfStale(): void {
		try {
			// Capture the token of the holder we are about to judge stale BEFORE the
			// staleness check, so we can fence the unlink against a concurrent
			// re-acquire: a peer (or the recovered original holder) that replaces the
			// lock between our stat and our unlink writes a different token, and the
			// mismatch aborts the reclaim. Without this fence two replicas could both
			// see the same stale mtime, and the loser would delete the winner's
			// freshly-acquired lock — reintroducing concurrent credits.json writes.
			const staleToken = this.readLockToken();
			const stat = statSync(this.lockPath);
			if (Date.now() - stat.mtimeMs > CREDIT_LOCK_STALE_MS) {
				// The holder is presumed dead (crashed/suspended before releasing).
				// Reclaim so a dead process cannot wedge billing indefinitely — but
				// only if the on-disk token is unchanged from what we observed as stale.
				const current = this.readLockToken();
				if (current === staleToken) {
					rmSync(this.lockPath, { force: true });
				}
			}
		} catch {
			// lock vanished between checks — fine, the next openSync retries.
		}
	}

	private releaseLock(fd: number): void {
		try {
			closeSync(fd);
		} catch {
			// already closed
		}
		const ownedToken = this.lockToken;
		this.lockToken = null;
		try {
			// Only delete the lock if it still carries OUR token. If a peer stale-
			// reclaimed our lock (we ran past CREDIT_LOCK_STALE_MS) and acquired a new
			// one, the on-disk token differs and we must NOT delete the successor's
			// lock — doing so would let a third writer enter and reintroduce concurrent
			// credits.json writes. A missing file is already released.
			const onDisk = this.readLockToken();
			if (onDisk === null || (ownedToken !== null && onDisk === ownedToken)) {
				rmSync(this.lockPath, { force: true });
			}
		} catch {
			// best effort — a read/remove failure leaves the lock for stale reclamation
		}
	}

	// Read the fencing token currently stamped in the lock file, or null if the
	// file is missing/empty/unreadable.
	private readLockToken(): string | null {
		try {
			const contents = readFileSync(this.lockPath, "utf8").trim();
			return contents.length > 0 ? contents : null;
		} catch {
			return null;
		}
	}

	async grantCredits(input: GrantCreditsInput): Promise<CreditGrant> {
		return this.mutate(() => this.grantCreditsImpl(input));
	}

	private grantCreditsImpl(input: GrantCreditsInput): CreditGrant {
		const now = input.now ?? new Date();
		// Idempotency: if this grant carries a dedupe key and a grant with that key
		// already exists, return it unchanged — never mint a second grant. Runs inside
		// the mutate() lock (state is freshly reloaded), so a retry from another process
		// also converges on the prior grant. This is what makes a non-transactional
		// retry of coupon redemption EXACTLY-ONCE: the key is the redemption id.
		const dedupeKey = input.idempotencyKey?.trim();
		if (dedupeKey) {
			const existing = this.grants.find((g) => g.idempotencyKey === dedupeKey);
			if (existing) return existing;
		}
		// Personal credits are only spendable when owned by a user (getUserPersonalAvailable
		// requires ownerScope === "user") and can never be allocated. A workspace-owned
		// personal grant would show in the workspace balance yet be unspendable by anyone,
		// so reject the combination instead of minting dead credits.
		if (input.creditClass === "personal" && input.ownerScope !== "user") {
			throw new CreditServiceError("Personal credits must be owned by a user (ownerScope must be 'user')", 400, "personal_credit_requires_user_owner");
		}
		const amount = normalizeAmount(input.amount);
		const grant: CreditGrant = {
			id: randomUUID(),
			workspaceId: requiredId(input.workspaceId, "workspaceId"),
			ownerScope: input.ownerScope,
			ownerId: requiredId(input.ownerId, "ownerId"),
			creditClass: input.creditClass,
			amount,
			source: input.source,
			expiresAt: normalizeIsoDate(input.expiresAt),
			createdAt: now.toISOString(),
			...(dedupeKey ? { idempotencyKey: dedupeKey } : {}),
		};
		this.grants.push(grant);
		const balance = this.getBalance(
			grant.ownerScope === "user" ? "member" : "workspace",
			grant.ownerId,
			grant.ownerScope === "user" ? grant.workspaceId : undefined,
		);
		this.appendLedger({
			workspaceId: grant.workspaceId,
			userId: grant.ownerScope === "user" ? grant.ownerId : undefined,
			creditClass: grant.creditClass,
			delta: amount,
			balanceAfter: balance[grant.creditClass],
			reason: `grant:${grant.source}`,
			refId: grant.id,
			createdAt: grant.createdAt,
		});
		return grant;
	}

	/**
	 * Reverse (claw back) a previously-minted grant, deducting up to the grant's
	 * amount back out of the owner's balance. Used by support owner-ops to undo an
	 * erroneous auto/owner-approved goodwill grant.
	 *
	 * Handles the already-spent case GRACEFULLY: the credits balance model clamps
	 * availability at >= 0 (it never represents negative balances / debt), so the
	 * reversal is CLAMPED to whatever of the grant remains unspent. The recoverable
	 * portion is recorded as a negative-delta debit (a "reversal" consumption); the
	 * portion the customer already spent is reported as `unrecoverable` so the
	 * caller can audit the gap (no debt row is written — that is the model's
	 * convention here, matching getBalance()'s Math.max(0, …) flooring).
	 *
	 * IDEMPOTENT on the grant id: a second reverseGrant() for the same grant is a
	 * no-op (returns the already-reversed amount, mints no second debit), so a
	 * retried clawback never double-deducts.
	 */
	async reverseGrant(grantId: string, reason: string, now = new Date()): Promise<{
		grantId: string;
		grantAmount: number;
		reversed: number;
		unrecoverable: number;
		alreadyReversed: boolean;
	}> {
		return this.mutate(() => this.reverseGrantImpl(grantId, reason, now));
	}

	private reverseGrantImpl(grantId: string, reason: string, now: Date): {
		grantId: string;
		grantAmount: number;
		reversed: number;
		unrecoverable: number;
		alreadyReversed: boolean;
	} {
		const id = requiredId(grantId, "grantId");
		const grant = this.grants.find((item) => item.id === id);
		if (!grant) throw new CreditServiceError("Credit grant not found", 404, "credit_grant_not_found");
		// Idempotency anchor: the reversal debit's refId. A retried reversal finds the
		// existing debit and returns without minting a second one.
		const reversalRef = `grant-reversal:${grant.id}`;
		// The reversal is recorded as a POSITIVE-amount consumption (a debit). A prior
		// reversal therefore shows as a positive consumption row under reversalRef.
		const existingReversed = this.consumptions
			.filter((item) => item.refId === reversalRef && item.amount > 0)
			.reduce((sum, item) => sum + item.amount, 0);
		if (existingReversed > 0) {
			return {
				grantId: grant.id,
				grantAmount: roundCredits(grant.amount),
				reversed: roundCredits(existingReversed),
				unrecoverable: roundCredits(Math.max(0, grant.amount - existingReversed)),
				alreadyReversed: true,
			};
		}
		const grantAmount = roundCredits(grant.amount);
		// Reverse ONLY against THIS grant's own unspent remainder — never against
		// credits that belong to a different grant/topup in the same balance bucket.
		// The consumption ledger is not grant-scoped, so attribute consumption to
		// grants deterministically (FIFO by createdAt) to derive the portion of THIS
		// grant that is still unspent. Using the aggregate same-class balance instead
		// would silently claw back UNRELATED credits (e.g. a fully-spent goodwill grant
		// clawed back out of the user's later personal top-up) and under-report the
		// genuinely-spent amount as recoverable.
		const grantRemainder = this.getGrantUnspentRemainder(grant, now);
		// Also clamp to what is actually spendable right now (the bucket can never go
		// negative); the per-grant remainder already bounds us below this, but this is
		// a defensive floor so a reversal can never drive the bucket negative.
		const available = grant.ownerScope === "user" && grant.creditClass === "personal"
			? this.getUserPersonalAvailable(grant.workspaceId, grant.ownerId, now)
			: this.getWorkspaceShareableAvailable(grant.workspaceId, now);
		const recoverable = roundCredits(Math.max(0, Math.min(grantAmount, grantRemainder, available)));
		if (recoverable > 0) {
			// Record a positive-amount consumption (a debit that REDUCES the available
			// balance) keyed on the reversalRef so it is idempotent and shows in the
			// ledger as a clawback (negative ledger delta). This is the inverse of the
			// original grant within the unspent remainder.
			this.recordConsumption(
				grant.workspaceId,
				grant.ownerScope === "user" ? grant.ownerId : grant.workspaceId,
				grant.creditClass,
				recoverable,
				reason || "grant_clawback",
				reversalRef,
				now,
			);
		}
		return {
			grantId: grant.id,
			grantAmount,
			reversed: recoverable,
			unrecoverable: roundCredits(Math.max(0, grantAmount - recoverable)),
			alreadyReversed: false,
		};
	}

	/**
	 * FULL clawback of a previously-minted grant identified by its idempotency KEY
	 * (the dodo add-on grant anchor), for a refund / chargeback. Unlike
	 * {@link reverseGrant} (which CLAMPS to the unspent remainder and never goes
	 * below 0), this debits the ENTIRE granted amount and is ALLOWED TO DRIVE THE
	 * BUCKET NEGATIVE (a debt) when part/all of the grant was already spent. The debt
	 * persists; a future grant raises the signed balance back toward 0 (i.e. future
	 * grants pay it down first) before any credits become spendable again.
	 *
	 * IDEMPOTENT on the grant's clawback ref: a webhook replay (refund/chargeback)
	 * with the same key is a no-op (no second debit). Returns `{ found:false }` when
	 * no grant carries the key (an unlinked / already-pruned grant) so the caller can
	 * proceed without throwing.
	 *
	 * Money-critical: callers MUST pass the original grant's `idempotencyKey`
	 * (`descriptor.anchor`), which is the stable per-occurrence anchor the dodo add-on
	 * path minted the grant with — so the clawback is exactly-once per disputed grant.
	 */
	async clawbackGrantByKey(idempotencyKey: string, reason: string, now = new Date()): Promise<{
		found: boolean;
		grantId?: string;
		grantAmount?: number;
		clawedBack?: number;
		alreadyClawedBack?: boolean;
	}> {
		return this.mutate(() => this.clawbackGrantByKeyImpl(idempotencyKey, reason, now));
	}

	private clawbackGrantByKeyImpl(idempotencyKey: string, reason: string, now: Date): {
		found: boolean;
		grantId?: string;
		grantAmount?: number;
		clawedBack?: number;
		alreadyClawedBack?: boolean;
	} {
		const key = idempotencyKey?.trim();
		if (!key) return { found: false };
		const grant = this.grants.find((g) => g.idempotencyKey === key);
		if (!grant) return { found: false };
		// Idempotency anchor: a clawback debit keyed on this grant id. A replayed
		// refund/chargeback finds the existing debit and returns without re-debiting.
		const clawbackRef = `grant-clawback:${grant.id}`;
		const existing = this.consumptions
			.filter((item) => item.refId === clawbackRef && item.amount > 0)
			.reduce((sum, item) => sum + item.amount, 0);
		if (existing > 0) {
			return {
				found: true,
				grantId: grant.id,
				grantAmount: roundCredits(grant.amount),
				clawedBack: roundCredits(existing),
				alreadyClawedBack: true,
			};
		}
		const grantAmount = roundCredits(grant.amount);
		if (grantAmount > 0) {
			// Record the FULL grant amount as a clawback debit (a positive-amount
			// consumption ⇒ negative ledger delta). This is NOT clamped to the unspent
			// remainder or to the spendable balance: a refunded/charged-back grant is
			// fully reversed even if already spent, so the bucket may go negative (debt).
			this.recordConsumption(
				grant.workspaceId,
				grant.ownerScope === "user" ? grant.ownerId : grant.workspaceId,
				grant.creditClass,
				grantAmount,
				reason || "grant_clawback",
				clawbackRef,
				now,
			);
		}
		return {
			found: true,
			grantId: grant.id,
			grantAmount,
			clawedBack: grantAmount,
			alreadyClawedBack: false,
		};
	}

	/**
	 * FULL clawback of EVERY grant whose idempotency key starts with `keyPrefix`, for
	 * a refund/chargeback that names a payment but not its individual add-on lines. The
	 * dodo add-on path mints each grant with the anchor `dodo-addon:<paymentRef>:<addon>:<index>`,
	 * so passing `dodo-addon:<paymentRef>:` claws back every credit pack bought on that
	 * payment. Each grant is reversed via {@link clawbackGrantByKey} (idempotent per
	 * grant, NEGATIVE-allowed). Returns the per-grant results; an empty array means no
	 * matching grant (e.g. a plan-only refund or an already-pruned grant).
	 */
	async clawbackGrantsByKeyPrefix(keyPrefix: string, reason: string, now = new Date()): Promise<Array<{
		found: boolean;
		grantId?: string;
		grantAmount?: number;
		clawedBack?: number;
		alreadyClawedBack?: boolean;
	}>> {
		return this.mutate(() => {
			const prefix = keyPrefix?.trim();
			if (!prefix) return [];
			// Snapshot matching keys first (clawbackGrantByKeyImpl mutates consumptions,
			// not grants, so the grant list is stable, but snapshot defensively).
			const keys = this.grants
				.filter((g) => typeof g.idempotencyKey === "string" && g.idempotencyKey.startsWith(prefix))
				.map((g) => g.idempotencyKey as string);
			const uniqueKeys = [...new Set(keys)];
			return uniqueKeys.map((key) => this.clawbackGrantByKeyImpl(key, reason, now));
		});
	}

	/**
	 * Signed shareable balance of a workspace — granted minus ALL consumption
	 * (including clawback debits), WITHOUT the `Math.max(0, …)` floor the spendable
	 * {@link getBalance}/{@link getWorkspaceShareableAvailable} apply. Can be NEGATIVE
	 * when a refund/chargeback clawback exceeded the unspent credits (a debt). Used by
	 * billing/admin surfaces to display the debt; spending paths keep using the floored
	 * available (a debt is simply unspendable — `available` is 0 — never a credit).
	 */
	getSignedWorkspaceShareableBalance(workspaceId: string, now = new Date()): number {
		const normalizedId = requiredId(workspaceId, "workspaceId");
		const granted = this.grants
			.filter((grant) => grant.workspaceId === normalizedId && grant.creditClass === "shareable" && isGrantActive(grant, now))
			.reduce((sum, grant) => sum + grant.amount, 0);
		const consumed = this.consumptions
			.filter((item) => item.workspaceId === normalizedId && item.creditClass === "shareable")
			.reduce((sum, item) => sum + item.amount, 0);
		return roundCredits(granted - consumed);
	}

	async allocate(grantId: string, toScope: CreditAllocationScope, toId: string, amount: number, byUser: string, now = new Date()): Promise<CreditAllocation> {
		return this.mutate(() => this.allocateImpl(grantId, toScope, toId, amount, byUser, now));
	}

	private allocateImpl(grantId: string, toScope: CreditAllocationScope, toId: string, amount: number, byUser: string, now: Date): CreditAllocation {
		const grant = this.requireGrant(grantId);
		if (grant.creditClass === "personal") {
			throw new CreditServiceError("Personal credits cannot be allocated", 403, "personal_credit_not_allocatable");
		}
		if (this.countAllocationsByUserForDay(byUser, now) >= this.dailyAllocationCap) {
			throw new CreditServiceError("Daily credit allocation cap exceeded", 429, "daily_allocation_cap_exceeded");
		}
		const normalizedAmount = normalizeAmount(amount);
		const available = Math.min(this.getGrantUnallocatedBalance(grant.id, now), this.getWorkspaceShareableAvailable(grant.workspaceId, now));
		if (normalizedAmount > available) {
			throw new CreditServiceError("Insufficient shareable credits on grant", 402, "insufficient_shareable_credits");
		}
		const allocation: CreditAllocation = {
			id: randomUUID(),
			grantId: grant.id,
			allocatedToScope: toScope,
			allocatedToId: requiredId(toId, "allocatedToId"),
			amount: normalizedAmount,
			allocatedBy: requiredId(byUser, "allocatedBy"),
			createdAt: now.toISOString(),
		};
		this.allocations.push(allocation);
		this.appendLedger({
			workspaceId: grant.workspaceId,
			userId: byUser,
			creditClass: "shareable",
			delta: -normalizedAmount,
			balanceAfter: this.getBalance("workspace", grant.workspaceId).shareable,
			reason: `allocate:${toScope}`,
			refId: allocation.id,
			createdAt: allocation.createdAt,
		});
		return allocation;
	}

	async revokeAllocation(allocationId: string, byUser: string, now = new Date()): Promise<CreditAllocation> {
		return this.mutate(() => this.revokeAllocationImpl(allocationId, byUser, now));
	}

	private revokeAllocationImpl(allocationId: string, byUser: string, now: Date): CreditAllocation {
		const allocation = this.allocations.find((item) => item.id === allocationId);
		if (!allocation) throw new CreditServiceError("Credit allocation not found", 404, "credit_allocation_not_found");
		if (allocation.revokedAt) return allocation;
		const createdAt = Date.parse(allocation.createdAt);
		if (Number.isFinite(createdAt) && now.getTime() - createdAt > UNDO_WINDOW_MS) {
			throw new CreditServiceError("Credit allocation undo window has expired", 409, "credit_allocation_undo_expired");
		}
		allocation.revokedAt = now.toISOString();
		const grant = this.requireGrant(allocation.grantId);
		this.appendLedger({
			workspaceId: grant.workspaceId,
			userId: requiredId(byUser, "revokedBy"),
			creditClass: "shareable",
			delta: allocation.amount,
			balanceAfter: this.getBalance("workspace", grant.workspaceId).shareable,
			reason: "allocation_revoked",
			refId: allocation.id,
			createdAt: allocation.revokedAt,
		});
		return allocation;
	}

	async releaseConsumption(workspaceId: string, userId: string, amount: number, creditClass: CreditClass, reason: string, refId?: string, now = new Date()): Promise<void> {
		await this.mutate(() => this.releaseConsumptionImpl(workspaceId, userId, amount, creditClass, reason, refId, now));
	}

	private releaseConsumptionImpl(workspaceId: string, userId: string, amount: number, creditClass: CreditClass, reason: string, refId: string | undefined, now: Date): void {
		const normalizedWorkspaceId = requiredId(workspaceId, "workspaceId");
		const normalizedUserId = requiredId(userId, "userId");
		const normalizedAmount = normalizeAmount(amount);
		const consumption: CreditConsumption = {
			id: randomUUID(),
			workspaceId: normalizedWorkspaceId,
			userId: normalizedUserId,
			creditClass,
			amount: -normalizedAmount,
			reason,
			refId,
			createdAt: now.toISOString(),
		};
		this.consumptions.push(consumption);
		this.appendLedger({
			workspaceId: normalizedWorkspaceId,
			userId: normalizedUserId,
			creditClass,
			delta: normalizedAmount,
			balanceAfter: creditClass === "personal"
				? this.getUserPersonalAvailable(normalizedWorkspaceId, normalizedUserId, now)
				: this.getUserShareableAvailable(normalizedWorkspaceId, normalizedUserId, now),
			reason,
			refId,
			createdAt: consumption.createdAt,
		});
	}

	async consume(workspaceId: string, userId: string, amount: number, reason: string, refId?: string, now = new Date()): Promise<ConsumeCreditsResult> {
		return this.mutate(() => this.consumeImpl(workspaceId, userId, amount, reason, refId, now));
	}

	private consumeImpl(workspaceId: string, userId: string, amount: number, reason: string, refId: string | undefined, now: Date): ConsumeCreditsResult {
		const normalizedWorkspaceId = requiredId(workspaceId, "workspaceId");
		const normalizedUserId = requiredId(userId, "userId");
		const requested = normalizeAmount(amount);
		// Check total availability BEFORE recording any debit so an oversized request
		// fails atomically (402) without partially spending personal/shareable credits.
		const personalAvailable = this.getUserPersonalAvailable(normalizedWorkspaceId, normalizedUserId, now);
		const shareableAvailable = this.getUserShareableAvailable(normalizedWorkspaceId, normalizedUserId, now);
		if (roundCredits(personalAvailable + shareableAvailable) < requested) {
			throw new CreditServiceError("Insufficient credits", 402, "insufficient_credits");
		}
		let remaining = requested;
		const consumed: Array<{ creditClass: CreditClass; amount: number }> = [];
		const personalDebit = Math.min(remaining, personalAvailable);
		if (personalDebit > 0) {
			this.recordConsumption(normalizedWorkspaceId, normalizedUserId, "personal", personalDebit, reason, refId, now);
			consumed.push({ creditClass: "personal", amount: personalDebit });
			remaining = roundCredits(remaining - personalDebit);
		}
		const shareableDebit = Math.min(remaining, shareableAvailable);
		if (shareableDebit > 0) {
			this.recordConsumption(normalizedWorkspaceId, normalizedUserId, "shareable", shareableDebit, reason, refId, now);
			consumed.push({ creditClass: "shareable", amount: shareableDebit });
			remaining = roundCredits(remaining - shareableDebit);
		}
		return {
			consumed,
			balance: this.getBalance("member", normalizedUserId, normalizedWorkspaceId),
		};
	}

	/**
	 * Whether the personal/shareable credit system is active for this workspace+user,
	 * i.e. any shareable grant exists for the workspace OR any personal grant exists
	 * for the user. The credit layer is opt-in: workspaces that have never been
	 * granted credits fall through to the existing usage-ledger quota system instead
	 * of failing every AI job with 402. Callers gate consume() on this.
	 */
	hasCreditSystem(workspaceId: string, userId: string, now = new Date()): boolean {
		const ws = workspaceId?.trim();
		const uid = userId?.trim();
		if (!ws || !uid) return false;
		return this.grants.some((grant) =>
			isGrantActive(grant, now)
			&& (
				(grant.workspaceId === ws && grant.creditClass === "shareable")
				|| (grant.workspaceId === ws && grant.ownerScope === "user" && grant.ownerId === uid && grant.creditClass === "personal")
			),
		);
	}

	/**
	 * Release every credit consumption recorded under `refId` that has not already
	 * been released, restoring the spent personal/shareable credits. Idempotent:
	 * re-invoking for the same ref is a no-op once releases are recorded. Used by
	 * the AI queue to refund credits when a submitted job later fails or cancels.
	 * jobId/refId is a globally-unique UUID, so a workspace filter is unnecessary.
	 */
	async releaseConsumptionsByRef(refId: string, reason: string, now = new Date()): Promise<Array<{ creditClass: CreditClass; amount: number }>> {
		return this.mutate(() => {
			const normalizedRef = requiredId(refId, "refId");
			const debits = this.consumptions.filter((item) => item.refId === normalizedRef && item.amount > 0);
			const released: Array<{ creditClass: CreditClass; amount: number }> = [];
			for (const debit of debits) {
				const alreadyReleased = this.consumptions
					.filter((item) => item.refId === normalizedRef && item.amount < 0 && item.creditClass === debit.creditClass && item.workspaceId === debit.workspaceId && item.userId === debit.userId)
					.reduce((sum, item) => sum + -item.amount, 0);
				const remaining = roundCredits(debit.amount - alreadyReleased);
				if (remaining <= 0) continue;
				this.releaseConsumptionImpl(debit.workspaceId, debit.userId, remaining, debit.creditClass, reason, normalizedRef, now);
				released.push({ creditClass: debit.creditClass, amount: remaining });
			}
			return released;
		});
	}

	/**
	 * Refund up to `amount` of the credits consumed under `refId`, distributed
	 * across the still-unreleased debits (shareable first, then personal, so the
	 * shared pool is restored before a buyer's personal add-on credits). Used to
	 * return the unused reserve padding when an AI job captures less than it
	 * debited at submission. Never refunds more than was actually consumed.
	 */
	async releasePartialByRef(refId: string, amount: number, reason: string, now = new Date()): Promise<Array<{ creditClass: CreditClass; amount: number }>> {
		return this.mutate(() => {
			const normalizedRef = requiredId(refId, "refId");
			let remainingToRefund = roundCredits(Math.max(0, amount));
			if (remainingToRefund <= 0) return [];
			const debits = this.consumptions
				.filter((item) => item.refId === normalizedRef && item.amount > 0)
				.sort((a, b) => (a.creditClass === b.creditClass ? 0 : a.creditClass === "shareable" ? -1 : 1));
			const released: Array<{ creditClass: CreditClass; amount: number }> = [];
			for (const debit of debits) {
				if (remainingToRefund <= 0) break;
				const alreadyReleased = this.consumptions
					.filter((item) => item.refId === normalizedRef && item.amount < 0 && item.creditClass === debit.creditClass && item.workspaceId === debit.workspaceId && item.userId === debit.userId)
					.reduce((sum, item) => sum + -item.amount, 0);
				const refundable = roundCredits(debit.amount - alreadyReleased);
				if (refundable <= 0) continue;
				const refund = roundCredits(Math.min(refundable, remainingToRefund));
				this.releaseConsumptionImpl(debit.workspaceId, debit.userId, refund, debit.creditClass, reason, normalizedRef, now);
				released.push({ creditClass: debit.creditClass, amount: refund });
				remainingToRefund = roundCredits(remainingToRefund - refund);
			}
			return released;
		});
	}

	getBalance(scope: CreditBalanceScope, id: string, workspaceId?: string, now = new Date()): CreditBalance {
		const normalizedId = requiredId(id, "id");
		let shareable = 0;
		let personal = 0;
		if (scope === "workspace") {
			shareable = this.getWorkspaceShareableAvailable(normalizedId, now);
			// Subtract spent personal credits, mirroring getUserPersonalAvailable, so
			// the workspace total does not overstate add-on credits already consumed.
			const personalOwnerIds = new Set(
				this.grants
					.filter((grant) => grant.workspaceId === normalizedId && grant.ownerScope === "user" && grant.creditClass === "personal" && isGrantActive(grant, now))
					.map((grant) => grant.ownerId),
			);
			personal = [...personalOwnerIds].reduce(
				(sum, ownerId) => sum + this.getUserPersonalAvailable(normalizedId, ownerId, now),
				0,
			);
		} else if (scope === "member" || scope === "user") {
			if (!workspaceId) {
				shareable = this.getActiveAllocations("member", normalizedId, now).reduce((sum, allocation) => sum + allocation.amount, 0);
				personal = this.grants
					.filter((grant) => grant.ownerScope === "user" && grant.ownerId === normalizedId && grant.creditClass === "personal" && isGrantActive(grant, now))
					.reduce((sum, grant) => sum + grant.amount, 0);
			} else {
				shareable = this.getUserShareableAvailable(workspaceId, normalizedId, now);
				personal = this.getUserPersonalAvailable(workspaceId, normalizedId, now);
			}
		} else {
			// page/chapter ids are not globally unique, so a page id from workspace B
			// can collide with one in workspace A. The route requires a workspace
			// query for these scopes; honor it here so a caller with read access to
			// workspace A cannot read workspace B's allocation balance.
			shareable = this.getActiveAllocations(scope, normalizedId, now, workspaceId).reduce((sum, allocation) => sum + allocation.amount, 0);
		}
		shareable = roundCredits(shareable);
		personal = roundCredits(personal);
		return { shareable, personal, total: roundCredits(shareable + personal) };
	}

	/** Resolve the workspace that owns a grant, or null if the grant is unknown. */
	getGrantWorkspaceId(grantId: string): string | null {
		return this.grants.find((grant) => grant.id === grantId)?.workspaceId ?? null;
	}

	/** Resolve the workspace that owns an allocation (via its grant), or null. */
	getAllocationWorkspaceId(allocationId: string): string | null {
		const allocation = this.allocations.find((item) => item.id === allocationId);
		if (!allocation) return null;
		return this.grants.find((grant) => grant.id === allocation.grantId)?.workspaceId ?? null;
	}

	listAllocations(workspaceId?: string): CreditAllocation[] {
		const allocations = workspaceId
			? this.allocations.filter((allocation) => this.grants.find((grant) => grant.id === allocation.grantId)?.workspaceId === workspaceId)
			: this.allocations;
		return allocations.map((allocation) => ({ ...allocation }));
	}

	listLedger(workspaceId?: string): CreditLedgerEntry[] {
		return this.ledger
			.filter((entry) => !workspaceId || entry.workspaceId === workspaceId)
			.map((entry) => ({ ...entry }));
	}

	resetForTests(): void {
		this.grants = [];
		this.allocations = [];
		this.ledger = [];
		this.consumptions = [];
		this.save();
	}

	private requireGrant(grantId: string): CreditGrant {
		const grant = this.grants.find((item) => item.id === grantId);
		if (!grant) throw new CreditServiceError("Credit grant not found", 404, "credit_grant_not_found");
		if (!isGrantActive(grant)) throw new CreditServiceError("Credit grant has expired", 410, "credit_grant_expired");
		return grant;
	}

	/**
	 * The portion of a SPECIFIC grant that is still unspent — i.e. how much of THIS
	 * grant could be clawed back without touching credits that belong to a different
	 * grant/topup in the same balance bucket (same workspace+class, and for personal
	 * also same owner). The consumption ledger is fungible (not grant-scoped), so
	 * consumption is attributed to grants DETERMINISTICALLY in FIFO order (oldest
	 * grant drained first), which is the conventional credit-bucket accounting and
	 * makes per-grant attribution stable and reproducible.
	 *
	 * Targeted grant-reversal debits (a prior clawback, keyed `grant-reversal:<id>`)
	 * are attributed ONLY to the grant they reversed — never spread FIFO across the
	 * bucket — so clawing back grant A can never shrink the computed remainder of an
	 * unrelated grant B.
	 *
	 * An expired grant has a remainder of 0: its credits are no longer spendable, so
	 * there is nothing left to reverse.
	 */
	private getGrantUnspentRemainder(grant: CreditGrant, now = new Date()): number {
		if (!isGrantActive(grant, now)) return 0;
		// Every ACTIVE grant in the same fungible balance bucket, oldest first. Ties on
		// createdAt break by INSERTION ORDER (the index in this.grants, which is the true
		// chronological mint order) — NOT by the random grant id, so attribution is
		// deterministic even when two grants share a millisecond timestamp. For PERSONAL
		// the bucket is per-user; for SHAREABLE the bucket is the whole workspace pool
		// (shareable credits are spendable by any member).
		const bucketGrants = this.grants
			.map((g, index) => ({ g, index }))
			.filter(({ g }) =>
				g.workspaceId === grant.workspaceId
				&& g.creditClass === grant.creditClass
				&& isGrantActive(g, now)
				&& (grant.creditClass === "personal"
					? g.ownerScope === "user" && g.ownerId === grant.ownerId
					: true),
			)
			.sort((a, b) => a.g.createdAt.localeCompare(b.g.createdAt) || a.index - b.index)
			.map(({ g }) => g);

		// Targeted reversal debits per grant (a prior clawback of THAT grant). These
		// reduce the specific grant's own remaining amount, not the shared pool.
		const targetedReversal = (gid: string): number =>
			this.consumptions
				.filter((item) => item.refId === `grant-reversal:${gid}` && item.amount > 0)
				.reduce((sum, item) => sum + item.amount, 0);

		// General (non-targeted) net consumption against the whole bucket: all
		// consumption EXCEPT targeted grant-reversal debits. Releases are negative and
		// net back in. Floored at 0 (the model never represents debt). PERSONAL spend is
		// scoped to the owner; SHAREABLE spend pools across ALL members of the workspace.
		const inBucket = (item: CreditConsumption): boolean =>
			item.workspaceId === grant.workspaceId
			&& item.creditClass === grant.creditClass
			&& (grant.creditClass === "personal" ? item.userId === grant.ownerId : true)
			&& !(typeof item.refId === "string" && item.refId.startsWith("grant-reversal:"));
		const generalConsumed = Math.max(
			0,
			this.consumptions
				.filter(inBucket)
				.reduce((sum, item) => sum + item.amount, 0),
		);

		// FIFO: drain general consumption across each grant's own (post-targeted-
		// reversal) amount, oldest first, and read off how much of THIS grant survives.
		let remainingConsumption = generalConsumed;
		for (const g of bucketGrants) {
			const ownAmount = Math.max(0, g.amount - targetedReversal(g.id));
			const drawn = Math.min(ownAmount, remainingConsumption);
			remainingConsumption = roundCredits(remainingConsumption - drawn);
			if (g.id === grant.id) {
				return roundCredits(Math.max(0, ownAmount - drawn));
			}
		}
		// Grant not found in its own bucket (should not happen) → nothing recoverable.
		return 0;
	}

	private getGrantUnallocatedBalance(grantId: string, now = new Date()): number {
		const grant = this.grants.find((item) => item.id === grantId);
		if (!grant || !isGrantActive(grant, now)) return 0;
		const allocated = this.allocations
			.filter((allocation) => allocation.grantId === grantId && !allocation.revokedAt)
			.reduce((sum, allocation) => sum + allocation.amount, 0);
		return roundCredits(Math.max(0, grant.amount - allocated));
	}

	/**
	 * How much of a fungible balance bucket's consumption is absorbed by the bucket's
	 * already-EXPIRED grants under FIFO (oldest grant first) — i.e. the portion of past
	 * spend that belongs to expired grants and so must NOT be subtracted from the live
	 * balance of still-active grants.
	 *
	 * Money invariant (P0): consumption recorded against a now-EXPIRED grant must stay
	 * attributed to that grant. The naive available-balance math subtracted ALL of a
	 * bucket's consumption from the ACTIVE grants only (active `granted − allConsumed`),
	 * so an expired grant that was, say, 30/50 spent silently drained 30 off the active
	 * pool. Subtracting this returned capacity from the consumption term removes exactly
	 * that bleed: `active granted − (consumed − expiredAbsorbed)`.
	 *
	 * FIFO model mirrors `getGrantUnspentRemainder`: grants ordered oldest-first
	 * (createdAt, then expired-before-active at a tie, then insertion order), each
	 * absorbing consumption up to its OWN granted amount net of any targeted
	 * grant-reversal debit (which is scoped to the grant it reversed, never spread across
	 * the bucket). Only the expired grants' absorbed share is summed and returned.
	 *
	 * `creditClass === "personal"` scopes the bucket to a single owner (personal credits
	 * are per-user); shareable pools across every member of the workspace.
	 */
	private getExpiredGrantsAbsorbedConsumption(workspaceId: string, creditClass: CreditClass, ownerId: string | undefined, totalConsumed: number, now: Date): number {
		// Oldest-first; expired sorts before active at an equal timestamp so it absorbs
		// its own past consumption first. Ties break by insertion order (true mint order).
		const bucketGrants = this.grants
			.map((g, index) => ({ g, index }))
			.filter(({ g }) =>
				g.workspaceId === workspaceId
				&& g.creditClass === creditClass
				&& (creditClass === "personal"
					? g.ownerScope === "user" && g.ownerId === ownerId
					: true),
			)
			.sort((a, b) =>
				a.g.createdAt.localeCompare(b.g.createdAt)
				|| (Number(isGrantActive(a.g, now)) - Number(isGrantActive(b.g, now)))
				|| a.index - b.index)
			.map(({ g }) => g);

		const targetedReversal = (gid: string): number =>
			this.consumptions
				.filter((item) => item.refId === `grant-reversal:${gid}` && item.amount > 0)
				.reduce((sum, item) => sum + item.amount, 0);

		let remainingConsumption = Math.max(0, totalConsumed);
		let expiredAbsorbed = 0;
		for (const g of bucketGrants) {
			if (remainingConsumption <= 0) break;
			const ownAmount = Math.max(0, g.amount - targetedReversal(g.id));
			const drawn = Math.min(ownAmount, remainingConsumption);
			remainingConsumption = roundCredits(remainingConsumption - drawn);
			if (!isGrantActive(g, now)) {
				expiredAbsorbed = roundCredits(expiredAbsorbed + drawn);
			}
		}
		return roundCredits(Math.max(0, expiredAbsorbed));
	}

	private getWorkspaceShareableAvailable(workspaceId: string, now = new Date()): number {
		const granted = this.grants
			.filter((grant) => grant.workspaceId === workspaceId && grant.creditClass === "shareable" && isGrantActive(grant, now))
			.reduce((sum, grant) => sum + grant.amount, 0);
		// Only MEMBER allocations are reserved out of the shareable pool: a member's
		// allocation is spendable solely by that member (added back in
		// getUserShareableAvailable). page/chapter allocations are advisory earmarks —
		// AI submission has no page/chapter spend path, so subtracting them here would
		// permanently lock credits no one can spend. Leave them in the pool so the
		// earmarked credits stay spendable by the workspace while the page/chapter
		// balance endpoint still surfaces the earmark.
		const memberAllocated = this.allocations
			.filter((allocation) => allocation.allocatedToScope === "member" && !allocation.revokedAt)
			.filter((allocation) => this.grants.some((grant) => grant.id === allocation.grantId && grant.workspaceId === workspaceId && isGrantActive(grant, now)))
			.reduce((sum, allocation) => sum + allocation.amount, 0);
		// Allocation-covered consumption is charged against each member's allocation
		// bucket (see getUserShareableAvailable), so only the portion of shareable
		// spend that exceeds a member's allocation draws down the unallocated pool.
		// Consumption by non-allocated users is entirely unallocated overflow.
		const consumedFromPool = this.getWorkspaceUnallocatedShareableConsumed(workspaceId, now);
		// P0: any shareable spend that FIFO-attributes to an already-EXPIRED shareable
		// grant belongs to that grant, not the active pool — subtract it back out of the
		// pool-draining consumption so an expired grant's own past spend never reduces the
		// live shareable balance. Bounded by consumedFromPool (we never add credits, only
		// undo the over-subtraction). totalShareableConsumed feeds the FIFO attribution.
		const totalShareableConsumed = this.getWorkspaceShareableConsumed(workspaceId);
		const expiredAbsorbed = Math.min(
			consumedFromPool,
			this.getExpiredGrantsAbsorbedConsumption(workspaceId, "shareable", undefined, totalShareableConsumed, now),
		);
		return roundCredits(Math.max(0, granted - memberAllocated - (consumedFromPool - expiredAbsorbed)));
	}

	/** Total (net) shareable consumption recorded in a workspace, across all members. */
	private getWorkspaceShareableConsumed(workspaceId: string): number {
		return Math.max(
			0,
			this.consumptions
				.filter((item) =>
					item.workspaceId === workspaceId
					&& item.creditClass === "shareable"
					&& !(typeof item.refId === "string" && item.refId.startsWith("grant-reversal:")))
				.reduce((sum, item) => sum + item.amount, 0),
		);
	}

	private getMemberShareableAllocated(workspaceId: string, userId: string, now = new Date()): number {
		return this.allocations
			.filter((allocation) => allocation.allocatedToScope === "member" && allocation.allocatedToId === userId && !allocation.revokedAt)
			.filter((allocation) => this.grants.some((grant) => grant.id === allocation.grantId && grant.workspaceId === workspaceId && isGrantActive(grant, now)))
			.reduce((sum, allocation) => sum + allocation.amount, 0);
	}

	private getUserShareableConsumed(workspaceId: string, userId: string): number {
		return this.consumptions
			.filter((item) => item.workspaceId === workspaceId && item.userId === userId && item.creditClass === "shareable")
			.reduce((sum, item) => sum + item.amount, 0);
	}

	// Sum, across every user who spent shareable credits in this workspace, the
	// portion of their spend not covered by their own member allocation. This is
	// what actually drains the workspace-unallocated shareable pool.
	private getWorkspaceUnallocatedShareableConsumed(workspaceId: string, now = new Date()): number {
		const userIds = new Set(
			this.consumptions
				.filter((item) => item.workspaceId === workspaceId && item.creditClass === "shareable")
				.map((item) => item.userId),
		);
		let total = 0;
		for (const userId of userIds) {
			const consumed = this.getUserShareableConsumed(workspaceId, userId);
			if (consumed <= 0) continue;
			const allocated = this.getMemberShareableAllocated(workspaceId, userId, now);
			total += Math.max(0, consumed - allocated);
		}
		return roundCredits(total);
	}

	private getActiveAllocations(scope: CreditAllocationScope, id: string, now = new Date(), workspaceId?: string): CreditAllocation[] {
		return this.allocations.filter((allocation) => {
			if (allocation.revokedAt || allocation.allocatedToScope !== scope || allocation.allocatedToId !== id) return false;
			const grant = this.grants.find((item) => item.id === allocation.grantId);
			if (!grant || !isGrantActive(grant, now)) return false;
			// When a workspace is supplied, only count allocations whose grant belongs
			// to it so page/chapter ids cannot leak balances across workspaces.
			return !workspaceId || grant.workspaceId === workspaceId;
		});
	}

	private getUserPersonalAvailable(workspaceId: string, userId: string, now = new Date()): number {
		const granted = this.grants
			.filter((grant) => (
				grant.workspaceId === workspaceId
				&& grant.ownerScope === "user"
				&& grant.ownerId === userId
				&& grant.creditClass === "personal"
				&& isGrantActive(grant, now)
			))
			.reduce((sum, grant) => sum + grant.amount, 0);
		const consumed = this.consumptions
			.filter((item) => item.workspaceId === workspaceId && item.userId === userId && item.creditClass === "personal")
			.reduce((sum, item) => sum + item.amount, 0);
		// P0: personal spend that FIFO-attributes to an already-EXPIRED personal grant
		// belongs to that grant — subtract it back out so an expired (partially-spent)
		// grant's own past consumption never drains the user's still-active personal
		// credits. generalConsumed excludes targeted grant-reversal debits (those reduce
		// only the grant they reversed), matching the FIFO attribution helper.
		const generalConsumed = this.consumptions
			.filter((item) =>
				item.workspaceId === workspaceId
				&& item.userId === userId
				&& item.creditClass === "personal"
				&& !(typeof item.refId === "string" && item.refId.startsWith("grant-reversal:")))
			.reduce((sum, item) => sum + item.amount, 0);
		const expiredAbsorbed = this.getExpiredGrantsAbsorbedConsumption(workspaceId, "personal", userId, Math.max(0, generalConsumed), now);
		return roundCredits(Math.max(0, granted - Math.max(0, consumed - expiredAbsorbed)));
	}

	private getUserShareableAvailable(workspaceId: string, userId: string, now = new Date()): number {
		const memberAllocated = this.getMemberShareableAllocated(workspaceId, userId, now);
		// Charge this user's own shareable spend against their allocation first; any
		// overflow has already been subtracted from the workspace-unallocated pool.
		const userConsumed = this.getUserShareableConsumed(workspaceId, userId);
		const allocationRemaining = Math.max(0, memberAllocated - userConsumed);
		const workspaceUnallocated = this.getWorkspaceShareableAvailable(workspaceId, now);
		return roundCredits(Math.max(0, allocationRemaining + workspaceUnallocated));
	}

	private recordConsumption(workspaceId: string, userId: string, creditClass: CreditClass, amount: number, reason: string, refId: string | undefined, now: Date): void {
		const consumption: CreditConsumption = {
			id: randomUUID(),
			workspaceId,
			userId,
			creditClass,
			amount: roundCredits(amount),
			reason: requiredId(reason, "reason"),
			refId,
			createdAt: now.toISOString(),
		};
		this.consumptions.push(consumption);
		this.appendLedger({
			workspaceId,
			userId,
			creditClass,
			delta: -consumption.amount,
			balanceAfter: creditClass === "personal"
				? this.getUserPersonalAvailable(workspaceId, userId, now)
				: this.getUserShareableAvailable(workspaceId, userId, now),
			reason: consumption.reason,
			refId,
			createdAt: consumption.createdAt,
		});
	}

	private countAllocationsByUserForDay(userId: string, now: Date): number {
		const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		const end = start + 24 * 60 * 60 * 1000;
		return this.allocations.filter((allocation) => {
			if (allocation.allocatedBy !== userId) return false;
			const time = Date.parse(allocation.createdAt);
			return Number.isFinite(time) && time >= start && time < end;
		}).length;
	}

	private appendLedger(input: Omit<CreditLedgerEntry, "id">): void {
		this.ledger.push({ id: randomUUID(), ...input, balanceAfter: roundCredits(input.balanceAfter), delta: roundCredits(input.delta) });
	}

	private load(): void {
		if (!existsSync(this.filePath)) return;
		const snapshot = readJsonFile<Partial<CreditSnapshot>>(this.filePath);
		this.grants = Array.isArray(snapshot.grants) ? snapshot.grants : [];
		this.allocations = Array.isArray(snapshot.allocations) ? snapshot.allocations : [];
		this.ledger = Array.isArray(snapshot.ledger) ? snapshot.ledger : [];
		this.consumptions = Array.isArray(snapshot.consumptions) ? snapshot.consumptions : [];
		// Exactly-once ×10 unit rebase for pre-redesign files (the file-backed twin
		// of migration 0087). save() stamps CREDIT_UNITS_VERSION, so an upgraded
		// file can never be multiplied twice; a brand-new empty store starts at the
		// current version with nothing to convert.
		const version = typeof snapshot.unitsVersion === "number" ? snapshot.unitsVersion : 1;
		if (version < CREDIT_UNITS_VERSION) {
			for (const grant of this.grants) grant.amount *= 10;
			for (const allocation of this.allocations) allocation.amount *= 10;
			for (const entry of this.ledger) {
				entry.delta *= 10;
				entry.balanceAfter *= 10;
			}
			for (const consumption of this.consumptions) consumption.amount *= 10;
			this.save();
		}
	}

	private save(beforeCommit?: () => void): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const payload = JSON.stringify({
			grants: this.grants,
			allocations: this.allocations,
			ledger: this.ledger,
			consumptions: this.consumptions,
			unitsVersion: CREDIT_UNITS_VERSION,
		}, null, 2);
		// Atomic write: serialize to a unique temp file, fsync, then rename over the
		// target. rename(2) is atomic on the same filesystem, so a concurrent reader
		// (or a crash mid-write) never observes a truncated/partial credits.json.
		//
		// `beforeCommit` (the outermost cross-process mutate() only) runs in the
		// instant before the rename so the lock-ownership fence re-read sits back-to-
		// back with the atomic commit — see mutate()/assertLockOwnership for why that
		// closes the stale-reclaim double-write window. If it throws (peer reclaimed
		// our lock → token differs), writeFileAtomic skips the rename and cleans up the
		// temp file: nothing is published, and mutate() rolls back + retries.
		writeFileAtomic(this.filePath, payload, beforeCommit);
	}
}

function normalizeAmount(amount: number): number {
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new CreditServiceError("Credit amount must be positive", 400, "invalid_credit_amount");
	}
	return roundCredits(amount);
}

function requiredId(value: string, field: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new CreditServiceError(`${field} is required`, 400, `missing_${field}`);
	return trimmed.slice(0, 300);
}

function normalizeIsoDate(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const time = Date.parse(value);
	if (!Number.isFinite(time)) throw new CreditServiceError("expiresAt must be an ISO timestamp", 400, "invalid_expires_at");
	return new Date(time).toISOString();
}

function isGrantActive(grant: CreditGrant, now = new Date()): boolean {
	return !grant.expiresAt || Date.parse(grant.expiresAt) > now.getTime();
}

function roundCredits(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

export const creditService = new CreditService();

export const grantCredits = creditService.grantCredits.bind(creditService);
export const reverseGrant = creditService.reverseGrant.bind(creditService);
export const clawbackGrantByKey = creditService.clawbackGrantByKey.bind(creditService);
export const clawbackGrantsByKeyPrefix = creditService.clawbackGrantsByKeyPrefix.bind(creditService);
export const getSignedWorkspaceShareableBalance = creditService.getSignedWorkspaceShareableBalance.bind(creditService);
export const allocate = creditService.allocate.bind(creditService);
export const revokeAllocation = creditService.revokeAllocation.bind(creditService);
export const consume = creditService.consume.bind(creditService);
export const hasCreditSystem = creditService.hasCreditSystem.bind(creditService);
export const releaseConsumption = creditService.releaseConsumption.bind(creditService);
export const releaseConsumptionsByRef = creditService.releaseConsumptionsByRef.bind(creditService);
export const releasePartialByRef = creditService.releasePartialByRef.bind(creditService);
export const getBalance = creditService.getBalance.bind(creditService);
export const listAllocations = creditService.listAllocations.bind(creditService);
export const getGrantWorkspaceId = creditService.getGrantWorkspaceId.bind(creditService);
export const getAllocationWorkspaceId = creditService.getAllocationWorkspaceId.bind(creditService);
