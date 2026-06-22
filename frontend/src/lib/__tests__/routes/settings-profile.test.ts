// Profile settings page (account management — display name + change password).
//
// Covers the load-bearing behaviours:
//   1. Renders the name / email / password sections with the current user.
//   2. Saving the display name calls authStore.updateDisplayName; Save is
//      disabled until the name is changed.
//   3. Changing the password requires current + matching new/confirm before the
//      button arms, and calls authStore.changePassword with the right args.
//   4. Email is rendered read-only.
//
// The auth store is mocked so no network is hit; the locale is pinned to English.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { locale, waitLocale } from "svelte-i18n";
import "$lib/i18n";

// ── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock is hoisted above the file's top-level consts, so everything the mock
// factory closes over must be created via vi.hoisted (also hoisted) to avoid a
// "cannot access before initialization" TDZ error.
const { updateDisplayName, changePassword, init, authState } = vi.hoisted(() => ({
	updateDisplayName: vi.fn(),
	changePassword: vi.fn(),
	init: vi.fn(async () => {}),
	authState: {
		user: { id: "user-1", name: "Original Name", email: "user@example.com" } as
			| { id: string; name: string; email: string }
			| null,
		isAuthenticated: true,
	},
}));

vi.mock("$lib/stores/auth.svelte.ts", () => ({
	authStore: {
		init,
		updateDisplayName: (...a: unknown[]) => updateDisplayName(...a),
		changePassword: (...a: unknown[]) => changePassword(...a),
		get user() {
			return authState.user;
		},
		get isAuthenticated() {
			return authState.isAuthenticated;
		},
	},
}));

vi.mock("$lib/stores/toasts.svelte.ts", () => ({
	toastsStore: {
		success: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		show: vi.fn(),
	},
}));

import ProfilePage from "../../../routes/settings/profile/+page.svelte";

beforeEach(async () => {
	vi.clearAllMocks();
	authState.user = { id: "user-1", name: "Original Name", email: "user@example.com" };
	authState.isAuthenticated = true;
	locale.set("en");
	await waitLocale();
	updateDisplayName.mockImplementation(async (name: string) => {
		authState.user = { ...authState.user!, name: name.trim() };
		return authState.user;
	});
	changePassword.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Profile settings page", () => {
	it("renders the name, email and password sections", async () => {
		render(ProfilePage);
		expect(await screen.findByRole("heading", { name: /display name/i })).toBeTruthy();
		expect(screen.getByRole("heading", { name: /^email$/i })).toBeTruthy();
		expect(screen.getByRole("heading", { name: /change password/i })).toBeTruthy();
	});

	it("prefills the current display name and renders email read-only", async () => {
		render(ProfilePage);
		const nameInput = (await screen.findByTestId("display-name-input")) as HTMLInputElement;
		expect(nameInput.value).toBe("Original Name");
		const emailInput = screen.getByTestId("email-readonly") as HTMLInputElement;
		expect(emailInput.value).toBe("user@example.com");
		expect(emailInput.readOnly).toBe(true);
	});

	it("disables Save until the name changes, then calls updateDisplayName", async () => {
		render(ProfilePage);
		const saveBtn = (await screen.findByTestId("save-name")) as HTMLButtonElement;
		// Unchanged → disabled.
		expect(saveBtn.disabled).toBe(true);

		const nameInput = screen.getByTestId("display-name-input") as HTMLInputElement;
		await fireEvent.input(nameInput, { target: { value: "Renamed Person" } });
		expect(saveBtn.disabled).toBe(false);

		await fireEvent.click(saveBtn);
		await waitFor(() => expect(updateDisplayName).toHaveBeenCalledWith("Renamed Person"));
	});

	it("requires current + matching new/confirm before changing the password", async () => {
		render(ProfilePage);
		const saveBtn = (await screen.findByTestId("save-password")) as HTMLButtonElement;
		expect(saveBtn.disabled).toBe(true);

		const current = screen.getByTestId("current-password") as HTMLInputElement;
		const next = screen.getByTestId("new-password") as HTMLInputElement;
		const confirm = screen.getByTestId("confirm-password") as HTMLInputElement;

		await fireEvent.input(current, { target: { value: "oldpass1" } });
		await fireEvent.input(next, { target: { value: "newpass12" } });
		// Mismatched confirm → still disabled + shows mismatch hint.
		await fireEvent.input(confirm, { target: { value: "different9" } });
		expect(saveBtn.disabled).toBe(true);
		expect(screen.getByText(/passwords don't match/i)).toBeTruthy();

		// Match → arms.
		await fireEvent.input(confirm, { target: { value: "newpass12" } });
		expect(saveBtn.disabled).toBe(false);

		await fireEvent.click(saveBtn);
		await waitFor(() => expect(changePassword).toHaveBeenCalledWith("oldpass1", "newpass12"));
	});

	it("keeps the password Save disabled for a too-short new password", async () => {
		render(ProfilePage);
		const saveBtn = (await screen.findByTestId("save-password")) as HTMLButtonElement;
		const current = screen.getByTestId("current-password") as HTMLInputElement;
		const next = screen.getByTestId("new-password") as HTMLInputElement;
		const confirm = screen.getByTestId("confirm-password") as HTMLInputElement;

		await fireEvent.input(current, { target: { value: "oldpass1" } });
		await fireEvent.input(next, { target: { value: "short" } });
		await fireEvent.input(confirm, { target: { value: "short" } });
		expect(saveBtn.disabled).toBe(true);
		expect(screen.getByText(/at least 8 characters/i)).toBeTruthy();
	});
});
