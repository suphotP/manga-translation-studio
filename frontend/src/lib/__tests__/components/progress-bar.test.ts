import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import ProgressBar from "$lib/components/ui/ProgressBar.svelte";

describe("ProgressBar", () => {
	it("renders solid tone when no gradient is provided", () => {
		const { container } = render(ProgressBar, {
			props: {
				value: 45,
				tone: "green"
			}
		});

		const progressbar = container.querySelector('[role="progressbar"]');
		expect(progressbar).toBeTruthy();

		const fill = progressbar?.firstElementChild as HTMLElement;
		expect(fill).toBeTruthy();
		expect(fill.className).toContain("bg-ws-green");
		expect(fill.style.width).toBe("45%");
	});

	it("renders custom CSS gradient when gradient prop is set to a CSS gradient", () => {
		const { container } = render(ProgressBar, {
			props: {
				value: 70,
				gradient: "linear-gradient(90deg,#8b5cf6,#d946ef)"
			}
		});

		const progressbar = container.querySelector('[role="progressbar"]');
		expect(progressbar).toBeTruthy();

		const fill = progressbar?.firstElementChild as HTMLElement;
		expect(fill).toBeTruthy();
		expect(fill.className).not.toContain("bg-ws-cyan");
		expect(fill.className).not.toContain("bg-ws-green");
		
		expect(fill.style.width).toBe("70%");
		// Check that the style contains the gradient background (JSDOM normalizes to rgb)
		expect(fill.style.background).toContain("linear-gradient");
		expect(fill.style.background).toContain("rgb(139, 92, 246)");
		expect(fill.style.background).toContain("rgb(217, 70, 239)");
	});

	it("resolves named gradient tokens", () => {
		const { container } = render(ProgressBar, {
			props: {
				value: 85,
				gradient: "cyan-violet"
			}
		});

		const progressbar = container.querySelector('[role="progressbar"]');
		expect(progressbar).toBeTruthy();

		const fill = progressbar?.firstElementChild as HTMLElement;
		expect(fill).toBeTruthy();
		expect(fill.style.width).toBe("85%");
		
		expect(fill.style.background).toContain("linear-gradient");
		expect(fill.style.background).toContain("rgb(34, 211, 238)");
		expect(fill.style.background).toContain("rgb(139, 92, 246)");
	});
});
