// Finding A — process-level last-resort handlers.
//
// index.ts must register UNCONDITIONAL `unhandledRejection` + `uncaughtException`
// handlers early in bootstrap (independent of SENTRY_DSN), so a stray rejection
// from a fire-and-forget `void <promise>` does not kill the API on Node >=15.
//
// Importing index.ts here is side-effect-light in the test runner: the server
// start (serve(), queue processors) is gated behind `import.meta.main`, which is
// false under bun test. The module's top-level `registerProcessGuards()` DOES
// run, so we can assert the listeners are installed and that re-import is
// idempotent (no duplicate handlers stacked across test-file imports).

import { describe, test, expect } from "bun:test";

describe("process guards (Finding A)", () => {
	test("importing the bootstrap registers unhandledRejection + uncaughtException handlers", async () => {
		await import("../index.js");
		expect(process.listeners("unhandledRejection").length).toBeGreaterThan(0);
		expect(process.listeners("uncaughtException").length).toBeGreaterThan(0);
	});

	test("re-importing the bootstrap does not stack duplicate handlers (idempotent)", async () => {
		await import("../index.js");
		const ur = process.listeners("unhandledRejection").length;
		const ue = process.listeners("uncaughtException").length;
		await import("../index.js");
		expect(process.listeners("unhandledRejection").length).toBe(ur);
		expect(process.listeners("uncaughtException").length).toBe(ue);
	});
});
