// Local-calendar-day → UTC-instant conversion for the Audit log date filters.
//
// The <input type="date"> yields a bare local calendar date ("2026-06-03"). The
// admin means "rows that happened on that day in MY timezone", so we convert the
// LOCAL-day boundaries to UTC instants the backend can bind as ::timestamptz.
//
// Parsing "YYYY-MM-DDTHH:mm:ss.sss" with NO zone suffix makes the browser treat
// it as LOCAL time; toISOString() then yields the matching UTC instant. Naively
// appending "T00:00:00.000Z" instead (the previous behavior) would mean an admin
// in Asia/Bangkok (UTC+7) querying 2026-06-03 misses 00:00–07:00 local rows and
// wrongly includes the next day's early hours.
//
// Extracted from +page.svelte as a pure module so the timezone math is unit-
// testable without mounting the component.

/** UTC instant (ISO) for the START of the given local calendar day. */
export function localDateStartUtc(date: string): string {
	return new Date(`${date}T00:00:00.000`).toISOString();
}

/** UTC instant (ISO) for the END of the given local calendar day. */
export function localDateEndUtc(date: string): string {
	return new Date(`${date}T23:59:59.999`).toISOString();
}
