export function normalizeAssigneeHandle(value: string | null | undefined): string | undefined {
	const normalized = value?.trim().replace(/^@+/, "").trim();
	return normalized || undefined;
}

export function formatAssigneeHandle(value: string | null | undefined, fallback = "unassigned"): string {
	const normalized = normalizeAssigneeHandle(value);
	return normalized ? `@${normalized}` : fallback;
}
