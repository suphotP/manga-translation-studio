import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import AdminDialog from "$lib/components/AdminDialog.svelte";
import { adminStore } from "$lib/stores/admin.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import type { AuthResponse, AuthUser } from "$lib/api/client.ts";

vi.mock("$lib/api/client.ts", () => ({
	clearApiAccessToken: vi.fn(),
	getAdminConfig: vi.fn(),
	login: vi.fn(),
	logout: vi.fn(),
	refreshAuthSession: vi.fn(),
	registerUser: vi.fn(),
	setApiAccessToken: vi.fn(),
	setAuthRefreshHandler: vi.fn(),
	updateAdminConfig: vi.fn(),
}));

const adminUser: AuthUser = {
	id: "admin-1",
	email: "admin@example.com",
	name: "Admin One",
	role: "admin",
	authProvider: "local",
	emailVerified: true,
	isActive: true,
};

const adminSession: AuthResponse = {
	user: adminUser,
	tokens: {
		accessToken: "access-admin",
		refreshToken: "refresh-admin",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	authStore.__resetForTesting();
	adminStore.close();
	adminStore.isSaving = false;
	adminStore.saveMessage = "";
	adminStore.saveError = false;
});

afterEach(() => {
	adminStore.close();
	adminStore.isSaving = false;
});

describe("AdminDialog", () => {
	it("shows saving as a passive receipt instead of a disabled save button", () => {
		authStore.__setSessionForTesting(adminSession);
		adminStore.showDialog = true;
		adminStore.isSaving = true;

		render(AdminDialog);

		expect(screen.queryByRole("button", { name: "บันทึก" })).toBeNull();
		expect(screen.getByLabelText("สถานะบันทึกการตั้งค่า").textContent).toContain("กำลังบันทึก");
		expect(screen.queryAllByRole("button").some((button) => (button as HTMLButtonElement).disabled)).toBe(false);
	});
});
