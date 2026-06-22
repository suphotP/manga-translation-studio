// Shared "is any app modal open" guard.
//
// Several surfaces open via a BARE-key global accelerator (no modifier): "/"
// opens SearchModal, "?" opens ShortcutsHelp. Each listens on the window, so
// nothing stops "/" from opening the search dialog *behind* an already-open
// ShortcutsHelp (or any other modal) — yielding two stacked aria-modal dialogs
// and letting focus land on the now-hidden search input. WCAG/ARIA expect a
// single modal in the focus context at a time.
//
// This helper answers one question: is an app modal already on screen? We probe
// the DOM for a visible `[aria-modal="true"]` dialog rather than coupling to any
// one store, so a global opener stays correct no matter which modal is up
// (CommandPalette, AuthModal, BulkImportDialog, library dialogs, …) — current or
// future. Global bare-key openers call `isAppModalOpen()` and bail when true.
//
// Note: this guards only ADDITIONAL opens. The modifier chord ⌘K still toggles
// the palette, and Escape (handled per-dialog) still closes the top dialog.

/** True when at least one visible `aria-modal="true"` dialog is mounted. */
export function isAppModalOpen(): boolean {
	if (typeof document === "undefined") return false;
	const dialogs = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
	for (const el of dialogs) {
		if (isVisible(el)) return true;
	}
	return false;
}

// An element counts as "open" only if it is actually rendered. Components that
// keep a hidden dialog in the tree (toggling `aria-modal`/`hidden`) would
// otherwise register as open; we skip anything display:none / visibility:hidden
// / [hidden]. `offsetParent === null` is a cheap, jsdom-safe visibility probe
// (also true for position:fixed, so we treat a missing offsetParent as visible
// when the element is not explicitly hidden).
function isVisible(el: HTMLElement): boolean {
	if (el.hidden) return false;
	const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
	if (style && (style.display === "none" || style.visibility === "hidden")) return false;
	return true;
}
