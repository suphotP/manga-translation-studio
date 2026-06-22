import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import ScopeToggle from "$lib/components/ScopeToggle.svelte";

describe("ScopeToggle", () => {
	it("renders page/all state and delegates scope changes", async () => {
		const onChange = vi.fn();

		render(ScopeToggle, {
			props: {
				label: "Feed scope",
				value: "page",
				onChange,
			},
		});

		expect(screen.getByRole("group", { name: "Feed scope" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "หน้า" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "ทั้งหมด" }).getAttribute("aria-pressed")).toBe("false");

		await fireEvent.click(screen.getByRole("button", { name: "ทั้งหมด" }));

		expect(onChange).toHaveBeenCalledWith("all");
	});

	it("supports custom labels and passive unavailable state", () => {
		render(ScopeToggle, {
			props: {
				label: "Custom scope",
				value: "all",
				pageLabel: "Current",
				allLabel: "Chapter",
				disabled: true,
				onChange: vi.fn(),
			},
		});

		const group = screen.getByRole("group", { name: "Custom scope" });

		expect(screen.queryByRole("button", { name: "Current" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Chapter" })).toBeNull();
		expect(group.textContent).toContain("Current");
		expect(group.textContent).toContain("Chapter");
		expect(group.querySelector(".scope-toggle-receipt.active")?.textContent?.trim()).toBe("Chapter");
	});
});
