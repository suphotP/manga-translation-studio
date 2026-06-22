import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { _ } from "svelte-i18n";
import { setLocale } from "$lib/i18n/index.ts";
import UsagePage from "../../../routes/settings/usage/+page.svelte";
import { usageStore } from "$lib/stores/usage.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import { billingStore } from "$lib/stores/billing.svelte.ts";
import type { UsageDashboard } from "$lib/api/client.ts";

const WS_ID = "ws-credits-test";
const SELF_USER_ID = "user-self-0001-aaaa";
const OTHER_USER_ID = "user-other-0002-bbbb";

const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();

// The dashboard the polling endpoint serves. A test can swap this to change the
// member breakdown the page renders (the poll would otherwise overwrite a
// directly-seeded usageStore.dashboard).
let servedDashboard: () => UsageDashboard = () => dashboard();

// A complete UsageDashboard. AI windows are THB-denominated (the backend unit);
// the page must convert them to CREDITS for display (1 credit = 0.09฿, post-×10 rebase #586):
//   monthly committed 0.18฿ → 2 credits, limit 63฿ → 700 credits,
//   daily committed 0.09฿ → 1 credit, reserved 0.09฿ → 1.
function dashboard(): UsageDashboard {
	const window = {
		periodKey: "2026-05",
		aiCapturedThb: 1.7,
		aiActiveReservedThb: 0.09,
		aiCommittedThb: 0.18,
		uploadBytes: 1024,
		exportBytes: 512,
		moderationImages: 0,
		limits: { aiCreditThb: 63, uploadBytes: 0, exportBytes: 0 },
		remaining: { aiCreditThb: 62.82, uploadBytes: null, exportBytes: null },
	};
	return {
		workspaceId: WS_ID,
		scope: "filesystem",
		enforced: true,
		plan: { id: "studio", name: "Studio", monthlyAiCredits: 700, includedStorageBytes: 0, maxSeatsIncluded: 5 },
		projectIds: [],
		projectCount: 0,
		totals: {
			daily: { ...window, periodKey: "2026-05-14", aiCommittedThb: 0.09, aiActiveReservedThb: 0.09 },
			monthly: window,
			eventCount: 4,
			eventCountCapped: false,
		},
		storage: {
			usedBytes: 678,
			originalBytes: 70,
			derivativeBytes: 96,
			exportArtifactBytes: 512,
			reservedBytes: 0,
			projectedBytes: 678,
			limitBytes: 1073741824,
			includedBytes: 1073741824,
			extraBytes: 0,
			remainingBytes: 1073741146,
			percentUsed: 0.1,
			enforced: true,
		},
		egress: {
			windowMs: 3600000,
			totalRequests: 0,
			totalBytes: 0,
			limitBytes: 0,
			remainingBytes: 0,
			enforced: false,
			perProjectEnforced: false,
			projects: [],
		},
		memberAttribution: "unattributed",
		members: {
			count: 2,
			breakdown: [
				{ userId: OTHER_USER_ID, role: "editor", disabled: false, aiCommittedThb: 0.09, uploadBytes: 2048, exportBytes: 0 },
			],
			unattributed: { aiCommittedThb: 0, uploadBytes: 0, exportBytes: 0 },
		},
	};
}

describe("settings/usage page — AI usage renders CREDITS, not ฿", () => {
	beforeAll(async () => {
		// CreditAmount reads $_("credits.unit"); svelte-i18n throws without an
		// initialised locale. Importing the i18n index runs init(); pin to en so
		// the credit unit label is the deterministic "credits".
		setLocale("en");
		await waitFor(() => {
			expect(get(_)("credits.unit")).toBe("credits");
		});
	});

	beforeEach(() => {
		globalThis.fetch = mockFetch;
		mockFetch.mockReset();
		servedDashboard = () => dashboard();
		// Route by URL: the usage dashboard poll returns our seeded dashboard; every
		// other background load (auth refresh / billing / members) gets a benign OK.
		mockFetch.mockImplementation((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
			if (url.includes("/usage/workspace/") && url.includes("/dashboard")) {
				return Promise.resolve(
					new Response(JSON.stringify({ dashboard: servedDashboard() }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
		});

		window.localStorage.setItem("manga-editor.currentWorkspaceId", WS_ID);
		// The store reads localStorage only at construction; set the live field so
		// the page's `wsId` derived resolves (the module singleton already exists).
		billingStore.currentWorkspaceId = WS_ID;

		// Authenticate directly so authStore.init() short-circuits without a fetch,
		// and so the self-member row resolves to a NAME (not a UUID).
		authStore.status = "authenticated";
		authStore.accessToken = "test-token";
		authStore.user = {
			id: SELF_USER_ID,
			email: "self@example.com",
			name: "Self Translator",
			role: "admin",
			isActive: true,
		};

		// Seed the usage dashboard the page reads (sidebar normally owns polling).
		usageStore.dashboard = dashboard();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		usageStore.__resetForTesting();
		workspacesStore.__resetForTesting();
		authStore.__resetForTesting();
		window.localStorage.clear();
		vi.clearAllMocks();
	});

	it("shows the monthly AI meter as credits with a credit label and no ฿", async () => {
		render(UsagePage);

		// Hero monthly meter: 0.18฿→2 credits used, 63฿→700 limit.
		await waitFor(() => {
			expect(screen.getByText("/ 700 credits")).toBeTruthy();
		});

		// The committed-credit number (2) is rendered by the CreditAmount atom.
		expect(screen.getAllByText("2").length).toBeGreaterThan(0);

		// No baht symbol anywhere on the AI-credit surfaces.
		const heroLabel = screen.getByText("AI credits (month)");
		const heroBar = heroLabel.closest(".hero-bar") as HTMLElement;
		expect(heroBar.textContent ?? "").not.toContain("฿");
	});

	it("shows the daily/month/reserved/remaining aggregate cells in credits, never ฿", async () => {
		render(UsagePage);

		await waitFor(() => {
			expect(screen.getByText("Today")).toBeTruthy();
		});

		const today = screen.getByText("Today").closest(".agg-cell") as HTMLElement;
		const month = screen.getByText("This month").closest(".agg-cell") as HTMLElement;
		const reserved = screen.getByText("Reserved").closest(".agg-cell") as HTMLElement;
		const remaining = screen.getByText("Remaining in period").closest(".agg-cell") as HTMLElement;

		for (const cell of [today, month, reserved, remaining]) {
			expect(cell.textContent ?? "").not.toContain("฿");
			// Each carries the i18n credit unit label (เครดิต / "credits") from CreditAmount.
			expect(/เครดิต|credits/.test(cell.textContent ?? "")).toBe(true);
		}
		// 0.09฿ → 1 credit (today committed + reserved).
		expect(within(today).getByText("1")).toBeTruthy();
		expect(within(reserved).getByText("1")).toBeTruthy();
	});

	it("renders the member-table AI column in credits and resolves the self userId to a name", async () => {
		render(UsagePage);

		// Member rows present.
		await waitFor(() => {
			expect(screen.getByText("Whole workspace")).toBeTruthy();
		});

		const table = screen.getByRole("table");
		const tableText = table.textContent ?? "";
		// No baht in the whole usage table.
		expect(tableText).not.toContain("฿");

		// The other member's raw UUID must NOT be rendered verbatim; the short id
		// (first 8 chars + ellipsis) stands in for an un-named member.
		expect(screen.queryByText(OTHER_USER_ID)).toBeNull();
		expect(screen.getByText(`${OTHER_USER_ID.slice(0, 8)}…`)).toBeTruthy();
	});

	it("resolves the signed-in member's row to their display name, not their UUID", async () => {
		// Add the self user to the breakdown so the page must resolve self → name.
		// The poll re-fetches the dashboard, so override what the endpoint serves
		// (not just the seeded store) to keep the self-member row stable.
		const withSelf: UsageDashboard = {
			...dashboard(),
			members: {
				count: 1,
				breakdown: [
					{ userId: SELF_USER_ID, role: "owner", disabled: false, aiCommittedThb: 0.18, uploadBytes: 0, exportBytes: 0 },
				],
				unattributed: { aiCommittedThb: 0, uploadBytes: 0, exportBytes: 0 },
			},
		};
		servedDashboard = () => withSelf;
		usageStore.dashboard = withSelf;

		render(UsagePage);

		await waitFor(() => {
			expect(screen.getByText("Self Translator")).toBeTruthy();
		});
		expect(screen.queryByText(SELF_USER_ID)).toBeNull();
	});
});
