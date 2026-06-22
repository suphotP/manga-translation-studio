import { afterEach, describe, expect, test } from "bun:test";

import { bootstrapPlatformOwner } from "../services/auth-users.js";
import type { AuthUserStore } from "../services/auth-users.js";
import type { User } from "../types/auth.js";

// Minimal in-memory store double: only the two methods the bootstrap touches.
function makeStore(initial: User | null) {
	let stored = initial;
	const updates: Array<{ userId: string; role: unknown }> = [];
	const store = {
		async findByEmail(email: string): Promise<User | null> {
			return stored && stored.email.toLowerCase() === email.toLowerCase() ? stored : null;
		},
		async update(userId: string, patch: { role?: unknown }): Promise<User | null> {
			updates.push({ userId, role: patch.role });
			if (stored && stored.id === userId) stored = { ...stored, ...(patch as Partial<User>) };
			return stored;
		},
	} as unknown as AuthUserStore;
	return { store, updates, current: () => stored };
}

function makeUser(over: Partial<User> = {}): User {
	return { id: "u1", email: "boss@example.com", name: "Boss", role: "editor", isActive: true, ...over } as User;
}

afterEach(() => {
	delete process.env.ADMIN_BOOTSTRAP_EMAIL;
});

describe("bootstrapPlatformOwner", () => {
	test("no-op when ADMIN_BOOTSTRAP_EMAIL is unset", async () => {
		const { store, updates } = makeStore(makeUser());
		delete process.env.ADMIN_BOOTSTRAP_EMAIL;
		await bootstrapPlatformOwner(store);
		expect(updates.length).toBe(0);
	});

	test("promotes the configured (case-insensitive) account to owner", async () => {
		const { store, updates, current } = makeStore(makeUser({ role: "editor" }));
		process.env.ADMIN_BOOTSTRAP_EMAIL = "BOSS@Example.com";
		await bootstrapPlatformOwner(store);
		expect(current()?.role).toBe("owner");
		expect(updates).toEqual([{ userId: "u1", role: "owner" }]);
	});

	test("is idempotent — already a platform admin → no second update", async () => {
		const { store, updates } = makeStore(makeUser({ role: "owner" }));
		process.env.ADMIN_BOOTSTRAP_EMAIL = "boss@example.com";
		await bootstrapPlatformOwner(store);
		await bootstrapPlatformOwner(store);
		expect(updates.length).toBe(0);
	});

	test("no-op (no throw) when the configured email has no account", async () => {
		const { store, updates } = makeStore(makeUser());
		process.env.ADMIN_BOOTSTRAP_EMAIL = "ghost@example.com";
		await bootstrapPlatformOwner(store);
		expect(updates.length).toBe(0);
	});

	test("never demotes — an existing 'admin' is left untouched", async () => {
		const { store, updates } = makeStore(makeUser({ role: "admin" }));
		process.env.ADMIN_BOOTSTRAP_EMAIL = "boss@example.com";
		await bootstrapPlatformOwner(store);
		expect(updates.length).toBe(0);
	});
});
