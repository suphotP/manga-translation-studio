import { describe, expect, it } from "vitest";
import { createPageRevisionId, saveSyncStatusLabel } from "$lib/project/page-revisions.js";
import type { Page } from "$lib/types.js";

function makePage(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "img-1",
		imageName: "image-01.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

describe("page revisions", () => {
	it("creates stable IDs for identical page content", () => {
		const page = makePage({
			textLayers: [{
				id: "layer-1",
				text: "Hello",
				x: 1,
				y: 2,
				w: 100,
				h: 50,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			}],
		});

		expect(createPageRevisionId(page, 0)).toBe(createPageRevisionId(structuredClone(page), 0));
	});

	it("changes when editable text changes", () => {
		const base = makePage({
			textLayers: [{
				id: "layer-1",
				text: "Hello",
				x: 1,
				y: 2,
				w: 100,
				h: 50,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			}],
		});
		const edited = structuredClone(base);
		edited.textLayers[0].text = "สวัสดี";

		expect(createPageRevisionId(base, 0)).not.toBe(createPageRevisionId(edited, 0));
	});

	it("changes when editable image layer geometry changes", () => {
		const base = makePage({
			imageLayers: [{
				id: "image-layer-1",
				imageId: "asset-1.png",
				imageName: "asset-1.png",
				originalName: "reference.png",
				x: 100,
				y: 120,
				w: 240,
				h: 100,
				rotation: 0,
				opacity: 1,
				visible: true,
				locked: false,
				index: 0,
				role: "reference",
			}],
		});
		const edited = structuredClone(base);
		edited.imageLayers![0].x = 140;
		edited.imageLayers![0].opacity = 0.55;

		expect(createPageRevisionId(base, 0)).not.toBe(createPageRevisionId(edited, 0));
	});

	it("changes when a non-default language track's text changes", () => {
		const base = makePage({
			textLayers: [{
				id: "layer-1",
				text: "ต้นฉบับ",
				x: 1,
				y: 2,
				w: 100,
				h: 50,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			}],
			languageOutputs: {
				en: {
					textLayers: [{
						id: "layer-1",
						text: "source",
						x: 1,
						y: 2,
						w: 100,
						h: 50,
						rotation: 0,
						fontSize: 24,
						alignment: "center",
						index: 0,
					}],
				},
			},
		});
		const edited = structuredClone(base);
		edited.languageOutputs!.en.textLayers[0].text = "translated";

		// A per-track edit (languageOutputs only; flat textLayers untouched) MUST
		// change the revision id, or autosave never fires and the edit is lost.
		expect(createPageRevisionId(base, 0)).not.toBe(createPageRevisionId(edited, 0));
	});

	it("is order-stable over languageOutputs (track + layer order does not matter)", () => {
		const layer = (id: string, text: string, index: number) => ({
			id,
			text,
			x: 1,
			y: 2,
			w: 100,
			h: 50,
			rotation: 0,
			fontSize: 24,
			alignment: "center" as const,
			index,
		});
		const a = makePage({
			languageOutputs: {
				en: { textLayers: [layer("l1", "a", 0), layer("l2", "b", 1)] },
				ja: { textLayers: [layer("l1", "x", 0)] },
			},
		});
		const b = makePage({
			languageOutputs: {
				ja: { textLayers: [layer("l1", "x", 0)] },
				en: { textLayers: [layer("l2", "b", 1), layer("l1", "a", 0)] },
			},
		});

		expect(createPageRevisionId(a, 0)).toBe(createPageRevisionId(b, 0));
	});

	it("back-compat: a default project with no languageOutputs has an unchanged revision", () => {
		// Pin the exact revision a legacy single-language page produced before the
		// languageOutputs fold-in existed. If this drifts, loading old projects would
		// flag a spurious "unsaved".
		const page = makePage({
			textLayers: [{
				id: "layer-1",
				text: "Hello",
				x: 1,
				y: 2,
				w: 100,
				h: 50,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			}],
		});

		expect(createPageRevisionId(page, 0)).toBe("p1-4d1bf420");
	});

	it.each(["name", "opacity", "charSpacing", "skewX", "skewY"] as const)(
		"marks the page dirty when the editable text prop %s changes (data-loss fix)",
		(prop) => {
			const base = makePage({
				textLayers: [{
					id: "layer-1",
					text: "Hello",
					x: 1,
					y: 2,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
			});
			const edited = structuredClone(base);
			// A non-default value for each previously-omitted editable prop.
			const value = prop === "name" ? "renamed" : prop === "opacity" ? 0.5 : 12;
			(edited.textLayers[0] as unknown as Record<string, unknown>)[prop] = value;

			// Editing any of these props MUST change the revision id, or autosave never
			// fires and the edit is silently lost on reload (same class as #291).
			expect(createPageRevisionId(base, 0)).not.toBe(createPageRevisionId(edited, 0));
		},
	);

	it.each([
		["opacity", 1],
		["charSpacing", 0],
		["skewX", 0],
		["skewY", 0],
	] as const)(
		"back-compat: setting %s to its render default does not dirty a legacy page",
		(prop, defaultValue) => {
			const legacy = makePage({
				textLayers: [{
					id: "layer-1",
					text: "Hello",
					x: 1,
					y: 2,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
			});
			const withExplicitDefault = structuredClone(legacy);
			(withExplicitDefault.textLayers[0] as unknown as Record<string, unknown>)[prop] = defaultValue;

			// A layer that explicitly carries the default value must hash identically to
			// a legacy layer that omits it — no spurious "unsaved" on load.
			expect(createPageRevisionId(withExplicitDefault, 0)).toBe(createPageRevisionId(legacy, 0));
		},
	);

	it("labels save states for compact UI badges", () => {
		expect(saveSyncStatusLabel("saved")).toBe("บันทึกแล้ว");
		expect(saveSyncStatusLabel("saving")).toBe("กำลังบันทึก");
		expect(saveSyncStatusLabel("unsaved")).toBe("ยังไม่บันทึก");
		expect(saveSyncStatusLabel("error")).toBe("บันทึกไม่สำเร็จ");
	});
});
