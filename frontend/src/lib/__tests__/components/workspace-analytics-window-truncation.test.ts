import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
// Register the locale dictionaries so the component's `$_(...)` keys resolve to
// real strings (test-setup.ts pins the active locale to Thai for the run).
import "$lib/i18n";
import WorkspaceAnalytics from "$lib/components/WorkspaceAnalytics.svelte";
import { perfAnalyticsStore } from "$lib/stores/perf-analytics.svelte.ts";
import { usageStore } from "$lib/stores/usage.svelte.ts";
import type { PerfWorkspaceAggregate } from "$lib/api/client.ts";

// The team-performance panel surfaces a notice ONLY when the backend reports
// that the window scan was capped (windowTruncated). Without it, a recent-only
// slice would be presented as a complete-period figure — the P2 this guards.

function aggregate(overrides: Partial<PerfWorkspaceAggregate> = {}): PerfWorkspaceAggregate {
	return {
		workspaceId: "ws-1",
		periodStart: "2026-05-07T00:00:00.000Z",
		memberCount: 3,
		medianComposite: 62,
		dimensionMedians: { throughput: 70, quality: 65, consistency: 60, ai_leverage: 50, collaboration: 68 },
		roi: { tmHits: 5, aiCaughtIssues: 2, timeSavedMinutes: 60, timeSavedHours: 1, moneySavedUsd: 20, hourlyRateUsd: 20 },
		computedAt: "2026-06-03T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	usageStore.reset();
	perfAnalyticsStore.reset();
});

afterEach(() => {
	perfAnalyticsStore.reset();
});

describe("WorkspaceAnalytics window-truncation notice", () => {
	it("renders the localized recent-only notice (with the cap count) when windowTruncated", () => {
		perfAnalyticsStore.aggregate = aggregate({ windowTruncated: true, windowEventLimit: 50000 });

		render(WorkspaceAnalytics, { props: { pipelineStages: [], hasProject: false } });

		// Thai notice prefix + the interpolated {n} cap (locale-formatted).
		const notice = screen.getByText(/แสดงจากเหตุการณ์ล่าสุด/);
		expect(notice).toBeTruthy();
		// {n} must be interpolated, not left as the literal token.
		expect(notice.textContent).not.toContain("{n}");
		expect(notice.textContent ?? "").toMatch(/50[,.]?000/);
	});

	it("does NOT render the notice for a complete (non-truncated) window", () => {
		perfAnalyticsStore.aggregate = aggregate({ windowTruncated: false });

		render(WorkspaceAnalytics, { props: { pipelineStages: [], hasProject: false } });

		expect(screen.queryByText(/แสดงจากเหตุการณ์ล่าสุด/)).toBeNull();
	});

	it("does NOT render the notice when there is no performance data at all", () => {
		// memberCount 0 ⇒ honest empty state; no truncation notice attaches to it.
		perfAnalyticsStore.aggregate = aggregate({ memberCount: 0, windowTruncated: true, windowEventLimit: 50000 });

		render(WorkspaceAnalytics, { props: { pipelineStages: [], hasProject: false } });

		expect(screen.queryByText(/แสดงจากเหตุการณ์ล่าสุด/)).toBeNull();
	});
});
