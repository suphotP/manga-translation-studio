// Audit log date-filter timezone conversion.
//
// Regression for the bug where the admin audit page sent `${date}T00:00:00.000Z`
// (UTC midnight) for a LOCAL calendar date, so an admin in a non-UTC timezone
// missed early-local-morning rows and wrongly included the next UTC day. The
// boundaries must be the admin's LOCAL day, expressed as UTC instants.

import { describe, it, expect, afterAll } from "vitest";
import { localDateStartUtc, localDateEndUtc } from "../../routes/admin/audit/audit-date-range.ts";

// jsdom/node run in whatever TZ the host has. To assert timezone-correctness
// deterministically we pin process.env.TZ for the duration of this file. (Node
// reads TZ lazily per Date construction, so setting it here is sufficient.)
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "Asia/Bangkok"; // UTC+7, no DST

afterAll(() => {
	if (ORIGINAL_TZ === undefined) delete process.env.TZ;
	else process.env.TZ = ORIGINAL_TZ;
});

describe("audit date-range local→UTC conversion (Asia/Bangkok, UTC+7)", () => {
	it("start of a local day is the previous UTC evening (17:00Z), not 00:00Z", () => {
		// Local 2026-06-03 00:00:00 in UTC+7 == 2026-06-02 17:00:00 UTC.
		expect(localDateStartUtc("2026-06-03")).toBe("2026-06-02T17:00:00.000Z");
	});

	it("end of a local day is 16:59:59.999Z of the same UTC day", () => {
		// Local 2026-06-03 23:59:59.999 in UTC+7 == 2026-06-03 16:59:59.999 UTC.
		expect(localDateEndUtc("2026-06-03")).toBe("2026-06-03T16:59:59.999Z");
	});

	it("a single selected local day spans exactly 24h of UTC instants", () => {
		const start = new Date(localDateStartUtc("2026-06-03")).getTime();
		const end = new Date(localDateEndUtc("2026-06-03")).getTime();
		expect(end - start).toBe(24 * 60 * 60 * 1000 - 1);
	});

	it("an event at 06:00 local (before UTC midnight rollover) falls inside the selected local day", () => {
		// 06:00 Bangkok on 2026-06-03 == 2026-06-02T23:00:00Z. The OLD naive bounds
		// (2026-06-03T00:00:00.000Z .. T23:59:59.999Z) would EXCLUDE this row; the
		// local-day bounds must include it.
		const eventUtc = new Date("2026-06-03T06:00:00+07:00").toISOString(); // 2026-06-02T23:00:00.000Z
		const start = localDateStartUtc("2026-06-03");
		const end = localDateEndUtc("2026-06-03");
		expect(eventUtc >= start && eventUtc <= end).toBe(true);
	});

	it("produces canonical UTC ISO strings the backend accepts (trailing Z, .sss precision)", () => {
		expect(localDateStartUtc("2026-06-03")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(localDateEndUtc("2026-06-03")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
});
