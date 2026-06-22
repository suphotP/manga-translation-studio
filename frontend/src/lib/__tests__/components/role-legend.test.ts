import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import RoleLegend from "$lib/components/ui/RoleLegend.svelte";

describe("RoleLegend", () => {
	it("renders all the passed role badges", () => {
		render(RoleLegend, {
			roles: ["clean", "translate", "qc"],
		});

		// RoleBadge translates these internally to:
		// clean -> คลีน
		// translate -> แปล
		// qc -> QC
		expect(screen.getByText("คลีน")).toBeTruthy();
		expect(screen.getByText("แปล")).toBeTruthy();
		expect(screen.getByText("QC")).toBeTruthy();
	});

	it("passes state prop to the child badges", () => {
		const { container } = render(RoleLegend, {
			roles: ["qc"],
			state: "done",
		});

		const badge = screen.getByText("QC");
		// If RoleBadge state is "done", it should have "border-ws-green/20" class or similar for done state
		expect(badge.className).toContain("border-ws-green");
	});
});
