import { describe, expect, test } from "bun:test";
import { PostgresGdprStore } from "../services/gdpr.js";
import { LastPlatformOwnerError } from "../services/auth-users.js";

/**
 * Real-Postgres durability + correctness test for PostgresGdprStore.
 *
 * Proves the whole point of the back-office store: the admin audit trail and
 * impersonation log PERSIST across a process bounce (a brand-new store instance,
 * i.e. "after restart", sees rows the previous instance wrote), queries by
 * actor/target/time paginate correctly, every audit row captures actorRole, and
 * the soft-delete owner-guard is preserved on the Postgres path (the last active
 * platform owner cannot self-delete — the row is NOT scrambled).
 *
 * Migrations (including 0057) must already be applied to TEST_DATABASE_URL:
 *   docker run -d --name pggdpr -e POSTGRES_PASSWORD=test -p 55434:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:test@127.0.0.1:55434/postgres \
 *     bun run src/migrations/cli.ts up
 *
 * The owner-guard sub-test additionally requires the auth user store to be the
 * Postgres store (so PostgresGdprStore.softDeleteUser routes the guarded write to
 * Postgres). Run the file with:
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55434/postgres \
 *   DATABASE_URL=postgres://postgres:test@127.0.0.1:55434/postgres \
 *   AUTH_USER_STORE=postgres \
 *     bun test src/__tests__/gdpr-postgres.real-pg.test.ts
 *
 * Everything shares one Bun.SQL connection (max: 1) opened/closed inside the
 * single test, matching pg-array-binds.real-pg.test.ts, so the test runner's
 * event loop is not stalled by a long-lived pool and max_connections is safe.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

describeReal("PostgresGdprStore (real Postgres)", () => {
	test("audit + impersonation persist across re-instantiation; actorRole captured; queries paginate", async () => {
		const NS = `gdpr-${Date.now()}`;
		const admin1 = `${NS}-admin1`;
		const admin2 = `${NS}-admin2`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		try {
			const store = new PostgresGdprStore(raw);

			// --- admin audit: write several rows, varying actor / target / role ---
			await store.recordAdminAudit({ adminUserId: admin1, actorRole: "support", action: "admin.workspace.credit_grant", targetKind: "workspace", targetId: `${NS}-ws-1`, detail: { aiCredits: 500 } });
			await store.recordAdminAudit({ adminUserId: admin2, actorRole: "owner", action: "admin.user.force_delete", targetKind: "user", targetId: `${NS}-u-1`, detail: { email: "x@y.z" } });
			for (let i = 0; i < 5; i++) {
				await store.recordAdminAudit({ adminUserId: admin1, actorRole: "support", action: "admin.cron.trigger", targetKind: "cron_job", targetId: `${NS}-job-${i}` });
			}

			// --- impersonation: open + close events ---
			const imp = await store.startImpersonation(admin1, `${NS}-target-1`, "support ticket");
			expect(imp.endedAt).toBeNull();
			const ended = await store.endImpersonation(imp.id);
			expect(ended?.endedAt).not.toBeNull();
			// Idempotent close: closing again returns the row unchanged.
			const endedAgain = await store.endImpersonation(imp.id);
			expect(endedAgain?.id).toBe(imp.id);

			// --- DURABILITY: a FRESH store instance (≈ after restart) sees the rows ---
			const reopened = new PostgresGdprStore(raw);

			// Query by actor.
			const byAdmin1 = await reopened.listAdminAudit({ adminUserId: admin1, limit: 100 });
			expect(byAdmin1.total).toBe(6); // 1 credit_grant + 5 cron triggers
			expect(byAdmin1.entries.every((e) => e.adminUserId === admin1)).toBe(true);

			// actorRole captured + filterable.
			expect(byAdmin1.entries.every((e) => e.actorRole === "support")).toBe(true);
			const byRole = await reopened.listAdminAudit({ actorRole: "owner", limit: 100 });
			expect(byRole.total).toBe(1);
			expect(byRole.entries[0].adminUserId).toBe(admin2);

			// Query by target.
			const byTarget = await reopened.listAdminAudit({ targetKind: "user", targetId: `${NS}-u-1` });
			expect(byTarget.total).toBe(1);
			expect(byTarget.entries[0].action).toBe("admin.user.force_delete");

			// Date range filtering
			const now = new Date();
			const tenSecondsAgo = new Date(now.getTime() - 10000).toISOString();
			const tenSecondsLater = new Date(now.getTime() + 10000).toISOString();

			const inRange = await reopened.listAdminAudit({ fromDate: tenSecondsAgo });
			expect(inRange.total).toBeGreaterThan(0);

			const futureFrom = await reopened.listAdminAudit({ fromDate: tenSecondsLater });
			expect(futureFrom.total).toBe(0);

			const pastTo = await reopened.listAdminAudit({ toDate: tenSecondsAgo });
			expect(pastTo.total).toBe(0);

			// Bounded UTC-ISO window (the canonical form the admin routes normalize to)
			// binds cleanly as ::timestamptz and selects exactly the rows inside it.
			const windowed = await reopened.listAdminAudit({
				adminUserId: admin1,
				fromDate: tenSecondsAgo,
				toDate: tenSecondsLater,
			});
			expect(windowed.total).toBe(6);
			expect(windowed.entries.every((e) => e.adminUserId === admin1)).toBe(true);

			// Pagination: page through the 6 admin1 rows in chunks of 4.
			const page1 = await reopened.listAdminAudit({ adminUserId: admin1, limit: 4, offset: 0 });
			const page2 = await reopened.listAdminAudit({ adminUserId: admin1, limit: 4, offset: 4 });
			expect(page1.total).toBe(6);
			expect(page1.entries).toHaveLength(4);
			expect(page2.entries).toHaveLength(2);
			const ids = new Set([...page1.entries, ...page2.entries].map((e) => e.id));
			expect(ids.size).toBe(6); // no overlap between pages
			// Newest-first ordering: page1's first row is at least as new as page2's last.
			expect(page1.entries[0].createdAt >= page2.entries[page2.entries.length - 1].createdAt).toBe(true);

			// Impersonation durability + actor/target filters.
			const impByAdmin = await reopened.listImpersonations({ adminUserId: admin1 });
			expect(impByAdmin.find((e) => e.id === imp.id)?.endedAt).not.toBeNull();
			const impByTarget = await reopened.listImpersonations({ targetUserId: `${NS}-target-1` });
			expect(impByTarget).toHaveLength(1);
		} finally {
			await raw.unsafe(`DELETE FROM admin_audit WHERE target_id LIKE $1 OR admin_user_id LIKE $1`, [`${NS}-%`]);
			await raw.unsafe(`DELETE FROM impersonation_events WHERE admin_user_id LIKE $1 OR impersonated_user_id LIKE $1`, [`${NS}-%`]);
			await raw.close?.();
		}
	});

	test("admin_audit.actor_role column exists (migration 0057 applied)", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		try {
			const rows = await raw.unsafe(`
				SELECT column_name FROM information_schema.columns
				WHERE table_name = 'admin_audit' AND column_name = 'actor_role'
			`);
			expect(rows).toHaveLength(1);
		} finally {
			await raw.close?.();
		}
	});

	// P1a (TOCTOU): the atomic CAS in purgeSoftDeletedUser must re-check the
	// deletion markers against the EXACT context the candidate was selected with,
	// so a restore-then-redelete (fresh future grace) between listing and purge
	// cannot be erased. This exercises the pure-Postgres CAS at the SQL level
	// (seed markers directly; assert the conditional UPDATE clears them only when
	// the context still matches) — it does not depend on the auth store posture.
	test("purgeSoftDeletedUser CAS skips when deletion markers no longer match the selection context", async () => {
		const NS = `gdpr-cas-${Date.now()}`;
		const userId = `${NS}-user`;
		const email = `${userId}@example.com`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		try {
			const store = new PostgresGdprStore(raw);
			// Seed an active user, then stamp an ORIGINAL soft-delete window.
			await raw.unsafe(`
				INSERT INTO auth_users (
					user_id, email, email_normalized, password_hash, name, role,
					auth_provider, email_verified, is_active, created_at, updated_at
				) VALUES ($1, $2, $2, 'x', 'CAS User', 'editor', 'local', true, true, now(), now())
				ON CONFLICT (user_id) DO NOTHING
			`, [userId, email]);
			const originalDeletedAt = "2026-01-01T00:00:00.000Z";
			const originalGraceUntil = "2026-01-31T00:00:00.000Z";
			await raw.unsafe(`
				UPDATE auth_users SET deleted_at = $2, delete_grace_until = $3, is_active = false WHERE user_id = $1
			`, [userId, originalDeletedAt, originalGraceUntil]);

			// THE RACE: between the sweep listing this OLD delete and purging, the user
			// restored + re-deleted with a FRESH future grace window (a new, current
			// undo window). Model the post-race live row directly.
			const freshDeletedAt = "2026-06-01T00:00:00.000Z";
			const freshGraceUntil = "2026-08-01T00:00:00.000Z"; // future undo window
			await raw.unsafe(`
				UPDATE auth_users SET deleted_at = $2, delete_grace_until = $3 WHERE user_id = $1
			`, [userId, freshDeletedAt, freshGraceUntil]);

			// Purge with the STALE selection context (the OLD deletedAt + a retention
			// cutoff/grace that only the OLD row satisfied). CAS must MISS → skip.
			const skipped = await store.purgeSoftDeletedUser(userId, {
				deletedAt: originalDeletedAt,
				graceUntilAtOrBefore: "2026-02-01T00:00:00.000Z",
				deletedAtOrBefore: "2026-02-01T00:00:00.000Z",
			});
			expect(skipped.purged).toBe(false);
			expect(skipped.reason).toBe("markers_changed");
			// Markers are UNTOUCHED — the fresh window survives, no erasure happened.
			const afterSkip = await raw.unsafe(`SELECT deleted_at, delete_grace_until FROM auth_users WHERE user_id = $1`, [userId]);
			expect(afterSkip[0].deleted_at).not.toBeNull();
			expect(new Date(afterSkip[0].delete_grace_until).toISOString()).toBe(freshGraceUntil);

			// Now purge with the context MATCHING the fresh row, where that fresh grace
			// is genuinely past (sweep clock after the window). The CAS HITS and clears
			// the markers — proving the conditional UPDATE authorizes a purge only when
			// the live row still satisfies every gate. (`purged` is NOT asserted true
			// here: the PII scrub runs through the file-mode authUserStore, which has no
			// row for this Postgres-only seed; the CAS — the P1a fix — is what we test,
			// and it must NOT report a skip reason.)
			const purged = await store.purgeSoftDeletedUser(userId, {
				deletedAt: freshDeletedAt,
				graceUntilAtOrBefore: "2026-09-01T00:00:00.000Z",
				deletedAtOrBefore: "2026-08-15T00:00:00.000Z",
			});
			expect(purged.reason).not.toBe("markers_changed");
			expect(purged.reason).not.toBe("not_soft_deleted");
			// Markers cleared by the winning CAS, so a re-run cannot re-purge
			// (idempotent / race-safe): the row will no longer be a candidate.
			const afterPurge = await raw.unsafe(`SELECT deleted_at, delete_grace_until FROM auth_users WHERE user_id = $1`, [userId]);
			expect(afterPurge[0].deleted_at).toBeNull();
			expect(afterPurge[0].delete_grace_until).toBeNull();

			// Re-run with the same context now MISSES (markers already cleared): a
			// double-purge / second sweep tick is a safe no-op, never a re-erase.
			const rerun = await store.purgeSoftDeletedUser(userId, {
				deletedAt: freshDeletedAt,
				graceUntilAtOrBefore: "2026-09-01T00:00:00.000Z",
				deletedAtOrBefore: "2026-08-15T00:00:00.000Z",
			});
			expect(rerun.purged).toBe(false);
		} finally {
			await raw.unsafe(`DELETE FROM auth_external_identities WHERE user_id = $1`, [userId]).catch(() => {});
			await raw.unsafe(`DELETE FROM auth_users WHERE user_id = $1`, [userId]);
			await raw.close?.();
		}
	});

	// P1 (erasure-completeness / atomicity): the purge clears the soft-delete
	// markers, scrubs PII, and drops SSO identities in ONE transaction. If any
	// statement AFTER the CAS throws (or the process dies before COMMIT), the WHOLE
	// transaction must ROLL BACK: `deleted_at` stays set, PII + identities survive,
	// and the user is STILL a sweep candidate so the next sweep retries — never a
	// partial purge that strands PII forever under a no-longer-soft-deleted row.
	test("purgeSoftDeletedUser rolls back atomically when the SSO-identity delete throws mid-purge (re-sweepable, no partial purge)", async () => {
		const NS = `gdpr-atomic-${Date.now()}`;
		const userId = `${NS}-user`;
		const email = `${userId}@example.com`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		try {
			// Seed an active user WITH PII + a linked SSO identity, then stamp an
			// expired soft-delete window so it is a genuine erasure candidate.
			await raw.unsafe(`
				INSERT INTO auth_users (
					user_id, email, email_normalized, password_hash, name, role,
					auth_provider, external_subject, email_verified, is_active, created_at, updated_at
				) VALUES ($1, $2, $2, 'secret-hash', 'Atomic User', 'editor', 'google', 'ext-subject-123', true, true, now(), now())
				ON CONFLICT (user_id) DO NOTHING
			`, [userId, email]);
			await raw.unsafe(`
				INSERT INTO auth_external_identities (user_id, provider, provider_user_id)
				VALUES ($1, 'google', 'ext-subject-123')
				ON CONFLICT DO NOTHING
			`, [userId]);
			const deletedAt = "2026-01-01T00:00:00.000Z";
			const graceUntil = "2026-01-15T00:00:00.000Z";
			await raw.unsafe(`
				UPDATE auth_users SET deleted_at = $2, delete_grace_until = $3, is_active = false WHERE user_id = $1
			`, [userId, deletedAt, graceUntil]);

			// FAULT INJECTION: wrap the client so that, INSIDE the purge transaction,
			// the `DELETE FROM auth_external_identities` (which runs AFTER the CAS +
			// PII scrub) throws — modeling a crash/failure mid-purge. We wrap `begin`
			// so the fault is injected on the transaction client `fn` actually uses;
			// every other statement (CAS, scrub) executes normally and would COMMIT if
			// not for the throw, which must instead force a ROLLBACK.
			const isFaultStatement = (q: string) =>
				q.includes("auth_external_identities") && q.trim().toUpperCase().startsWith("DELETE");
			const faulting = {
				// Inject on the direct path too, so the test catches a NON-atomic
				// implementation (separate statements) just as well as the atomic one.
				unsafe: (q: string, p?: unknown[]) => {
					if (isFaultStatement(q)) throw new Error("injected mid-purge failure (SSO-identity delete)");
					return raw.unsafe(q, p);
				},
				begin: <T,>(fn: (tx: unknown) => Promise<T>) =>
					raw.begin((tx: { unsafe: (q: string, p?: unknown[]) => Promise<unknown> }) => {
						const wrappedTx = {
							unsafe: (q: string, p?: unknown[]) => {
								if (isFaultStatement(q)) {
									throw new Error("injected mid-purge failure (SSO-identity delete)");
								}
								return tx.unsafe(q, p);
							},
						};
						return fn(wrappedTx);
					}),
			};
			const store = new PostgresGdprStore(faulting as unknown as ConstructorParameters<typeof PostgresGdprStore>[0]);

			// The purge must throw (the injected failure propagates out of the txn).
			await expect(
				store.purgeSoftDeletedUser(userId, {
					deletedAt,
					graceUntilAtOrBefore: "2026-02-01T00:00:00.000Z",
					deletedAtOrBefore: "2026-02-01T00:00:00.000Z",
				}),
			).rejects.toThrow();

			// ROLLBACK PROOF: the CAS-cleared markers were rolled back with the failed
			// scrub — `deleted_at`/`delete_grace_until` are STILL set, PII is INTACT,
			// and the SSO identity survives. No partial purge stranded PII.
			const after = await raw.unsafe(`
				SELECT email, name, password_hash, external_subject, deleted_at, delete_grace_until
				FROM auth_users WHERE user_id = $1
			`, [userId]);
			expect(after[0].deleted_at).not.toBeNull();
			expect(after[0].delete_grace_until).not.toBeNull();
			expect(after[0].email).toBe(email); // NOT the purge tombstone
			expect(after[0].name).toBe("Atomic User");
			expect(after[0].password_hash).toBe("secret-hash");
			expect(after[0].external_subject).toBe("ext-subject-123");
			const idents = await raw.unsafe(`SELECT 1 FROM auth_external_identities WHERE user_id = $1`, [userId]);
			expect(idents).toHaveLength(1);

			// RE-SWEEPABLE: the row is STILL a candidate (markers intact), so the next
			// sweep retries. A retry through a HEALTHY store now completes the purge.
			const expiredAgain = await store.listExpiredSoftDeletes(new Date("2026-02-01T00:00:00.000Z"));
			expect(expiredAgain.some((e) => e.userId === userId)).toBe(true);
			const pendingAgain = await store.listPendingSoftDeletes();
			expect(pendingAgain.some((e) => e.userId === userId)).toBe(true);

			// Retry on the un-faulted client → atomic purge succeeds this time:
			// markers cleared, PII scrubbed, identities gone, all in one commit.
			const healthy = new PostgresGdprStore(raw);
			const retried = await healthy.purgeSoftDeletedUser(userId, {
				deletedAt,
				graceUntilAtOrBefore: "2026-02-01T00:00:00.000Z",
				deletedAtOrBefore: "2026-02-01T00:00:00.000Z",
			});
			expect(retried.reason).not.toBe("markers_changed");
			const final = await raw.unsafe(`
				SELECT email, name, password_hash, external_subject, deleted_at FROM auth_users WHERE user_id = $1
			`, [userId]);
			expect(final[0].deleted_at).toBeNull();
			expect(String(final[0].email).startsWith("purged+")).toBe(true);
			expect(final[0].name).toBe("[deleted user]");
			expect(final[0].password_hash).toBe("");
			expect(final[0].external_subject).toBeNull();
			const identsFinal = await raw.unsafe(`SELECT 1 FROM auth_external_identities WHERE user_id = $1`, [userId]);
			expect(identsFinal).toHaveLength(0);
		} finally {
			await raw.unsafe(`DELETE FROM auth_external_identities WHERE user_id = $1`, [userId]).catch(() => {});
			await raw.unsafe(`DELETE FROM auth_users WHERE user_id = $1`, [userId]);
			await raw.close?.();
		}
	});

	// Owner-guard on the Postgres path requires the auth user store to be Postgres
	// too (so the guarded write lands in the same DB). Gated on that posture.
	const ownerGuardEnabled = process.env.AUTH_USER_STORE === "postgres" && process.env.DATABASE_URL;
	const ownerGuardTest = ownerGuardEnabled ? test : test.skip;

	ownerGuardTest("solo active owner self-delete is BLOCKED on the Postgres path (row stays owner+active, NOT scrambled)", async () => {
		const NS = `gdpr-og-${Date.now()}`;
		const ownerId = `${NS}-owner`;
		const ownerEmail = `${ownerId}@example.com`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		try {
			// Seed exactly ONE active owner. The shared DB may hold other owners from
			// the app's bootstrap, so neutralize them for the duration of the test by
			// flipping them inactive, then restore in finally.
			const others = await raw.unsafe(`SELECT user_id FROM auth_users WHERE role = 'owner' AND is_active = true`);
			const otherIds: string[] = others.map((r: { user_id: string }) => r.user_id);
			for (const id of otherIds) {
				await raw.unsafe(`UPDATE auth_users SET is_active = false WHERE user_id = $1`, [id]);
			}
			await raw.unsafe(`
				INSERT INTO auth_users (
					user_id, email, email_normalized, password_hash, name, role,
					auth_provider, email_verified, is_active, created_at, updated_at
				) VALUES ($1, $2, $2, 'x', 'Sole Owner', 'owner', 'local', true, true, now(), now())
				ON CONFLICT (user_id) DO NOTHING
			`, [ownerId, ownerEmail]);

			const store = new PostgresGdprStore(raw);
			await expect(
				store.softDeleteUser(ownerId, { gracePeriodMs: 1000 }),
			).rejects.toBeInstanceOf(LastPlatformOwnerError);

			// Fail-closed: still owner + active + original email, no soft-delete stamp.
			const rows = await raw.unsafe(`SELECT role, is_active, email, deleted_at, delete_grace_until FROM auth_users WHERE user_id = $1`, [ownerId]);
			expect(rows[0].role).toBe("owner");
			expect(rows[0].is_active === true || rows[0].is_active === "t" || rows[0].is_active === 1).toBe(true);
			expect(rows[0].email).toBe(ownerEmail);
			expect(rows[0].deleted_at).toBeNull();
			expect(rows[0].delete_grace_until).toBeNull();
		} finally {
			await raw.unsafe(`DELETE FROM auth_users WHERE user_id = $1`, [ownerId]);
			// Restore any owners we deactivated.
			await raw.unsafe(`UPDATE auth_users SET is_active = true WHERE role = 'owner' AND user_id LIKE $1`, [`${NS}-%`]).catch(() => {});
			await raw.close?.();
		}
	});

	ownerGuardTest("with a second active owner, soft-delete SUCCEEDS on the Postgres path and stamps the grace window", async () => {
		const NS = `gdpr-og2-${Date.now()}`;
		const ownerA = `${NS}-ownerA`;
		const ownerB = `${NS}-ownerB`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		try {
			for (const [id, name] of [[ownerA, "Owner A"], [ownerB, "Owner B"]]) {
				await raw.unsafe(`
					INSERT INTO auth_users (
						user_id, email, email_normalized, password_hash, name, role,
						auth_provider, email_verified, is_active, created_at, updated_at
					) VALUES ($1, $2, $2, 'x', $3, 'owner', 'local', true, true, now(), now())
					ON CONFLICT (user_id) DO NOTHING
				`, [id, `${id}@example.com`, name]);
			}

			const store = new PostgresGdprStore(raw);
			const snapshot = await store.softDeleteUser(ownerA, { gracePeriodMs: 1000 * 60 });
			expect(snapshot).not.toBeNull();
			expect(snapshot?.redactedEmail).toBe(`deleted+${ownerA}@redacted.invalid`);

			const rowsA = await raw.unsafe(`SELECT is_active, email, deleted_at, delete_grace_until FROM auth_users WHERE user_id = $1`, [ownerA]);
			expect(rowsA[0].is_active === false || rowsA[0].is_active === "f" || rowsA[0].is_active === 0).toBe(true);
			expect(String(rowsA[0].email).startsWith("deleted+")).toBe(true);
			expect(rowsA[0].deleted_at).not.toBeNull();
			expect(rowsA[0].delete_grace_until).not.toBeNull();

			// Pending list reflects the soft-delete; the survivor owner is untouched.
			const pending = await store.listPendingSoftDeletes();
			expect(pending.find((p) => p.userId === ownerA)).toBeDefined();
			const rowsB = await raw.unsafe(`SELECT role, is_active FROM auth_users WHERE user_id = $1`, [ownerB]);
			expect(rowsB[0].role).toBe("owner");
		} finally {
			await raw.unsafe(`DELETE FROM auth_users WHERE user_id IN ($1, $2)`, [ownerA, ownerB]);
			await raw.close?.();
		}
	});

	// P1 (erasure-completeness): the purge transaction also scrubs the subject's
	// ANCILLARY PII — consent IP/UA, invite emails, the notification inbox, support
	// message bodies, and workspace memberships — atomically with the auth scrub.
	test("purgeSoftDeletedUser also erases ancillary PII (consent IP/UA, invite email, notifications, support messages, memberships) in the same txn", async () => {
		const NS = `gdpr-ancillary-${Date.now()}`;
		const userId = `${NS}-user`;
		const email = `${userId}@Example.com`; // mixed-case to prove case-insensitive invite match
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		const wsId = `${NS}-ws`;
		const ticketId = `${NS}-ticket`;
		try {
			await raw.unsafe(`
				INSERT INTO auth_users (user_id, email, email_normalized, password_hash, name, role, auth_provider, email_verified, is_active, created_at, updated_at)
				VALUES ($1, $2, lower($2), 'x', 'Ancillary User', 'editor', 'local', true, true, now(), now())
				ON CONFLICT (user_id) DO NOTHING
			`, [userId, email]);
			// Seed ancillary PII.
			await raw.unsafe(`INSERT INTO consent_events (id, user_id, consent_type, categories, ip_address, user_agent, policy_version) VALUES (gen_random_uuid(), $1, 'cookie', '{}'::jsonb, '203.0.113.9', 'PII-UA', 'v1')`, [userId]);
			await raw.unsafe(`INSERT INTO notifications (id, user_id, type, title, body) VALUES (gen_random_uuid(), $1, 'ticket_opened', 'PII', 'secret')`, [userId]);
			await raw.unsafe(`INSERT INTO workspaces (workspace_id, name, created_at, updated_at) VALUES ($1, 'WS', now(), now()) ON CONFLICT (workspace_id) DO NOTHING`, [wsId]);
			await raw.unsafe(`INSERT INTO workspace_members (workspace_id, user_id, role, member_studio_role, scope, created_at, updated_at) VALUES ($1, $2, 'editor', 'translator', '{}'::jsonb, now(), now()) ON CONFLICT DO NOTHING`, [wsId, userId]);
			await raw.unsafe(`INSERT INTO workspace_invites (invite_id, workspace_id, email, role, token_hash, status, invited_by_user_id, expires_at) VALUES ($1, $2, lower($3), 'editor', $4, 'pending', 'boss', now() + interval '7 days')`, [`${NS}-inv`, wsId, email, `${NS}-hash`]);
			await raw.unsafe(`INSERT INTO support_tickets (id, requester_user_id, subject) VALUES ($1, $2, 'help')`, [ticketId, userId]);
			await raw.unsafe(`INSERT INTO support_ticket_messages (id, ticket_id, author_kind, author_user_id, body) VALUES ($1, $2, 'customer', $3, 'PII message body')`, [`${NS}-msg`, ticketId, userId]);

			// Stamp an expired soft-delete window so it is a genuine candidate. Also stash
			// the original email in `deletion_original_email` (what the REAL softDeleteUser
			// does before it redacts auth_users.email) so the invite-erasure key is the
			// ORIGINAL address even though this raw-stamp path leaves `email` unredacted.
			const deletedAt = "2026-01-01T00:00:00.000Z";
			await raw.unsafe(`UPDATE auth_users SET deleted_at = $2, delete_grace_until = $2, is_active = false, deletion_original_email = $3 WHERE user_id = $1`, [userId, deletedAt, email]);

			const store = new PostgresGdprStore(raw);
			const purged = await store.purgeSoftDeletedUser(userId, {
				deletedAt,
				graceUntilAtOrBefore: "2026-02-01T00:00:00.000Z",
				deletedAtOrBefore: "2026-02-01T00:00:00.000Z",
			});
			expect(purged.reason).not.toBe("markers_changed");

			// Consent PII nulled, the row retained.
			const consent = await raw.unsafe(`SELECT ip_address, user_agent FROM consent_events WHERE user_id = $1`, [userId]);
			expect(consent.length).toBe(1);
			expect(consent[0].ip_address).toBeNull();
			expect(consent[0].user_agent).toBeNull();
			// Notifications deleted.
			expect((await raw.unsafe(`SELECT 1 FROM notifications WHERE user_id = $1`, [userId])).length).toBe(0);
			// Membership deleted.
			expect((await raw.unsafe(`SELECT 1 FROM workspace_members WHERE user_id = $1`, [userId])).length).toBe(0);
			// Invite email anonymized (keyed off the ORIGINAL email recovered from
			// deletion_original_email, NOT the redacted alias on the live auth row).
			const inv = await raw.unsafe(`SELECT email FROM workspace_invites WHERE invite_id = $1`, [`${NS}-inv`]);
			expect(inv[0].email).toBe(`purged+${userId}@redacted.invalid`);
			// The stashed original email is itself erased inside the same purge txn.
			const purgedRow = await raw.unsafe(`SELECT email, deletion_original_email FROM auth_users WHERE user_id = $1`, [userId]);
			expect(purgedRow[0].email).toBe(`purged+${userId}@redacted.invalid`);
			expect(purgedRow[0].deletion_original_email).toBeNull();
			// Support message body anonymized.
			const msg = await raw.unsafe(`SELECT body FROM support_ticket_messages WHERE author_user_id = $1`, [userId]);
			expect(msg[0].body).toBe("[deleted user message]");
		} finally {
			await raw.unsafe(`DELETE FROM support_ticket_messages WHERE ticket_id = $1`, [ticketId]).catch(() => {});
			await raw.unsafe(`DELETE FROM support_tickets WHERE id = $1`, [ticketId]).catch(() => {});
			await raw.unsafe(`DELETE FROM workspace_invites WHERE workspace_id = $1`, [wsId]).catch(() => {});
			await raw.unsafe(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]).catch(() => {});
			await raw.unsafe(`DELETE FROM notifications WHERE user_id = $1`, [userId]).catch(() => {});
			await raw.unsafe(`DELETE FROM consent_events WHERE user_id = $1`, [userId]).catch(() => {});
			await raw.unsafe(`DELETE FROM workspaces WHERE workspace_id = $1`, [wsId]).catch(() => {});
			await raw.unsafe(`DELETE FROM auth_users WHERE user_id = $1`, [userId]).catch(() => {});
			await raw.close?.();
		}
	});

	// P1 (GDPR erasure-completeness regression) — END-TO-END through the REAL
	// softDeleteUser → redact → purge sequence. The bug: softDeleteUser redacts
	// auth_users.email to `deleted+<id>@redacted.invalid`, then the purge derived
	// the invite-erasure key from that ALREADY-redacted row, so invites addressed to
	// the ORIGINAL email were never anonymized. We stash the original email at
	// soft-delete time (`deletion_original_email`) and recover it at purge, so the
	// invite to the original address IS purged. Requires AUTH_USER_STORE=postgres so
	// softDeleteUser's guarded redaction write lands in the same DB.
	const e2eEnabled = process.env.AUTH_USER_STORE === "postgres" && process.env.DATABASE_URL;
	const e2eTest = e2eEnabled ? test : test.skip;
	e2eTest("real soft-delete (redacts email) then purge anonymizes the invite addressed to the ORIGINAL email", async () => {
		const NS = `gdpr-orig-${Date.now()}`;
		const userId = `${NS}-user`;
		const email = `${userId}@Example.com`; // mixed-case to prove case-insensitive match
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		const wsId = `${NS}-ws`;
		try {
			await raw.unsafe(`
				INSERT INTO auth_users (user_id, email, email_normalized, password_hash, name, role, auth_provider, email_verified, is_active, created_at, updated_at)
				VALUES ($1, $2, lower($2), 'x', 'Orig User', 'editor', 'local', true, true, now(), now())
				ON CONFLICT (user_id) DO NOTHING
			`, [userId, email]);
			await raw.unsafe(`INSERT INTO workspaces (workspace_id, name, created_at, updated_at) VALUES ($1, 'WS', now(), now()) ON CONFLICT (workspace_id) DO NOTHING`, [wsId]);
			await raw.unsafe(`INSERT INTO workspace_invites (invite_id, workspace_id, email, role, token_hash, status, invited_by_user_id, expires_at) VALUES ($1, $2, lower($3), 'editor', $4, 'pending', 'boss', now() + interval '7 days')`, [`${NS}-inv`, wsId, email, `${NS}-hash`]);

			const store = new PostgresGdprStore(raw);
			// REAL soft-delete: redacts auth_users.email to the alias + stashes the
			// original email. After this the live row no longer carries the original.
			const snapshot = await store.softDeleteUser(userId, { gracePeriodMs: 1 });
			expect(snapshot?.originalEmail?.toLowerCase()).toBe(email.toLowerCase());
			const live = await raw.unsafe(`SELECT email, deletion_original_email FROM auth_users WHERE user_id = $1`, [userId]);
			expect(live[0].email).toBe(`deleted+${userId}@redacted.invalid`);
			expect(String(live[0].deletion_original_email).toLowerCase()).toBe(email.toLowerCase());

			// Backdate the window to make it a genuine past-grace purge candidate.
			const deletedAt = "2026-01-01T00:00:00.000Z";
			await raw.unsafe(`UPDATE auth_users SET deleted_at = $2, delete_grace_until = $2 WHERE user_id = $1`, [userId, deletedAt]);

			const purged = await store.purgeSoftDeletedUser(userId, {
				deletedAt,
				graceUntilAtOrBefore: "2026-02-01T00:00:00.000Z",
				deletedAtOrBefore: "2026-02-01T00:00:00.000Z",
			});
			expect(purged.purged).toBe(true);

			// The invite addressed to the ORIGINAL email is anonymized (NOT left as PII),
			// proving the purge keyed off the recovered original — not the redacted alias.
			const inv = await raw.unsafe(`SELECT email FROM workspace_invites WHERE invite_id = $1`, [`${NS}-inv`]);
			expect(inv[0].email).toBe(`purged+${userId}@redacted.invalid`);
			expect(inv[0].email).not.toBe(email.toLowerCase());
			// Stash cleared inside the same purge txn.
			const after = await raw.unsafe(`SELECT deletion_original_email FROM auth_users WHERE user_id = $1`, [userId]);
			expect(after[0].deletion_original_email).toBeNull();
		} finally {
			await raw.unsafe(`DELETE FROM workspace_invites WHERE workspace_id = $1`, [wsId]).catch(() => {});
			await raw.unsafe(`DELETE FROM workspaces WHERE workspace_id = $1`, [wsId]).catch(() => {});
			await raw.unsafe(`DELETE FROM auth_users WHERE user_id = $1`, [userId]).catch(() => {});
			await raw.close?.();
		}
	});

	// P1 (login-failure purge over-reach) — auth_login_failures is keyed by the RAW
	// login email (no user_id). Soft-delete FREES the normalized email for reuse, so
	// a LATER active account can register the SAME email and accrue its OWN
	// brute-force/lockout rows. The erased account's purge must NOT delete that live
	// account's lockout evidence. We seed one failure row stamped BEFORE the subject's
	// soft-delete (the erased identity's) and one stamped AFTER (the reused-email live
	// account's), then assert the purge time-bounds the delete to `failure_at <=`
	// soft-delete instant: the old row is erased, the new row survives.
	test("purgeSoftDeletedUser time-bounds the auth_login_failures delete so a later same-email active account keeps its lockout rows", async () => {
		const NS = `gdpr-loginfail-${Date.now()}`;
		const userId = `${NS}-user`;
		const email = `${userId}@Example.com`; // mixed-case to prove case-insensitive match
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		try {
			await raw.unsafe(`
				INSERT INTO auth_users (user_id, email, email_normalized, password_hash, name, role, auth_provider, email_verified, is_active, created_at, updated_at)
				VALUES ($1, $2, lower($2), 'x', 'Loginfail User', 'editor', 'local', true, true, now(), now())
				ON CONFLICT (user_id) DO NOTHING
			`, [userId, email]);

			const deletedAt = "2026-01-01T00:00:00.000Z";
			// OLD identity's brute-force row, stamped BEFORE the soft-delete instant.
			const beforeAt = "2025-12-31T23:00:00.000Z";
			// LATER (reused-email) active account's lockout row, stamped AFTER.
			const afterAt = "2026-03-01T12:00:00.000Z";
			await raw.unsafe(`INSERT INTO auth_login_failures (email, ip, failure_at) VALUES (lower($1), '203.0.113.10', $2)`, [email, beforeAt]);
			await raw.unsafe(`INSERT INTO auth_login_failures (email, ip, failure_at) VALUES (lower($1), '203.0.113.11', $2)`, [email, afterAt]);

			// Stamp an expired soft-delete window + stash the original email (what real
			// softDeleteUser does) so the purge keys auth_login_failures off the original.
			await raw.unsafe(`UPDATE auth_users SET deleted_at = $2, delete_grace_until = $2, is_active = false, deletion_original_email = $3 WHERE user_id = $1`, [userId, deletedAt, email]);

			const store = new PostgresGdprStore(raw);
			const purged = await store.purgeSoftDeletedUser(userId, {
				deletedAt,
				graceUntilAtOrBefore: "2026-02-01T00:00:00.000Z",
				deletedAtOrBefore: "2026-02-01T00:00:00.000Z",
			});
			expect(purged.purged).toBe(true);

			const remaining = await raw.unsafe(`SELECT failure_at, ip FROM auth_login_failures WHERE lower(email) = lower($1) ORDER BY failure_at`, [email]);
			// Exactly the LATER account's row survives; the erased identity's row is gone.
			expect(remaining.length).toBe(1);
			expect(remaining[0].ip).toBe("203.0.113.11");
			expect(new Date(remaining[0].failure_at).toISOString()).toBe(afterAt);
		} finally {
			await raw.unsafe(`DELETE FROM auth_login_failures WHERE lower(email) = lower($1)`, [email]).catch(() => {});
			await raw.unsafe(`DELETE FROM auth_users WHERE user_id = $1`, [userId]).catch(() => {});
			await raw.close?.();
		}
	});
});
