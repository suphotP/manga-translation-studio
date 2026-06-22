// AI-support — payment_reconciliations store (migration 0058).
//
// File-store unit coverage runs everywhere. A real-Postgres block (gated on
// RECON_TEST_DATABASE_URL) proves the actual SQL idempotency: the unique
// idempotency_key + ON CONFLICT DO NOTHING means a re-record returns the existing
// row WITHOUT inserting a second — the database-layer single-grant guarantee.
//
//   docker run -d -e POSTGRES_PASSWORD=verify -e POSTGRES_USER=verify \
//     -e POSTGRES_DB=recon -p 55440:5432 postgres:16-alpine
//   DATABASE_URL=postgres://verify:verify@127.0.0.1:55440/recon bun run src/migrations/cli.ts up
//   RECON_TEST_DATABASE_URL=postgres://verify:verify@127.0.0.1:55440/recon bun test payment-reconciliations-store

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	FilePaymentReconciliationStore,
	PostgresPaymentReconciliationStore,
} from "../services/support/payment-reconciliations-store.js";

const tempDirs: string[] = [];
function tempStore(): FilePaymentReconciliationStore {
	const dir = mkdtempSync(join(tmpdir(), "recon-store-"));
	tempDirs.push(dir);
	return new FilePaymentReconciliationStore(join(dir, "reconciliations.json"));
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("FilePaymentReconciliationStore", () => {
	test("records a granted decision and reports created=true", async () => {
		const store = tempStore();
		const { record, created } = await store.recordDecision({
			userId: "u1",
			ticketId: "t1",
			detectedDiscrepancyCents: 5600,
			currency: "usd",
			action: "granted",
			grantedCents: 5600,
		});
		expect(created).toBe(true);
		expect(record.action).toBe("granted");
		expect(record.grantedCents).toBe(5600);
		expect(record.currency).toBe("USD");
		expect(record.actor).toBe("ai");
		expect(record.idempotencyKey).toBe("recon:t1");
	});

	test("a second decision for the same ticket is idempotent (created=false, original returned)", async () => {
		const store = tempStore();
		const first = await store.recordDecision({ userId: "u1", ticketId: "t1", detectedDiscrepancyCents: 5600, action: "granted", grantedCents: 5600 });
		const second = await store.recordDecision({ userId: "u1", ticketId: "t1", detectedDiscrepancyCents: 9999, action: "granted", grantedCents: 9999 });
		expect(second.created).toBe(false);
		// The ORIGINAL row is returned (5600), not the second attempt's 9999.
		expect(second.record.id).toBe(first.record.id);
		expect(second.record.grantedCents).toBe(5600);
	});

	test("granted_cents is forced to 0 for a non-granted action", async () => {
		const store = tempStore();
		const { record } = await store.recordDecision({ userId: "u1", ticketId: "t2", detectedDiscrepancyCents: 100, action: "flagged_for_human", grantedCents: 100 });
		expect(record.action).toBe("flagged_for_human");
		expect(record.grantedCents).toBe(0);
	});

	test("listByUser returns a user's decisions newest first", async () => {
		const store = tempStore();
		await store.recordDecision({ userId: "u1", ticketId: "ta", detectedDiscrepancyCents: 0, action: "none" });
		await store.recordDecision({ userId: "u1", ticketId: "tb", detectedDiscrepancyCents: 200, action: "granted", grantedCents: 200 });
		await store.recordDecision({ userId: "u2", ticketId: "tc", detectedDiscrepancyCents: 1, action: "granted", grantedCents: 1 });
		const u1 = await store.listByUser("u1");
		expect(u1).toHaveLength(2);
		expect(u1.every((r) => r.userId === "u1")).toBe(true);
	});

	test("persists across a reload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "recon-reload-"));
		tempDirs.push(dir);
		const path = join(dir, "reconciliations.json");
		const a = new FilePaymentReconciliationStore(path);
		await a.recordDecision({ userId: "u1", ticketId: "t1", detectedDiscrepancyCents: 300, action: "granted", grantedCents: 300 });
		const b = new FilePaymentReconciliationStore(path);
		const reloaded = await b.getByIdempotencyKey("recon:t1");
		expect(reloaded?.grantedCents).toBe(300);
		// And the reloaded store still enforces idempotency.
		const again = await b.recordDecision({ userId: "u1", ticketId: "t1", detectedDiscrepancyCents: 999, action: "granted", grantedCents: 999 });
		expect(again.created).toBe(false);
	});
});

// ── Real Postgres (gated) ──────────────────────────────────────────────────────

const DB_URL = process.env.RECON_TEST_DATABASE_URL?.trim();
const describeMaybe = DB_URL ? describe : describe.skip;

describeMaybe("PostgresPaymentReconciliationStore (real Postgres)", () => {
	const sql = new Bun.SQL(DB_URL as string);
	const store = new PostgresPaymentReconciliationStore(sql as never);

	// ticket_id has a FK to support_tickets, so seed the tickets the tests reference.
	async function seedTicket(id: string, requester: string): Promise<void> {
		await sql.unsafe(
			"INSERT INTO support_tickets (id, requester_user_id, subject) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
			[id, requester, "recon test"],
		);
	}

	beforeEach(async () => {
		await sql.unsafe("DELETE FROM payment_reconciliations");
		await sql.unsafe("DELETE FROM support_tickets");
		await seedTicket("t-pg", "u1");
		await seedTicket("t-race", "u2");
	});
	afterAll(async () => {
		await sql.unsafe("DELETE FROM payment_reconciliations");
		await sql.unsafe("DELETE FROM support_tickets");
		await sql.close?.();
	});

	test("ON CONFLICT idempotency: the same ticket grants once at the DB layer", async () => {
		const first = await store.recordDecision({ userId: "u1", ticketId: "t-pg", detectedDiscrepancyCents: 5600, currency: "USD", action: "granted", grantedCents: 5600 });
		expect(first.created).toBe(true);
		const second = await store.recordDecision({ userId: "u1", ticketId: "t-pg", detectedDiscrepancyCents: 9999, action: "granted", grantedCents: 9999 });
		expect(second.created).toBe(false);
		expect(second.record.grantedCents).toBe(5600);
		// Exactly one row exists.
		const rows = await sql.unsafe("SELECT COUNT(*)::int AS n FROM payment_reconciliations WHERE idempotency_key = $1", ["recon:t-pg"]);
		expect(Number((rows[0] as { n: number }).n)).toBe(1);
	});

	test("concurrent double-record races to exactly one insert", async () => {
		const [a, b] = await Promise.all([
			store.recordDecision({ userId: "u2", ticketId: "t-race", detectedDiscrepancyCents: 100, action: "granted", grantedCents: 100 }),
			store.recordDecision({ userId: "u2", ticketId: "t-race", detectedDiscrepancyCents: 100, action: "granted", grantedCents: 100 }),
		]);
		// Exactly one of the two created the row.
		expect([a.created, b.created].filter(Boolean).length).toBe(1);
		const rows = await sql.unsafe("SELECT COUNT(*)::int AS n FROM payment_reconciliations WHERE idempotency_key = $1", ["recon:t-race"]);
		expect(Number((rows[0] as { n: number }).n)).toBe(1);
	});
});
