export function normalizeAssigneeHandle(value: string | null | undefined): string | null {
	const normalized = value?.trim().replace(/^@+/, "").trim();
	return normalized ? normalized : null;
}

export function formatAssigneeHandle(value: string | null | undefined, fallback = "Unassigned"): string {
	const normalized = normalizeAssigneeHandle(value);
	return normalized ? `@${normalized}` : fallback;
}
