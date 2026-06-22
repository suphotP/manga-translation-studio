<!-- PromptDialog — custom prompt modal, pure UI. ws design system + shared Dialog atom (W3.4). -->
<script lang="ts">
	import { promptStore } from "$lib/stores/prompt.ts";
	import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { _ } from "svelte-i18n";
	import Dialog from "$lib/components/ui/Dialog.svelte";

	// Safeguard for i18n not being ready. `$_` is the svelte-i18n message
	// formatter (a function); the dynamic group lookup is intentionally
	// best-effort and falls back to the inline defaults when absent.
	let t = $derived(($_ as unknown as Record<string, Record<string, string>>).promptDialog || {
		title: "Custom Prompt",
		placeholder: "Additional instructions for AI...",
		cancel: "Cancel",
		send: "Send"
	});

	let showDialog = $state(false);
	let text = $state("");

	// Subscribe to prompt store changes
	promptStore.subscribe(state => {
		showDialog = state.showDialog;
		text = state.text;
	});

	function handleSend() {
		promptStore.close();
		aiJobsStore.generateCover(editorStore.editor, text || undefined);
	}
</script>

<Dialog open={showDialog} onClose={() => promptStore.close()} title={t.title} size="sm">
	<textarea
		class="prompt-textarea"
		bind:value={text}
		placeholder={t.placeholder}
		aria-label={t.title}
	></textarea>
	{#snippet footer()}
		<button type="button" class="ws-btn-ghost ws-dialog-btn" onclick={promptStore.close}>{t.cancel}</button>
		<button type="button" class="ws-dialog-btn ws-dialog-btn-primary" onclick={handleSend}>{t.send}</button>
	{/snippet}
</Dialog>

<style>
	.prompt-textarea {
		width: 100%;
		min-height: 128px;
		padding: 12px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, var(--color-ws-bg));
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13px;
		line-height: 1.5;
		resize: vertical;
	}

	.prompt-textarea:focus {
		outline: none;
		border-color: var(--color-ws-accent);
		box-shadow: var(--ws-focus-ring);
	}
</style>
