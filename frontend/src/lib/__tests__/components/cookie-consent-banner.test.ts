import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "$lib/i18n";
import CookieConsent from "$lib/components/CookieConsent.svelte";
import { COOKIE_CONSENT_STORAGE_KEY } from "$lib/consent/cookie-consent";

beforeEach(() => {
	localStorage.removeItem(COOKIE_CONSENT_STORAGE_KEY);
	document.querySelectorAll("[data-test-modal]").forEach((node) => node.remove());
	vi.stubGlobal("ResizeObserver", class {
		observe() {}
		unobserve() {}
		disconnect() {}
	});
});

afterEach(() => {
	cleanup();
	localStorage.removeItem(COOKIE_CONSENT_STORAGE_KEY);
	document.querySelectorAll("[data-test-modal]").forEach((node) => node.remove());
	vi.unstubAllGlobals();
});

describe("CookieConsent banner", () => {
	it("defers below active app modals instead of blocking conflict recovery", async () => {
		const { container } = render(CookieConsent);

		await waitFor(() => expect(container.querySelector(".cc-root")).toBeTruthy());

		const modal = document.createElement("div");
		modal.dataset.testModal = "true";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		document.body.appendChild(modal);

		await waitFor(() => {
			const root = container.querySelector(".cc-root");
			expect(root?.classList.contains("cc-root--modal-deferred")).toBe(true);
			expect(root?.getAttribute("aria-hidden")).toBe("true");
		});

		modal.remove();

		await waitFor(() => {
			const root = container.querySelector(".cc-root");
			expect(root?.classList.contains("cc-root--modal-deferred")).toBe(false);
			expect(root?.hasAttribute("aria-hidden")).toBe(false);
		});
	});
});
