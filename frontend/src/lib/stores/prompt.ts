// Prompt store — custom prompt dialog state
// Using writable store for compatibility

import { writable } from 'svelte/store';

interface PromptState {
	showDialog: boolean;
	text: string;
}

const initialState: PromptState = {
	showDialog: false,
	text: ''
};

function createPromptStore() {
	const { subscribe, set, update } = writable(initialState);

	return {
		subscribe,
		setText: (value: string) => update(s => ({ ...s, text: value })),
		open: () => set({ showDialog: true, text: '' }),
		close: () => update(s => ({ ...s, showDialog: false })),
		showDialog: false,
		text: ''
	};
}

export const promptStore = createPromptStore();
