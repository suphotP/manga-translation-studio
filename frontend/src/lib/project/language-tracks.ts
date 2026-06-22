// Per-language "Language Track" accessors (Shape B, additive — see types.ts).
//
// A Language Track is the pair (projectId, targetLang). Translation, typeset and
// QC output is per-language, so each page can carry a `languageOutputs` map keyed
// by target language. Existing single-language data never populates that map; the
// legacy flat `Page.textLayers` / `translationScriptSlots` / handoffs are treated
// as the project's DEFAULT-language track. These helpers hide that backfill so
// un-migrated pages render exactly as the default-lang track.
//
// Cleaning is deliberately NOT per-language: the cleaned raster is shared across
// all target languages, so `Page.cleaningHandoff` stays project/source-level and
// is never read through these accessors.
//
// PURE module: no store import, no side effects. Functions never mutate inputs.

import type {
	ImageLayer,
	Page,
	PageLanguageOutput,
	PageQcHandoff,
	PageTranslationHandoff,
	ProjectState,
	TextLayer,
	TranslationScriptSlot,
} from "$lib/types.js";

/**
 * The list of active Language Tracks for a project.
 *
 * Backfill: absent `targetLangs` (single-language / legacy projects) resolves to
 * `[targetLang]`. The default track is always the project's `targetLang`. The
 * returned array is a fresh copy (safe to keep / iterate) and the default lang is
 * guaranteed present and first.
 */
export function listTracks(state: Pick<ProjectState, "targetLang" | "targetLangs">): string[] {
	const defaultLang = state.targetLang;
	const declared = state.targetLangs;
	if (!Array.isArray(declared) || declared.length === 0) {
		return [defaultLang];
	}
	// De-dupe while preserving order, and guarantee the default lang leads.
	const seen = new Set<string>();
	const ordered: string[] = [];
	const push = (lang: string) => {
		if (!seen.has(lang)) {
			seen.add(lang);
			ordered.push(lang);
		}
	};
	push(defaultLang);
	for (const lang of declared) {
		push(lang);
	}
	return ordered;
}

/**
 * The currently selected Language Track for the UI.
 *
 * Backfill: absent `activeTargetLang` resolves to `targetLang`. If the stored
 * selection is no longer an active track it is clamped back to the default lang,
 * so callers always receive a track that exists in `listTracks(state)`.
 */
export function activeTrack(
	state: Pick<ProjectState, "targetLang" | "targetLangs" | "activeTargetLang">,
): string {
	const active = state.activeTargetLang;
	if (!active) {
		return state.targetLang;
	}
	return listTracks(state).includes(active) ? active : state.targetLang;
}

/** True when `lang` is the project's default Language Track. */
export function isDefaultTrack(
	state: Pick<ProjectState, "targetLang">,
	lang: string,
): boolean {
	return lang === state.targetLang;
}

/**
 * The page's output bucket for a given Language Track.
 *
 * - If the page carries an explicit `languageOutputs[lang]` bucket, it is returned
 *   as-is (the migrated multi-track shape).
 * - Otherwise the legacy flat fields (`page.textLayers` etc.) are returned as a
 *   read-only VIEW so an un-migrated page renders as whichever lang is asked for.
 *   This backfill is intentionally lang-agnostic: legacy single-language pages have
 *   exactly one track, so the flat fields stand in for it regardless of `lang`.
 *
 * The returned object is never the live page object; mutating it must not be relied
 * upon to mutate page state (this module is pure — writes belong in the store).
 */
export function pageOutput(page: Page, lang: string): PageLanguageOutput {
	const explicit = page.languageOutputs?.[lang];
	if (explicit) {
		return explicit;
	}
	return legacyTrackView(page);
}

/**
 * Whether a page has a materialized (explicit) bucket for the given track. Legacy
 * pages backfilled via the flat fields return `false` — useful for "needs migration"
 * checks or deciding whether to lazily materialize a bucket in the store.
 */
export function hasMaterializedTrack(page: Page, lang: string): boolean {
	return Boolean(page.languageOutputs && Object.prototype.hasOwnProperty.call(page.languageOutputs, lang));
}

/**
 * Whether a page carries a real `languageOutputs[lang]` record (a non-null object).
 *
 * This is the CLIENT mirror of the backend export pipeline's `languageOutputForPage`
 * readiness check (`backend/src/services/export-pipeline.ts`): an explicit non-default
 * language track is only exportable for a page when that page has a genuine output
 * bucket for it. Without one, rendering would silently fall back to the flat/source
 * (default-language) layout and export the WRONG language. Client and server MUST
 * agree on what "missing output" means, so this matches the backend's notion (a
 * truthy record, not merely an own-property) rather than `hasMaterializedTrack`.
 */
export function hasLanguageOutput(page: Page, lang: string | undefined): boolean {
	if (!lang) return false;
	const output = page.languageOutputs?.[lang];
	return Boolean(output) && typeof output === "object";
}

/**
 * A read-only view of a page's legacy flat fields as a `PageLanguageOutput`.
 *
 * This is the backfill accessor: it treats an absent `languageOutputs` as the
 * project's default track. Optional handoffs/slots are carried through as-is
 * (absent stays absent). `textLayers` falls back to an empty array if the page
 * somehow lacks the (non-optional) field.
 */
export function legacyTrackView(page: Page): PageLanguageOutput {
	const view: PageLanguageOutput = {
		textLayers: page.textLayers ?? ([] as TextLayer[]),
	};
	if (page.translationScriptSlots !== undefined) {
		view.translationScriptSlots = page.translationScriptSlots as TranslationScriptSlot[];
	}
	if (page.translationHandoff !== undefined) {
		view.translationHandoff = page.translationHandoff as PageTranslationHandoff;
	}
	if (page.qcHandoff !== undefined) {
		view.qcHandoff = page.qcHandoff as PageQcHandoff;
	}
	return view;
}

/**
 * The text layers for a page in a given track. Convenience over `pageOutput`,
 * always returns an array (never undefined).
 */
export function trackTextLayers(page: Page, lang: string): TextLayer[] {
	return pageOutput(page, lang).textLayers ?? [];
}

/**
 * The translation script slots for a page in a given track, or an empty array.
 */
export function trackScriptSlots(page: Page, lang: string): TranslationScriptSlot[] {
	return pageOutput(page, lang).translationScriptSlots ?? [];
}

/**
 * The image layers to render for a page in a given Language Track.
 *
 * Mirrors the backend export pipeline's `resolveExportImageLayers`
 * (`backend/src/services/export-pipeline.ts`): when the page carries an explicit
 * `languageOutputs[lang].imageLayers` array, that per-language override is used;
 * otherwise it falls back to the flat `page.imageLayers`. The fallback covers BOTH
 * an un-materialized track (no `languageOutputs[lang]` at all) AND a materialized
 * track that overrides text but NOT images — in either case the shared/source image
 * stack is the right one, so client and server composite the SAME image layers.
 *
 * `imageLayers` is not (yet) declared on `PageLanguageOutput`, so it is read
 * defensively off the raw bucket — exactly as the backend reads it off the raw
 * `languageOutputs[track]` record. Never mutates the page; returns the array as-is
 * (callers apply the visible/z-order filter, identical to text resolution).
 */
export function trackImageLayers(page: Page, lang: string): ImageLayer[] {
	const explicit = page.languageOutputs?.[lang] as { imageLayers?: unknown } | undefined;
	const override = explicit?.imageLayers;
	if (Array.isArray(override)) return override as ImageLayer[];
	return page.imageLayers ?? [];
}

// ---------------------------------------------------------------------------
// Write-side helpers (the store mutates pages through these so the per-language
// materialization rules live in ONE pure place). These build the NEXT value for
// a field; the caller assigns it onto the live page. They never mutate inputs.
// ---------------------------------------------------------------------------

/**
 * Whether writes for `lang` should go to the flat legacy fields (`page.textLayers`
 * …) rather than a `languageOutputs[lang]` bucket.
 *
 * The DEFAULT track always writes flat — that keeps single-language / legacy
 * projects byte-identical (no `languageOutputs` is ever created for them). Only a
 * NON-default track materializes a per-language bucket.
 */
export function trackWritesFlat(
	state: Pick<ProjectState, "targetLang">,
	lang: string,
): boolean {
	return isDefaultTrack(state, lang);
}

/**
 * Deep-ish copy of a text layer for seeding a new track. Positions/styles are
 * carried verbatim; the text content is COPIED as the translator's starting point
 * (the product decision: a new track seeds from the source layout, not blank).
 * IDs are preserved so a layer keeps a stable identity across tracks (each track
 * owns its own copy of that id's content).
 */
function cloneTextLayerForSeed(layer: TextLayer): TextLayer {
	return { ...layer };
}

/**
 * Build the `languageOutputs[lang]` bucket to use when a NON-default track is
 * first touched (switch or edit) and has no materialized bucket yet. It SEEDS
 * from the page's default/source layout (the flat fields) so a translator starts
 * with the same boxes/positions/styles and copied text, then edits in place.
 *
 * Returns a fresh bucket; does not mutate the page.
 */
export function seedTrackOutput(page: Page): PageLanguageOutput {
	const source = legacyTrackView(page);
	const seeded: PageLanguageOutput = {
		textLayers: source.textLayers.map(cloneTextLayerForSeed),
	};
	if (source.translationScriptSlots !== undefined) {
		seeded.translationScriptSlots = source.translationScriptSlots.map((slot) => ({ ...slot }));
	}
	// Handoffs are workflow state, not layout — a fresh track starts without them
	// so its translation/QC status is independent of the source track.
	return seeded;
}

/**
 * Build the NEXT `languageOutputs` record for a page after writing `textLayers`
 * into the given NON-default track. If the track has no bucket yet it is seeded
 * (so existing per-track slots/handoffs are preserved on subsequent writes).
 *
 * Returns a fresh `Record` (the caller assigns it onto `page.languageOutputs`);
 * never mutates the page or its existing buckets.
 */
/**
 * Build the NEXT `languageOutputs` after writing translation SCRIPT SLOTS into a
 * non-default track — the script-slot twin of {@link writeTrackTextLayers}.
 */
export function writeTrackScriptSlots(
	page: Page,
	lang: string,
	slots: TranslationScriptSlot[],
): Record<string, PageLanguageOutput> {
	const existing = page.languageOutputs ?? {};
	const base = existing[lang] ?? seedTrackOutput(page);
	return {
		...existing,
		[lang]: {
			...base,
			translationScriptSlots: slots,
		},
	};
}

/**
 * Build the NEXT `languageOutputs` after writing the translation HANDOFF state
 * into a non-default track.
 */
export function writeTrackTranslationHandoff(
	page: Page,
	lang: string,
	handoff: PageTranslationHandoff,
): Record<string, PageLanguageOutput> {
	const existing = page.languageOutputs ?? {};
	const base = existing[lang] ?? seedTrackOutput(page);
	return {
		...existing,
		[lang]: {
			...base,
			translationHandoff: handoff,
		},
	};
}

export function writeTrackTextLayers(
	page: Page,
	lang: string,
	textLayers: TextLayer[],
): Record<string, PageLanguageOutput> {
	const existing = page.languageOutputs ?? {};
	const base = existing[lang] ?? seedTrackOutput(page);
	return {
		...existing,
		[lang]: {
			...base,
			textLayers,
		},
	};
}
