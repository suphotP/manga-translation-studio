import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import AuthModal from "$lib/components/auth/AuthModal.svelte";
import * as api from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { authUiStore } from "$lib/stores/auth-ui.svelte.ts";
import type { AuthResponse, AuthUser } from "$lib/api/client.ts";

// Mock the API client so the modal's authStore calls hit fakes (and the SSO
// button query stays deterministic / empty).
vi.mock("$lib/api/client.ts", () => ({
	clearApiAccessToken: vi.fn(),
	getCurrentUser: vi.fn(),
	login: vi.fn(),
	logout: vi.fn(),
	refreshAuthSession: vi.fn(),
	registerUser: vi.fn(),
	setApiAccessToken: vi.fn(),
	setAuthRefreshHandler: vi.fn(),
	forgotPassword: vi.fn(() => Promise.resolve({ ok: true })),
	ssoStartUrl: vi.fn((provider: string) => `/api/auth/sso/${provider}/start`),
	fetchSsoProviders: vi.fn(() => Promise.resolve([])),
}));

const editor: AuthUser = {
	id: "user-1",
	email: "editor@example.com",
	name: "Editor One",
	role: "editor",
	authProvider: "local",
	emailVerified: false,
	isActive: true,
};

const session: AuthResponse = {
	user: editor,
	tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	authStore.__resetForTesting();
	authUiStore.__resetForTesting();
});

describe("AuthModal", () => {
	it("does not render when the auth UI store is closed", () => {
		render(AuthModal);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens on the requested mode and renders the segmented tab control", async () => {
		render(AuthModal);
		authUiStore.openAuthModal("login");

		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		const tablist = screen.getByRole("tablist", { name: "โหมดบัญชี" });
		expect(tablist).toBeTruthy();
		// Sign-in tab is selected by default.
		const loginTab = screen.getByRole("tab", { name: "เข้าใช้งาน" });
		expect(loginTab.getAttribute("aria-selected")).toBe("true");
	});

	it("tablist supports roving tabindex + arrow-key navigation", async () => {
		render(AuthModal);
		authUiStore.openAuthModal("login");
		await waitFor(() => screen.getByRole("dialog"));

		const loginTab = screen.getByRole("tab", { name: "เข้าใช้งาน" });
		const registerTab = screen.getByRole("tab", { name: "สร้างบัญชี" });

		// Roving tabindex: only the active tab is in the tab order.
		expect(loginTab.getAttribute("tabindex")).toBe("0");
		expect(registerTab.getAttribute("tabindex")).toBe("-1");

		// ArrowRight moves to + activates the next tab.
		const tablist = screen.getByRole("tablist", { name: "โหมดบัญชี" });
		await fireEvent.keyDown(tablist, { key: "ArrowRight" });
		await waitFor(() => expect(registerTab.getAttribute("aria-selected")).toBe("true"));
		expect(registerTab.getAttribute("tabindex")).toBe("0");
		expect(loginTab.getAttribute("tabindex")).toBe("-1");

		// ArrowLeft wraps/moves back to the sign-in tab.
		await fireEvent.keyDown(tablist, { key: "ArrowLeft" });
		await waitFor(() => expect(loginTab.getAttribute("aria-selected")).toBe("true"));
	});

	it("switches modes and preserves the typed email across the switch", async () => {
		render(AuthModal);
		authUiStore.openAuthModal("login");
		await waitFor(() => screen.getByRole("dialog"));

		await fireEvent.input(screen.getByLabelText("อีเมล"), {
			target: { value: "carry@example.com" },
		});

		// Switch to Create account.
		await fireEvent.click(screen.getByRole("tab", { name: "สร้างบัญชี" }));
		await waitFor(() =>
			expect((screen.getByRole("tab", { name: "สร้างบัญชี" })).getAttribute("aria-selected")).toBe("true"),
		);

		// Email carries over to the register form.
		expect((screen.getByLabelText("อีเมล") as HTMLInputElement).value).toBe("carry@example.com");
	});

	it("calls authStore.login (api.login) on sign-in submit and closes on success", async () => {
		vi.mocked(api.login).mockResolvedValue(session);
		const onAuthenticated = vi.fn();
		render(AuthModal);
		authUiStore.openAuthModal("login", onAuthenticated);
		await waitFor(() => screen.getByRole("dialog"));

		await fireEvent.input(screen.getByLabelText("อีเมล"), {
			target: { value: "editor@example.com" },
		});
		await fireEvent.input(screen.getByLabelText("รหัสผ่าน"), {
			target: { value: "Password!123" },
		});
		await fireEvent.submit(screen.getByLabelText("อีเมล").closest("form")!);

		await waitFor(() => expect(api.login).toHaveBeenCalledWith("editor@example.com", "Password!123", undefined));
		// Success closes the modal and fires the one-shot callback.
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(onAuthenticated).toHaveBeenCalledTimes(1);
		expect(authUiStore.open).toBe(false);
		expect(authStore.isAuthenticated).toBe(true);
	});

	it("registers (api.registerUser) with auto sign-in when the password policy passes", async () => {
		vi.mocked(api.registerUser).mockResolvedValue(session);
		const { container } = render(AuthModal);
		authUiStore.openAuthModal("register");
		await waitFor(() => screen.getByRole("dialog"));

		await fireEvent.input(screen.getByLabelText("ชื่อที่จะแสดงในทีม"), {
			target: { value: "Editor One" },
		});
		await fireEvent.input(screen.getByLabelText("อีเมล"), {
			target: { value: "editor@example.com" },
		});
		// Target the password fields by id: register mode renders two fields whose
		// labels both contain "รหัสผ่าน", so a label-text query is ambiguous.
		await fireEvent.input(container.querySelector("#auth-modal-password")!, {
			target: { value: "Password!123" },
		});
		await fireEvent.input(container.querySelector("#auth-modal-confirm")!, {
			target: { value: "Password!123" },
		});
		await fireEvent.click(screen.getByRole("checkbox"));
		await fireEvent.submit(screen.getByLabelText("อีเมล").closest("form")!);

		await waitFor(() =>
			expect(api.registerUser).toHaveBeenCalledWith({
				email: "editor@example.com",
				password: "Password!123",
				name: "Editor One",
			}, undefined),
		);
		await waitFor(() => expect(authStore.role).toBe("editor"));
		expect(authUiStore.open).toBe(false);
	});

	it("blocks register submit with an inline policy error and never calls the API", async () => {
		const { container } = render(AuthModal);
		authUiStore.openAuthModal("register");
		await waitFor(() => screen.getByRole("dialog"));

		await fireEvent.input(screen.getByLabelText("อีเมล"), {
			target: { value: "weak@example.com" },
		});
		// Too-weak password (fails the policy: no uppercase/number/symbol/length).
		await fireEvent.input(container.querySelector("#auth-modal-password")!, { target: { value: "abc" } });
		await fireEvent.input(container.querySelector("#auth-modal-confirm")!, { target: { value: "abc" } });
		await fireEvent.click(screen.getByRole("checkbox"));
		await fireEvent.submit(screen.getByLabelText("อีเมล").closest("form")!);

		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(api.registerUser).not.toHaveBeenCalled();
		// Modal stays open on a validation failure.
		expect(authUiStore.open).toBe(true);
	});

	it("submits forgot-password (api.forgotPassword) and shows the generic confirmation", async () => {
		render(AuthModal);
		authUiStore.openAuthModal("forgot");
		await waitFor(() => screen.getByRole("dialog"));

		await fireEvent.input(screen.getByLabelText("อีเมล"), {
			target: { value: "lost@example.com" },
		});
		await fireEvent.submit(screen.getByLabelText("อีเมล").closest("form")!);

		await waitFor(() => expect(api.forgotPassword).toHaveBeenCalledWith("lost@example.com"));
		// The confirmation status appears; the modal stays open (no auth happened).
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(authUiStore.open).toBe(true);
	});
});
