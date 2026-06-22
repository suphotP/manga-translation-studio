import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

// Every exit from the full-page onboarding tour MUST mark onboarding done +
// dismiss the dashboard spotlight before navigating — otherwise a user can leave
// onboarding un-finished via a quick link and get double-onboarded on the
// dashboard (the spotlight then swallows their first "create chapter"). The quick
// links were plain <a> anchors that bypassed the shared complete() flow; this test
// guards that they now route through it.

const { gotoMock, dismissTourMock } = vi.hoisted(() => ({
	gotoMock: vi.fn(async (_destination: string, _opts?: { replaceState?: boolean }) => {}),
	dismissTourMock: vi.fn(),
}));

vi.mock("$app/navigation", () => ({
	goto: gotoMock,
}));

vi.mock("$lib/onboarding/tour-steps", () => ({
	dismissTour: dismissTourMock,
}));

vi.mock("$lib/stores/auth.svelte.ts", () => ({
	authStore: {
		init: vi.fn(async () => {}),
		get currentUser() {
			return { email: "first-run@example.com" };
		},
	},
}));

const TOUR_STORAGE_KEY = "manga-editor.onboarding.tour.v1";

import OnboardingPage from "../../../routes/onboarding/+page.svelte";

beforeEach(() => {
	gotoMock.mockClear();
	dismissTourMock.mockClear();
	localStorage.clear();
});

afterEach(() => {
	localStorage.clear();
});

function readDone(): boolean {
	const raw = localStorage.getItem(TOUR_STORAGE_KEY);
	if (!raw) return false;
	try {
		return Boolean(JSON.parse(raw)?.done);
	} catch {
		return false;
	}
}

describe("onboarding page exit paths all mark onboarding done", () => {
	it("quick link 'Library' marks done + dismisses spotlight before navigating", async () => {
		render(OnboardingPage);

		const link = screen.getByText("เข้าคลัง (เรื่อง / ตอน)");
		await fireEvent.click(link);

		// No double-onboard: the dashboard spotlight is dismissed and the done flag is set.
		expect(dismissTourMock).toHaveBeenCalledTimes(1);
		expect(readDone()).toBe(true);
		// Navigation goes to the link's destination (not just "/"), and replaces history.
		expect(gotoMock).toHaveBeenCalledWith("/library", { replaceState: true });
	});

	it("quick link 'Dashboard' marks done before navigating", async () => {
		render(OnboardingPage);

		await fireEvent.click(screen.getByText("เปิดแดชบอร์ด"));

		expect(dismissTourMock).toHaveBeenCalledTimes(1);
		expect(readDone()).toBe(true);
		expect(gotoMock).toHaveBeenCalledWith("/dashboard", { replaceState: true });
	});

	it("quick link 'Storage' marks done before navigating", async () => {
		render(OnboardingPage);

		await fireEvent.click(screen.getByText("เปิดคลังรูป (Storage)"));

		expect(dismissTourMock).toHaveBeenCalledTimes(1);
		expect(readDone()).toBe(true);
		expect(gotoMock).toHaveBeenCalledWith("/storage", { replaceState: true });
	});

	it("the 'skip tour' button also marks done + dismisses spotlight", async () => {
		render(OnboardingPage);

		await fireEvent.click(screen.getByText("ข้ามทัวร์"));

		expect(dismissTourMock).toHaveBeenCalledTimes(1);
		expect(readDone()).toBe(true);
		expect(gotoMock).toHaveBeenCalledWith("/", { replaceState: true });
	});
});
