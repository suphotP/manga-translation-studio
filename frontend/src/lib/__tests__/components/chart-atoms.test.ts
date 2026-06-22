import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import Sparkline, { sparklinePoints, sparklineLinePath, sparklineAreaPath } from "$lib/components/ui/Sparkline.svelte";
import BarChart, { barWidthPct } from "$lib/components/ui/BarChart.svelte";
import StatTrend, { trendDirection, trendDeltaPct } from "$lib/components/ui/StatTrend.svelte";

describe("Sparkline geometry", () => {
	it("returns no points for an empty series", () => {
		expect(sparklinePoints([], 100, 40)).toEqual([]);
		expect(sparklineLinePath([])).toBe("");
		expect(sparklineAreaPath([], 40)).toBe("");
	});

	it("maps higher values nearer the top (smaller y) within the padded box", () => {
		const points = sparklinePoints([0, 10], 100, 40, 2);
		expect(points).toHaveLength(2);
		// value 0 (min) sits at the bottom, value 10 (max) at the top.
		expect(points[0]!.y).toBeGreaterThan(points[1]!.y);
		// endpoints span the inner width [pad, width-pad].
		expect(points[0]!.x).toBe(2);
		expect(points[1]!.x).toBe(98);
	});

	it("pins a flat series to the vertical midline (no fake collapse to floor)", () => {
		const points = sparklinePoints([5, 5, 5], 100, 40, 2);
		// midline of inner height (40 - 2*2 = 36): pad + 0.5*36 = 20
		expect(points.every((p) => p.y === 20)).toBe(true);
	});

	it("builds a closed area path from line points", () => {
		const points = sparklinePoints([1, 2, 3], 100, 40, 2);
		const area = sparklineAreaPath(points, 40, 2);
		expect(area.startsWith("M")).toBe(true);
		expect(area.endsWith("Z")).toBe(true);
	});
});

describe("Sparkline rendering", () => {
	it("renders an honest empty label when fewer than two points", () => {
		render(Sparkline, { values: [5], emptyLabel: "ไม่มีข้อมูล" });
		expect(screen.getByText("ไม่มีข้อมูล")).toBeTruthy();
		expect(document.querySelector("svg")).toBeNull();
	});

	it("renders an svg path for a real series of two or more points", () => {
		render(Sparkline, { values: [1, 4, 2, 6], ariaLabel: "trend" });
		const svg = document.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("aria-label")).toBe("trend");
		expect(document.querySelectorAll("path").length).toBeGreaterThan(0);
	});
});

describe("BarChart", () => {
	it("computes width as a percent of the max, clamped and zero-safe", () => {
		expect(barWidthPct(5, 10)).toBe(50);
		expect(barWidthPct(10, 10)).toBe(100);
		expect(barWidthPct(20, 10)).toBe(100);
		expect(barWidthPct(-1, 10)).toBe(0);
		expect(barWidthPct(5, 0)).toBe(0);
		expect(barWidthPct(5, Number.NaN)).toBe(0);
	});

	it("renders an empty state with no rows", () => {
		render(BarChart, { rows: [], emptyLabel: "ยังไม่มีข้อมูล" });
		expect(screen.getByText("ยังไม่มีข้อมูล")).toBeTruthy();
	});

	it("renders one labelled bar per real row", () => {
		render(BarChart, { rows: [
			{ id: "a", label: "คลีน", value: 3, valueLabel: "3/5" },
			{ id: "b", label: "แปล", value: 1, valueLabel: "1/2" },
		] });
		expect(screen.getByText("คลีน")).toBeTruthy();
		expect(screen.getByText("แปล")).toBeTruthy();
		expect(screen.getByText("3/5")).toBeTruthy();
	});
});

describe("StatTrend math", () => {
	it("derives direction from the two real values", () => {
		expect(trendDirection(10, 5)).toBe("up");
		expect(trendDirection(3, 8)).toBe("down");
		expect(trendDirection(4, 4)).toBe("flat");
		// No baseline ⇒ no trend claim.
		expect(trendDirection(4, null)).toBe("flat");
		expect(trendDirection(4, undefined)).toBe("flat");
	});

	it("returns null delta percent when there is no usable baseline (avoids fake ∞%)", () => {
		expect(trendDeltaPct(10, 0)).toBeNull();
		expect(trendDeltaPct(10, null)).toBeNull();
		expect(trendDeltaPct(15, 10)).toBe(50);
		expect(trendDeltaPct(5, 10)).toBe(-50);
	});

	it("renders the headline value and a delta chip only when previous is given", () => {
		const { unmount } = render(StatTrend, { label: "AI", value: 15, previous: 10, prefix: "฿" });
		expect(screen.getByText("AI")).toBeTruthy();
		expect(screen.getByText("50%")).toBeTruthy();
		unmount();

		render(StatTrend, { label: "Solo", value: 7 });
		expect(screen.getByText("Solo")).toBeTruthy();
		expect(screen.queryByLabelText("แนวโน้ม")).toBeNull();
	});
});
