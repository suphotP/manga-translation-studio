import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import AuthForgotForm from "$lib/components/auth/AuthForgotForm.svelte";
import AuthLoginForm from "$lib/components/auth/AuthLoginForm.svelte";
import AuthResetForm from "$lib/components/auth/AuthResetForm.svelte";
import AuthSignupForm from "$lib/components/auth/AuthSignupForm.svelte";
import * as api from "$lib/api/client.ts";
import { evaluatePassword, PASSWORD_MAX_LENGTH } from "$lib/auth/password-policy.ts";
import { setLocale } from "$lib/i18n";
import { authStore } from "$lib/stores/auth.svelte.ts";

vi.mock("$lib/api/client.ts", async () => {
	const actual = await vi.importActual<typeof import("$lib/api/client.ts")>("$lib/api/client.ts");
	return {
		ApiError: actual.ApiError,
		clearApiAccessToken: vi.fn(),
		exchangeSsoCode: vi.fn(),
		fetchSsoProviders: vi.fn(() => Promise.resolve([])),
		forgotPassword: vi.fn(),
		getCurrentUser: vi.fn(),
		login: vi.fn(),
		logout: vi.fn(),
		refreshAuthSession: vi.fn(),
		registerUser: vi.fn(),
		resendVerification: vi.fn(),
		resendVerificationEmail: vi.fn(),
		resetPassword: vi.fn(),
		setApiAccessToken: vi.fn(),
		setAuthRefreshHandler: vi.fn(),
		ssoStartUrl: vi.fn((provider: string) => `/api/auth/sso/${provider}/start`),
		updateMyProfile: vi.fn(),
		verifyEmail: vi.fn(),
		verifyOtp: vi.fn(),
	};
});

beforeEach(async () => {
	vi.clearAllMocks();
	cleanup();
	localStorage.clear();
	authStore.__resetForTesting();
	await setLocale("th");
});

describe("auth form i18n errors and limits", () => {
	it("renders auth store error keys in the active locale and relocalizes after switching locale", async () => {
		vi.mocked(api.login).mockRejectedValue(new Error("Invalid credentials from server"));
		await setLocale("en");
		render(AuthLoginForm);

		await fireEvent.input(screen.getByLabelText("Email"), {
			target: { value: "editor@example.com" },
		});
		await fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "wrong-password" },
		});
		await fireEvent.submit(screen.getByLabelText("Email").closest("form")!);

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("Sign-in failed. Check your email/password and try again.");
		});
		expect(screen.queryByText(/Invalid credentials from server/)).toBeNull();

		await setLocale("th");
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("เข้าใช้งานไม่สำเร็จ เช็ก Email/รหัสผ่าน แล้วลองใหม่");
		});
	});

	it("caps email/name inputs but NEVER passwords (the browser must not silently truncate a paste)", () => {
		// Password fields deliberately have NO maxlength: a >128 paste must reach
		// evaluatePassword so the password_max_length rule shows, instead of the
		// browser quietly registering a truncated credential (review #587 P2).
		// maxLength of an attribute-less input reads -1.
		let result = render(AuthSignupForm);
		expect((result.container.querySelector("#auth-signup-name") as HTMLInputElement).maxLength).toBe(200);
		expect((result.container.querySelector("#auth-signup-name") as HTMLInputElement).required).toBe(true);
		expect((result.container.querySelector("#auth-signup-email") as HTMLInputElement).maxLength).toBe(254);
		expect((result.container.querySelector("#auth-signup-password") as HTMLInputElement).maxLength).toBe(-1);
		expect((result.container.querySelector("#auth-signup-confirm") as HTMLInputElement).maxLength).toBe(-1);

		cleanup();
		result = render(AuthLoginForm);
		expect((result.container.querySelector("#auth-login-email") as HTMLInputElement).maxLength).toBe(254);
		expect((result.container.querySelector("#auth-login-password") as HTMLInputElement).maxLength).toBe(-1);

		cleanup();
		result = render(AuthForgotForm);
		expect((result.container.querySelector("#auth-forgot-email") as HTMLInputElement).maxLength).toBe(254);

		cleanup();
		result = render(AuthResetForm, { props: { token: "reset-token" } });
		expect((result.container.querySelector("#auth-reset-password") as HTMLInputElement).maxLength).toBe(-1);
		expect((result.container.querySelector("#auth-reset-confirm") as HTMLInputElement).maxLength).toBe(-1);
	});

	it("turns signup required markers into green checks only after each field is valid", async () => {
		const { container } = render(AuthSignupForm);
		expect([...container.querySelectorAll(".auth-required")].map((node) => node.textContent)).toEqual(["*", "*", "*", "*"]);

		await fireEvent.input(container.querySelector("#auth-signup-name")!, { target: { value: "Editor One" } });
		await fireEvent.input(container.querySelector("#auth-signup-email")!, { target: { value: "editor@example.com" } });
		await fireEvent.input(container.querySelector("#auth-signup-password")!, { target: { value: "Password!123" } });
		await fireEvent.input(container.querySelector("#auth-signup-confirm")!, { target: { value: "Password!123" } });

		await waitFor(() => {
			expect(container.querySelectorAll(".auth-required.auth-required-ok")).toHaveLength(4);
			expect([...container.querySelectorAll(".auth-required")].map((node) => node.textContent)).toEqual(["✓", "✓", "✓", "✓"]);
		});
	});

	it("surfaces signup length errors under over-limit email and name fields", async () => {
		const { container } = render(AuthSignupForm);

		await fireEvent.input(container.querySelector("#auth-signup-name")!, { target: { value: "น".repeat(201) } });
		await fireEvent.input(container.querySelector("#auth-signup-email")!, { target: { value: `${"a".repeat(245)}@example.com` } });

		expect(screen.getByText("ชื่อยาวเกิน 200 ตัวอักษร")).toBeTruthy();
		expect(screen.getByText("อีเมลยาวเกิน 254 ตัวอักษร")).toBeTruthy();
	});

	it("rejects passwords longer than the backend maximum with the maxlength rule", () => {
		const overLimit = `${"A".repeat(PASSWORD_MAX_LENGTH)}a1!`;
		const result = evaluatePassword(overLimit);

		expect(result.rules.find((rule) => rule.id === "maxlength")?.ok).toBe(false);
		expect(result.firstUnmetRuleId).toBe("maxlength");
		expect(result.valid).toBe(false);
	});
});
