import { USER_LIST_MAX_LIMIT, type UserListCursor } from "../services/auth-users.js";

/**
 * HTTP-boundary helpers for the keyset-paginated admin user list. The cursor —
 * (lower(name), user_id) — is exposed as an opaque base64url token so callers
 * round-trip `nextCursor` without depending on its internal shape.
 */

export function encodeUserCursor(cursor: UserListCursor | null): string | null {
	if (!cursor) return null;
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeUserCursor(raw: string | undefined): UserListCursor | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
		if (
			parsed && typeof parsed === "object" &&
			typeof (parsed as UserListCursor).name === "string" &&
			typeof (parsed as UserListCursor).userId === "string"
		) {
			return { name: (parsed as UserListCursor).name, userId: (parsed as UserListCursor).userId };
		}
	} catch {
		// Malformed cursor → start from the first page rather than 500.
	}
	return undefined;
}

export function parseUserLimit(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return undefined;
	// Store clamps to [1, USER_LIST_MAX_LIMIT]; clamp here too so the echoed
	// `limit` in the response matches what was actually applied.
	return Math.min(Math.max(Math.floor(parsed), 1), USER_LIST_MAX_LIMIT);
}
