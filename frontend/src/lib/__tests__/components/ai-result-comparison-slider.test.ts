import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import "$lib/i18n";
import AiResultComparisonSlider from "$lib/components/AiResultComparisonSlider.svelte";

// signedAssetSrc (used by the slider when *Params are supplied) imports these
// from the API client. Mock them so the action can mint a signed assetToken in
// the test without a real backend. signedAssetUrl mirrors the real impl: append
// ?assetToken=… to a backend URL, return blob:/data: URLs unchanged.
const signedAssetUrl = vi.fn(
	async (url: string, _projectId: string, _imageId: string, _purpose: string) => {
		if (url.startsWith("blob:") || url.startsWith("data:")) return url;
		const separator = url.includes("?") ? "&" : "?";
		return `${url}${separator}assetToken=tok-test`;
	},
);
const invalidateAssetToken = vi.fn();

vi.mock("$lib/api/client.js", () => ({
	signedAssetUrl: (...args: unknown[]) => (signedAssetUrl as unknown as (...a: unknown[]) => unknown)(...args),
	invalidateAssetToken: (...args: unknown[]) => invalidateAssetToken(...args),
}));

describe("AiResultComparisonSlider", () => {
	beforeEach(() => {
		signedAssetUrl.mockClear();
		invalidateAssetToken.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders before and after images inside a bounded frame", () => {
		const { container } = render(AiResultComparisonSlider, {
			props: { beforeUrl: "https://cdn.test/before.webp", afterUrl: "https://cdn.test/after.webp" },
		});

		const before = container.querySelector(".ai-result-before") as HTMLImageElement;
		const after = container.querySelector(".ai-result-after") as HTMLImageElement;
		expect(before.getAttribute("src")).toBe("https://cdn.test/before.webp");
		expect(after.getAttribute("src")).toBe("https://cdn.test/after.webp");

		// The frame is the bounded container — the result never renders full-size.
		const frame = container.querySelector(".ai-result-frame");
		expect(frame).toBeTruthy();
	});

	it("starts at the midpoint and reveals more of the AI result as the slider moves", async () => {
		const { container } = render(AiResultComparisonSlider, {
			props: { beforeUrl: "before", afterUrl: "after" },
		});

		const range = container.querySelector(".ai-result-range") as HTMLInputElement;
		const afterWrap = container.querySelector(".ai-result-after-wrap") as HTMLElement;
		expect(range.value).toBe("50");
		expect(afterWrap.getAttribute("style")).toContain("inset(0 0 0 50%)");

		await fireEvent.input(range, { target: { value: "80" } });
		expect(afterWrap.getAttribute("style")).toContain("inset(0 0 0 80%)");

		const divider = container.querySelector(".ai-result-divider") as HTMLElement;
		expect(divider.getAttribute("style")).toContain("left: 80%");
	});

	it("uses provided before/after labels", () => {
		const { getByText } = render(AiResultComparisonSlider, {
			props: { beforeUrl: "b", afterUrl: "a", beforeLabel: "Source", afterLabel: "AI" },
		});
		expect(getByText("Source")).toBeTruthy();
		expect(getByText("AI")).toBeTruthy();
	});

	it("loads owned-project assets through a signed assetToken instead of a bare 401-prone URL", async () => {
		// The regression: an owned-project AI result rendered via a raw <img src> of
		// /api/images/<projectId>/result_<uuid>.png 401s because a browser <img>
		// cannot send the Authorization header. When *Params are supplied the slider
		// must route the load through signedAssetSrc, which appends a signed token.
		const { container } = render(AiResultComparisonSlider, {
			props: {
				beforeUrl: "/api/images/project-1/image-1.webp",
				afterUrl: "/api/images/project-1/result_abc.png",
				beforeParams: {
					projectId: "project-1",
					imageId: "image-1.webp",
					url: "/api/images/project-1/image-1.webp",
					purpose: "editor_preview",
				},
				afterParams: {
					projectId: "project-1",
					imageId: "result_abc.png",
					url: "/api/images/project-1/result_abc.png",
					purpose: "editor_preview",
				},
			},
		});

		// The action mints tokens asynchronously; let microtasks + reactivity settle.
		await tick();
		await Promise.resolve();
		await tick();

		const before = container.querySelector(".ai-result-before") as HTMLImageElement;
		const after = container.querySelector(".ai-result-after") as HTMLImageElement;

		// Tokens were requested for the AI-result asset with the editor_preview scope.
		expect(signedAssetUrl).toHaveBeenCalledWith(
			"/api/images/project-1/result_abc.png",
			"project-1",
			"result_abc.png",
			"editor_preview",
			false,
		);

		// The rendered src carries the signed token — never a bare 401-prone URL.
		expect(before.getAttribute("src")).toBe("/api/images/project-1/image-1.webp?assetToken=tok-test");
		expect(after.getAttribute("src")).toBe("/api/images/project-1/result_abc.png?assetToken=tok-test");
	});

	it("shows an inline fallback (not a broken image) when a signed result load fails after retry", async () => {
		const { container } = render(AiResultComparisonSlider, {
			props: {
				beforeUrl: "/api/images/project-1/image-1.webp",
				afterUrl: "/api/images/project-1/result_abc.png",
				afterParams: {
					projectId: "project-1",
					imageId: "result_abc.png",
					url: "/api/images/project-1/result_abc.png",
					purpose: "editor_preview",
				},
			},
		});

		await tick();
		await Promise.resolve();
		await tick();

		const after = container.querySelector(".ai-result-after") as HTMLImageElement;
		// First error → action re-mints once (token-expiry recovery).
		await fireEvent.error(after);
		await tick();
		await Promise.resolve();
		await tick();
		// Second error after the single retry is a definitive failure → onFailed.
		await fireEvent.error(after);
		await tick();

		expect(invalidateAssetToken).toHaveBeenCalled();
		// The broken-image glyph is suppressed and a localized note is shown instead.
		expect(after.classList.contains("ai-result-failed")).toBe(true);
		expect(container.textContent).toContain("โหลดผล AI ไม่สำเร็จ");
	});
});
