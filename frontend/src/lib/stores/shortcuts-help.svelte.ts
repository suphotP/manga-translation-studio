// Keyboard-shortcuts-help open-state store.
//
// A tiny runed store holding only the ShortcutsHelp modal's visibility —
// mirroring `command-palette.svelte.ts` / `search.svelte.ts`. Keeping it
// standalone lets ANY surface open the help: the global "?" accelerator, the
// command palette's `openShortcutsHelp` action, or a future menu item — without
// prop-drilling or grabbing the component instance.

class ShortcutsHelpStore {
	open = $state(false);

	openHelp(): void {
		this.open = true;
	}

	closeHelp(): void {
		this.open = false;
	}

	toggle(): void {
		this.open = !this.open;
	}
}

export const shortcutsHelpStore = new ShortcutsHelpStore();
