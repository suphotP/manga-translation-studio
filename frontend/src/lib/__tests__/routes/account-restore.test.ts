// /account/restore page (GDPR — email-link account recovery).
//
// The DELETE /api/account flow hands back a restore link of the shape
// /account/restore?user=…&token=…. This page is what that link opens: it must
// exist (otherwise the link 404s) and POST the signed user+token to the public
// restore endpoint so a LOGGED-OUT user can undo their deletion within the grace
// window. These tests pin the query-string → API-call wiring and the
// success / failure / missing-link states.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import { locale, waitLocale } from "svelte-i18n";
import "$lib/i18n";

// ── Mocks ────────────────────────────────────────────────────────────────────
const restoreAccountWithToken = vi.fn();
const goto = vi.fn();

vi.mock("$lib/api/client.ts", () => ({
	restoreAccountWithToken: (...a: unknown[]) => restoreAccountWithToken(...a),
	// ApiError is referenced for instanceof checks in the page.
	ApiError: class ApiError extends Error {},
}));

vi.mock("$lib/stores/auth.svelte.ts", () => ({
	authStore: { init: vi.fn(async () => {}) },
}));

vi.mock("$app/navigation", () => ({
	goto: (...a: unknown[]) => goto(...a),
}));

// Drive the page's query-string read. Each test sets the URL before render.
let currentUrl = new URL("http://localhost/account/restore");
vi.mock("$app/state", () => ({
	get page() {
		return { url: currentUrl, params: {} };
	},
}));

import RestorePage from "../../../routes/account/restore/+page.svelte";

beforeEach(async () => {
	vi.clearAllMocks();
	locale.set("en");
	await waitLocale();
	currentUrl = new URL("http://localhost/account/restore?user=user-1&token=tok-abc");
	restoreAccountWithToken.mockResolvedValue({ ok: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/account/restore page", () => {
	it("posts the user+token from the query string to the restore endpoint", async () => {
		render(RestorePage);
		await waitFor(() => expect(restoreAccountWithToken).toHaveBeenCalledTimes(1));
		expect(restoreAccountWithToken).toHaveBeenCalledWith("user-1", "tok-abc");
	});

	it("shows a success state + sign-in action when restore succeeds", async () => {
		render(RestorePage);
		await waitFor(() => expect(restoreAccountWithToken).toHaveBeenCalled());
		expect(await screen.findByText(/restored/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy();
	});

	it("shows an error state when the grace window has passed (ok:false)", async () => {
		restoreAccountWithToken.mockResolvedValue({ ok: false });
		render(RestorePage);
		await waitFor(() => expect(restoreAccountWithToken).toHaveBeenCalled());
		expect(await screen.findByText(/could not be restored|grace window/i)).toBeTruthy();
	});

	it("does not call the API and surfaces an error when the link is missing user/token", async () => {
		currentUrl = new URL("http://localhost/account/restore");
		render(RestorePage);
		await waitFor(() => expect(screen.getByText(/incomplete/i)).toBeTruthy());
		expect(restoreAccountWithToken).not.toHaveBeenCalled();
	});
});
