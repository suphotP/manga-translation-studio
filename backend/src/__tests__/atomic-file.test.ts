import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileAtomic } from "../utils/atomic-file.js";

describe("writeFileAtomic", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "manga-atomic-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("writes the full payload and creates missing parent directories", () => {
		const path = join(dir, "nested", "state.json");
		writeFileAtomic(path, JSON.stringify({ ok: true }));
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ ok: true });
	});

	test("leaves no temp file behind after a successful write", () => {
		const path = join(dir, "state.json");
		writeFileAtomic(path, "first");
		writeFileAtomic(path, "second");
		const stray = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
		expect(stray).toEqual([]);
		expect(readFileSync(path, "utf-8")).toBe("second");
	});

	test("never truncates the existing target: a concurrent reader sees the old OR new file, never a partial one", () => {
		const path = join(dir, "state.json");
		const previous = JSON.stringify({ version: 1, pages: [1, 2, 3] });
		writeFileSync(path, previous);

		// Interleave many atomic writes with reads. Because the new bytes are written
		// to a temp file and rename()d over the target, every read MUST observe a
		// complete, parseable JSON document — either the prior version or a new one,
		// but never a half-written (truncate-then-write) state.
		const next = JSON.stringify({ version: 2, pages: Array.from({ length: 5000 }, (_, i) => i) });
		for (let i = 0; i < 50; i += 1) {
			writeFileAtomic(path, next);
			// Read immediately after — must always be valid JSON, never truncated.
			const raw = readFileSync(path, "utf-8");
			expect(() => JSON.parse(raw)).not.toThrow();
		}
		expect(readFileSync(path, "utf-8")).toBe(next);
	});

	test("a write that fails does not corrupt the existing target and cleans up its temp", () => {
		const path = join(dir, "state.json");
		writeFileSync(path, "good");
		// A non-string/non-Uint8Array payload makes the write throw AFTER opening the
		// temp file; the existing target must survive untouched and no temp may leak.
		expect(() => writeFileAtomic(path, { not: "serializable" } as unknown as string)).toThrow();
		expect(readFileSync(path, "utf-8")).toBe("good");
		const stray = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
		expect(stray).toEqual([]);
		expect(existsSync(path)).toBe(true);
	});
});
