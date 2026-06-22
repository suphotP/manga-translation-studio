// Onboarding tour step configuration + "don't show again" persistence.
//
// Steps are data-driven: each one points at a `[data-tour="<target>"]` anchor
// in the workspace dashboard and carries i18n keys (with English fallbacks) for
// its title/body. Keeping this as a plain module makes the step contract
// unit-testable and lets the UI component stay thin.

export type TourPlacement = "top" | "bottom" | "left" | "right" | "center";

export interface TourStep {
	/** Stable id (used as a test/track handle). */
	id: string;
	/** `data-tour` value to spotlight, or null for a centered intro step. */
	target: string | null;
	/** i18n key for the step title. */
	titleKey: string;
	/** English fallback used when the i18n key is missing. */
	titleFallback: string;
	/** i18n key for the step body copy. */
	bodyKey: string;
	/** English fallback body. */
	bodyFallback: string;
	/** Preferred tooltip placement relative to the target. */
	placement: TourPlacement;
}

export const ONBOARDING_TOUR_STORAGE_KEY = "comic-workspace.onboardingTour.dismissed";

export const ONBOARDING_TOUR_STEPS: readonly TourStep[] = [
	{
		id: "welcome",
		target: null,
		titleKey: "onboardingTour.welcome.title",
		titleFallback: "Welcome to your workspace",
		bodyKey: "onboardingTour.welcome.body",
		bodyFallback:
			"A quick tour of the dashboard. You can leave any time with Escape or the Skip button.",
		placement: "center",
	},
	{
		id: "hero",
		target: "hero",
		titleKey: "onboardingTour.hero.title",
		titleFallback: "Pick up where you left off",
		bodyKey: "onboardingTour.hero.body",
		bodyFallback:
			"The hero card always shows the chapter that needs you next, with one button to jump back into the work.",
		placement: "bottom",
	},
	{
		id: "tasks",
		target: "my-tasks",
		titleKey: "onboardingTour.tasks.title",
		titleFallback: "Your tasks, in one lane",
		bodyKey: "onboardingTour.tasks.body",
		bodyFallback:
			"Assigned translate, clean, typeset and QC jobs land here. Open one to focus on a single issue at a time.",
		placement: "right",
	},
	{
		id: "attention",
		target: "needs-attention",
		titleKey: "onboardingTour.attention.title",
		titleFallback: "What needs attention",
		bodyKey: "onboardingTour.attention.body",
		bodyFallback:
			"Blockers, comments and AI checks that are waiting on a decision surface here so nothing slips.",
		placement: "left",
	},
	{
		id: "search",
		target: "search",
		titleKey: "onboardingTour.search.title",
		titleFallback: "Find anything fast",
		bodyKey: "onboardingTour.search.body",
		bodyFallback:
			"Search across stories, chapters, languages and statuses — or type a command like “create a new chapter”.",
		placement: "bottom",
	},
] as const;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function resolveStorage(storage?: StorageLike): StorageLike | null {
	if (storage) return storage;
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

/** True once the visitor has chosen "don't show again". */
export function isTourDismissed(storage?: StorageLike): boolean {
	const store = resolveStorage(storage);
	if (!store) return false;
	try {
		return store.getItem(ONBOARDING_TOUR_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

/** Persist the "don't show again" choice. */
export function dismissTour(storage?: StorageLike): void {
	const store = resolveStorage(storage);
	if (!store) return;
	try {
		store.setItem(ONBOARDING_TOUR_STORAGE_KEY, "1");
	} catch {
		/* storage unavailable — tour simply re-appears next visit */
	}
}

/** Clear the dismissal so the tour can be replayed (e.g. from a Help menu). */
export function resetTour(storage?: StorageLike): void {
	const store = resolveStorage(storage);
	if (!store) return;
	try {
		store.removeItem(ONBOARDING_TOUR_STORAGE_KEY);
	} catch {
		/* ignore */
	}
}

/** True when the tour should auto-open (first visit, not yet dismissed). */
export function shouldAutoStartTour(storage?: StorageLike): boolean {
	return !isTourDismissed(storage);
}
