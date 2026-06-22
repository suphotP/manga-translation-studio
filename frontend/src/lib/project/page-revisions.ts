import type { ImageLayer, Page, PageLanguageOutput, TextLayer } from "$lib/types.js";
import { _ } from "$lib/i18n";
import { get } from "svelte/store";

export type SaveSyncStatus = "saved" | "saving" | "unsaved" | "error";

function stableTextLayer(layer: TextLayer) {
	// `name`, `opacity`, `charSpacing`, `skewX`, `skewY` are all editable via the
	// inspector / `MangaEditor.updateTextLayer`, but were historically MISSING from
	// this fingerprint — so editing any of them did NOT change the page revision id,
	// the page never went "unsaved", and the edit was silently lost on reload (same
	// data-loss CLASS as the per-language #291 r2 bug). They are folded in below.
	//
	// BACK-COMPAT: each new field is emitted ONLY when it differs from its render
	// default (name: absent; opacity: 1; charSpacing/skewX/skewY: 0). A legacy or
	// untouched layer therefore produces a byte-identical JSON to before this change
	// (JSON.stringify omits `undefined` keys) — no spurious "unsaved" on load — while
	// any real edit to a non-default value (or a change away from one) flips the hash.
	const opacity = layer.opacity ?? 1;
	const charSpacing = layer.charSpacing ?? 0;
	const skewX = layer.skewX ?? 0;
	const skewY = layer.skewY ?? 0;
	return {
		id: layer.id,
		name: layer.name || undefined,
		text: layer.text,
		sourceText: layer.sourceText,
		sourceCategory: layer.sourceCategory,
		sourceProvider: layer.sourceProvider,
		confidence: layer.confidence,
		protected: layer.protected,
		x: layer.x,
		y: layer.y,
		w: layer.w,
		h: layer.h,
		rotation: layer.rotation,
		opacity: opacity === 1 ? undefined : opacity,
		fontSize: layer.fontSize,
		charSpacing: charSpacing === 0 ? undefined : charSpacing,
		skewX: skewX === 0 ? undefined : skewX,
		skewY: skewY === 0 ? undefined : skewY,
		fontFamily: layer.fontFamily,
		fill: layer.fill,
		stroke: layer.stroke,
		strokeWidth: layer.strokeWidth,
		alignment: layer.alignment,
		visible: layer.visible,
		locked: layer.locked,
		index: layer.index,
		effects: layer.effects ?? null,
	};
}

function stableImageLayer(layer: ImageLayer) {
	return {
		id: layer.id,
		imageId: layer.imageId,
		imageName: layer.imageName,
		originalName: layer.originalName,
		x: layer.x,
		y: layer.y,
		w: layer.w,
		h: layer.h,
		rotation: layer.rotation,
		opacity: layer.opacity,
		visible: layer.visible,
		locked: layer.locked,
		index: layer.index,
		role: layer.role,
	};
}

/**
 * Per-language track text, folded into the revision fingerprint so an edit on a
 * NON-default Language Track (which writes to `page.languageOutputs[lang]`, not the
 * flat `page.textLayers`) actually changes the revision id → marks the page unsaved
 * → autosave/save persists it.
 *
 * BACK-COMPAT: a legacy / single-language page has no `languageOutputs`, so this
 * returns `undefined` and `JSON.stringify` omits the key entirely — the revision is
 * byte-identical to before this field existed (no spurious "unsaved" on load).
 *
 * Determinism: tracks are emitted as an array sorted by lang code, and each track's
 * text layers are sorted by (index, id) like the flat path, so reordering the map or
 * its layers does not change the fingerprint — only content does.
 */
function stableLanguageOutputs(
	outputs: Record<string, PageLanguageOutput> | undefined,
): Array<{ lang: string; textLayers: ReturnType<typeof stableTextLayer>[] }> | undefined {
	if (!outputs) return undefined;
	const langs = Object.keys(outputs).sort((a, b) => a.localeCompare(b));
	if (langs.length === 0) return undefined;
	return langs.map((lang) => ({
		lang,
		textLayers: [...(outputs[lang]?.textLayers ?? [])]
			.sort((a, b) => (a.index - b.index) || a.id.localeCompare(b.id))
			.map(stableTextLayer),
	}));
}

export function createPageRevisionSource(page: Page, pageIndex: number): string {
	return JSON.stringify({
		pageIndex,
		imageId: page.imageId,
		imageName: page.imageName,
		originalName: page.originalName,
		editImageId: page.edits?.imageId ?? null,
		coverRect: page.coverRect ?? null,
		textLayers: [...(page.textLayers ?? [])]
			.sort((a, b) => (a.index - b.index) || a.id.localeCompare(b.id))
			.map(stableTextLayer),
		imageLayers: [...(page.imageLayers ?? [])]
			.sort((a, b) => (a.index - b.index) || a.id.localeCompare(b.id))
			.map(stableImageLayer),
		languageOutputs: stableLanguageOutputs(page.languageOutputs),
	});
}

export function hashRevisionSource(source: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < source.length; i += 1) {
		hash ^= source.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createPageRevisionId(page: Page, pageIndex: number): string {
	return `p${pageIndex + 1}-${hashRevisionSource(createPageRevisionSource(page, pageIndex))}`;
}

function t(key: string, fallback: string): string {
	try {
		const translate = get(_);
		const value = translate(key);
		if (value && value !== key) return value;
	} catch {
		// Locale may be unavailable in isolated unit tests; fall back below.
	}
	return fallback;
}

export function saveSyncStatusLabel(status: SaveSyncStatus): string {
	const labels: Record<SaveSyncStatus, [string, string]> = {
		saved: ["pageRevisions.saveSyncStatus.saved", "บันทึกแล้ว"],
		saving: ["pageRevisions.saveSyncStatus.saving", "กำลังบันทึก"],
		unsaved: ["pageRevisions.saveSyncStatus.unsaved", "ยังไม่บันทึก"],
		error: ["pageRevisions.saveSyncStatus.error", "บันทึกไม่สำเร็จ"],
	};
	const [key, fallback] = labels[status];
	return t(key, fallback);
}
