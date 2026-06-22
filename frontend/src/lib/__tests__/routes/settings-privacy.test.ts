// Privacy & Data settings page (GDPR self-service — W2.6).
//
// Covers the three load-bearing behaviours of the page:
//   1. It renders the export + delete sections and the export history.
//   2. The "Request data export" button calls the API client.
//   3. Account deletion is gated behind an explicit type-to-confirm step — the
//      confirm button stays disabled until the confirmation word is typed.
//
// The API client module is mocked so no network is hit; the i18n locale is
// pinned to English so text assertions are stable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { locale, waitLocale } from "svelte-i18n";
import "$lib/i18n";
import type { AccountExportJob } from "$lib/api/client.ts";

// ── Mocks ────────────────────────────────────────────────────────────────────
const requestAccountExport = vi.fn();
const listAccountExports = vi.fn();
const downloadAccountExport = vi.fn();
const deleteMyAccount = vi.fn();
const restoreMyAccount = vi.fn();
const restoreAccountWithToken = vi.fn();

vi.mock("$lib/api/client.ts", () => ({
	requestAccountExport: (...a: unknown[]) => requestAccountExport(...a),
	listAccountExports: (...a: unknown[]) => listAccountExports(...a),
	downloadAccountExport: (...a: unknown[]) => downloadAccountExport(...a),
	deleteMyAccount: (...a: unknown[]) => deleteMyAccount(...a),
	restoreMyAccount: (...a: unknown[]) => restoreMyAccount(...a),
	restoreAccountWithToken: (...a: unknown[]) => restoreAccountWithToken(...a),
}));

// authStore.init is awaited on mount before the protected load runs; logout is
// called after a successful restore (the session was revoked by the delete).
const authLogout = vi.fn((...a: unknown[]) => Promise.resolve());
vi.mock("$lib/stores/auth.svelte.ts", () => ({
	authStore: { init: vi.fn(async () => {}), logout: (...a: unknown[]) => authLogout(...a) },
}));

// goto is invoked to send the user to /login after restore (no valid session).
const goto = vi.fn((...a: unknown[]) => Promise.resolve());
vi.mock("$app/navigation", () => ({
	goto: (...a: unknown[]) => goto(...a),
}));

// Toasts are fire-and-forget side effects; stub them out.
vi.mock("$lib/stores/toasts.svelte.ts", () => ({
	toastsStore: {
		success: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		show: vi.fn(),
	},
}));

import PrivacyPage from "../../../routes/settings/privacy/+page.svelte";

function job(overrides: Partial<AccountExportJob> = {}): AccountExportJob {
	return {
		id: "job-1",
		userId: "user-1",
		status: "ready",
		zipUrl: "/api/account/export/job-1/download?expires=999&signature=abc",
		failureReason: null,
		bytes: 2048,
		expiresAt: "2026-07-01T00:00:00.000Z",
		createdAt: "2026-06-01T00:00:00.000Z",
		completedAt: "2026-06-01T00:01:00.000Z",
		...overrides,
	};
}

beforeEach(async () => {
	vi.clearAllMocks();
	locale.set("en");
	await waitLocale();
	listAccountExports.mockResolvedValue({ jobs: [] });
	requestAccountExport.mockResolvedValue({ job: job({ status: "queued", zipUrl: null }) });
	deleteMyAccount.mockResolvedValue({
		ok: true,
		deletedAt: "2026-06-04T00:00:00.000Z",
		deleteGraceUntil: "2026-07-04T00:00:00.000Z",
		restoreUrl: "/account/restore?user=user-1&token=tok",
	});
	restoreMyAccount.mockResolvedValue({ ok: true });
	restoreAccountWithToken.mockResolvedValue({ ok: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Privacy & Data settings page", () => {
	it("renders the export and delete sections", async () => {
		render(PrivacyPage);
		expect(await screen.findByRole("heading", { name: /export my data/i })).toBeTruthy();
		expect(screen.getByRole("heading", { name: /delete my account/i })).toBeTruthy();
		// History loaded from the client (empty → empty-state copy).
		await waitFor(() => expect(listAccountExports).toHaveBeenCalled());
		expect(await screen.findByText(/haven't requested any data exports/i)).toBeTruthy();
	});

	it("renders export history with a download link for ready jobs", async () => {
		listAccountExports.mockResolvedValue({ jobs: [job()] });
		render(PrivacyPage);
		expect(await screen.findByTestId("export-history")).toBeTruthy();
		expect(screen.getByRole("button", { name: /download/i })).toBeTruthy();
		// The "ready" status badge surfaces.
		expect(screen.getByText(/^Ready$/i)).toBeTruthy();
	});

	it("calls the client when the export button is pressed", async () => {
		render(PrivacyPage);
		const button = await screen.findByRole("button", { name: /request data export/i });
		await fireEvent.click(button);
		await waitFor(() => expect(requestAccountExport).toHaveBeenCalledTimes(1));
	});

	it("requires explicit confirmation before deleting the account", async () => {
		render(PrivacyPage);
		// Open the confirm box.
		const start = await screen.findByRole("button", { name: /^Delete my account$/i });
		await fireEvent.click(start);
		const confirmBox = await screen.findByTestId("delete-confirm");
		expect(confirmBox).toBeTruthy();

		// The destructive confirm button is disabled until the word is typed.
		const confirmButton = screen.getByRole("button", {
			name: /permanently delete my account/i,
		});
		expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

		// Clicking while disabled must not call the API.
		await fireEvent.click(confirmButton);
		expect(deleteMyAccount).not.toHaveBeenCalled();

		// Type the confirmation word → button arms → click deletes.
		const input = screen.getByLabelText(/type the confirmation word/i);
		await fireEvent.input(input, { target: { value: "DELETE" } });
		await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(confirmButton);
		await waitFor(() => expect(deleteMyAccount).toHaveBeenCalledTimes(1));
	});

	it("offers a restore action after a successful deletion", async () => {
		render(PrivacyPage);
		const start = await screen.findByRole("button", { name: /^Delete my account$/i });
		await fireEvent.click(start);
		const input = await screen.findByLabelText(/type the confirmation word/i);
		await fireEvent.input(input, { target: { value: "DELETE" } });
		const confirmButton = screen.getByRole("button", {
			name: /permanently delete my account/i,
		});
		await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(confirmButton);

		// Restore section appears.
		const restoreButton = await screen.findByRole("button", { name: /restore my account/i });
		await fireEvent.click(restoreButton);
		// Restore uses the SIGNED token proof from the delete response (the session
		// was revoked by the delete, so a session-based restore would fail), then
		// signs out and routes to /login.
		await waitFor(() => expect(restoreAccountWithToken).toHaveBeenCalledTimes(1));
		expect(restoreAccountWithToken).toHaveBeenCalledWith("user-1", "tok");
		expect(restoreMyAccount).not.toHaveBeenCalled();
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/login"));
	});
});
