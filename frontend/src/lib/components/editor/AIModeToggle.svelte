<!-- AIModeToggle — top-right AI panel toggle for the editor chrome.
	W3.1: surfaces AI mode as a dedicated top-right control. Opening it routes the
	right inspector to its "ai" mode (and ensures the inspector is open); the
	active state reflects whether the AI inspector is the current surface. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";

	let aiActive = $derived(editorUiStore.inspectorOpen && editorUiStore.rightPanelMode === "ai");
	let generating = $derived(aiJobsStore.isGenerating);

	function toggleAi(): void {
		if (aiActive) {
			// Collapse back to layer inspector rather than fully closing, so the
			// user keeps a working right panel.
			editorUiStore.setRightPanelMode("layers");
			return;
		}
		editorUiStore.setRightPanelMode("ai");
	}
</script>

<button
	type="button"
	class="ai-mode-toggle"
	class:active={aiActive}
	class:busy={generating}
	aria-pressed={aiActive}
	title={aiActive ? $_("aiModeToggle.titleActive") : $_("aiModeToggle.titleInactive")}
	onclick={toggleAi}
>
	<span class="ai-mode-glyph" aria-hidden="true">✦</span>
	<span class="ai-mode-copy">
		<strong>AI</strong>
		<small>{generating ? $_("aiModeToggle.statusBusy") : aiActive ? $_("aiModeToggle.statusOpen") : $_("aiModeToggle.statusAssistant")}</small>
	</span>
</button>

<style>
	.ai-mode-toggle {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 7px;
		min-height: 40px;
		padding: 4px 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-blue) 34%, transparent);
		border-radius: 9px;
		background: linear-gradient(180deg,
			color-mix(in srgb, var(--color-ws-accent) 18%, transparent),
			color-mix(in srgb, var(--color-ws-accent) 8%, transparent));
		color: var(--color-ws-ink);
		cursor: pointer;
		font-family: inherit;
		letter-spacing: 0;
		transition: border-color 0.15s ease, background 0.15s ease;
	}

	.ai-mode-toggle:hover {
		border-color: color-mix(in srgb, var(--color-ws-blue) 55%, transparent);
		background: linear-gradient(180deg,
			color-mix(in srgb, var(--color-ws-accent) 26%, transparent),
			color-mix(in srgb, var(--color-ws-accent) 12%, transparent));
	}

	.ai-mode-toggle.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 70%, transparent);
		background: linear-gradient(180deg,
			color-mix(in srgb, var(--color-ws-accent) 34%, transparent),
			color-mix(in srgb, var(--color-ws-accent) 18%, transparent));
		box-shadow:
			0 6px 18px color-mix(in srgb, var(--color-ws-accent) 22%, transparent),
			inset 0 -1px 0 color-mix(in srgb, var(--color-ws-accent) 40%, transparent);
		color: var(--color-ws-ink);
	}

	.ai-mode-glyph {
		font-size: 14px;
		font-weight: 900;
		line-height: 1;
		color: var(--color-ws-blue);
	}

	.ai-mode-toggle.active .ai-mode-glyph,
	.ai-mode-toggle.busy .ai-mode-glyph {
		color: color-mix(in srgb, var(--color-ws-blue) 70%, var(--color-ws-ink) 30%);
	}

	.ai-mode-toggle.busy .ai-mode-glyph {
		animation: ai-pulse 1.1s ease-in-out infinite;
	}

	.ai-mode-copy {
		display: flex;
		flex-direction: column;
		gap: 1px;
		line-height: 1;
	}

	.ai-mode-copy strong {
		font-size: 11px;
		font-weight: 850;
		color: var(--color-ws-ink);
	}

	.ai-mode-copy small {
		font-size: 8px;
		font-weight: 760;
		/* ink (near-white), not mid-gray text token — 8px on the violet button needs it */
		color: color-mix(in srgb, var(--color-ws-ink) 70%, transparent);
	}

	@keyframes ai-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (max-width: 1040px) {
		.ai-mode-copy small {
			display: none;
		}
	}
</style>
