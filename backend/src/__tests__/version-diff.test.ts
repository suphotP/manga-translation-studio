import { describe, test, expect } from "bun:test";
import { applySelectiveRestore, computeVersionDiff } from "../services/version-diff.js";
import type { ProjectState, TextLayerData, ImageLayerData, ImageEditLayerData, PageState } from "../types/index.js";

function textLayer(overrides: Partial<TextLayerData> & { id: string }): TextLayerData {
	return {
		text: "",
		x: 0,
		y: 0,
		w: 100,
		h: 40,
		rotation: 0,
		fontSize: 16,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayerData> & { id: string }): ImageLayerData {
	return {
		imageId: "img-layer",
		imageName: "layer.png",
		x: 0,
		y: 0,
		w: 200,
		h: 200,
		rotation: 0,
		opacity: 1,
		index: 0,
		...overrides,
	};
}

function page(overrides: Partial<PageState> = {}): PageState {
	return {
		imageId: "img-page",
		imageName: "page.png",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function state(pages: PageState[], overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "p1",
		userId: "u1",
		name: "Demo",
		createdAt: new Date().toISOString(),
		pages,
		currentPage: 0,
		targetLang: "en",
		...overrides,
	};
}

describe("computeVersionDiff", () => {
	test("detects added/removed pages with deltas", () => {
		const base = state([page({ imageId: "a" })]);
		const target = state([page({ imageId: "a" }), page({ imageId: "b" })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.pageDelta).toBe(1);
		expect(diff.addedPageCount).toBe(1);
		expect(diff.removedPageCount).toBe(0);
		const added = diff.pages.find((p) => p.pageIndex === 1);
		expect(added?.status).toBe("added");
	});

	test("removed page is reported when base has more pages", () => {
		const base = state([page({ imageId: "a" }), page({ imageId: "b" })]);
		const target = state([page({ imageId: "a" })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.pageDelta).toBe(-1);
		expect(diff.removedPageCount).toBe(1);
		expect(diff.pages.find((p) => p.pageIndex === 1)?.status).toBe("removed");
	});

	test("detects text-layer add/remove/edit/move on a page", () => {
		const base = state([
			page({
				textLayers: [
					textLayer({ id: "t1", text: "hello", x: 0, y: 0 }),
					textLayer({ id: "t2", text: "world" }),
				],
			}),
		]);
		const target = state([
			page({
				textLayers: [
					textLayer({ id: "t1", text: "hi", x: 50, y: 10 }), // edited + moved
					textLayer({ id: "t3", text: "new" }), // added
					// t2 removed
				],
			}),
		]);
		const diff = computeVersionDiff(base, target);
		expect(diff.textLayerDelta).toBe(0);
		const pageDiff = diff.pages.find((p) => p.pageIndex === 0);
		expect(pageDiff?.status).toBe("changed");
		const byId = new Map(pageDiff!.layers.map((l) => [l.layerId, l]));
		expect(byId.get("t1")!.changes).toEqual(expect.arrayContaining(["edited", "moved"]));
		expect(byId.get("t1")!.textBefore).toBe("hello");
		expect(byId.get("t1")!.textAfter).toBe("hi");
		expect(byId.get("t3")!.changes).toEqual(["added"]);
		expect(byId.get("t2")!.changes).toEqual(["removed"]);
	});

	test("page image change is flagged even with no layer changes", () => {
		const base = state([page({ imageId: "orig" })]);
		const target = state([page({ imageId: "edited" })]);
		const diff = computeVersionDiff(base, target);
		const pageDiff = diff.pages.find((p) => p.pageIndex === 0);
		expect(pageDiff?.imageChanged).toBe(true);
		expect(pageDiff?.status).toBe("changed");
	});

	test("identical states report no changed pages", () => {
		const a = state([page({ textLayers: [textLayer({ id: "t1", text: "same" })] })]);
		const b = structuredClone(a);
		const diff = computeVersionDiff(a, b);
		expect(diff.changedPageCount).toBe(0);
		// Unchanged pages are omitted from the diff payload to keep it small.
		expect(diff.pages.find((p) => p.pageIndex === 0)).toBeUndefined();
	});

	test("detects image-layer moves and restyle", () => {
		const base = state([page({ imageLayers: [imageLayer({ id: "i1", opacity: 1 })] })]);
		const target = state([page({ imageLayers: [imageLayer({ id: "i1", opacity: 0.5, x: 40 })] })]);
		const diff = computeVersionDiff(base, target);
		const layer = diff.pages[0].layers.find((l) => l.layerId === "i1");
		expect(layer?.kind).toBe("image");
		expect(layer?.changes).toEqual(expect.arrayContaining(["moved", "restyled"]));
	});
});

describe("applySelectiveRestore", () => {
	test("no scope returns project scope without mutating inputs", () => {
		const current = state([page({ imageId: "cur" })]);
		const snapshot = state([page({ imageId: "snap" })]);
		const result = applySelectiveRestore(current, snapshot, {});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.scope).toBe("project");
		// current input untouched
		expect(current.pages[0].imageId).toBe("cur");
	});

	test("page scope swaps only the targeted page, preserving others", () => {
		const current = state([
			page({ imageId: "cur0", textLayers: [textLayer({ id: "a", text: "current0" })] }),
			page({ imageId: "cur1", textLayers: [textLayer({ id: "b", text: "current1" })] }),
		]);
		const snapshot = state([
			page({ imageId: "snap0", textLayers: [textLayer({ id: "a", text: "old0" })] }),
			page({ imageId: "snap1", textLayers: [textLayer({ id: "b", text: "old1" })] }),
		]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 1 });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.scope).toBe("page");
		// page 0 preserved from current
		expect(result.state.pages[0].imageId).toBe("cur0");
		expect(result.state.pages[0].textLayers[0].text).toBe("current0");
		// page 1 restored from snapshot
		expect(result.state.pages[1].imageId).toBe("snap1");
		expect(result.state.pages[1].textLayers[0].text).toBe("old1");
		// inputs untouched
		expect(current.pages[1].imageId).toBe("cur1");
	});

	test("layer scope restores a single text layer, keeping sibling layers + page image", () => {
		const current = state([
			page({
				imageId: "cur-image",
				textLayers: [
					textLayer({ id: "keep", text: "keep-current" }),
					textLayer({ id: "target", text: "current-text", x: 99 }),
				],
			}),
		]);
		const snapshot = state([
			page({
				imageId: "snap-image",
				textLayers: [
					textLayer({ id: "keep", text: "keep-old" }),
					textLayer({ id: "target", text: "old-text", x: 0 }),
				],
			}),
		]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 0, layerId: "target" });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.scope).toBe("layer");
		expect(result.restoredLayerKind).toBe("text");
		const restoredPage = result.state.pages[0];
		// page image stays current (not reverted)
		expect(restoredPage.imageId).toBe("cur-image");
		// sibling layer stays current
		expect(restoredPage.textLayers.find((l) => l.id === "keep")?.text).toBe("keep-current");
		// target layer reverted to snapshot
		const target = restoredPage.textLayers.find((l) => l.id === "target");
		expect(target?.text).toBe("old-text");
		expect(target?.x).toBe(0);
	});

	test("layer scope re-adds a layer that was deleted in current state", () => {
		const current = state([page({ textLayers: [textLayer({ id: "keep", text: "keep" })] })]);
		const snapshot = state([
			page({ textLayers: [textLayer({ id: "keep", text: "keep" }), textLayer({ id: "gone", text: "resurrected" })] }),
		]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 0, layerId: "gone" });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.state.pages[0].textLayers).toHaveLength(2);
		expect(result.state.pages[0].textLayers.find((l) => l.id === "gone")?.text).toBe("resurrected");
	});

	test("layer scope restores an image layer", () => {
		const current = state([page({ imageLayers: [imageLayer({ id: "i1", opacity: 1 })] })]);
		const snapshot = state([page({ imageLayers: [imageLayer({ id: "i1", opacity: 0.25 })] })]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 0, layerId: "i1" });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.restoredLayerKind).toBe("image");
		expect(result.state.pages[0].imageLayers?.[0].opacity).toBe(0.25);
	});

	test("rejects page index out of range in snapshot", () => {
		const current = state([page(), page()]);
		const snapshot = state([page()]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 1 });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("page_out_of_range");
	});

	test("rejects page index out of range in current project", () => {
		const current = state([page()]);
		const snapshot = state([page(), page()]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 1 });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("page_out_of_range");
	});

	test("rejects layer id present in neither snapshot nor current page", () => {
		const current = state([page({ textLayers: [textLayer({ id: "a", text: "x" })] })]);
		const snapshot = state([page({ textLayers: [textLayer({ id: "a", text: "y" })] })]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 0, layerId: "missing" });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("layer_not_found");
	});

	test("layer scope deletes a text layer added after the snapshot", () => {
		// Reverting an accidentally-added layer: it is absent in the older snapshot
		// but present now, so restoring the target state means removing it.
		const current = state([
			page({ textLayers: [textLayer({ id: "keep", text: "keep" }), textLayer({ id: "new", text: "oops" })] }),
		]);
		const snapshot = state([page({ textLayers: [textLayer({ id: "keep", text: "keep" })] })]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 0, layerId: "new" });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.restoredLayerKind).toBe("text");
		expect(result.state.pages[0].textLayers).toHaveLength(1);
		expect(result.state.pages[0].textLayers.find((l) => l.id === "new")).toBeUndefined();
		// sibling layer is untouched
		expect(result.state.pages[0].textLayers.find((l) => l.id === "keep")?.text).toBe("keep");
		// current state is not mutated
		expect(current.pages[0].textLayers).toHaveLength(2);
	});

	test("layer scope deletes an image layer added after the snapshot", () => {
		const current = state([
			page({ imageLayers: [imageLayer({ id: "base" }), imageLayer({ id: "new" })] }),
		]);
		const snapshot = state([page({ imageLayers: [imageLayer({ id: "base" })] })]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 0, layerId: "new" });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.restoredLayerKind).toBe("image");
		expect(result.state.pages[0].imageLayers).toHaveLength(1);
		expect(result.state.pages[0].imageLayers?.find((l) => l.id === "new")).toBeUndefined();
	});
});

// Phase C — non-destructive edit-layer (bubble-clean/brush/heal/clone) counts must
// surface in version diffs, and a page-scoped restore must round-trip the edit stack.
function editLayer(id: string, index: number): ImageEditLayerData {
	return {
		id,
		kind: "bubble-clean",
		target: "page-background",
		visible: true,
		opacity: 1,
		sourceImageId: "img-page",
		bbox: { x: 0, y: 0, w: 10, h: 10 },
		payload: { type: "fill-mask", maskAssetId: `${id}-mask`, maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } },
		index,
		tool: { id: "bubble-clean" },
		createdAt: new Date().toISOString(),
	};
}

describe("Phase C — edit-layer counts in version diff", () => {
	test("a page that gained edits is reported changed with edit-layer counts + delta", () => {
		const base = state([page({ imageEditLayers: [] })]);
		const target = state([page({ imageEditLayers: [editLayer("e1", 0), editLayer("e2", 1)] })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.editLayerDelta).toBe(2);
		const changed = diff.pages.find((p) => p.pageIndex === 0);
		expect(changed?.status).toBe("changed");
		expect(changed?.baseEditLayerCount).toBe(0);
		expect(changed?.targetEditLayerCount).toBe(2);
	});

	test("equal edit counts on an otherwise-identical page are unchanged", () => {
		const base = state([page({ imageEditLayers: [editLayer("e1", 0)] })]);
		const target = state([page({ imageEditLayers: [editLayer("e1", 0)] })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.editLayerDelta).toBe(0);
		expect(diff.changedPageCount).toBe(0);
	});

	// P1-3 (codex): same edit COUNT but a different edit IDENTITY/visibility/asset/bbox is
	// still a visual change — restoring it would repaint the page — so it must report changed.
	test("same edit count with a TOGGLED visibility is reported changed", () => {
		const base = state([page({ imageEditLayers: [editLayer("e1", 0)] })]);
		const hidden = { ...editLayer("e1", 0), visible: false };
		const target = state([page({ imageEditLayers: [hidden] })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.editLayerDelta).toBe(0); // counts equal
		expect(diff.changedPageCount).toBe(1);
		expect(diff.pages.find((p) => p.pageIndex === 0)?.status).toBe("changed");
	});

	test("same edit count with a SWAPPED mask asset is reported changed", () => {
		const base = state([page({ imageEditLayers: [editLayer("e1", 0)] })]);
		const swapped = {
			...editLayer("e1", 0),
			payload: { type: "fill-mask" as const, maskAssetId: "e1-mask-v2", maskEncoding: "png-alpha" as const, fill: { r: 255, g: 255, b: 255, a: 255 } },
		};
		const target = state([page({ imageEditLayers: [swapped] })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.editLayerDelta).toBe(0);
		expect(diff.changedPageCount).toBe(1);
	});

	test("same edit count with a MOVED bbox is reported changed", () => {
		const base = state([page({ imageEditLayers: [editLayer("e1", 0)] })]);
		const moved = { ...editLayer("e1", 0), bbox: { x: 50, y: 60, w: 10, h: 10 } };
		const target = state([page({ imageEditLayers: [moved] })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.editLayerDelta).toBe(0);
		expect(diff.changedPageCount).toBe(1);
	});

	test("same count but a DIFFERENT edit id (one swapped for another) is reported changed", () => {
		const base = state([page({ imageEditLayers: [editLayer("e1", 0)] })]);
		const target = state([page({ imageEditLayers: [editLayer("e2", 0)] })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.editLayerDelta).toBe(0);
		expect(diff.changedPageCount).toBe(1);
	});

	test("identical edit stacks remain unchanged (no false positive)", () => {
		const base = state([page({ imageEditLayers: [editLayer("e1", 0), editLayer("e2", 1)] })]);
		const target = state([page({ imageEditLayers: [editLayer("e1", 0), editLayer("e2", 1)] })]);
		const diff = computeVersionDiff(base, target);
		expect(diff.changedPageCount).toBe(0);
	});

	test("page-scoped restore round-trips the edit stack", () => {
		const current = state([page({ imageEditLayers: [editLayer("e1", 0), editLayer("e2", 1)] })]);
		const snapshot = state([page({ imageEditLayers: [editLayer("e1", 0)] })]);
		const result = applySelectiveRestore(current, snapshot, { pageIndex: 0 });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.scope).toBe("page");
		expect(result.state.pages[0].imageEditLayers).toHaveLength(1);
		expect(result.state.pages[0].imageEditLayers?.[0].id).toBe("e1");
	});
});
