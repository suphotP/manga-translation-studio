export interface WorkspaceIdentityColor {
	name: string;
	value: string;
}

export interface WorkspaceIdentity {
	initials: string;
	color: WorkspaceIdentityColor;
}

export const WORKSPACE_IDENTITY_PALETTE: readonly WorkspaceIdentityColor[] = [
	{ name: "accent", value: "var(--color-ws-accent, #7C5CFF)" },
	{ name: "violet", value: "var(--color-ws-violet, #8B5CF6)" },
	{ name: "cyan", value: "var(--color-ws-cyan, #22D3EE)" },
	{ name: "green", value: "var(--color-ws-green, #34D399)" },
	{ name: "amber", value: "var(--color-ws-amber, #FBBF24)" },
	{ name: "rose", value: "var(--color-ws-rose, #FB7185)" },
	{ name: "blue", value: "var(--color-ws-blue, #8fb8ff)" },
	{ name: "accent-blue", value: "color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 62%, var(--color-ws-blue, #8fb8ff))" },
	{ name: "violet-rose", value: "color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 58%, var(--color-ws-rose, #FB7185))" },
	{ name: "cyan-green", value: "color-mix(in srgb, var(--color-ws-cyan, #22D3EE) 52%, var(--color-ws-green, #34D399))" },
] as const;

const WORD_SPLIT_PATTERN = /[\s._\-–—/|]+/u;
const LETTER_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;
const DEFAULT_INITIALS = "WS";

export function workspaceIdentityColor(workspaceId: string | null | undefined): WorkspaceIdentityColor {
	const key = workspaceId?.trim() || "workspace";
	let hash = 2166136261;
	for (const char of key) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return WORKSPACE_IDENTITY_PALETTE[(hash >>> 0) % WORKSPACE_IDENTITY_PALETTE.length]!;
}

export function workspaceInitials(name: string | null | undefined): string {
	const cleanName = name?.trim();
	if (!cleanName) return DEFAULT_INITIALS;
	const words = cleanName.split(WORD_SPLIT_PATTERN).filter(Boolean);
	const firstLetters = words
		.map((word) => visibleCharacters(word)[0])
		.filter((char): char is string => Boolean(char))
		.slice(0, 2);
	if (firstLetters.length >= 2) return firstLetters.join("").toLocaleUpperCase();
	const allCharacters = visibleCharacters(cleanName);
	const initials = allCharacters.slice(0, 2).join("").toLocaleUpperCase();
	return initials || DEFAULT_INITIALS;
}

export function workspaceIdentityFor(input: { workspaceId?: string | null; name?: string | null }): WorkspaceIdentity {
	return {
		initials: workspaceInitials(input.name),
		color: workspaceIdentityColor(input.workspaceId),
	};
}

function visibleCharacters(value: string): string[] {
	return Array.from(value).filter((char) => LETTER_OR_NUMBER_PATTERN.test(char));
}
