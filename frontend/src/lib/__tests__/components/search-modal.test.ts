import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import SearchModal from "$lib/components/SearchModal.svelte";
import type { SearchResult } from "$lib/search/search-index.ts";
import { searchStore } from "$lib/stores/search.svelte.ts";

// The modal's visibility lives in a shared singleton store, so each test must
// start from a closed state to stay independent.
afterEach(() => {
	searchStore.closeSearch();
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
			keywords: ["naruto", "ninja"],
		},
		{
			id: "chapter:p2",
			kind: "chapter",
			title: "Bleach — Soul",
			subtitle: "TH",
			badge: "Chapter",
			targetId: "p2",
			keywords: ["bleach", "soul"],
		},
		{
			id: "workspace:w1",
			kind: "workspace",
			title: "Studio B",
			subtitle: "PRO",
			badge: "Workspace",
			targetId: "w1",
			keywords: ["studio"],
		},
	];
}

async function pressSlash(): Promise<void> {
	await fireEvent.keyDown(window, { key: "/" });
}

describe("SearchModal", () => {
	it("opens on '/', shows results, filters, navigates on Enter, and closes", async () => {
		const onNavigate = vi.fn();
		render(SearchModal, { props: { buildResults: makeResults, onNavigate } });

		expect(screen.queryByRole("dialog")).toBeNull();

		await pressSlash();

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toBeTruthy();
		expect(screen.getAllByRole("option")).toHaveLength(3);

		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "bleach" } });

		await waitFor(() => {
			expect(screen.getAllByRole("option")).toHaveLength(1);
		});
		expect(screen.getByRole("option").textContent).toContain("Bleach");

		await fireEvent.keyDown(dialog, { key: "Enter" });

		expect(onNavigate).toHaveBeenCalledTimes(1);
		expect(onNavigate.mock.calls[0][0].targetId).toBe("p2");
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("does NOT open on '/' while typing in an input", async () => {
		render(SearchModal, { props: { buildResults: makeResults, onNavigate: vi.fn() } });
		const field = document.createElement("input");
		document.body.appendChild(field);
		field.focus();

		await fireEvent.keyDown(field, { key: "/" });

		expect(screen.queryByRole("dialog")).toBeNull();
		field.remove();
	});

	it("moves selection with arrow keys and exposes aria-activedescendant", async () => {
		render(SearchModal, { props: { buildResults: makeResults, onNavigate: vi.fn() } });
		await pressSlash();
		const dialog = await screen.findByRole("dialog");
		const input = screen.getByRole("combobox");

		expect(input.getAttribute("aria-activedescendant")).toBe("search-modal-option-0");
		expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");

		await fireEvent.keyDown(dialog, { key: "ArrowDown" });
		await waitFor(() => {
			expect(input.getAttribute("aria-activedescendant")).toBe("search-modal-option-1");
		});
	});

	it("closes on Escape without navigating", async () => {
		const onNavigate = vi.fn();
		render(SearchModal, { props: { buildResults: makeResults, onNavigate } });
		await pressSlash();
		const dialog = await screen.findByRole("dialog");

		await fireEvent.keyDown(dialog, { key: "Escape" });

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
		expect(onNavigate).not.toHaveBeenCalled();
	});

	it("shows an empty state when nothing matches", async () => {
		render(SearchModal, { props: { buildResults: makeResults, onNavigate: vi.fn() } });
		await pressSlash();
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "zzzzz" } });

		await waitFor(() => {
			expect(screen.queryAllByRole("option")).toHaveLength(0);
		});
		expect(screen.getByText(/ไม่พบผลลัพธ์/)).toBeTruthy();
	});

	it("opens when the shared store is opened (e.g. the sidebar search button)", async () => {
		render(SearchModal, { props: { buildResults: makeResults, onNavigate: vi.fn() } });
		expect(screen.queryByRole("dialog")).toBeNull();

		searchStore.openSearch();

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toBeTruthy();
		expect(screen.getAllByRole("option")).toHaveLength(3);
	});

	it("runs a result on row click and exposes no nested interactive control", async () => {
		const onNavigate = vi.fn();
		render(SearchModal, { props: { buildResults: makeResults, onNavigate } });
		await pressSlash();
		await screen.findByRole("dialog");

		const options = screen.getAllByRole("option");
		// The option ROW is the click target — there must be no inner button.
		expect(options[0].querySelector("button")).toBeNull();

		await fireEvent.click(options[1]);

		expect(onNavigate).toHaveBeenCalledTimes(1);
		expect(onNavigate.mock.calls[0][0].targetId).toBe("p2");
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("activates the hovered row (mousemove) and runs it on click", async () => {
		const onNavigate = vi.fn();
		render(SearchModal, { props: { buildResults: makeResults, onNavigate } });
		await pressSlash();
		await screen.findByRole("dialog");
		const input = screen.getByRole("combobox");
		const options = screen.getAllByRole("option");

		await fireEvent.mouseMove(options[2]);
		await waitFor(() => {
			expect(input.getAttribute("aria-activedescendant")).toBe("search-modal-option-2");
		});
		expect(options[2].getAttribute("aria-selected")).toBe("true");

		await fireEvent.click(options[2]);
		expect(onNavigate.mock.calls[0][0].targetId).toBe("w1");
	});

	it("does NOT open on '/' while another aria-modal dialog is already open", async () => {
		render(SearchModal, { props: { buildResults: makeResults, onNavigate: vi.fn() } });

		// Stand in for an already-open app modal (e.g. ShortcutsHelp / palette).
		const other = document.createElement("div");
		other.setAttribute("role", "dialog");
		other.setAttribute("aria-modal", "true");
		document.body.appendChild(other);

		await pressSlash();

		// Only the pre-existing modal exists; search never stacked behind it.
		const dialogs = screen.getAllByRole("dialog");
		expect(dialogs).toHaveLength(1);
		expect(dialogs[0]).toBe(other);
		expect(searchStore.open).toBe(false);

		other.remove();
	});
});
