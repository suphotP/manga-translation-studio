import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
// Register the locale dictionaries (addMessages + init) so the component's
// `$_(...)` keys resolve to real strings — without this import the i18n store
// has no messages registered in this test's module graph and `$_` echoes the
// raw key. test-setup.ts forces the active locale to Thai for the run.
import "$lib/i18n";
import WorkspaceReportsView from "$lib/components/WorkspaceReportsView.svelte";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { usageStore } from "$lib/stores/usage.svelte.ts";
import { perfAnalyticsStore } from "$lib/stores/perf-analytics.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import type { AuthUser, AuthUserRole, ProjectSummary } from "$lib/api/client.js";
import type { AdminMe } from "$lib/api/admin.ts";
import type { RevenueSummary } from "$lib/api/admin/revenue.ts";

// The Reports view loads the revenue panel from the admin API on mount. Default
// to a NO-permission stub so the revenue panel is omitted (honest) and no real
// network call is attempted; individual tests can override via the hoisted refs.
const admin = vi.hoisted(() => ({
	getAdminMe: vi.fn<() => Promise<AdminMe>>(),
	setAdminApiToken: vi.fn(),
	getSummary: vi.fn<() => Promise<RevenueSummary>>(),
}));

vi.mock("$lib/api/admin.ts", () => ({
	getAdminMe: admin.getAdminMe,
	setAdminApiToken: admin.setAdminApiToken,
}));

vi.mock("$lib/api/admin/revenue.ts", () => ({
	adminRevenueApi: { getSummary: admin.getSummary },
}));

const now = "2026-05-14T00:00:00.000Z";

// Seed a signed-in session with a given PLATFORM role. The Reports view gates the
// admin /me probe on the client-known platform role, so back-office roles
// (owner/admin/support/accountant) reach getAdminMe while ordinary studio
// accounts (editor/viewer) never do.
function seedSession(role: AuthUserRole): void {
	const user: AuthUser = {
		id: `user-${role}`,
		email: `${role}@example.com`,
		name: `${role} user`,
		role,
		authProvider: "local",
		emailVerified: true,
		isActive: true,
	};
	authStore.__setSessionForTesting({
		user,
		tokens: { accessToken: "test-access-token", refreshToken: "test-refresh-token" },
	});
}

function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
	return {
		projectId: "project-1",
		name: "Alpha Chapter 1",
		createdAt: now,
		updatedAt: now,
		targetLang: "th",
		pageCount: 12,
		textLayerCount: 24,
		taskCount: 4,
		openTaskCount: 2,
		reviewTaskCount: 1,
		openCommentCount: 1,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	admin.getAdminMe.mockResolvedValue({ role: "viewer", permissions: [], sections: [] });
	admin.getSummary.mockResolvedValue({ currencies: [], plans: [], activeSubscriptionsTotal: 0 });
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	usageStore.reset();
	perfAnalyticsStore.reset();
	authStore.__resetForTesting();
	editorUiStore.openReports();
});

describe("WorkspaceReportsView", () => {
	it("renders nothing until the reports view is active", () => {
		editorUiStore.openDashboard();
		render(WorkspaceReportsView);
		expect(screen.queryByLabelText("รายงานเวิร์กสเปซ")).toBeNull();
	});

	it("renders the reports surface with all core panels when there is work data", () => {
		// With at least one library chapter the full per-section report renders
		// (the consolidated empty hero only takes over when EVERY source is empty).
		projectStore.recentProjects = [projectSummary({ projectId: "a" })];

		render(WorkspaceReportsView);

		expect(screen.getByLabelText("รายงานเวิร์กสเปซ")).toBeTruthy();
		expect(screen.queryByTestId("reports-empty-hero")).toBeNull();
		// Each panel is present (loading/empty/data — but mounted).
		expect(screen.getByTestId("reports-pipeline")).toBeTruthy();
		expect(screen.getByTestId("reports-usage")).toBeTruthy();
		expect(screen.getByTestId("reports-export-ready")).toBeTruthy();
		expect(screen.getByTestId("reports-performance")).toBeTruthy();
		expect(screen.getByTestId("reports-export-history")).toBeTruthy();
	});

	it("consolidates into ONE empty-state card when the workspace has no data", () => {
		render(WorkspaceReportsView);

		// Genuinely empty workspace → a single premium empty hero replaces the
		// stacked per-section "no data" placeholders.
		const hero = screen.getByTestId("reports-empty-hero");
		expect(hero).toBeTruthy();
		expect(hero.textContent).toContain("ยังไม่มีข้อมูลให้สรุป");

		// The individual placeholder panels are NOT rendered in this state.
		expect(screen.queryByTestId("reports-library-empty")).toBeNull();
		expect(screen.queryByTestId("reports-library-stats")).toBeNull();
		expect(screen.queryByTestId("reports-pipeline")).toBeNull();
		expect(screen.queryByTestId("reports-export-ready")).toBeNull();
		expect(screen.queryByTestId("reports-export-history")).toBeNull();
		expect(screen.queryByTestId("reports-performance")).toBeNull();
		expect(screen.queryByText("ยังไม่มีข้อมูลประสิทธิภาพ")).toBeNull();
	});

	it("aggregates real library stats from the recent-projects summaries", () => {
		projectStore.recentProjects = [
			projectSummary({ projectId: "a", pageCount: 10, openTaskCount: 3, openCommentCount: 1 }),
			projectSummary({ projectId: "b", pageCount: 5, openTaskCount: 2, openCommentCount: 4 }),
		];

		render(WorkspaceReportsView);

		const stats = screen.getByTestId("reports-library-stats");
		expect(stats).toBeTruthy();
		expect(screen.queryByTestId("reports-library-empty")).toBeNull();
		// 2 projects · 15 pages · 5 open tasks · 5 open comments — all real sums.
		expect(stats.textContent).toContain("15");
		expect(stats.textContent).toContain("5");
	});

	it("never probes the admin endpoint for an ordinary studio account", async () => {
		// A normal editor (or workspace owner, whose platform role is editor) is
		// never a platform admin, so the view must NOT call getAdminMe — otherwise
		// every page logs a 403 in the console.
		seedSession("editor");
		render(WorkspaceReportsView);

		// Give the on-mount load a turn to (not) fire.
		await Promise.resolve();
		await Promise.resolve();
		expect(admin.getAdminMe).not.toHaveBeenCalled();
		expect(admin.getSummary).not.toHaveBeenCalled();
		expect(screen.queryByTestId("reports-revenue")).toBeNull();
	});

	it("omits the revenue panel when the viewer lacks the revenue permission", async () => {
		// A back-office role still reaches getAdminMe (the server is the source of
		// truth); the no-permission response then omits the panel honestly.
		seedSession("support");
		render(WorkspaceReportsView);

		await waitFor(() => expect(admin.getAdminMe).toHaveBeenCalled());
		// No revenue permission → panel omitted entirely (not an error banner).
		expect(screen.queryByTestId("reports-revenue")).toBeNull();
		expect(admin.getSummary).not.toHaveBeenCalled();
	});

	it("renders the revenue panel only when the viewer holds admin:revenue.read", async () => {
		seedSession("accountant");
		admin.getAdminMe.mockResolvedValue({
			role: "accountant",
			permissions: ["admin:revenue.read"],
			sections: [],
		});
		admin.getSummary.mockResolvedValue({
			currencies: [{ currency: "USD", mrrCents: "120000", arrCents: "1440000", activeSubscriptions: 8 }],
			plans: [],
			activeSubscriptionsTotal: 8,
		});

		render(WorkspaceReportsView);

		await waitFor(() => expect(screen.queryByTestId("reports-revenue")).toBeTruthy());
		const panel = screen.getByTestId("reports-revenue");
		expect(panel.textContent).toContain("USD");
		// 120000 cents → 1,200 MRR (formatted), real money from the summary.
		expect(panel.textContent).toContain("1,200");
		expect(admin.getSummary).toHaveBeenCalled();
	});
});
