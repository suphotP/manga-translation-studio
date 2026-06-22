// Global-search open-state store.
//
// A tiny runed store holding only the search modal's visibility — mirroring
// `command-palette.svelte.ts` so ANY surface (a top-bar search field, the "/"
// accelerator, a future launcher) can open the global search without
// prop-drilling or grabbing a component instance. The `SearchModal.svelte`
// component subscribes to `open` and owns the heavier concerns (query, focus
// trap, result list, navigation).
//
// Search is intentionally SEPARATE from the Cmd-K command palette: the palette
// runs *actions* (navigate views, switch tool, sign out), while this finds
// *content* (the user's real projects/chapters + workspaces) and jumps to it.
// Keeping them in two stores lets each own its own accelerator ("/" vs "⌘K")
// and ARIA dialog without fighting over a single open flag.

class SearchStore {
	open = $state(false);

	openSearch(): void {
		this.open = true;
	}

	closeSearch(): void {
		this.open = false;
	}

	toggle(): void {
		this.open = !this.open;
	}
}

export const searchStore = new SearchStore();
