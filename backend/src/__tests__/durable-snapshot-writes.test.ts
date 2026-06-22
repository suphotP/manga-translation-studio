import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, test } from "bun:test";
import { FileAuthSessionStore, type AuthSessionRecord } from "../services/auth-sessions.js";
import { FileBillingStore } from "../services/billing-store.js";

// Regression coverage for the durability fix: the file-mode auth-session and
// billing snapshots must be written through `writeFileAtomic` (temp → fsync →
// rename), so a write round-trips to identical data AND never leaves a stray
// temp file (a truncated/partial snapshot would corrupt auth or money state).
// The atomic mechanism itself is unit-tested in atomic-file.test.ts; here we
// assert the two stores actually route their whole-file snapshot writes through
// it without leaking a temp sibling.

const tempDirs: string[] = [];

function freshDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

function strayTempFiles(forPath: string): string[] {
	return readdirSync(dirname(forPath)).filter((name) => name.endsWith(".tmp"));
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("FileAuthSessionStore durable snapshot writes", () => {
	function session(overrides: Partial<AuthSessionRecord> = {}): AuthSessionRecord {
		return {
			sessionId: "sess-1",
			userId: "user-1",
			tokenHash: "hash-1",
			createdAt: 1_000,
			expiresAt: Date.now() + 60_000,
			...overrides,
		};
	}

	test("round-trips a session and reloads it from a fresh instance", async () => {
		const path = join(freshDir("manga-auth-snap-"), "auth-sessions.json");
		const store = new FileAuthSessionStore(path);

		await store.create(session({ sessionId: "sess-a", tokenHash: "hash-a" }));
		await store.create(session({ sessionId: "sess-b", tokenHash: "hash-b" }));

		// A brand-new instance reading the same JSON file must see both sessions —
		// proving the snapshot was fully (not partially) persisted to disk.
		const reloaded = new FileAuthSessionStore(path);
		const found = await reloaded.findByTokenHash("hash-a");
		expect(found?.sessionId).toBe("sess-a");
		expect(await reloaded.listUserSessions("user-1")).toHaveLength(2);
	});

	test("leaves no temp file behind after writes, and the snapshot is valid JSON", async () => {
		const path = join(freshDir("manga-auth-snap-"), "auth-sessions.json");
		const store = new FileAuthSessionStore(path);

		await store.create(session({ tokenHash: "hash-1" }));
		await store.revokeTokenHash("hash-1");

		expect(strayTempFiles(path)).toEqual([]);
		// The committed file is a complete, parseable snapshot — never truncated.
		expect(() => JSON.parse(readFileSync(path, "utf-8"))).not.toThrow();
	});
});

describe("FileBillingStore durable snapshot writes", () => {
	test("round-trips a plan assignment and reloads it from a fresh instance", async () => {
		const path = join(freshDir("manga-billing-snap-"), "billing-accounts.json");
		const store = new FileBillingStore(path);

		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "pro" });

		const reloaded = new FileBillingStore(path);
		expect((await reloaded.getWorkspaceAssignment("ws-1"))?.planId).toBe("pro");
	});

	test("leaves no temp file behind after a write, and the snapshot is valid JSON", async () => {
		const path = join(freshDir("manga-billing-snap-"), "billing-accounts.json");
		const store = new FileBillingStore(path);

		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "creator" });
		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "studio" });

		expect(strayTempFiles(path)).toEqual([]);
		expect(() => JSON.parse(readFileSync(path, "utf-8"))).not.toThrow();
	});
});
