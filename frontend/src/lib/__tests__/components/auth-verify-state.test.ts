import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import AuthVerifyState from "$lib/components/auth/AuthVerifyState.svelte";
import type { AuthUser } from "$lib/api/client.ts";
import { setLocale } from "$lib/i18n";
import { authStore } from "$lib/stores/auth.svelte.ts";

function setSignedInEmail(email: string): void {
	const user: AuthUser = {
		id: "user-otp",
		email,
		name: "OTP User",
		role: "editor",
		authProvider: "local",
		emailVerified: false,
		isActive: true,
	};

	authStore.__setSessionForTesting({
		user,
		tokens: { accessToken: "access-token", refreshToken: "refresh-token" },
	});
}

function getOtpHelpText(container: HTMLElement): string {
	return container.querySelector(".otp-help")?.textContent ?? "";
}

beforeEach(async () => {
	localStorage.clear();
	authStore.__resetForTesting();
	await setLocale("en", { syncUser: false });
});

afterEach(() => {
	cleanup();
	authStore.__resetForTesting();
});

describe("AuthVerifyState", () => {
	it("renders visible spacing between the OTP prefix, email, and suffix", () => {
		setSignedInEmail("editor@example.com");

		const { container } = render(AuthVerifyState);
		const helpText = getOtpHelpText(container);

		expect(helpText).toContain("We sent a 6-digit verification code to editor@example.com");
		expect(helpText).toContain("editor@example.com — enter the code below");
		expect(helpText).not.toContain("code toeditor@example.com");
		expect(helpText).not.toContain("editor@example.com—");
		expect(helpText).not.toContain("editor@example.com  —");
	});

	it("does not create an empty emphasized email slot when no signed-in user is loaded", () => {
		const { container } = render(AuthVerifyState);
		const help = container.querySelector(".otp-help");

		expect(help?.querySelector("strong")).toBeNull();
		expect(help?.textContent ?? "").toContain("We sent a 6-digit verification code to — enter the code below");
		expect(help?.textContent ?? "").not.toContain("code to  —");
	});
});
