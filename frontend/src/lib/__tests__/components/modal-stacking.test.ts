// Integration guard for the modal focus/stacking bug.
//
// Both SearchModal ("/") and ShortcutsHelp ("?") listen for a BARE-key
// accelerator on the window. Before the shared modal guard, "/" would open the
// search dialog *behind* an already-open ShortcutsHelp (and vice versa),
// producing two stacked aria-modal dialogs and moving focus to the hidden
// search input. These tests mount both at once and assert only ONE aria-modal
// dialog is ever on screen, that Escape closes the top one, and that the other
// opener works again afterwards.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import SearchModal from "$lib/components/SearchModal.svelte";
import ShortcutsHelp from "$lib/components/ShortcutsHelp.svelte";
import type { SearchResult } from "$lib/search/search-index.ts";
import { searchStore } from "$lib/stores/search.svelte.ts";
import { shortcutsHelpStore } from "$lib/stores/shortcuts-help.svelte.ts";

afterEach(() => {
	searchStore.closeSearch();
	shortcutsHelpStore.closeHelp();
});

function makeResults(): SearchResult[] {
	return [
		{
			id: "chapter:p1",
			kind: "chapter",
			title: "Naruto — Ninja",
			subtitle: "EN · 20p",
			badge: "Chapter",
			targetId: "p1",
			keywords: ["naruto"],
		},
	];
}

function renderBoth() {
	render(SearchModal, { props: { buildResults: makeResults, onNavigate: vi.fn() } });
	render(ShortcutsHelp);
}

const openDialogs = () =>
	Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));

describe("modal stacking guard", () => {
	it("pressing '?' while SearchModal is open does NOT stack a second dialog", async () => {
		renderBoth();
		await fireEvent.keyDown(window, { key: "/" });
		await screen.findByRole("dialog");
		expect(openDialogs()).toHaveLength(1);

		await fireEvent.keyDown(window, { key: "?" });

		// Still exactly one aria-modal dialog — the search one — and help stayed shut.
		expect(openDialogs()).toHaveLength(1);
		expect(searchStore.open).toBe(true);
		expect(shortcutsHelpStore.open).toBe(false);
	});

	it("pressing '/' while ShortcutsHelp is open does NOT open search behind it", async () => {
		renderBoth();
		await fireEvent.keyDown(window, { key: "?" });
		await screen.findByRole("dialog");
		expect(openDialogs()).toHaveLength(1);

		await fireEvent.keyDown(window, { key: "/" });

		expect(openDialogs()).toHaveLength(1);
		expect(shortcutsHelpStore.open).toBe(true);
		expect(searchStore.open).toBe(false);
	});

	it("Escape closes the top modal, then the other opener works again", async () => {
		renderBoth();

		// Open help, confirm "/" is blocked.
		await fireEvent.keyDown(window, { key: "?" });
		const help = await screen.findByRole("dialog");
		await fireEvent.keyDown(window, { key: "/" });
		expect(searchStore.open).toBe(false);

		// Escape closes help.
		await fireEvent.keyDown(help, { key: "Escape" });
		await waitFor(() => {
			expect(shortcutsHelpStore.open).toBe(false);
		});
		await waitFor(() => {
			expect(openDialogs()).toHaveLength(0);
		});

		// Now "/" opens search (nothing else is up).
		await fireEvent.keyDown(window, { key: "/" });
		await waitFor(() => {
			expect(searchStore.open).toBe(true);
		});
		expect(openDialogs()).toHaveLength(1);
	});
});
