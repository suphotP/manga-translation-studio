// Prompt store — custom prompt dialog state
// Svelte 5 class-based store

class PromptStore {
	showDialog = $state(false);
	text = $state("");

	setText(value: string): void {
		this.text = value;
	}

	open(): void {
		this.text = "";
		this.showDialog = true;
	}

	close(): void {
		this.showDialog = false;
	}
}

export const promptStore = new PromptStore();
