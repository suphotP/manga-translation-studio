import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import AuthAccountMenu from "$lib/components/AuthAccountMenu.svelte";
import * as api from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import type { AuthResponse, AuthUser } from "$lib/api/client.ts";

vi.mock("$lib/api/client.ts", () => ({
	clearApiAccessToken: vi.fn(),
	getCurrentUser: vi.fn(),
	login: vi.fn(),
	logout: vi.fn(),
	refreshAuthSession: vi.fn(),
	registerUser: vi.fn(),
	setApiAccessToken: vi.fn(),
	setAuthRefreshHandler: vi.fn(),
	resendVerificationEmail: vi.fn(),
	ssoStartUrl: vi.fn((provider: string) => `/api/auth/sso/${provider}/start`),
	fetchSsoProviders: vi.fn(() => Promise.resolve([])),
}));

// signOut() now calls invalidateAll() to re-run route guards after logout;
// stub the navigation module so the menu's sign-out path doesn't hit the real
// SvelteKit runtime (which throws outside a navigation context under jsdom).
vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(() => Promise.resolve()),
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
	tokens: {
		accessToken: "access-1",
		refreshToken: "refresh-1",
	},
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	authStore.__resetForTesting();
});

describe("AuthAccountMenu", () => {
	it("shows prototype access and opens the local auth form when anonymous", async () => {
		render(AuthAccountMenu);

		const trigger = screen.getByRole("button", { name: /บัญชี ผู้ใช้ งานบนเครื่องนี้/ });
		await fireEvent.click(trigger);

		expect(screen.getByText("ผูกบัญชีเพื่อซิงก์งาน")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "เข้าใช้งาน" }).length).toBe(1);
		expect(screen.getByRole("button", { name: "สร้างบัญชี" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เข้าใช้งาน" }));
		expect(screen.getByLabelText("อีเมล")).toBeTruthy();
		expect(screen.getByLabelText("รหัสผ่าน")).toBeTruthy();
	});

	it("creates an editor account from the menu", async () => {
		vi.mocked(api.registerUser).mockResolvedValue(session);
		render(AuthAccountMenu);

		await fireEvent.click(screen.getByRole("button", { name: /บัญชี ผู้ใช้ งานบนเครื่องนี้/ }));
		await fireEvent.click(screen.getByRole("button", { name: "สร้างบัญชี" }));
		await fireEvent.input(screen.getByLabelText("ชื่อที่แสดง"), { target: { value: "Editor One" } });
		await fireEvent.input(screen.getByLabelText("อีเมล"), { target: { value: "editor@example.com" } });
		await fireEvent.input(screen.getByLabelText("รหัสผ่าน"), { target: { value: "Password!123" } });
		await fireEvent.submit(screen.getByLabelText("อีเมล").closest("form")!);

		expect(api.registerUser).toHaveBeenCalledWith({
			email: "editor@example.com",
			password: "Password!123",
			name: "Editor One",
		}, undefined);
		expect(authStore.role).toBe("editor");
	});

	it("shows a passive receipt instead of a disabled submit button while auth is busy", async () => {
		const pending = deferred<AuthResponse>();
		vi.mocked(api.login).mockReturnValue(pending.promise);
		render(AuthAccountMenu);

		await fireEvent.click(screen.getByRole("button", { name: /บัญชี ผู้ใช้ งานบนเครื่องนี้/ }));
		await fireEvent.click(screen.getByRole("button", { name: "เข้าใช้งาน" }));
		await fireEvent.input(screen.getByLabelText("อีเมล"), { target: { value: "editor@example.com" } });
		await fireEvent.input(screen.getByLabelText("รหัสผ่าน"), { target: { value: "Password!123" } });
		await fireEvent.submit(screen.getByLabelText("อีเมล").closest("form")!);

		expect(screen.getByLabelText("สถานะบัญชี").textContent).toContain("กำลังทำงาน");
		expect(screen.queryByRole("button", { name: "เข้าใช้งาน" })).toBeNull();
		expect(document.querySelectorAll(".account-popover button:disabled")).toHaveLength(0);

		pending.resolve(session);
		await waitFor(() => expect(screen.queryByLabelText("สถานะบัญชี")).toBeNull());
	});

	it("shows signed-in account details without the legacy permission summary", async () => {
		authStore.__setSessionForTesting(session);
		render(AuthAccountMenu);

		await fireEvent.click(screen.getByRole("button", { name: /บัญชี Editor Editor One/ }));

		expect(document.querySelector(".permission-grid")).toBeNull();
		expect(screen.queryByLabelText("สรุปสิทธิ์บัญชี")).toBeNull();
		expect(screen.getByText("editor@example.com")).toBeTruthy();
		expect(screen.getByText("ยังไม่ได้ยืนยันอีเมล")).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "จัดการบัญชี" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ออกจากระบบ" })).toBeTruthy();
		expect(screen.queryByText("รัน AI")).toBeNull();
		expect(screen.queryByText("ตั้งค่าระบบ")).toBeNull();
		expect(screen.queryByText("ได้")).toBeNull();
		expect(screen.queryByText("ไม่ได้")).toBeNull();
	});

	it("shows a passive receipt instead of a disabled sign-out button while signing out", async () => {
		const pending = deferred<void>();
		vi.mocked(api.logout).mockReturnValue(pending.promise);
		authStore.__setSessionForTesting(session);
		render(AuthAccountMenu);

		await fireEvent.click(screen.getByRole("button", { name: /บัญชี Editor Editor One/ }));
		await fireEvent.click(screen.getByRole("button", { name: "ออกจากระบบ" }));

		expect(screen.getByLabelText("สถานะออกจากระบบ").textContent).toContain("กำลังออกจากระบบ");
		expect(screen.queryByRole("button", { name: "ออกจากระบบ" })).toBeNull();
		expect(document.querySelectorAll(".account-popover button:disabled")).toHaveLength(0);

		pending.resolve();
		await waitFor(() => expect(screen.queryByLabelText("สถานะออกจากระบบ")).toBeNull());
	});
});
