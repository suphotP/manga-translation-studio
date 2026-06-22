<!--
	ShortcutsHelp — keyboard shortcuts reference modal.

	Lists every REAL shortcut in the app, grouped by area (general, editor tools,
	canvas, saving), sourced from `shortcuts-catalog.ts` (which in
	turn reads the live tool registry + the platform palette chord). Opened by the
	global "?" accelerator (Shift+/) when not typing, or by the command palette's
	`openShortcutsHelp` action — both flip the shared `shortcutsHelpStore`.

	Accessible: an aria modal dialog, focus-trapped, dismissed with Esc or a
	backdrop click. The shortcut list is a definition list so screen readers pair
	each description with its keys.
-->
<script lang="ts">
	import { tick } from "svelte";
	import { _ } from "$lib/i18n";
	import { buildShortcutGroups, type ShortcutGroup } from "$lib/shortcuts/shortcuts-catalog.ts";
	import { shortcutsHelpStore } from "$lib/stores/shortcuts-help.svelte.ts";
	import { isAppModalOpen } from "$lib/a11y/modal-guard.ts";
	import ShortcutCheatSheet from "$lib/components/ShortcutCheatSheet.svelte";

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		// Override the catalog source in tests; defaults to the live grouped set.
		buildGroups = buildLiveGroups,
	} = $props<{ buildGroups?: () => ShortcutGroup[] }>();

	function buildLiveGroups(): ShortcutGroup[] {
		return buildShortcutGroups(msg);
	}

	let groups = $state<ShortcutGroup[]>([]);
	let dialogEl = $state<HTMLDivElement>();
	let closeBtnEl = $state<HTMLButtonElement>();
	let previouslyFocused: HTMLElement | null = null;

	let open = $derived(shortcutsHelpStore.open);

	// Build the (localised) catalog + trap focus when opened; restore focus when
	// closed. Centralising it here keeps every open path identical.
	$effect(() => {
		if (!open) return;
		previouslyFocused = (document.activeElement as HTMLElement) ?? null;
		groups = buildGroups();
		void (async () => {
			await tick();
			closeBtnEl?.focus();
		})();
	});

	$effect(() => {
		if (open) return;
		previouslyFocused?.focus?.();
		previouslyFocused = null;
	});

	function closeHelp(): void {
		shortcutsHelpStore.closeHelp();
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
		return el.isContentEditable === true;
	}

	// "?" is Shift+/ on most layouts. Treat it as a bare accelerator: skip while
	// typing or when other modifiers (Meta/Ctrl/Alt) are held so we never hijack
	// a literal "?" in a field or an app combo.
	function onGlobalKeydown(event: KeyboardEvent): void {
		if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
		if (open) return;
		if (isTypingTarget(event.target)) return;
		// Don't stack a second aria-modal dialog: if another app modal (e.g. the
		// SearchModal "/" dialog or the command palette) is already open, leave it
		// alone — Escape closes the top one first. Still preventDefault so a literal
		// "?" doesn't leak through to the page underneath.
		if (isAppModalOpen()) {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		shortcutsHelpStore.openHelp();
	}

	function onDialogKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeHelp();
			return;
		}
		if (event.key === "Tab") {
			// Single-stop focus trap: keep focus on the close button.
			event.preventDefault();
			closeBtnEl?.focus();
		}
	}

	function keyJoinerLabel(joiner: "or" | "plus" | undefined): string {
		if (joiner === "plus") return "+";
		return msg("shortcutsHelp.or", "or");
	}
</script>

<svelte:window onkeydown={onGlobalKeydown} />

{#if open}
	<div class="shortcuts-backdrop" role="presentation" onclick={closeHelp}></div>
	<div
		class="shortcuts-modal"
		bind:this={dialogEl}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="shortcuts-help-title"
		onkeydown={onDialogKeydown}
	>
		<header class="shortcuts-head">
			<h2 id="shortcuts-help-title" class="shortcuts-title">
				{msg("shortcutsHelp.title", "คีย์ลัดทั้งหมด")}
			</h2>
			<button
				bind:this={closeBtnEl}
				type="button"
				class="shortcuts-close"
				onclick={closeHelp}
				aria-label={msg("shortcutsHelp.closeLabel", "ปิด")}
			>
				<span aria-hidden="true">✕</span>
			</button>
		</header>

		<ShortcutCheatSheet {groups} {keyJoinerLabel} />

		<footer class="shortcuts-foot">
			<span>{msg("shortcutsHelp.footHint", "กด")} <kbd class="shortcuts-kbd">?</kbd> {msg("shortcutsHelp.footHintOpen", "เพื่อเปิดอีกครั้ง")}</span>
			<span><kbd class="shortcuts-kbd">Esc</kbd> {msg("shortcutsHelp.footHintClose", "เพื่อปิด")}</span>
		</footer>
	</div>
{/if}

<style>
	.shortcuts-backdrop {
		position: fixed;
		inset: 0;
		z-index: 2000;
		border: 0;
		padding: 0;
		background: color-mix(in srgb, var(--color-ws-bg) 55%, transparent);
		backdrop-filter: blur(2px);
		cursor: default;
	}

	.shortcuts-modal {
		position: fixed;
		left: 50%;
		top: 50%;
		z-index: 2001;
		display: flex;
		flex-direction: column;
		width: min(720px, calc(100vw - 32px));
		max-height: min(80vh, 680px);
		transform: translate(-50%, -50%);
		overflow: hidden;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow: 0 28px 80px color-mix(in srgb, var(--color-ws-bg) 55%, transparent);
		color: var(--color-ws-ink);
	}

	.shortcuts-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 18px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.shortcuts-title {
		margin: 0;
		font-size: 15px;
		font-weight: 700;
	}

	.shortcuts-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		color: var(--color-ws-text);
		font-size: 13px;
		cursor: pointer;
	}

	.shortcuts-close:hover {
		background: color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		color: var(--color-ws-ink);
	}

	.shortcuts-close:focus-visible {
		outline: 2px solid var(--color-ws-accent);
		outline-offset: 2px;
	}

	.shortcuts-body {
		flex: 1;
		min-height: 0;
		padding: 8px 18px 16px;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px 28px;
		align-content: start;
	}

	.shortcuts-group {
		padding-top: 12px;
	}

	.shortcuts-group-title {
		margin: 0 0 6px;
		color: var(--color-ws-faint);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.shortcuts-list {
		margin: 0;
	}

	.shortcuts-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 34px;
		padding: 4px 0;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
	}

	.shortcuts-label {
		min-width: 0;
		margin: 0;
		font-size: 12.5px;
		color: var(--color-ws-ink);
	}

	.shortcuts-keys {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 4px;
		margin: 0;
	}

	.shortcuts-joiner {
		color: var(--color-ws-faint);
		font-size: 11px;
	}

	.shortcuts-kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		padding: 2px 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 14%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 600;
		font-family: inherit;
	}

	.shortcuts-foot {
		display: flex;
		gap: 18px;
		padding: 11px 18px;
		border-top: 1px solid var(--ws-hair);
		color: var(--color-ws-faint);
		font-size: 11px;
	}

	.shortcuts-foot span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	@media (prefers-reduced-motion: reduce) {
		.shortcuts-backdrop {
			backdrop-filter: none;
		}
	}
</style>
