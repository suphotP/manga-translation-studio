// Seat enforcement (pre-launch issue 12) pinned against REAL Postgres — the
// fake-SQL suites cannot exercise the billing_plans join / advisory-lock path.
//
//   - createInvite fail-fast: members + pending non-viewer invites ≥ seats → 402
//   - acceptInvite authoritative gate: seats full at acceptance time → 402
//   - viewers are FREE: never counted, never blocked (owner decision)
//   - re-accept by an existing (disabled) member does not consume a new seat
//
// Run (migrations must already be applied):
//   TEST_DATABASE_URL=postgres://... bun test src/__tests__/seat-enforcement.real-pg.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { PostgresWorkspaceAccessStore, WorkspaceAccessError } from "../services/workspace-access.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

describeReal("workspace seat enforcement (real Postgres)", () => {
	// Unique per-run ids so reruns never collide; everything is swept in afterAll.
	const run = randomUUID().slice(0, 8);
	const wsId = `seat-ws-${run}`;
	let sql: { unsafe: (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>; close?: () => Promise<void> };
	let store: PostgresWorkspaceAccessStore;

	beforeAll(async () => {
		sql = new (globalThis as never as { Bun: { SQL: new (url: string, opts: { max: number }) => typeof sql } }).Bun.SQL(
			TEST_DATABASE_URL as string,
			{ max: 2 },
		);
		store = new PostgresWorkspaceAccessStore(sql as never);
		await sql.unsafe(
			`INSERT INTO workspaces (workspace_id, name) VALUES ($1, 'seat test') ON CONFLICT DO NOTHING`,
			[wsId],
		);
		// creator plan = 2 seats (post-redesign catalog; billing_plans row is the
		// live mirror migration 0087 upserts).
		await sql.unsafe(
			`INSERT INTO workspace_billing_accounts (workspace_id, plan_id, status)
			 VALUES ($1, 'creator', 'active')
			 ON CONFLICT (workspace_id) DO UPDATE SET plan_id = 'creator', status = 'active'`,
			[wsId],
		);
		await sql.unsafe(
			`INSERT INTO workspace_members (workspace_id, user_id, role, member_studio_role, scope, created_at, updated_at)
			 VALUES ($1, $2, 'owner', 'owner', '{}'::jsonb, now(), now())`,
			[wsId, `seat-owner-${run}`],
		);
	});

	afterAll(async () => {
		await sql.unsafe(`DELETE FROM workspace_invites WHERE workspace_id = $1`, [wsId]).catch(() => undefined);
		await sql.unsafe(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]).catch(() => undefined);
		await sql.unsafe(`DELETE FROM workspace_billing_accounts WHERE workspace_id = $1`, [wsId]).catch(() => undefined);
		await sql.unsafe(`DELETE FROM workspaces WHERE workspace_id = $1`, [wsId]).catch(() => undefined);
		await sql.close?.();
	});

	test("the full lifecycle enforces seats at mint AND accept, with viewers free", async () => {
		const ownerId = `seat-owner-${run}`;

		// Seat 2 of 2: mint + accept an editor invite — allowed.
		const first = await store.createInvite({
			workspaceId: wsId,
			email: `seat-a-${run}@example.com`,
			role: "editor",
			invitedByUserId: ownerId,
		});
		const firstMember = await store.acceptInvite({
			inviteId: first.inviteId,
			inviteToken: first.inviteToken,
			userId: `seat-user-a-${run}`,
			email: `seat-a-${run}@example.com`,
		});
		expect(firstMember.role).toBe("editor");

		// Seats now 2/2 → minting another NON-viewer invite fail-fasts with 402.
		let mintError: unknown;
		try {
			await store.createInvite({
				workspaceId: wsId,
				email: `seat-b-${run}@example.com`,
				role: "editor",
				invitedByUserId: ownerId,
			});
		} catch (error) {
			mintError = error;
		}
		expect(mintError).toBeInstanceOf(WorkspaceAccessError);
		expect((mintError as WorkspaceAccessError).code).toBe("workspace_seats_exhausted");
		expect((mintError as WorkspaceAccessError).status).toBe(402);

		// Viewers are free: a viewer invite mints AND accepts at 2/2.
		const viewer = await store.createInvite({
			workspaceId: wsId,
			email: `seat-v-${run}@example.com`,
			role: "viewer",
			invitedByUserId: ownerId,
		});
		const viewerMember = await store.acceptInvite({
			inviteId: viewer.inviteId,
			inviteToken: viewer.inviteToken,
			userId: `seat-user-v-${run}`,
			email: `seat-v-${run}@example.com`,
		});
		expect(viewerMember.role).toBe("viewer");

		// ACCEPT-time authoritative gate: free a seat, mint an editor invite, then
		// re-fill the seat BEFORE acceptance — the accept must 402 even though the
		// invite minted fine.
		await store.removeMember({ workspaceId: wsId, userId: `seat-user-a-${run}`, actorUserId: ownerId });
		const raced = await store.createInvite({
			workspaceId: wsId,
			email: `seat-c-${run}@example.com`,
			role: "editor",
			invitedByUserId: ownerId,
		});
		// Re-enable member A directly (simulates a parallel accept winning the seat).
		await sql.unsafe(
			`UPDATE workspace_members SET disabled_at = NULL, updated_at = now() WHERE workspace_id = $1 AND user_id = $2`,
			[wsId, `seat-user-a-${run}`],
		);
		let acceptError: unknown;
		try {
			await store.acceptInvite({
				inviteId: raced.inviteId,
				inviteToken: raced.inviteToken,
				userId: `seat-user-c-${run}`,
				email: `seat-c-${run}@example.com`,
			});
		} catch (error) {
			acceptError = error;
		}
		expect(acceptError).toBeInstanceOf(WorkspaceAccessError);
		expect((acceptError as WorkspaceAccessError).code).toBe("workspace_seats_exhausted");

		// The failed accept leaves its invite PENDING, and pending non-viewer
		// invites hold a seat reservation at mint time — revoke it before the
		// re-accept scenario below (matches what an admin would do).
		await sql.unsafe(
			`UPDATE workspace_invites SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE invite_id = $1`,
			[raced.inviteId],
		);

		// Re-accept path: a DISABLED former member re-accepting does not need a
		// free seat beyond their own re-enabled row. Disable A again, then invite
		// + accept as the SAME user — allowed at 1 free seat.
		await store.removeMember({ workspaceId: wsId, userId: `seat-user-a-${run}`, actorUserId: ownerId });
		const back = await store.createInvite({
			workspaceId: wsId,
			email: `seat-a-${run}@example.com`,
			role: "editor",
			invitedByUserId: ownerId,
		});
		const backMember = await store.acceptInvite({
			inviteId: back.inviteId,
			inviteToken: back.inviteToken,
			userId: `seat-user-a-${run}`,
			email: `seat-a-${run}@example.com`,
		});
		expect(backMember.role).toBe("editor");

		// VIEWER PROMOTION consumes a seat (review #592 P1): with 2/2 seats used,
		// promoting the existing viewer to editor must 402 — their viewer row does
		// not already hold a seat.
		const promote = await store.createInvite({
			workspaceId: wsId,
			email: `seat-v-${run}@example.com`,
			role: "viewer", // mints free; the PROMOTION attempt below uses a fresh non-viewer invite
			invitedByUserId: ownerId,
		});
		await sql.unsafe(
			`UPDATE workspace_invites SET role = 'editor' WHERE invite_id = $1`,
			[promote.inviteId],
		);
		let promoteError: unknown;
		try {
			await store.acceptInvite({
				inviteId: promote.inviteId,
				inviteToken: promote.inviteToken,
				userId: `seat-user-v-${run}`,
				email: `seat-v-${run}@example.com`,
			});
		} catch (error) {
			promoteError = error;
		}
		expect((promoteError as WorkspaceAccessError)?.code).toBe("workspace_seats_exhausted");

		// ZERO-QUANTITY seat grants add nothing (review #592 P1): an active grant
		// with quantity=0 must not raise the cap.
		await sql.unsafe(
			`INSERT INTO workspace_addon_grants (grant_id, workspace_id, addon_id, quantity, seats, status, source)
			 VALUES ($1, $2, 'seat-1', 0, 1, 'active', 'mock')`,
			[`seat-grant-${run}`, wsId],
		);
		let stillBlocked: unknown;
		try {
			await store.createInvite({
				workspaceId: wsId,
				email: `seat-d-${run}@example.com`,
				role: "editor",
				invitedByUserId: ownerId,
			});
		} catch (error) {
			stillBlocked = error;
		}
		expect((stillBlocked as WorkspaceAccessError)?.code).toBe("workspace_seats_exhausted");

		// INACTIVE billing falls back to FREE seats (review #592 P1): cancel the
		// billing row — allowance drops to free (2), and with 2 non-viewer members
		// active a new mint still 402s (and would even if creator had more seats).
		await sql.unsafe(
			`UPDATE workspace_billing_accounts SET status = 'cancelled' WHERE workspace_id = $1`,
			[wsId],
		);
		let cancelledBlocked: unknown;
		try {
			await store.createInvite({
				workspaceId: wsId,
				email: `seat-e-${run}@example.com`,
				role: "editor",
				invitedByUserId: ownerId,
			});
		} catch (error) {
			cancelledBlocked = error;
		}
		expect((cancelledBlocked as WorkspaceAccessError)?.code).toBe("workspace_seats_exhausted");

		// PATCH-PROMOTION bypass (review #592 r2 P1): with seats full, updating the
		// free viewer's role to editor must 402 — the update path enforces the
		// same gate as invite acceptance.
		let patchError: unknown;
		try {
			await store.updateMember({
				workspaceId: wsId,
				userId: `seat-user-v-${run}`,
				role: "editor",
				actorUserId: ownerId,
			});
		} catch (error) {
			patchError = error;
		}
		expect((patchError as WorkspaceAccessError)?.code).toBe("workspace_seats_exhausted");
		// Sideways/downgrade updates stay free: re-PATCH the viewer AS a viewer.
		const stillViewer = await store.updateMember({
			workspaceId: wsId,
			userId: `seat-user-v-${run}`,
			role: "viewer",
			actorUserId: ownerId,
		});
		expect(stillViewer.role).toBe("viewer");
	});
});
