import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import "$lib/i18n";
import LanguagePicker from "$lib/components/ui/LanguagePicker.svelte";

// LanguagePicker is an inline combobox/listbox (NOT a modal), so it must follow
// the WAI-ARIA combobox + aria-activedescendant pattern: focus stays on the
// search input while up/down move a virtual "active" option that is announced via
// aria-activedescendant. Previously the active option had no id and the input had
// no aria-activedescendant, so screen readers never heard the highlighted row.

async function openList(): Promise<HTMLInputElement> {
	await fireEvent.click(screen.getByRole("button"));
	return (await screen.findByRole("combobox")) as HTMLInputElement;
}

describe("LanguagePicker combobox a11y", () => {
	it("exposes aria-activedescendant pointing at the highlighted option", async () => {
		render(LanguagePicker, { props: { value: "th", onChange: vi.fn(), ariaLabel: "ภาษาเป้าหมาย" } });

		const input = await openList();

		// On open the first option is active and announced.
		const active = input.getAttribute("aria-activedescendant");
		expect(active).toBeTruthy();
		const firstOption = screen.getAllByRole("option")[0];
		expect(firstOption.id).toBe(active);
		expect(input.getAttribute("aria-controls")).toBe(firstOption.closest("ul")?.id);
	});

	it("moves the active option with ArrowDown/ArrowUp and announces it", async () => {
		render(LanguagePicker, { props: { value: "th", onChange: vi.fn(), ariaLabel: "ภาษาเป้าหมาย" } });

		const input = await openList();
		const initial = input.getAttribute("aria-activedescendant");

		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await waitFor(() => {
			expect(input.getAttribute("aria-activedescendant")).not.toBe(initial);
		});
		const afterDown = input.getAttribute("aria-activedescendant");
		// The announced id must match a rendered option element.
		expect(screen.getAllByRole("option").some((option) => option.id === afterDown)).toBe(true);

		await fireEvent.keyDown(input, { key: "ArrowUp" });
		await waitFor(() => {
			expect(input.getAttribute("aria-activedescendant")).toBe(initial);
		});
	});

	it("selects the active option with Enter (keyboard activation)", async () => {
		const onChange = vi.fn();
		render(LanguagePicker, { props: { value: "th", onChange, ariaLabel: "ภาษาเป้าหมาย" } });

		const input = await openList();
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await fireEvent.keyDown(input, { key: "Enter" });

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0]).toBeTruthy();
	});

	it("still selects on mouse click without breaking", async () => {
		const onChange = vi.fn();
		render(LanguagePicker, { props: { value: "th", onChange, ariaLabel: "ภาษาเป้าหมาย" } });

		await openList();
		const englishOption = screen
			.getAllByRole("option")
			.find((option) => option.textContent?.includes("English"));
		expect(englishOption).toBeTruthy();
		await fireEvent.click(englishOption as HTMLElement);

		expect(onChange).toHaveBeenCalledWith("en");
	});

	it("announces the custom-code row via aria-activedescendant when typed", async () => {
		render(LanguagePicker, { props: { value: "th", onChange: vi.fn(), ariaLabel: "ภาษาเป้าหมาย" } });

		const input = await openList();
		// A code not in the curated list yields a single custom "use this code" row.
		await fireEvent.input(input, { target: { value: "xx-Custom" } });

		await waitFor(() => {
			const options = screen.getAllByRole("option");
			expect(options).toHaveLength(1);
			// The custom row is active and its id is announced on the input.
			expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
		});
	});
});
