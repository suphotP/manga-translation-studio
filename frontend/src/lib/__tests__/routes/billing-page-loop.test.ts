// Regression guard for the P0 reactive request-loop self-DoS on
// /settings/billing (fixed in "Fix P0: /settings/billing reactive request-loop").
//
// The bug: the page's $effect read wsId (= billingStore.currentWorkspaceId) and
// called loaders that WROTE store state (loadSubscription → setCurrentWorkspaceId,
// plus subscription/invoices/usage state the page reads), so the effect re-ran
// after every load → an unbounded loop firing /billing/:ws, /usage/.../dashboard
// and /invoices 200-400× in ~3s, 429-storming the backend.
//
// These tests render the real page against a mocked fetch and assert each
// per-workspace endpoint fires a SMALL CONSTANT number of times (not 200+), and
// that a runtime workspace-id change reloads each endpoint exactly once more.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { _ } from "svelte-i18n";
import { setLocale } from "$lib/i18n/index.ts";
import BillingPage from "../../../routes/settings/billing/+page.svelte";
import { billingStore } from "$lib/stores/billing.svelte.ts";
import { usageStore } from "$lib/stores/usage.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";

const WS_A = "ws-aaaa-1111";
const WS_B = "ws-bbbb-2222";

const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();

// Count requests per logical endpoint so the test asserts on the loop directly.
const counts = { subscription: 0, invoices: 0, usage: 0, catalog: 0 };

function classify(url: string): keyof typeof counts | null {
	if (url.includes("/usage/workspace/") && url.includes("/dashboard")) return "usage";
	if (url.includes("/billing/plans")) return "catalog";
	if (url.includes("/billing/") && url.endsWith("/invoices")) return "invoices";
	if (url.includes("/billing/")) return "subscription";
	return null;
}

// A Dodo-backed (active) subscription so loadInvoices proceeds to the real
// /invoices request rather than short-circuiting to portal_only.
function subscriptionBody(workspaceId: string) {
	return {
		workspaceId,
		planId: "studio",
		plan: { id: "studio", name: "Studio" },
		assignment: { status: "active", currentPeriodEnd: "2026-07-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
		grants: [],
	};
}

function usageBody(workspaceId: string) {
	return {
		dashboard: {
			workspaceId,
			scope: "filesystem",
			enforced: true,
			plan: { id: "studio", name: "Studio", monthlyAiCredits: 700, includedStorageBytes: 0, maxSeatsIncluded: 5 },
			projectIds: [],
			projectCount: 0,
			totals: {
				daily: { periodKey: "2026-06-04", aiCapturedThb: 0, aiActiveReservedThb: 0, aiCommittedThb: 0, uploadBytes: 0, exportBytes: 0, moderationImages: 0, limits: { aiCreditThb: 595, uploadBytes: 0, exportBytes: 0 }, remaining: { aiCreditThb: 595, uploadBytes: null, exportBytes: null } },
				monthly: { periodKey: "2026-06", aiCapturedThb: 0, aiActiveReservedThb: 0, aiCommittedThb: 0, uploadBytes: 0, exportBytes: 0, moderationImages: 0, limits: { aiCreditThb: 595, uploadBytes: 0, exportBytes: 0 }, remaining: { aiCreditThb: 595, uploadBytes: null, exportBytes: null } },
				eventCount: 0,
			},
			storage: { usedBytes: 0, originalBytes: 0, derivativeBytes: 0, exportArtifactBytes: 0, reservedBytes: 0, projectedBytes: 0, limitBytes: 1073741824, includedBytes: 1073741824, extraBytes: 0, remainingBytes: 1073741824, percentUsed: 0, enforced: true },
			egress: { windowMs: 3600000, totalRequests: 0, totalBytes: 0, limitBytes: 0, remainingBytes: 0, enforced: false, perProjectEnforced: false, projects: [] },
			memberAttribution: "unattributed",
			members: { count: 1, breakdown: [], unattributed: { aiCommittedThb: 0, uploadBytes: 0, exportBytes: 0 } },
		},
	};
}

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("settings/billing — no reactive request loop (P0)", () => {
	beforeAll(async () => {
		setLocale("en");
		await waitFor(() => {
			expect(get(_)("billing.heading")).toBe("Billing");
		});
	});

	beforeEach(() => {
		counts.subscription = 0;
		counts.invoices = 0;
		counts.usage = 0;
		counts.catalog = 0;

		globalThis.fetch = mockFetch;
		mockFetch.mockReset();
		mockFetch.mockImplementation((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
			const kind = classify(url);
			if (kind) counts[kind] += 1;
			// Pull the workspace id out of /billing/:ws or /usage/workspace/:ws/...
			const wsMatch = url.match(/\/billing\/([^/?]+)/) ?? url.match(/\/usage\/workspace\/([^/?]+)/);
			const ws = wsMatch ? decodeURIComponent(wsMatch[1]) : WS_A;
			if (kind === "usage") return Promise.resolve(ok(usageBody(ws)));
			if (kind === "subscription") return Promise.resolve(ok(subscriptionBody(ws)));
			if (kind === "invoices") return Promise.resolve(ok({ invoices: [], availability: "portal_only" }));
			if (kind === "catalog") return Promise.resolve(ok({ plans: [] }));
			return Promise.resolve(ok({}));
		});

		window.localStorage.setItem("manga-editor.currentWorkspaceId", WS_A);
		billingStore.currentWorkspaceId = WS_A;

		authStore.status = "authenticated";
		authStore.accessToken = "test-token";
		authStore.user = { id: "user-1", email: "a@b.c", name: "Tester", role: "admin", isActive: true };
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		billingStore.__resetForTesting();
		usageStore.__resetForTesting();
		authStore.__resetForTesting();
		window.localStorage.clear();
		vi.clearAllMocks();
	});

	it("loads each per-workspace endpoint a small constant number of times, never a loop", async () => {
		render(BillingPage);

		// Let the onMount auth-init resolve + the guarded effect run + any
		// microtask/macrotask the loaders schedule settle.
		await waitFor(() => {
			expect(counts.subscription).toBeGreaterThan(0);
			expect(counts.usage).toBeGreaterThan(0);
		});
		// Give any (buggy) loop ample time to explode the counts.
		await new Promise((r) => setTimeout(r, 250));

		// The page fires loadSubscription once, loadInvoices once (which may itself
		// ensure-load the subscription once if not yet present), and usage once.
		// Pre-fix this was 200-400. The guard caps it to a small constant; assert a
		// generous-but-tight ceiling that a real loop would blow past instantly.
		expect(counts.subscription).toBeLessThanOrEqual(2);
		expect(counts.invoices).toBeLessThanOrEqual(1);
		expect(counts.usage).toBeLessThanOrEqual(1);
		expect(counts.catalog).toBeLessThanOrEqual(1);
	});

	it("reloads each per-workspace endpoint exactly once on a runtime workspace switch", async () => {
		render(BillingPage);

		await waitFor(() => {
			expect(counts.usage).toBeGreaterThan(0);
		});
		await new Promise((r) => setTimeout(r, 100));

		const before = { ...counts };

		// Simulate the runtime workspace switch the chrome performs.
		billingStore.setCurrentWorkspaceId(WS_B);

		await waitFor(() => {
			expect(counts.usage).toBe(before.usage + 1);
		});
		await new Promise((r) => setTimeout(r, 200));

		// Exactly one more of each, and crucially no runaway loop after the switch.
		expect(counts.usage).toBe(before.usage + 1);
		expect(counts.subscription).toBeLessThanOrEqual(before.subscription + 2);
		expect(counts.invoices).toBe(before.invoices + 1);
	});

	it("does not re-fire loads when an unrelated reactive store value changes", async () => {
		render(BillingPage);

		await waitFor(() => {
			expect(counts.usage).toBeGreaterThan(0);
		});
		await new Promise((r) => setTimeout(r, 100));
		const before = { ...counts };

		// Touch reactive store state the loaders themselves write (this is exactly
		// what used to retrigger the effect). With untrack + the load guard, the
		// effect must NOT re-run loads for the already-loaded workspace.
		billingStore.invoices = [];
		billingStore.subscription = { ...subscriptionBody(WS_A) } as never;
		usageStore.dashboard = usageBody(WS_A).dashboard as never;

		await new Promise((r) => setTimeout(r, 200));

		expect(counts.subscription).toBe(before.subscription);
		expect(counts.invoices).toBe(before.invoices);
		expect(counts.usage).toBe(before.usage);
	});
});
