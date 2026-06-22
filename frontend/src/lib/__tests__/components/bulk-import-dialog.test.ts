import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import BulkImportDialog from "$lib/components/BulkImportDialog.svelte";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import "$lib/i18n";

// The bulk-import modal previously did initial-focus + Escape + restore by hand
// but had NO Tab focus-trap, so keyboard users could tab out behind the blocking
// dialog. It now delegates to the shared `dialogFocus` action; these tests pin
// the trap + Escape + restore behavior that action provides.

afterEach(() => {
	editorUiStore.closeBulkImport();
	vi.restoreAllMocks();
});

describe("BulkImportDialog focus management", () => {
	it("moves initial focus inside the dialog when opened", async () => {
		editorUiStore.openBulkImport();
		render(BulkImportDialog);

		const dialog = await screen.findByRole("dialog", { name: "Import รูปแบบรวม" });
		await waitFor(() => {
			expect(dialog.contains(document.activeElement)).toBe(true);
		});
	});

	it("traps Tab inside the dialog (focus cannot escape to the background)", async () => {
		const background = document.createElement("button");
		background.type = "button";
		background.textContent = "Background";
		document.body.append(background);

		editorUiStore.openBulkImport();
		render(BulkImportDialog);

		const dialog = await screen.findByRole("dialog", { name: "Import รูปแบบรวม" });
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

		// Even after focus is yanked to a background control, the focusin guard
		// pulls it back inside the dialog.
		background.focus();
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

		// Wrapping Tab from the last control returns to the first — focus stays in.
		await fireEvent.keyDown(document, { key: "Tab" });
		expect(dialog.contains(document.activeElement)).toBe(true);

		background.remove();
	});

	it("makes background siblings inert while open", async () => {
		const background = document.createElement("button");
		background.type = "button";
		document.body.append(background);

		editorUiStore.openBulkImport();
		render(BulkImportDialog);

		await screen.findByRole("dialog", { name: "Import รูปแบบรวม" });
		await waitFor(() => expect(background.inert).toBe(true));
		expect(background.getAttribute("aria-hidden")).toBe("true");

		background.remove();
	});

	it("closes on Escape and restores focus to the opener", async () => {
		const opener = document.createElement("button");
		opener.type = "button";
		opener.textContent = "Opener";
		document.body.append(opener);
		opener.focus();

		editorUiStore.openBulkImport();
		render(BulkImportDialog);

		const dialog = await screen.findByRole("dialog", { name: "Import รูปแบบรวม" });
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

		await fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() => expect(editorUiStore.bulkImportOpen).toBe(false));
		await waitFor(() => expect(document.activeElement).toBe(opener));

		opener.remove();
	});
});
