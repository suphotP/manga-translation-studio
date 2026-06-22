import type { ProjectSummary } from "$lib/api/client.js";

export const RECENT_PROJECT_PICKER_LIMIT = 30;

const INTERNAL_AUDIT_NAME_PATTERN = /^(Flow\d+\s+UX Audit Chapter|P104 Sales Demo Chapter 104|Chapter)$/i;

// Internal/audit-named projects (UX audit + sales-demo seeds) used to be MASKED
// into invented story titles (e.g. "Glass Harbor ตอน 12"), which rendered as fake
// real series in a user's recent-series rail. That is fabricated data. We now show
// an honest, neutral label instead — disambiguation already comes from the short
// project id via formatRecentProjectDisambiguator().
const INTERNAL_PROJECT_LABEL = "โปรเจกต์ภายใน";

function normalizeSearch(value: string): string {
	return value.trim().toLowerCase();
}

export function getShortProjectId(projectId: string): string {
	const compact = projectId.trim().replace(/[^A-Za-z0-9]/g, "");
	if (!compact) return "unknown";
	if (compact.length <= 10) return compact;
	return `${compact.slice(0, 4)}${compact.slice(-4)}`;
}

export function formatRecentProjectStats(project: ProjectSummary): string {
	const lang = project.targetLang ? project.targetLang.toUpperCase() : "LANG";
	if (project.pageCount <= 0) return `ยังไม่มีหน้า / ${project.textLayerCount} เลเยอร์ข้อความ / ${lang}`;
	return `${project.pageCount} หน้า / ${project.textLayerCount} เลเยอร์ข้อความ / ${lang}`;
}

function recentProjectIdentityKey(project: ProjectSummary): string {
	return `${formatRecentProjectName(project).toLowerCase()}|${formatRecentProjectStats(project).toLowerCase()}`;
}

export function needsRecentProjectDisambiguator(
	project: ProjectSummary,
	projects: readonly ProjectSummary[],
): boolean {
	const key = recentProjectIdentityKey(project);
	return projects.filter((candidate) => recentProjectIdentityKey(candidate) === key).length > 1;
}

export function formatRecentProjectDisambiguator(
	project: ProjectSummary,
	projects: readonly ProjectSummary[],
): string | null {
	if (!needsRecentProjectDisambiguator(project, projects)) return null;
	return `รหัส ${getShortProjectId(project.projectId)}`;
}

export function recentProjectNeedsPageSetup(project: Pick<ProjectSummary, "pageCount">): boolean {
	return project.pageCount <= 0;
}

export function formatRecentProjectName(project: Pick<ProjectSummary, "name"> & Partial<Pick<ProjectSummary, "projectId">>): string {
	const name = project.name.trim();
	if (INTERNAL_AUDIT_NAME_PATTERN.test(name)) {
		return INTERNAL_PROJECT_LABEL;
	}
	return name || "ยังไม่ตั้งชื่อตอน";
}

export function formatRecentProjectUpdatedAt(updatedAt: string, nowMs = Date.now()): string {
	const updatedMs = Date.parse(updatedAt);
	if (!Number.isFinite(updatedMs)) return "ยังไม่รู้เวลาอัปเดต";

	const diffMs = Math.max(0, nowMs - updatedMs);
	const minute = 60 * 1000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (diffMs < minute) return "อัปเดตเมื่อกี้";
	if (diffMs < hour) return `อัปเดต ${Math.max(1, Math.round(diffMs / minute))} นาทีที่แล้ว`;
	if (diffMs < day) return `อัปเดต ${Math.max(1, Math.round(diffMs / hour))} ชม.ที่แล้ว`;
	if (diffMs < 7 * day) return `อัปเดต ${Math.max(1, Math.round(diffMs / day))} วันที่แล้ว`;

	const date = new Date(updatedMs);
	return `อัปเดต ${date.toLocaleDateString("th-TH", { day: "numeric", month: "short" })}`;
}

export function buildRecentProjectSearchText(project: ProjectSummary): string {
	return [
		formatRecentProjectName(project),
		getShortProjectId(project.projectId),
		project.targetLang,
		project.pageCount.toString(),
		project.textLayerCount.toString(),
	].join(" ").toLowerCase();
}

export function preserveRecentProjectOrder(
	currentProjects: readonly ProjectSummary[],
	nextProjects: readonly ProjectSummary[],
): ProjectSummary[] {
	if (currentProjects.length === 0 || nextProjects.length === 0) return [...nextProjects];
	const nextById = new Map(nextProjects.map((project) => [project.projectId, project]));
	const ordered = currentProjects
		.map((project) => nextById.get(project.projectId))
		.filter((project): project is ProjectSummary => Boolean(project));
	const seen = new Set(ordered.map((project) => project.projectId));
	return [
		...ordered,
		...nextProjects.filter((project) => !seen.has(project.projectId)),
	];
}

export interface RecentProjectPickerResult {
	readonly projects: ProjectSummary[];
	readonly hiddenCount: number;
	readonly totalMatches: number;
}

export function getRecentProjectPickerItems(
	projects: readonly ProjectSummary[],
	query: string,
	selectedProjectId = "",
	limit = RECENT_PROJECT_PICKER_LIMIT,
): RecentProjectPickerResult {
	const normalizedQuery = normalizeSearch(query);
	const safeLimit = Math.max(1, Math.floor(limit));
	const matches = normalizedQuery
		? projects.filter((project) => buildRecentProjectSearchText(project).includes(normalizedQuery))
		: [...projects];
	const visible = matches.slice(0, safeLimit);

	if (!normalizedQuery && selectedProjectId && !visible.some((project) => project.projectId === selectedProjectId)) {
		const selectedProject = projects.find((project) => project.projectId === selectedProjectId);
		if (selectedProject) {
			visible.unshift(selectedProject);
			visible.splice(safeLimit);
		}
	}

	return {
		projects: visible,
		hiddenCount: Math.max(0, matches.length - visible.length),
		totalMatches: matches.length,
	};
}
