// Image-edit suite v1 (W3.13) — MaskBuffer singleton.
//
// A MaskBuffer holds the active pixel selection for the cleaning workbench as a
// single-channel `Uint8ClampedArray` in IMAGE-SPACE (one byte per native image
// pixel, 0 = unselected, 255 = fully selected, intermediate = feathered/partial).
//
// Every selection tool (Marquee, Lasso, Polygon, Magic Wand, Color Range) writes
// into this buffer; every refine tool (Grow/Contract/Feather) transforms it; and
// every paint tool (Healing, Clone) reads it to decide which pixels it may touch.
//
// The buffer is intentionally decoupled from Fabric/DOM so it is trivially
// unit-testable. Conversion to/from a canvas ImageData alpha channel is provided
// for tools that rasterise via the 2D context (Lasso, Polygon, Marquee path fill).

export type MaskCompositeMode = "replace" | "add" | "subtract" | "intersect";

export interface MaskBounds {
	minX: number;
	minY: number;
	maxX: number; // inclusive
	maxY: number; // inclusive
}

/** Listener fired whenever the mask contents change. */
export type MaskChangeListener = (mask: MaskBuffer) => void;

const EMPTY_BOUNDS: MaskBounds = { minX: 0, minY: 0, maxX: -1, maxY: -1 };

/**
 * Resolve which composite mode a pointer gesture implies from Photoshop-style
 * modifiers: Shift = add, Alt = subtract, Shift+Alt = intersect, none = replace.
 */
export function modeFromModifiers(mod: { shiftKey?: boolean; altKey?: boolean }): MaskCompositeMode {
	if (mod.shiftKey && mod.altKey) return "intersect";
	if (mod.shiftKey) return "add";
	if (mod.altKey) return "subtract";
	return "replace";
}

export class MaskBuffer {
	private _width = 0;
	private _height = 0;
	private _data: Uint8ClampedArray = new Uint8ClampedArray(0);
	private _bounds: MaskBounds = { ...EMPTY_BOUNDS };
	private _boundsDirty = false;
	private readonly listeners = new Set<MaskChangeListener>();

	get width(): number {
		return this._width;
	}
	get height(): number {
		return this._height;
	}
	get data(): Uint8ClampedArray {
		return this._data;
	}

	/** Reallocate (and clear) the buffer for a new page image size. */
	resize(width: number, height: number): void {
		const w = Math.max(0, Math.floor(width));
		const h = Math.max(0, Math.floor(height));
		if (w === this._width && h === this._height) {
			this.clear();
			return;
		}
		this._width = w;
		this._height = h;
		this._data = new Uint8ClampedArray(w * h);
		this._bounds = { ...EMPTY_BOUNDS };
		this._boundsDirty = false;
		this.emitChange();
	}

	/** True when no pixel is selected. */
	isEmpty(): boolean {
		const b = this.getBounds();
		return b.maxX < b.minX || b.maxY < b.minY;
	}

	clear(): void {
		this._data.fill(0);
		this._bounds = { ...EMPTY_BOUNDS };
		this._boundsDirty = false;
		this.emitChange();
	}

	/** Select everything (used by "Select All", Ctrl+A semantics). */
	selectAll(): void {
		this._data.fill(255);
		this._bounds = { minX: 0, minY: 0, maxX: this._width - 1, maxY: this._height - 1 };
		this._boundsDirty = false;
		this.emitChange();
	}

	at(x: number, y: number): number {
		if (x < 0 || y < 0 || x >= this._width || y >= this._height) return 0;
		return this._data[y * this._width + x];
	}

	/**
	 * Composite another single-channel buffer of the same dimensions into this
	 * mask. `src` values are treated as 0..255 alpha. Returns the dirty bounds.
	 */
	composite(src: Uint8ClampedArray | Uint8Array, mode: MaskCompositeMode = "replace"): MaskBounds {
		const n = this._width * this._height;
		if (src.length < n) {
			throw new Error(`MaskBuffer.composite: source length ${src.length} < ${n}`);
		}
		const dst = this._data;
		switch (mode) {
			case "replace":
				for (let i = 0; i < n; i++) dst[i] = src[i];
				break;
			case "add":
				for (let i = 0; i < n; i++) {
					if (src[i] > dst[i]) dst[i] = src[i];
				}
				break;
			case "subtract":
				for (let i = 0; i < n; i++) {
					if (src[i] > 0) {
						const remaining = dst[i] - src[i];
						dst[i] = remaining > 0 ? remaining : 0;
					}
				}
				break;
			case "intersect":
				for (let i = 0; i < n; i++) {
					dst[i] = src[i] < dst[i] ? src[i] : dst[i];
				}
				break;
		}
		this._boundsDirty = true;
		this.emitChange();
		return this.getBounds();
	}

	/** Replace the mask contents wholesale with a sized buffer (must match dims). */
	setData(data: Uint8ClampedArray | Uint8Array): void {
		const n = this._width * this._height;
		if (data.length !== n) {
			throw new Error(`MaskBuffer.setData: expected ${n} bytes, got ${data.length}`);
		}
		this._data.set(data);
		this._boundsDirty = true;
		this.emitChange();
	}

	/** Lazily recompute the tight bounding box of selected pixels. */
	getBounds(): MaskBounds {
		if (this._boundsDirty) {
			this.recomputeBounds();
			this._boundsDirty = false;
		}
		return this._bounds;
	}

	private recomputeBounds(): void {
		const { _width: w, _height: h, _data: d } = this;
		let minX = w;
		let minY = h;
		let maxX = -1;
		let maxY = -1;
		for (let y = 0; y < h; y++) {
			const row = y * w;
			for (let x = 0; x < w; x++) {
				if (d[row + x] > 0) {
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
		}
		this._bounds = maxX < 0 ? { ...EMPTY_BOUNDS } : { minX, minY, maxX, maxY };
	}

	/** Count of selected (alpha > 0) pixels. O(n); used by tools/tests. */
	countSelected(): number {
		let count = 0;
		const d = this._data;
		for (let i = 0; i < d.length; i++) if (d[i] > 0) count++;
		return count;
	}

	/**
	 * Export the mask as an RGBA ImageData-style buffer where alpha = mask value
	 * and RGB is a fixed tint. Used to paint the marching-ants/overlay preview and
	 * to feed OpenCV (single-channel) via the alpha channel.
	 */
	toRGBA(tint: [number, number, number] = [56, 189, 248]): Uint8ClampedArray {
		const n = this._width * this._height;
		const out = new Uint8ClampedArray(n * 4);
		const [r, g, b] = tint;
		const d = this._data;
		for (let i = 0; i < n; i++) {
			const o = i * 4;
			out[o] = r;
			out[o + 1] = g;
			out[o + 2] = b;
			out[o + 3] = d[i];
		}
		return out;
	}

	/** Copy of the single-channel data (defensive; for OpenCV Mat construction). */
	cloneData(): Uint8ClampedArray {
		return this._data.slice();
	}

	onChange(listener: MaskChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emitChange(): void {
		for (const l of this.listeners) l(this);
	}
}

/** Process-wide active selection shared by every tool. */
export const maskBuffer = new MaskBuffer();
