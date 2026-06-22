/**
 * Stable story identity + cosmetic library slug helpers.
 *
 * Stories used to be keyed by a title-derived slug. That collided whenever two
 * stories shared a title and broke whenever a title was renamed (the URL key
 * changed under the user). Stories are now keyed by a STABLE, URL-safe,
 * dash-free id that is never derived from the title.
 *
 * The library URL is a hybrid `/library/<storyId>-<slug>`:
 *  - `storyId` is the real key (dash-free, stable across renames),
 *  - `slug` is a cosmetic, human-readable title slug that may change freely.
 *
 * Because the id is dash-free, the URL segment can be split on the FIRST '-':
 * the leading token is always the id and everything after is the slug, which is
 * ignored for lookup. Legacy slug-based ids (which contain dashes) are matched
 * by the full segment so existing projects and bookmarks keep resolving.
 */

const STORY_ID_LENGTH = 10;
const STORY_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Mint a raw, stable, URL-safe, dash-free story id.
 *
 * Uses `crypto.getRandomValues` when available for good entropy and falls back
 * to `Math.random` so it still works in non-secure / test contexts.
 */
function mintRawStoryId(): string {
	const cryptoObj = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
	if (cryptoObj?.getRandomValues) {
		const bytes = new Uint8Array(STORY_ID_LENGTH);
		cryptoObj.getRandomValues(bytes);
		let id = "";
		for (const byte of bytes) {
			id += STORY_ID_ALPHABET[byte % STORY_ID_ALPHABET.length];
		}
		return id;
	}
	let id = "";
	for (let index = 0; index < STORY_ID_LENGTH; index += 1) {
		id += STORY_ID_ALPHABET[Math.floor(Math.random() * STORY_ID_ALPHABET.length)];
	}
	return id;
}

/**
 * Whether a freshly-minted dash-free candidate id would collide with an existing
 * story id — either identical, or equal to the LEADING TOKEN of an existing
 * legacy dashed slug id (which would let the two share a URL leading token). The
 * resolver ({@link findStoryGroupByTitleKey}) already resolves deterministically
 * even on collision; this guard is defence-in-depth so it never has to.
 */
export function storyIdCollidesWith(candidate: string, existingStoryId: string): boolean {
	const c = candidate.trim();
	const e = existingStoryId.trim();
	if (!c || !e) return false;
	return c === e || c === storyIdFromTitleKey(e);
}

/**
 * Mint a fresh, stable, URL-safe, dash-free story id for a NEW story, avoiding
 * collision with any already-known story id (pass the current stories' ids).
 * Collision is astronomically unlikely (36^10) so a bounded retry is plenty; we
 * fall back to a raw mint rather than loop forever.
 */
export function generateStableStoryId(existingStoryIds: Iterable<string> = []): string {
	const taken = [...existingStoryIds].map((id) => (id ?? "").trim()).filter(Boolean);
	if (taken.length === 0) return mintRawStoryId();
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const candidate = mintRawStoryId();
		if (!taken.some((id) => storyIdCollidesWith(candidate, id))) return candidate;
	}
	return mintRawStoryId();
}

/**
 * Extract the stable story id from a `[titleKey]` URL segment.
 *
 * New-format ids are dash-free, so the id is the token before the first '-'
 * and the rest is the cosmetic slug. A legacy slug-based id has no separate
 * slug; this still returns its leading token, but resolution must also try the
 * full segment (see {@link storyGroupKeyMatches}).
 */
export function storyIdFromTitleKey(titleKey: string): string {
	const trimmed = titleKey.trim();
	if (!trimmed) return trimmed;
	const dashIndex = trimmed.indexOf("-");
	return dashIndex === -1 ? trimmed : trimmed.slice(0, dashIndex);
}

/** Build the cosmetic, human-readable slug appended after the story id. */
export function buildStorySlug(title: string | null | undefined): string {
	return (title ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9ก-๙]+/gi, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Build the hybrid `[titleKey]` URL segment from a stable id + optional title.
 *
 * The slug is purely cosmetic; the id alone is a valid segment when there is no
 * title yet. A legacy slug-based id (already containing dashes) is returned
 * unchanged so its existing URLs stay byte-identical.
 */
export function buildStoryTitleKey(storyId: string, title?: string | null): string {
	const id = storyId.trim();
	if (!id) return id;
	// Legacy slug ids already encode their own readable form; don't append again.
	if (id.includes("-")) return id;
	const slug = buildStorySlug(title);
	return slug ? `${id}-${slug}` : id;
}

/**
 * Decide whether a story group (keyed by its stored `storyId`) matches a
 * `[titleKey]` URL segment.
 *
 * New stories: the segment's leading dash-free token equals the group's stable
 * id. Legacy stories: the group's slug-based id equals the FULL segment. Trying
 * both keeps new ids and old bookmarks resolving without a forced migration.
 */
export function storyGroupKeyMatches(groupStoryId: string, titleKey: string): boolean {
	const key = titleKey.trim();
	if (!key) return false;
	const groupId = groupStoryId.trim();
	if (!groupId) return false;
	// New-format: stable id is the leading token of the segment.
	if (groupId === storyIdFromTitleKey(key)) return true;
	// Legacy back-compat: slug-based id matched the whole segment.
	return groupId === key;
}

/**
 * Resolve the single story group that owns a `[titleKey]` URL segment —
 * deterministically and INDEPENDENT of group order.
 *
 * `storyGroupKeyMatches` can return true for two different groups for the same
 * segment (a new dash-free id whose value equals the leading token of a legacy
 * dashed slug). A bare `.find()` would then pick whichever comes first, sending
 * users to the wrong/empty story and making the legacy one order-dependently
 * unreachable. Preferring exactness removes that ambiguity:
 *  1) EXACT full-segment match wins — covers a legacy slug id AND a bare new id.
 *  2) Otherwise a LEADING-TOKEN match against a DASH-FREE (new-format) id —
 *     covers `<newId>-<cosmeticSlug>`. A dashed legacy id can never equal the
 *     dash-free token, so legacy stories are only ever reached via the exact
 *     pass and can never be hidden behind a colliding new id.
 */
export function findStoryGroupByTitleKey<T>(
	groups: readonly T[],
	getStoryId: (group: T) => string,
	titleKey: string | null | undefined,
): T | undefined {
	const key = (titleKey ?? "").trim();
	if (!key) return undefined;
	const exact = groups.find((group) => getStoryId(group).trim() === key);
	if (exact) return exact;
	const token = storyIdFromTitleKey(key);
	if (!token) return undefined;
	return groups.find((group) => {
		const id = getStoryId(group).trim();
		return id !== "" && !id.includes("-") && id === token;
	});
}
