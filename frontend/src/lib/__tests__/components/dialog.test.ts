import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import "$lib/i18n";
import DialogHarness from "./fixtures/DialogHarness.svelte";
import NestedDialogHarness from "./fixtures/NestedDialogHarness.svelte";

describe("Dialog atom", () => {
	it("exposes an aria-modal dialog labelled by its title and described by its copy", () => {
		render(DialogHarness, { open: true });

		const dialog = screen.getByRole("dialog", { name: "Harness Dialog" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		const labelledById = dialog.getAttribute("aria-labelledby");
		const describedById = dialog.getAttribute("aria-describedby");
		expect(labelledById && document.getElementById(labelledById)?.textContent).toBe("Harness Dialog");
		expect(describedById && document.getElementById(describedById)?.textContent).toBe("Test dialog body");
	});

	it("describes a custom-header dialog by caller copy via ariaDescribedby", () => {
		render(DialogHarness, { open: true, customHeader: true });

		const dialog = screen.getByRole("alertdialog", { name: "Custom Header Dialog" });
		const describedById = dialog.getAttribute("aria-describedby");
		expect(describedById && document.getElementById(describedById)?.textContent).toBe("Custom safety copy");
	});

	it("moves initial focus to the first control and traps Tab/Shift+Tab inside", async () => {
		render(DialogHarness, { open: true });

		const dialog = screen.getByRole("dialog", { name: "Harness Dialog" });
		const firstInput = screen.getByTestId("first-input");
		// The close button renders last in DOM order so it sits at the end of the
		// tab cycle, leaving initial focus on the first body control.
		const closeButton = screen.getByRole("button", { name: "ปิดหน้าต่าง" });

		await waitFor(() => expect(document.activeElement).toBe(firstInput));

		// Tab forward from the last control wraps to the first.
		closeButton.focus();
		await fireEvent.keyDown(document, { key: "Tab" });
		expect(document.activeElement).toBe(firstInput);

		// Shift+Tab from the first control wraps to the last.
		await fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(closeButton);

		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("pulls focus back inside when it escapes to a background element", async () => {
		const background = document.createElement("button");
		background.type = "button";
		background.textContent = "Background";
		document.body.append(background);
		render(DialogHarness, { open: true });

		const firstInput = screen.getByTestId("first-input");
		await waitFor(() => expect(document.activeElement).toBe(firstInput));

		background.focus();
		await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));
		background.remove();
	});

	it("makes background siblings inert and aria-hidden, then restores them on close", async () => {
		const background = document.createElement("button");
		background.type = "button";
		background.textContent = "Background";
		document.body.append(background);

		const { unmount } = render(DialogHarness, { open: true });
		await waitFor(() => expect(background.inert).toBe(true));
		expect(background.getAttribute("aria-hidden")).toBe("true");

		unmount();
		await waitFor(() => expect(background.inert).toBe(false));
		expect(background.getAttribute("aria-hidden")).toBeNull();
		background.remove();
	});

	it("closes on Escape and via the close button when dismissible", async () => {
		const onClose = vi.fn();
		render(DialogHarness, { open: true, onClose });

		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("first-input")));
		await fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);

		await fireEvent.click(screen.getByRole("button", { name: "ปิดหน้าต่าง" }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("does not dismiss on Escape while busy", async () => {
		const onClose = vi.fn();
		render(DialogHarness, { open: true, busy: true, onClose });

		await fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
	});

	it("hides the close button and ignores Escape when not dismissible", async () => {
		const onClose = vi.fn();
		render(DialogHarness, { open: true, dismissible: false, onClose });

		expect(screen.queryByRole("button", { name: "ปิดหน้าต่าง" })).toBeNull();
		await fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
	});

	it("blocks clicks on background elements while open", async () => {
		const backgroundAction = vi.fn();
		const background = document.createElement("button");
		background.type = "button";
		background.textContent = "Background";
		background.addEventListener("click", backgroundAction);
		document.body.append(background);

		render(DialogHarness, { open: true });
		await waitFor(() => expect(background.inert).toBe(true));

		await fireEvent.click(background);
		expect(backgroundAction).not.toHaveBeenCalled();
		background.remove();
	});

	it("a click on a dialog STACKED ABOVE another dialog reaches its own controls (nested-dialog regression)", async () => {
		// Repro: a confirmation Dialog opened inside a panel Dialog (e.g.
		// CancelReviewDialog inside AssignReviewPanel). The outer dialog installs a
		// capture-phase background-click guard; before the fix it swallowed clicks on
		// the INNER dialog's confirm button (target outside the outer layer), so the
		// nested confirm action never fired.
		const onConfirm = vi.fn();
		render(NestedDialogHarness, { onConfirm });

		// Open the nested confirmation from inside the outer panel.
		await fireEvent.click(screen.getByTestId("open-inner"));
		const innerConfirm = await screen.findByTestId("inner-confirm");

		// Clicking the inner dialog's own button MUST fire its handler.
		await fireEvent.click(innerConfirm);
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});
});
