import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ShortcutsHelp from "$lib/components/ShortcutsHelp.svelte";
import { shortcutsHelpStore } from "$lib/stores/shortcuts-help.svelte.ts";
import { commandPaletteStore } from "$lib/stores/command-palette.svelte.ts";

afterEach(() => {
	shortcutsHelpStore.closeHelp();
});

async function pressQuestion(): Promise<void> {
	await fireEvent.keyDown(window, { key: "?" });
}

describe("ShortcutsHelp", () => {
	it("opens on '?', lists real grouped shortcuts, and closes on Escape", async () => {
		render(ShortcutsHelp);

		expect(screen.queryByRole("dialog")).toBeNull();

		await pressQuestion();

		const dialog = await screen.findByRole("dialog", { name: /คีย์ลัด|keyboard shortcuts/i });
		expect(dialog).toBeTruthy();

		// Real shortcuts are present: the "/" search (Focus mode's J/K were removed
		// with the Focus surface).
		expect(screen.getByText("/")).toBeTruthy();
		expect(screen.getByText("เคลียร์บอลลูน")).toBeTruthy();
		expect(screen.getByText(/คลิกในบอลลูน/)).toBeTruthy();
		// Group headings are rendered (general + tools + canvas + saving).
		expect(screen.getAllByRole("heading").length).toBeGreaterThanOrEqual(4);

		await fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("does NOT open on '?' while typing in a field", async () => {
		render(ShortcutsHelp);
		const field = document.createElement("textarea");
		document.body.appendChild(field);
		field.focus();

		await fireEvent.keyDown(field, { key: "?" });

		expect(screen.queryByRole("dialog")).toBeNull();
		field.remove();
	});

	it("opens when the shared store is opened (e.g. the palette action)", async () => {
		render(ShortcutsHelp);
		expect(screen.queryByRole("dialog")).toBeNull();

		// Simulate the command palette's openShortcutsHelp action.
		shortcutsHelpStore.openHelp();

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toBeTruthy();
	});

	it("closes via the close button", async () => {
		render(ShortcutsHelp);
		await pressQuestion();
		await screen.findByRole("dialog");

		const closeBtn = screen.getByRole("button", { name: /ปิด|close/i });
		await fireEvent.click(closeBtn);

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("the command palette is unaffected by the help store", async () => {
		// Guard: opening help does not open the palette (separate stores).
		shortcutsHelpStore.openHelp();
		expect(commandPaletteStore.open).toBe(false);
		shortcutsHelpStore.closeHelp();
	});

	it("does NOT open on '?' while another aria-modal dialog is already open", async () => {
		render(ShortcutsHelp);

		// Stand in for an already-open app modal (e.g. SearchModal / palette).
		const other = document.createElement("div");
		other.setAttribute("role", "dialog");
		other.setAttribute("aria-modal", "true");
		document.body.appendChild(other);

		await pressQuestion();

		// Only the pre-existing modal exists; help never stacked behind it.
		const dialogs = screen.getAllByRole("dialog");
		expect(dialogs).toHaveLength(1);
		expect(dialogs[0]).toBe(other);
		expect(shortcutsHelpStore.open).toBe(false);

		other.remove();
	});
});
