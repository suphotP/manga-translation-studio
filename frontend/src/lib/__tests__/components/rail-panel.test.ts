import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import RailPanelHarness from "./fixtures/RailPanelHarness.svelte";

describe("RailPanel", () => {
	it("renders title, subtitle, and slot content correctly", () => {
		render(RailPanelHarness, {
			title: "ตัวช่วยจัดการ",
			subtitle: "เมนูจัดการบทและตอน",
			childText: "เนื้อหาในพาเนล",
		});

		expect(screen.getByText("ตัวช่วยจัดการ")).toBeTruthy();
		expect(screen.getByText("เมนูจัดการบทและตอน")).toBeTruthy();
		expect(screen.getByText("เนื้อหาในพาเนล")).toBeTruthy();
	});

	it("applies the panel layout classes properly", () => {
		const { container } = render(RailPanelHarness, {
			title: "Test Panel",
			class: "custom-class",
		});

		const panel = container.firstElementChild as HTMLElement;
		expect(panel).toBeTruthy();
		expect(panel.className).toContain("rounded-ws");
		expect(panel.className).toContain("border");
		expect(panel.className).toContain("bg-ws-surface/80");
		expect(panel.className).toContain("p-4");
		expect(panel.className).toContain("custom-class");
	});
});
