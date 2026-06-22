import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import DialogFocusHarness from "./fixtures/DialogFocusHarness.svelte";

// Behavior contract for the headless `dialogFocus` action (Dialog.svelte) that
// the bespoke save-conflict / pricing / SSO / story-settings / coupon modals use
// to gain focus-trap + Escape + restore + background-inert without changing their
// own markup/styling.
describe("dialogFocus action", () => {
	it("moves initial focus to the first control on open", async () => {
		render(DialogFocusHarness, { open: true });
		const firstInput = screen.getByTestId("first-input");
		await waitFor(() => expect(document.activeElement).toBe(firstInput));
	});

	it("does not move initial focus when autoFocus is false", async () => {
		const outside = document.createElement("button");
		outside.type = "button";
		document.body.append(outside);
		outside.focus();

		render(DialogFocusHarness, { open: true, autoFocus: false });
		// Focus is NOT yanked to the first control on open; the caller owns it.
		// (Tab-trap + focus-recovery for genuinely-escaped focus is covered below.)
		await Promise.resolve();
		expect(document.activeElement).not.toBe(screen.getByTestId("first-input"));
		outside.remove();
	});

	it("traps Tab and Shift+Tab inside the dialog", async () => {
		render(DialogFocusHarness, { open: true });
		const firstInput = screen.getByTestId("first-input");
		const confirm = screen.getByTestId("confirm");
		await waitFor(() => expect(document.activeElement).toBe(firstInput));

		// Forward from the last control wraps to the first.
		confirm.focus();
		await fireEvent.keyDown(document, { key: "Tab" });
		expect(document.activeElement).toBe(firstInput);

		// Shift+Tab from the first control wraps to the last.
		await fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(confirm);
	});

	it("pulls focus back inside when it escapes to the background", async () => {
		const background = document.createElement("button");
		background.type = "button";
		background.textContent = "Background";
		document.body.append(background);

		render(DialogFocusHarness, { open: true });
		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("first-input")));

		background.focus();
		await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));
		background.remove();
	});

	it("makes background siblings inert + aria-hidden, then restores them on close", async () => {
		const background = document.createElement("button");
		background.type = "button";
		document.body.append(background);

		const { unmount } = render(DialogFocusHarness, { open: true });
		await waitFor(() => expect(background.inert).toBe(true));
		expect(background.getAttribute("aria-hidden")).toBe("true");

		unmount();
		await waitFor(() => expect(background.inert).toBe(false));
		expect(background.getAttribute("aria-hidden")).toBeNull();
		background.remove();
	});

	it("calls onEscape when dismissible and idle", async () => {
		const onEscape = vi.fn();
		render(DialogFocusHarness, { open: true, onEscape });
		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("first-input")));
		await fireEvent.keyDown(document, { key: "Escape" });
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it("ignores Escape while busy (blocking recovery dialog keeps focus)", async () => {
		const onEscape = vi.fn();
		render(DialogFocusHarness, { open: true, busy: true, onEscape });
		await fireEvent.keyDown(document, { key: "Escape" });
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("ignores Escape when not dismissible", async () => {
		const onEscape = vi.fn();
		render(DialogFocusHarness, { open: true, dismissible: false, onEscape });
		await fireEvent.keyDown(document, { key: "Escape" });
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("restores focus to the opener on close", async () => {
		const opener = document.createElement("button");
		opener.type = "button";
		opener.textContent = "Opener";
		document.body.append(opener);
		opener.focus();
		expect(document.activeElement).toBe(opener);

		const { unmount } = render(DialogFocusHarness, { open: true });
		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("first-input")));

		unmount();
		await waitFor(() => expect(document.activeElement).toBe(opener));
		opener.remove();
	});

	it("blocks clicks on background elements while open", async () => {
		const backgroundAction = vi.fn();
		const background = document.createElement("button");
		background.type = "button";
		background.addEventListener("click", backgroundAction);
		document.body.append(background);

		render(DialogFocusHarness, { open: true });
		await waitFor(() => expect(background.inert).toBe(true));

		await fireEvent.click(background);
		expect(backgroundAction).not.toHaveBeenCalled();
		background.remove();
	});
});
