import { describe, expect, test } from "bun:test";
import {
	PostgresWorkspaceAccessStore,
	WorkspaceAccessError,
	roleHasPermission,
	workspaceScopeCovers,
	type WorkspaceAccessSqlClient,
	type WorkspaceRole,
} from "../services/workspace-access.js";
import { parseAuditDateFilter, compareAuditInstants } from "../routes/workspaces.js";

/**
 * Self-contained fake SQL client for the unified audit-log read API.
 *
 * It simulates the audit_events SELECT (filters + inclusive date range +
 * keyset cursor) and the workspace_members lookup used by requirePermission,
 * so the store-level filtering, pagination, and access-scoping behaviour can be
 * asserted without a live Postgres instance. Date-range conditions are matched
 * positionally in the exact order the store appends them so cursor parameters
 * still line up.
 */
class FakeAuditSqlClient implements WorkspaceAccessSqlClient {
	queries: Array<{ query: string; params: unknown[] }> = [];
	auditRows: Array<Record<string, unknown>> = [];
	memberRows: Array<Record<string, unknown>> = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });

		if (query.includes("FROM audit_events")) {
			let paramIndex = 1;
			let rows = this.auditRows.filter((row) => row.workspace_id === params[0]);
			if (query.includes("action = $")) {
				const action = params[paramIndex++];
				rows = rows.filter((row) => row.action === action);
			}
			if (query.includes("entity_type = $")) {
				const entityType = params[paramIndex++];
				rows = rows.filter((row) => row.entity_type === entityType);
			}
			if (query.includes("actor_user_id = $")) {
				const actorUserId = params[paramIndex++];
				rows = rows.filter((row) => row.actor_user_id === actorUserId);
			}
			if (query.includes("created_at >= $")) {
				const createdAfter = String(params[paramIndex++]);
				rows = rows.filter((row) => String(row.created_at) >= createdAfter);
			}
			if (query.includes("created_at <= $")) {
				const createdBefore = String(params[paramIndex++]);
				rows = rows.filter((row) => String(row.created_at) <= createdBefore);
			}
			if (query.includes("created_at < $")) {
				const cursorCreatedAt = String(params[paramIndex++]);
				const cursorId = String(params[paramIndex++]);
				rows = rows.filter((row) => {
					// The store keys the cursor on the high-precision created_at the
					// SQL exposes as cursor_created_at, so compare against the same value.
					const created = String(row.cursor_created_at ?? row.created_at);
					return created < cursorCreatedAt
						|| (created === cursorCreatedAt && String(row.audit_event_id) < cursorId);
				});
			}
			const limit = Number(params[params.length - 1]);
			return rows
				.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))
					|| String(b.audit_event_id).localeCompare(String(a.audit_event_id)))
				.slice(0, Number.isFinite(limit) ? limit : undefined) as T[];
		}

		if (query.includes("FROM workspace_members") && query.includes("WHERE")) {
			const member = this.memberRows.find((row) => row.workspace_id === params[0] && row.user_id === params[1]);
			return (member ? [member] : []) as T[];
		}

		return [];
	}
}

function decodeCursor(cursor: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
}

function auditEvent(input: {
	id: string;
	workspaceId?: string;
	actorUserId?: string;
	action?: string;
	entityType?: string;
	createdAt: string;
	cursorCreatedAt?: string;
}): Record<string, unknown> {
	return {
		audit_event_id: input.id,
		workspace_id: input.workspaceId ?? "workspace-1",
		actor_user_id: input.actorUserId ?? "owner-1",
		action: input.action ?? "workspace_member_updated",
		entity_type: input.entityType ?? "workspace_member",
		entity_id: "entity-1",
		metadata: JSON.stringify({}),
		created_at: input.createdAt,
		cursor_created_at: input.cursorCreatedAt ?? input.createdAt,
	};
}

function memberRow(input: { userId: string; role: WorkspaceRole; scope?: unknown }): Record<string, unknown> {
	return {
		workspace_id: "workspace-1",
		user_id: input.userId,
		role: input.role,
		scope: input.scope ?? "{}",
		invited_by_user_id: null,
		created_at: "2026-05-28T02:00:00.000Z",
		updated_at: "2026-05-28T02:00:00.000Z",
		disabled_at: null,
	};
}

describe("workspace audit read API", () => {
	test("filters audit events by inclusive created_at date range", async () => {
		const client = new FakeAuditSqlClient();
		client.auditRows = [
			auditEvent({ id: "audit-jan", createdAt: "2026-01-10T00:00:00.000Z" }),
			auditEvent({ id: "audit-mar", createdAt: "2026-03-10T00:00:00.000Z" }),
			auditEvent({ id: "audit-may", createdAt: "2026-05-10T00:00:00.000Z" }),
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const page = await store.listAuditEventPage("workspace-1", {
			createdAfter: "2026-02-01T00:00:00.000Z",
			createdBefore: "2026-04-01T00:00:00.000Z",
		});

		expect(page.events.map((event) => event.auditEventId)).toEqual(["audit-mar"]);
		const query = client.queries.at(-1)?.query ?? "";
		expect(query).toContain("created_at >= $2::timestamptz");
		expect(query).toContain("created_at <= $3::timestamptz");
	});

	test("treats date-range bounds as inclusive at the exact boundary", async () => {
		const client = new FakeAuditSqlClient();
		client.auditRows = [
			auditEvent({ id: "audit-edge", createdAt: "2026-03-01T00:00:00.000Z" }),
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const page = await store.listAuditEventPage("workspace-1", {
			createdAfter: "2026-03-01T00:00:00.000Z",
			createdBefore: "2026-03-01T00:00:00.000Z",
		});

		expect(page.events.map((event) => event.auditEventId)).toEqual(["audit-edge"]);
	});

	test("combines actor + action + date-range filters with the correct param positions", async () => {
		const client = new FakeAuditSqlClient();
		client.auditRows = [
			auditEvent({ id: "match", actorUserId: "admin-1", action: "workspace_invite_revoked", createdAt: "2026-03-15T00:00:00.000Z" }),
			auditEvent({ id: "wrong-actor", actorUserId: "owner-1", action: "workspace_invite_revoked", createdAt: "2026-03-15T00:00:00.000Z" }),
			auditEvent({ id: "out-of-range", actorUserId: "admin-1", action: "workspace_invite_revoked", createdAt: "2026-06-15T00:00:00.000Z" }),
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const page = await store.listAuditEventPage("workspace-1", {
			action: "workspace_invite_revoked",
			actorUserId: "admin-1",
			createdAfter: "2026-03-01T00:00:00.000Z",
			createdBefore: "2026-04-01T00:00:00.000Z",
		});

		expect(page.events.map((event) => event.auditEventId)).toEqual(["match"]);
		const query = client.queries.at(-1)?.query ?? "";
		expect(query).toContain("action = $2");
		expect(query).toContain("actor_user_id = $3");
		expect(query).toContain("created_at >= $4::timestamptz");
		expect(query).toContain("created_at <= $5::timestamptz");
	});

	test("paginates a date-bounded result set with keyset cursors", async () => {
		const client = new FakeAuditSqlClient();
		client.auditRows = [
			auditEvent({ id: "audit-c", createdAt: "2026-03-30T00:00:00.000Z", cursorCreatedAt: "2026-03-30T00:00:00.300000Z" }),
			auditEvent({ id: "audit-b", createdAt: "2026-03-20T00:00:00.000Z", cursorCreatedAt: "2026-03-20T00:00:00.200000Z" }),
			auditEvent({ id: "audit-a", createdAt: "2026-03-10T00:00:00.000Z", cursorCreatedAt: "2026-03-10T00:00:00.100000Z" }),
			auditEvent({ id: "audit-out", createdAt: "2026-06-10T00:00:00.000Z" }),
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const first = await store.listAuditEventPage("workspace-1", {
			limit: 2,
			createdAfter: "2026-03-01T00:00:00.000Z",
			createdBefore: "2026-04-01T00:00:00.000Z",
		});
		expect(first.events.map((event) => event.auditEventId)).toEqual(["audit-c", "audit-b"]);
		expect(first.nextCursor).toBeDefined();
		const decoded = decodeCursor(first.nextCursor!);
		expect(decoded.kind).toBe("auditEventId");
		expect(decoded.id).toBe("audit-b");

		const second = await store.listAuditEventPage("workspace-1", {
			limit: 2,
			cursor: first.nextCursor,
			createdAfter: "2026-03-01T00:00:00.000Z",
			createdBefore: "2026-04-01T00:00:00.000Z",
		});
		expect(second.events.map((event) => event.auditEventId)).toEqual(["audit-a"]);
		expect(second.nextCursor).toBeUndefined();

		// The out-of-range event must never appear even across pages.
		const allIds = [...first.events, ...second.events].map((event) => event.auditEventId);
		expect(allIds).not.toContain("audit-out");
	});

	test("omits date-range SQL when no bounds are supplied", async () => {
		const client = new FakeAuditSqlClient();
		client.auditRows = [auditEvent({ id: "audit-1", createdAt: "2026-03-01T00:00:00.000Z" })];
		const store = new PostgresWorkspaceAccessStore(client);

		await store.listAuditEventPage("workspace-1", {});
		const query = client.queries.at(-1)?.query ?? "";
		expect(query).not.toContain("created_at >=");
		expect(query).not.toContain("created_at <=");
	});

	test("scopes audit reads to workspace members holding manage_members + workspace-wide scope", async () => {
		const client = new FakeAuditSqlClient();
		client.memberRows = [
			memberRow({ userId: "admin-1", role: "admin" }),
			memberRow({ userId: "viewer-1", role: "viewer" }),
			memberRow({ userId: "scoped-editor", role: "editor", scope: JSON.stringify({ projectIds: ["project-1"] }) }),
		];
		const store = new PostgresWorkspaceAccessStore(client);

		// Admin is a member and may manage members (gate the route enforces).
		const admin = await store.requirePermission("workspace-1", "admin-1", "manage_members");
		expect(admin.role).toBe("admin");
		expect(workspaceScopeCovers(admin.scope, undefined)).toBe(true);

		// Viewer is a member but lacks manage_members -> 403.
		expect(roleHasPermission("viewer", "manage_members")).toBe(false);
		await expect(store.requirePermission("workspace-1", "viewer-1", "manage_members")).rejects.toMatchObject({
			status: 403,
			code: "workspace_permission_denied",
		});

		// Non-members cannot read audit events at all -> 404.
		await expect(store.requirePermission("workspace-1", "stranger", "manage_members")).rejects.toMatchObject({
			status: 404,
			code: "workspace_not_found",
		});

		// A project-scoped member fails the workspace-wide scope gate the route applies.
		const scoped = await store.requirePermission("workspace-1", "scoped-editor", "manage_members").catch((error) => error);
		if (scoped instanceof WorkspaceAccessError) {
			// editor lacks manage_members regardless, so this path also denies.
			expect(scoped.status).toBe(403);
		} else {
			expect(workspaceScopeCovers(scoped.scope, undefined)).toBe(false);
		}
	});
});

describe("parseAuditDateFilter (audit date-bound validation)", () => {
	test("returns undefined when the bound is absent", () => {
		expect(parseAuditDateFilter(undefined)).toBeUndefined();
	});

	test("accepts strict ISO-8601 instants and preserves the original string verbatim", () => {
		// Z designator, millisecond precision.
		expect(parseAuditDateFilter("2026-03-20T00:00:00.000Z")).toBe("2026-03-20T00:00:00.000Z");
		// No fractional seconds.
		expect(parseAuditDateFilter("2026-03-20T00:00:00Z")).toBe("2026-03-20T00:00:00Z");
		// Numeric timezone offset is preserved (not normalized to UTC).
		expect(parseAuditDateFilter("2026-03-20T09:00:00+09:00")).toBe("2026-03-20T09:00:00+09:00");
		// Surrounding whitespace is trimmed but the instant is otherwise untouched.
		expect(parseAuditDateFilter("  2026-03-20T00:00:00Z  ")).toBe("2026-03-20T00:00:00Z");
		// Valid leap day on a leap year is accepted.
		expect(parseAuditDateFilter("2024-02-29T00:00:00Z")).toBe("2024-02-29T00:00:00Z");
	});

	test("preserves sub-millisecond (microsecond) precision instead of truncating", () => {
		// The previous Date round-trip collapsed this to "...200Z"; the validated
		// original string must keep all six fractional digits so the timestamptz
		// bound matches audit_events.created_at at microsecond resolution.
		const micros = "2026-03-20T00:00:00.200500Z";
		const result = parseAuditDateFilter(micros);
		expect(result).toBe(micros);
		// Guard against a silent millisecond truncation regression.
		expect(result).not.toBe("2026-03-20T00:00:00.200Z");
	});

	test("rejects impossible calendar dates that Date.parse would silently roll over", () => {
		// Feb 30 does not exist — Date.parse rolls it to Mar 2; we must refuse it.
		expect(parseAuditDateFilter("2026-02-30T00:00:00Z")).toBeNull();
		// Feb 29 on a non-leap year is invalid.
		expect(parseAuditDateFilter("2026-02-29T00:00:00Z")).toBeNull();
		// Month 13 and day 00 / 32 are impossible.
		expect(parseAuditDateFilter("2026-13-01T00:00:00Z")).toBeNull();
		expect(parseAuditDateFilter("2026-00-10T00:00:00Z")).toBeNull();
		expect(parseAuditDateFilter("2026-01-32T00:00:00Z")).toBeNull();
		// April has 30 days, not 31.
		expect(parseAuditDateFilter("2026-04-31T00:00:00Z")).toBeNull();
		// Out-of-range time components.
		expect(parseAuditDateFilter("2026-03-20T25:00:00Z")).toBeNull();
		expect(parseAuditDateFilter("2026-03-20T12:60:00Z")).toBeNull();
	});

	test("rejects leap-second bounds (:60) so they never reach the ::timestamptz cast", () => {
		// A leap second like 23:59:60 is syntactically ISO-8601, but Date.parse
		// returns NaN for it (breaking compareAuditInstants) and Postgres rejects
		// the out-of-range seconds field on the ::timestamptz cast — which would
		// escape as an unhandled 500 instead of the intended invalid_created_after
		// / invalid_created_before 400. The tightened regex now refuses the :60
		// seconds field structurally, before it can reach the DB. We reject rather
		// than normalize the leap second.
		expect(parseAuditDateFilter("2016-12-31T23:59:60Z")).toBeNull();
		// The same applies with a fractional component and with a numeric offset.
		expect(parseAuditDateFilter("2016-12-31T23:59:60.500Z")).toBeNull();
		expect(parseAuditDateFilter("2017-01-01T08:59:60+09:00")).toBeNull();
		// A non-leap second at the top of the legal range is still accepted.
		expect(parseAuditDateFilter("2026-03-20T23:59:59Z")).toBe("2026-03-20T23:59:59Z");
	});

	test("rejects year 0000 which the calendar math accepts but Postgres has no year for", () => {
		// 0000-01-01 is a real-looking date (and Date.parse does NOT return NaN for
		// it, so the NaN safety-net misses it), but Postgres jumps from 1 BC to 1 AD
		// and rejects year 0 on the ::timestamptz cast — a 500 if it slipped through.
		// The explicit year >= 1 guard refuses it as a clean 400 instead.
		expect(parseAuditDateFilter("0000-01-01T00:00:00Z")).toBeNull();
		expect(parseAuditDateFilter("0000-12-31T23:59:59.999Z")).toBeNull();
		// Year 0001 is the first real year and is accepted verbatim.
		expect(parseAuditDateFilter("0001-01-01T00:00:00Z")).toBe("0001-01-01T00:00:00Z");
	});

	test("rejects the 24:00 hour form entirely (including fractional 24:00:00)", () => {
		// ISO-8601 permits "24:00:00" as an end-of-day alias, but no audit filter
		// needs it and admitting it dragged in a fractional "24:00:00.001" variant:
		// the bare 24:00:00 was special-cased as valid yet Date.parse is NaN for the
		// fractional form, so it reached the ::timestamptz cast as a 500. The hour is
		// now constrained to 00–23 structurally, so every 24:xx shape is a clean 400.
		expect(parseAuditDateFilter("2026-03-20T24:00:00Z")).toBeNull();
		expect(parseAuditDateFilter("2026-03-20T24:00:00.000Z")).toBeNull();
		// The exact round-4 finding: a fractional 24:00:00 that previously slipped
		// past the hour===24 minute/second-only check and exploded at the cast.
		expect(parseAuditDateFilter("2026-03-20T24:00:00.001Z")).toBeNull();
		expect(parseAuditDateFilter("2026-03-20T24:30:00Z")).toBeNull();
		// Hour 25 (already invalid) stays rejected, and 23:59:59 remains the legal max.
		expect(parseAuditDateFilter("2026-03-20T25:00:00Z")).toBeNull();
		expect(parseAuditDateFilter("2026-03-20T23:00:00Z")).toBe("2026-03-20T23:00:00Z");
	});

	test("rejects over-long fractional-second tails that are not real sub-second values", () => {
		// The fractional part is capped at 1–9 digits; a longer tail is not a value
		// Postgres' microsecond-resolution timestamptz accepts, so refuse it up front
		// rather than letting it reach the cast.
		expect(parseAuditDateFilter("2026-03-20T00:00:00.1234567890Z")).toBeNull();
		// An empty fractional part (trailing dot with no digits) is also malformed.
		expect(parseAuditDateFilter("2026-03-20T00:00:00.Z")).toBeNull();
		// Exactly nine fractional digits is the accepted maximum.
		expect(parseAuditDateFilter("2026-03-20T00:00:00.123456789Z")).toBe("2026-03-20T00:00:00.123456789Z");
	});

	test("safety-net: any garbage that slips past the regex but Date.parse rejects becomes a 400, never a 500", () => {
		// This is the class-killer guard. Even if some shape were to satisfy the
		// structural regex AND the calendar check yet still be an instant Postgres'
		// ::timestamptz cast would reject, the final Number.isNaN(Date.parse(...))
		// gate turns it into a clean invalid_created_after/before 400 instead of an
		// unhandled 500. We force the scenario with a stub that makes Date.parse
		// report NaN for an otherwise well-formed instant, proving the net catches
		// inputs no explicit rule above enumerated.
		const realParse = Date.parse;
		try {
			// Make Date.parse claim everything is unparseable.
			(Date as unknown as { parse: (s: string) => number }).parse = () => Number.NaN;
			// A string that passes the regex and calendar check (real date/time, valid
			// offset) — only the NaN safety-net stands between it and the SQL cast.
			expect(parseAuditDateFilter("2026-03-20T12:34:56.500Z")).toBeNull();
		} finally {
			(Date as unknown as { parse: (s: string) => number }).parse = realParse;
		}
		// And with the real Date.parse the same instant is still accepted, confirming
		// the net only fires on genuinely unparseable values.
		expect(parseAuditDateFilter("2026-03-20T12:34:56.500Z")).toBe("2026-03-20T12:34:56.500Z");
	});

	test("rejects non-ISO / locale-style strings that Date.parse would accept", () => {
		expect(parseAuditDateFilter("May 29, 2026")).toBeNull();
		expect(parseAuditDateFilter("2026/03/20")).toBeNull();
		// Date-only and missing-timezone forms are not full instants.
		expect(parseAuditDateFilter("2026-03-20")).toBeNull();
		expect(parseAuditDateFilter("2026-03-20T00:00:00")).toBeNull();
		// Plain junk and empty input.
		expect(parseAuditDateFilter("not-a-date")).toBeNull();
		expect(parseAuditDateFilter("   ")).toBeNull();
		// Absurdly long input is rejected before regex work.
		expect(parseAuditDateFilter(`2026-03-20T00:00:00Z${" ".repeat(50)}x`)).toBeNull();
	});

	test("rejects out-of-range timezone offsets before they reach the ::timestamptz cast", () => {
		// The regex shape "[+-]HH:MM" matches digit-wise, but an offset like +99:99
		// is not a real timezone — Postgres would raise a cast error instead of us
		// returning the intended invalid_created_after/before 400, so refuse it here.
		expect(parseAuditDateFilter("2026-03-20T00:00:00+99:99")).toBeNull();
		// Offset hours above ±14 are out of the ISO-8601 / Postgres range.
		expect(parseAuditDateFilter("2026-03-20T00:00:00+15:00")).toBeNull();
		expect(parseAuditDateFilter("2026-03-20T00:00:00-15:00")).toBeNull();
		// 14:00 is the boundary; minutes past it are invalid.
		expect(parseAuditDateFilter("2026-03-20T00:00:00+14:30")).toBeNull();
		// Offset minutes must be 00–59.
		expect(parseAuditDateFilter("2026-03-20T00:00:00+05:60")).toBeNull();
	});

	test("accepts in-range timezone offsets at the ±14:00 boundary", () => {
		// Maximum legal offsets on both signs are preserved verbatim.
		expect(parseAuditDateFilter("2026-03-20T00:00:00+14:00")).toBe("2026-03-20T00:00:00+14:00");
		expect(parseAuditDateFilter("2026-03-20T00:00:00-14:00")).toBe("2026-03-20T00:00:00-14:00");
		// A non-zero in-range offset with minutes is fine.
		expect(parseAuditDateFilter("2026-03-20T00:00:00+05:45")).toBe("2026-03-20T00:00:00+05:45");
	});
});

describe("compareAuditInstants (sub-millisecond range ordering)", () => {
	test("rejects an inverted range that differs only below the millisecond", () => {
		// Date.parse collapses both to the same millisecond (.200) and would report
		// them as equal, letting this inverted range slip past the guard. The
		// comparator must see createdAfter (.200900) as later than createdBefore
		// (.200100) so the route returns invalid_date_range.
		const createdAfter = "2026-03-20T00:00:00.200900Z";
		const createdBefore = "2026-03-20T00:00:00.200100Z";
		expect(compareAuditInstants(createdAfter, createdBefore)).toBeGreaterThan(0);
		// Guard against a regression to plain Date.parse, which ties here.
		expect(Date.parse(createdAfter) - Date.parse(createdBefore)).toBe(0);
	});

	test("treats sub-millisecond-equal instants as equal (inclusive boundary still valid)", () => {
		const instant = "2026-03-20T00:00:00.200500Z";
		expect(compareAuditInstants(instant, instant)).toBe(0);
		// A properly ordered sub-millisecond range is not rejected.
		expect(compareAuditInstants("2026-03-20T00:00:00.200100Z", "2026-03-20T00:00:00.200900Z")).toBeLessThan(0);
	});

	test("treats instants differing only in trailing-zero fraction count as equal", () => {
		// Round-4 finding: the tail compare padded without trimming, so the same
		// instant written with extra trailing zeros — ".1234000000Z" vs ".1234Z" —
		// produced tails of different lengths and was wrongly ordered, surfacing as a
		// spurious invalid_date_range. They are the SAME instant and must tie at 0.
		expect(compareAuditInstants("2026-03-20T00:00:00.1234000000Z", "2026-03-20T00:00:00.1234Z")).toBe(0);
		expect(compareAuditInstants("2026-03-20T00:00:00.1234Z", "2026-03-20T00:00:00.1234000000Z")).toBe(0);
		// Trailing zeros in the sub-millisecond tail specifically (beyond the first
		// three digits) also tie: .200900 == .2009.
		expect(compareAuditInstants("2026-03-20T00:00:00.200900Z", "2026-03-20T00:00:00.2009Z")).toBe(0);
		// And used as an inclusive range bound (after === before) it must NOT be
		// flagged as inverted: createdAfter <= createdBefore.
		expect(compareAuditInstants("2026-03-20T00:00:00.500000Z", "2026-03-20T00:00:00.5Z")).toBe(0);
		// A genuine sub-millisecond difference still orders correctly (not masked by
		// the trim): .2009 (== .200900) is later than .200100.
		expect(compareAuditInstants("2026-03-20T00:00:00.2009Z", "2026-03-20T00:00:00.200100Z")).toBeGreaterThan(0);
	});

	test("orders bounds carrying different timezone offsets as true instants", () => {
		// 09:00+09:00 is the same instant as 00:00Z; the comparator must agree.
		expect(compareAuditInstants("2026-03-20T09:00:00+09:00", "2026-03-20T00:00:00Z")).toBe(0);
		// And +09:00 local 09:00 is earlier than 01:00Z (== 10:00+09:00).
		expect(compareAuditInstants("2026-03-20T09:00:00+09:00", "2026-03-20T01:00:00Z")).toBeLessThan(0);
	});
});

describe("audit date bounds preserve microsecond precision through the SQL layer", () => {
	test("passes the full-precision createdAfter string to the timestamptz bound", async () => {
		const client = new FakeAuditSqlClient();
		// Two events straddle the microsecond boundary the bound sits on.
		client.auditRows = [
			auditEvent({ id: "audit-below", createdAt: "2026-03-20T00:00:00.200300Z" }),
			auditEvent({ id: "audit-at", createdAt: "2026-03-20T00:00:00.200500Z" }),
			auditEvent({ id: "audit-above", createdAt: "2026-03-20T00:00:00.200900Z" }),
		];
		const store = new PostgresWorkspaceAccessStore(client);

		// Inclusive lower bound at .200500: the .200300 event must be excluded.
		const page = await store.listAuditEventPage("workspace-1", {
			createdAfter: "2026-03-20T00:00:00.200500Z",
		});

		expect(page.events.map((event) => event.auditEventId)).toEqual(["audit-above", "audit-at"]);
		// The exact, un-truncated microsecond string reaches the SQL param.
		const lastQuery = client.queries.at(-1);
		expect(lastQuery?.query).toContain("created_at >= $2::timestamptz");
		expect(lastQuery?.params[1]).toBe("2026-03-20T00:00:00.200500Z");
	});

	test("passes the full-precision createdBefore string to the timestamptz bound", async () => {
		const client = new FakeAuditSqlClient();
		client.auditRows = [
			auditEvent({ id: "audit-below", createdAt: "2026-03-20T00:00:00.200300Z" }),
			auditEvent({ id: "audit-at", createdAt: "2026-03-20T00:00:00.200500Z" }),
			auditEvent({ id: "audit-above", createdAt: "2026-03-20T00:00:00.200900Z" }),
		];
		const store = new PostgresWorkspaceAccessStore(client);

		// Inclusive upper bound at .200500: the .200900 event must be excluded,
		// the .200500 row must still match (the old ms-truncation wrongly dropped it).
		const page = await store.listAuditEventPage("workspace-1", {
			createdBefore: "2026-03-20T00:00:00.200500Z",
		});

		expect(page.events.map((event) => event.auditEventId)).toEqual(["audit-at", "audit-below"]);
		const lastQuery = client.queries.at(-1);
		expect(lastQuery?.query).toContain("created_at <= $2::timestamptz");
		expect(lastQuery?.params[1]).toBe("2026-03-20T00:00:00.200500Z");
	});
});
