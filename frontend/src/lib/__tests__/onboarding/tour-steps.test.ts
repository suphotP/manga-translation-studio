import { beforeEach, describe, expect, it } from "vitest";
import {
	ONBOARDING_TOUR_STEPS,
	ONBOARDING_TOUR_STORAGE_KEY,
	dismissTour,
	isTourDismissed,
	resetTour,
	shouldAutoStartTour,
} from "$lib/onboarding/tour-steps";

function createMemoryStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		raw: map,
	};
}

let storage: ReturnType<typeof createMemoryStorage>;

beforeEach(() => {
	storage = createMemoryStorage();
});

describe("onboarding tour step config", () => {
	it("defines a non-empty ordered list of steps", () => {
		expect(ONBOARDING_TOUR_STEPS.length).toBeGreaterThan(0);
	});

	it("gives every step a unique id", () => {
		const ids = ONBOARDING_TOUR_STEPS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("provides i18n keys AND English fallbacks for every step", () => {
		for (const step of ONBOARDING_TOUR_STEPS) {
			expect(step.titleKey).toMatch(/^onboardingTour\./);
			expect(step.bodyKey).toMatch(/^onboardingTour\./);
			expect(step.titleFallback.length).toBeGreaterThan(0);
			expect(step.bodyFallback.length).toBeGreaterThan(0);
		}
	});

	it("uses valid placements and only null/string targets", () => {
		const placements = new Set(["top", "bottom", "left", "right", "center"]);
		for (const step of ONBOARDING_TOUR_STEPS) {
			expect(placements.has(step.placement)).toBe(true);
			expect(step.target === null || typeof step.target === "string").toBe(true);
		}
	});

	it("starts with a centered intro step that has no spotlight target", () => {
		expect(ONBOARDING_TOUR_STEPS[0].target).toBeNull();
		expect(ONBOARDING_TOUR_STEPS[0].placement).toBe("center");
	});
});

describe("onboarding tour persistence", () => {
	it("auto-starts on first visit and not after dismissal", () => {
		expect(isTourDismissed(storage)).toBe(false);
		expect(shouldAutoStartTour(storage)).toBe(true);

		dismissTour(storage);

		expect(isTourDismissed(storage)).toBe(true);
		expect(shouldAutoStartTour(storage)).toBe(false);
		expect(storage.raw.get(ONBOARDING_TOUR_STORAGE_KEY)).toBe("1");
	});

	it("can be reset so the tour replays", () => {
		dismissTour(storage);
		expect(shouldAutoStartTour(storage)).toBe(false);

		resetTour(storage);
		expect(isTourDismissed(storage)).toBe(false);
		expect(shouldAutoStartTour(storage)).toBe(true);
	});
});
