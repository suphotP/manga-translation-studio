import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import CountDotGroup from "$lib/components/ui/CountDotGroup.svelte";

describe("CountDotGroup", () => {
	it("renders the items with correct values and titles", () => {
		render(CountDotGroup, {
			items: [
				{ label: "งานเปิด", value: 5, tone: "violet" },
				{ label: "รอรีวิว", value: 2, tone: "amber" },
				{ label: "คอมเมนต์", value: 0, tone: "cyan" },
			]
		});

		// Check if the values are rendered
		expect(screen.getByText("5")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy();
		expect(screen.getByText("0")).toBeTruthy();

		// Check if titles (tooltips) are present
		expect(screen.getByTitle("งานเปิด")).toBeTruthy();
		expect(screen.getByTitle("รอรีวิว")).toBeTruthy();
		expect(screen.getByTitle("คอมเมนต์")).toBeTruthy();
	});

	it("applies correct text and dot styling classes based on basic tones", () => {
		const { container } = render(CountDotGroup, {
			items: [
				{ label: "งานเปิด", value: 5, tone: "violet" },
			]
		});

		const span = screen.getByTitle("งานเปิด");
		expect(span.className).toContain("text-ws-violet");

		const dot = container.querySelector(".ws-dot");
		expect(dot).toBeTruthy();
		expect(dot?.className).toContain("bg-ws-violet");
	});

	it("handles custom tailwind tones gracefully", () => {
		const { container } = render(CountDotGroup, {
			items: [
				{ label: "ด่วน", value: 3, tone: "bg-white" },
			]
		});

		const dot = container.querySelector(".ws-dot");
		expect(dot).toBeTruthy();
		expect(dot?.className).toContain("bg-white");
	});
});
