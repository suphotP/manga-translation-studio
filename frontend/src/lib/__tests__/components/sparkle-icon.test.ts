import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import SparkleIcon from "$lib/components/ui/SparkleIcon.svelte";

const SPARKLE_PATH = "M12 6l1.6 4.4L18 12l-4.4 1.6L12 18l-1.6-4.4L6 12l4.4-1.6z";

describe("SparkleIcon", () => {
	it("renders the symmetrical four-point AI sparkle by default", () => {
		const { container } = render(SparkleIcon);

		const svg = container.querySelector("svg");
		const path = container.querySelector("path");

		expect(svg?.getAttribute("width")).toBe("12");
		expect(svg?.getAttribute("height")).toBe("12");
		expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
		expect(svg?.getAttribute("fill")).toBe("none");
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
		expect(path?.getAttribute("d")).toBe(SPARKLE_PATH);
		expect(path?.getAttribute("fill")).toBe("currentColor");
		expect(path?.hasAttribute("fill-opacity")).toBe(false);
	});

	it("keeps explicit size zero instead of falling back to the default", () => {
		const { container } = render(SparkleIcon, {
			props: { size: 0 }
		});

		const svg = container.querySelector("svg");
		expect(svg?.getAttribute("width")).toBe("0");
		expect(svg?.getAttribute("height")).toBe("0");
	});

	it("passes custom fill, fill opacity, and CSS class through to the rendered svg", () => {
		const { container } = render(SparkleIcon, {
			props: {
				size: 17,
				fill: "#22d3ee",
				fillOpacity: 0.9,
				class: "text-ws-accent"
			}
		});

		const svg = container.querySelector("svg");
		const path = container.querySelector("path");

		expect(svg?.getAttribute("class")).toBe("text-ws-accent");
		expect(svg?.getAttribute("width")).toBe("17");
		expect(svg?.getAttribute("height")).toBe("17");
		expect(path?.getAttribute("fill")).toBe("#22d3ee");
		expect(path?.getAttribute("fill-opacity")).toBe("0.9");
		expect(path?.getAttribute("d")).toBe(SPARKLE_PATH);
	});
});
