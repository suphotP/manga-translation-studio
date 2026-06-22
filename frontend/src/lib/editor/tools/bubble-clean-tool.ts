// Tool 9 — Bubble Auto-Clean (K) — the flagship "clean on the web" tool.
//
// Click INSIDE a speech bubble; we region-grow over the page bitmap from the
// click, BOUNDED by the bubble's dark line-art border (we stop wherever pixel
// luminance drops below a tunable edge threshold = the outline / text strokes).
// The grown region is the bubble INTERIOR. Because the dark JP text strokes are
// below the edge threshold, they start as "holes" inside the region; we then
// fill any hole that is fully enclosed by the interior (not reachable from the
// page border) so the text glyphs become part of the cleaned region too. A small
// grow/contract hugs the outline without leaving a halo. Finally we paint the
// region to clean paper — pure white #FFF by default, or the dominant light
// colour sampled near the bubble edge ("paper" mode).
//
// The result is committed exactly like the heal / clone tools: one
// `applyToolPatchInstant` patch (region-local) → one debounced background
// persist → ONE undoable BrushBackgroundCommand per click. No parallel
// persistence / undo path is invented.
//
// The pure `bubbleFillMask` + `sampleInteriorPaper` cores are exported
// separately so they can be unit-tested headless (no DOM / canvas).

import { getEditorShortcutForSuiteTool } from "$lib/editor-tools/keymap.js";
import {
	readSourceImageDataCached,
	computeMaskBounds,
	makeImageData,
	type PixelRegion,
} from "./raster.js";
import { dilateMask, erodeMask } from "./morphology.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

export type BubbleFillMode = "white" | "paper";

export interface BubbleCleanOptions {
	/**
	 * Edge / line-art luminance threshold (0..255). A pixel counts as bubble
	 * interior only when its luminance is >= this value; darker pixels are the
	 * outline / text strokes the fill must stop at. Manga bubbles are near-white
	 * paper with near-black ink, so ~140 cleanly separates the two by default.
	 */
	edgeThreshold: number;
	/** Paint the interior to pure white (#FFF) or the sampled dominant paper colour. */
	fillMode: BubbleFillMode;
	/**
	 * Grow (>0) / contract (<0) the filled region by this many px before painting,
	 * to hug the outline without leaving a 1px anti-aliased halo. Default +1 swallows
	 * the soft edge ring just inside the ink.
	 */
	grow: number;
	/**
	 * Safety cap: if the region exceeds this FRACTION of the whole page it almost
	 * certainly leaked past an open outline (or the click was outside a bubble), so
	 * we abort rather than repaint half the page. 0..1.
	 */
	maxAreaFraction: number;
}

const DEFAULT_OPTIONS: BubbleCleanOptions = {
	edgeThreshold: 140,
	fillMode: "white",
	grow: 1,
	maxAreaFraction: 0.6,
};

/** Rec.601 luma of an RGBA pixel at byte offset `o`. */
function lumaAt(data: Uint8ClampedArray | Uint8Array, o: number): number {
	return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
}

/**
 * Pure region-grow core. From the click (px,py), flood the connected set of
 * pixels whose luminance is >= `edgeThreshold` (the light bubble interior),
 * bounded by darker line-art. Then fill any enclosed dark holes (the JP text
 * strokes sitting inside the interior) so they join the cleaned region, and
 * apply the grow/contract. Returns a full single-channel image-space mask
 * (0/255), or `null` when the click is out of bounds, on a dark pixel, or the
 * region blew past the area cap (open outline / clicked outside a bubble).
 *
 * Uses an explicit scanline stack fill over a typed array — NOT recursion — so a
 * large interior stays O(area) and never overflows the call stack.
 */
export function bubbleFillMask(
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	px: number,
	py: number,
	opts: Pick<BubbleCleanOptions, "edgeThreshold" | "grow" | "maxAreaFraction">,
): Uint8ClampedArray | null {
	const x0 = Math.round(px);
	const y0 = Math.round(py);
	if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return null;
	const total = width * height;
	const threshold = clampThreshold(opts.edgeThreshold);

	// 1 = light interior pixel (>= threshold), 0 = dark edge/ink. Precompute once.
	const seedO = (y0 * width + x0) * 4;
	if (lumaAt(rgba, seedO) < threshold) return null; // clicked the outline / on text

	const maxArea = Math.max(1, Math.floor(total * clampFraction(opts.maxAreaFraction)));

	// `region` marks the flooded light interior. Scanline stack fill: push seed
	// spans, expand left/right to the run boundary (dark edge), then probe the
	// rows above/below for new light runs.
	const region = new Uint8ClampedArray(total);
	let area = 0;
	const isLight = (idx: number): boolean => lumaAt(rgba, idx * 4) >= threshold;

	// Stack of (x, y) seeds; each is expanded into a full scanline run.
	const stackX: number[] = [x0];
	const stackY: number[] = [y0];
	while (stackX.length > 0) {
		const sx = stackX.pop()!;
		const sy = stackY.pop()!;
		const rowBase = sy * width;
		if (region[rowBase + sx]) continue;
		if (!isLight(rowBase + sx)) continue;
		// Expand the run left and right along this row to the dark boundary.
		let left = sx;
		while (left - 1 >= 0 && !region[rowBase + left - 1] && isLight(rowBase + left - 1)) left--;
		let right = sx;
		while (right + 1 < width && !region[rowBase + right + 1] && isLight(rowBase + right + 1)) right++;
		for (let x = left; x <= right; x++) {
			region[rowBase + x] = 1;
			area++;
		}
		if (area > maxArea) return null; // leaked → abort (open outline / outside a bubble)
		// Probe the rows above and below for new light runs to seed.
		for (const ny of [sy - 1, sy + 1]) {
			if (ny < 0 || ny >= height) continue;
			const nRow = ny * width;
			let x = left;
			while (x <= right) {
				if (!region[nRow + x] && isLight(nRow + x)) {
					stackX.push(x);
					stackY.push(ny);
					// Skip to the end of this contiguous light run so we push it once.
					while (x <= right && isLight(nRow + x)) x++;
				} else {
					x++;
				}
			}
		}
	}

	// 2) Fill enclosed dark holes (the JP text strokes inside the bubble). A dark
	//    pixel that is NOT reachable from the image border through other dark
	//    pixels is enclosed by the interior, so it belongs to the cleaned region.
	//    Flood the dark pixels reachable from the border; everything dark left
	//    over is an interior hole → add it to the region.
	fillEnclosedHoles(rgba, width, height, region, threshold);

	// 3) Expand into 255 mask, then grow/contract to hug the outline (kill the
	//    1px anti-aliased halo just inside the ink).
	let mask: Uint8ClampedArray = new Uint8ClampedArray(total);
	for (let i = 0; i < total; i++) mask[i] = region[i] ? 255 : 0;
	const grow = Math.round(opts.grow);
	if (grow > 0) mask = dilateMask(mask, width, height, grow);
	else if (grow < 0) mask = erodeMask(mask, width, height, -grow);
	return mask;
}

/**
 * Mark interior holes (enclosed dark pixels = text strokes) into `region`.
 *
 * We flood the DARK pixels (luma < threshold) that touch the image border. Any
 * dark pixel NOT reached that way is enclosed by the light interior we already
 * flooded — i.e. a text glyph or interior ink island — so we add it to `region`.
 * Bounded to the interior's bounding box so it stays cheap. Pure scanline-ish
 * stack flood (typed-array `seenDark`), no recursion.
 */
function fillEnclosedHoles(
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	region: Uint8ClampedArray,
	threshold: number,
): void {
	// Bounding box of the interior (+1 margin) so the hole search is local.
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (region[row + x]) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return;
	const bx0 = Math.max(0, minX - 1);
	const by0 = Math.max(0, minY - 1);
	const bx1 = Math.min(width - 1, maxX + 1);
	const by1 = Math.min(height - 1, maxY + 1);

	const isDark = (idx: number): boolean => lumaAt(rgba, idx * 4) < threshold;
	// `seenDark` = dark pixels reachable from the bounding-box border (the OUTSIDE
	// ink, e.g. the bubble outline itself and the page). Anything dark + inside the
	// bbox + not seen is an enclosed hole.
	const seenDark = new Uint8Array(width * height);
	const stack: number[] = [];
	const pushIfBorderDark = (x: number, y: number) => {
		const idx = y * width + x;
		if (region[idx] || seenDark[idx] || !isDark(idx)) return;
		seenDark[idx] = 1;
		stack.push(idx);
	};
	// Seed from every border cell of the bbox.
	for (let x = bx0; x <= bx1; x++) {
		pushIfBorderDark(x, by0);
		pushIfBorderDark(x, by1);
	}
	for (let y = by0; y <= by1; y++) {
		pushIfBorderDark(bx0, y);
		pushIfBorderDark(bx1, y);
	}
	while (stack.length > 0) {
		const idx = stack.pop()!;
		const x = idx % width;
		const y = (idx - x) / width;
		// 4-connected neighbours within the bbox.
		if (x - 1 >= bx0) tryDark(x - 1, y);
		if (x + 1 <= bx1) tryDark(x + 1, y);
		if (y - 1 >= by0) tryDark(x, y - 1);
		if (y + 1 <= by1) tryDark(x, y + 1);
	}
	function tryDark(x: number, y: number) {
		const idx = y * width + x;
		if (region[idx] || seenDark[idx] || !isDark(idx)) return;
		seenDark[idx] = 1;
		stack.push(idx);
	}

	// Enclosed dark pixels (inside bbox, dark, not border-reachable) → interior.
	for (let y = by0; y <= by1; y++) {
		const row = y * width;
		for (let x = bx0; x <= bx1; x++) {
			const idx = row + x;
			if (!region[idx] && isDark(idx) && !seenDark[idx]) region[idx] = 1;
		}
	}
}

/**
 * Sample the dominant LIGHT colour just inside the bubble interior for "paper"
 * mode: average the RGB of the brightest interior pixels (the clean paper),
 * ignoring the darker text/edge pixels that the mask also covers. Falls back to
 * white when the mask is empty or no light pixels are found.
 */
export function sampleInteriorPaper(
	rgba: Uint8ClampedArray | Uint8Array,
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	threshold: number,
): [number, number, number] {
	let r = 0;
	let g = 0;
	let b = 0;
	let n = 0;
	const t = clampThreshold(threshold);
	const len = Math.min(mask.length, width * height);
	for (let i = 0; i < len; i++) {
		if (!mask[i]) continue;
		const o = i * 4;
		if (lumaAt(rgba, o) < t) continue; // skip text/edge pixels inside the mask
		r += rgba[o];
		g += rgba[o + 1];
		b += rgba[o + 2];
		n++;
	}
	if (n === 0) return [255, 255, 255];
	return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function clampThreshold(t: number): number {
	if (!Number.isFinite(t)) return DEFAULT_OPTIONS.edgeThreshold;
	return Math.min(255, Math.max(0, Math.round(t)));
}

function clampFraction(f: number): number {
	if (!Number.isFinite(f)) return DEFAULT_OPTIONS.maxAreaFraction;
	return Math.min(1, Math.max(0.01, f));
}

/**
 * Build the region-local RGBA patch that paints the masked interior to the fill
 * colour, leaving everything outside the mask as the original pixels. `base` and
 * `mask` are FULL image-space buffers; only `region` is read/written so the
 * per-click compute scales with the bubble size, not the whole page.
 */
export function paintFillRegion(
	base: ImageData,
	mask: Uint8ClampedArray,
	region: PixelRegion,
	fill: [number, number, number],
): ImageData {
	const { width } = base;
	const baseData = base.data;
	const out = new Uint8ClampedArray(region.width * region.height * 4);
	for (let y = 0; y < region.height; y++) {
		const sy = region.y + y;
		for (let x = 0; x < region.width; x++) {
			const sx = region.x + x;
			const si = sy * width + sx; // single-channel mask index
			const so = si * 4; // RGBA index into base
			const oo = (y * region.width + x) * 4;
			if (mask[si]) {
				out[oo] = fill[0];
				out[oo + 1] = fill[1];
				out[oo + 2] = fill[2];
				out[oo + 3] = 255;
			} else {
				out[oo] = baseData[so];
				out[oo + 1] = baseData[so + 1];
				out[oo + 2] = baseData[so + 2];
				out[oo + 3] = baseData[so + 3];
			}
		}
	}
	return makeImageData(out, region.width, region.height);
}

export interface BubbleCleanApi {
	options: BubbleCleanOptions;
}

export function createBubbleCleanTool(
	initial: Partial<BubbleCleanOptions> = {},
): EditorTool & BubbleCleanApi {
	const options: BubbleCleanOptions = { ...DEFAULT_OPTIONS, ...initial };

	// HISTORY-BOUNDARY (#367 P1) — onPointerDown fire-and-forgets clean(), so two
	// rapid clicks could overlap: click 2 would read the canvas + arm a fresh
	// debounce while click 1's commit is still in flight, letting them coalesce into
	// ONE undo command again. Serialise clicks on a single promise chain so each
	// click only starts AFTER the previous click has fully committed its own command
	// (currentImageUrl advanced, stroke-before snapshot reset). N rapid clicks then
	// produce N independent undo steps in reverse order. The chain never rejects
	// (errors are swallowed inside runClean's host calls) so one bad click can't
	// wedge the tool.
	let pending: Promise<void> = Promise.resolve();

	/**
	 * Run one bubble-clean at the image-space click and commit it as a single
	 * undoable background edit. Region-local read + paint + instant apply mirror
	 * the heal/clone instant-apply pipeline exactly (one patch → one persist → one
	 * BrushBackgroundCommand). Falls back to the legacy full-image commit when the
	 * host has no instant-apply support (test stubs).
	 */
	async function runClean(
		ctx: ToolContext,
		ix: number,
		iy: number,
		expectedEpoch: number | undefined,
	): Promise<void> {
		// Cached, epoch-keyed full-page read (Fix C): reused across clicks on the same
		// page so each click no longer pays the ~48 MB getImageData readback. Treated
		// read-only here (bubbleFillMask/sampleInteriorPaper read; the legacy path copies).
		const full = readSourceImageDataCached(
			ctx.sourceElement,
			ctx.imageWidth,
			ctx.imageHeight,
			ctx.host.getImageEpoch?.(),
		);
		if (!full) {
			ctx.host.setToolStatus?.("อ่านภาพไม่สำเร็จ ลองอีกครั้ง", "blocked");
			return;
		}
		const mask = bubbleFillMask(full.data, ctx.imageWidth, ctx.imageHeight, ix, iy, options);
		// null → click on the outline/text, out of bounds, or leaked past an open
		// border. No-op (no undo step pushed) so a stray click never repaints the page.
		if (!mask) {
			// #bubble-clean: was a SILENT no-op — the cleaner thought the tool was broken.
			ctx.host.setToolStatus?.("คลิกด้านในบอลลูนคำพูด — ไม่พบบอลลูนตรงจุดที่คลิก", "blocked");
			return;
		}
		const region = computeMaskBounds(mask, ctx.imageWidth, ctx.imageHeight, 1);
		if (!region) {
			ctx.host.setToolStatus?.("ไม่พบขอบเขตบอลลูนที่ใช้ได้ — ลองคลิกกลางบอลลูน", "blocked");
			return;
		}

		const fill: [number, number, number] =
			options.fillMode === "paper"
				? sampleInteriorPaper(full.data, mask, ctx.imageWidth, ctx.imageHeight, options.edgeThreshold)
				: [255, 255, 255];

		// NON-DESTRUCTIVE PATH (Phase A) — when the host supports edit layers, record the
		// clean as a tiny `ImageEditLayer` (alpha mask ROI asset + sampled fill + bbox)
		// instead of baking a full new page PNG. We still paint the ROI onto the live
		// backing canvas first for instant visual feedback, but DO NOT schedule the
		// full-image background persist; the edit layer (+ its small mask asset) is what
		// survives reload/export. One click = one edit layer (its own undo boundary is
		// added in a later phase; for now the layer is appended + saved via saveState).
		const canEditLayer = typeof ctx.host.commitImageEditLayer === "function";
		if (canEditLayer) {
			// Instant ROI preview (responsiveness) — paint the painted interior straight
			// onto the live canvas so the user sees the clean immediately. This is a
			// transient preview: it is NOT persisted as a page background (no
			// scheduleBackgroundPersist); the host's edit-composite cache repaint after
			// commit is the durable visual.
			const canPreview = typeof ctx.host.applyToolPatchInstant === "function";
			if (canPreview) {
				const patch = paintFillRegion(full, mask, region, fill);
				ctx.host.applyToolPatchInstant!(patch, region as PixelRegion, expectedEpoch, { preview: true });
			}
			// Extract the alpha-only ROI mask (single channel) so the host uploads only
			// the tiny bubble region, not a full-page buffer.
			const roiMask = new Uint8ClampedArray(region.width * region.height);
			for (let y = 0; y < region.height; y++) {
				const srcRow = (region.y + y) * ctx.imageWidth + region.x;
				const dstRow = y * region.width;
				for (let x = 0; x < region.width; x++) roiMask[dstRow + x] = mask[srcRow + x];
			}
			// P1-a DATA-SAFETY — the commit (mask upload + save-side append) can FAIL /
			// return false (network/upload/quota). The instant ROI paint above is only a
			// PREVIEW; if the commit did not persist we must NOT leave the user staring at
			// a cleaned bubble that silently vanishes on reload/export. So treat the clean
			// as done ONLY when commitImageEditLayer returns truthy. On failure REVERT the
			// preview (repaint the ORIGINAL ROI pixels) so the visual matches what was
			// actually saved; the host/store already surfaces the error toast/banner.
			const recorded = await ctx.host.commitImageEditLayer!({
				mask: roiMask,
				region: region as PixelRegion,
				fill: { r: fill[0], g: fill[1], b: fill[2], a: 255 },
				tool: { id: "bubble-clean" },
			});
			if (!recorded && canPreview) {
				// Repaint the untouched original ROI to undo the transient preview. An
				// all-zero mask makes paintFillRegion copy the base pixels verbatim. Reuse
				// the same epoch guard so a stale revert can't land on a page that has
				// since advanced (the host drops it if the epoch moved).
				const revertMask = new Uint8ClampedArray(ctx.imageWidth * ctx.imageHeight);
				const revert = paintFillRegion(full, revertMask, region, fill);
				ctx.host.applyToolPatchInstant!(revert, region as PixelRegion, expectedEpoch, { preview: true, skipSnapshot: true });
			}
			return;
		}
	}

	const tool: EditorTool & BubbleCleanApi = {
		id: "bubble-clean",
		label: "Bubble Auto-Clean",
		icon: "◌",
		shortcut: getEditorShortcutForSuiteTool("bubble-clean"),
		kind: "paint",
		options,

		activate() {},
		deactivate() {},

		// One click = one bounded fill = one undoable step. Pointer move/up are no-ops
		// (this is a click tool, not a drag-stroke tool). Clicks are serialised on the
		// `pending` chain so rapid clicks each commit as their own undo step (see above).
		onPointerDown(ctx: ToolContext, event: ToolPointerEvent) {
			const ix = event.image.x;
			const iy = event.image.y;
			// STALE-PATCH EPOCH GUARD (#367 P1, round 4) — snapshot the backing-canvas
			// epoch at the moment the click STARTS (NOT inside runClean, which runs later
			// on the serialised `pending` chain and may begin AFTER a page switch). The
			// page bitmap we are about to read + the patch we build belong to THIS epoch;
			// passing it into applyToolPatchInstant lets the host discard the patch if the
			// page/image advanced before it lands (mirrors how brush/heal/clone capture
			// their epoch at gesture start). `undefined` on hosts without getImageEpoch
			// (test stubs) → no guard, patch applies as before.
			const epoch = ctx.host.getImageEpoch?.();
			pending = pending.then(() => runClean(ctx, ix, iy, epoch)).catch(() => {});
			// NAV/TEARDOWN DRAIN (#367 P1) — runClean() reads the canvas + commits
			// ASYNCHRONOUSLY, but this onPointerDown returns void, so the queued/in-flight
			// commit is invisible to the registry's `commitInFlight` (it only tracks the
			// promise returned from onPointerUp) AND, until runClean reaches the debounced
			// persist gate, to `pendingBrushCommits`. A page-switch / project-load /
			// teardown in that window would NOT wait → the bubble-clean edit could be
			// dropped or committed onto the WRONG page (the #248/#255/#358 wrong-page bug).
			// Register THIS click's pending op with the host's nav/teardown drain RIGHT NOW
			// (synchronously) so navigation awaits it before advancing currentPage / loading
			// a new image — the commit then lands on the page it started on, or its stale
			// patch is discarded by applyToolPatchInstant's epoch guard. No-op on hosts
			// without instant-apply backing (test stubs that omit trackInstantToolCommit).
			ctx.host.trackInstantToolCommit?.(pending);
			void pending;
		},
		onPointerMove() {},
		onPointerUp() {},
	};

	return tool;
}
