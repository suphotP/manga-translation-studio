// Command palette open-state store.
//
// A tiny runed store that holds nothing but the palette's visibility. Keeping
// it separate from the CommandPalette.svelte component lets ANY surface (the
// top-bar search affordance, a keyboard shortcut mounted elsewhere, a future
// "?" help launcher) request the palette without prop-drilling or grabbing a
// component instance. The component itself subscribes to `open` and owns all
// the heavier concerns (query, focus trap, command list).

class CommandPaletteStore {
	open = $state(false);

	openPalette(): void {
		this.open = true;
	}

	closePalette(): void {
		this.open = false;
	}

	toggle(): void {
		this.open = !this.open;
	}
}

export const commandPaletteStore = new CommandPaletteStore();
