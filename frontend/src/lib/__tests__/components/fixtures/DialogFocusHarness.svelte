<!-- Test harness for the headless `dialogFocus` action exported from Dialog.svelte.
	Renders a bespoke (un-styled-shell) dialog panel so the action's focus-trap /
	Escape / restore / background-inert behavior can be exercised against arbitrary
	caller markup — the way the migrated bespoke modals use it. -->
<script lang="ts">
	import { dialogFocus } from "$lib/components/Dialog.svelte";

	let {
		open = true,
		dismissible = true,
		busy = false,
		autoFocus = true,
		onEscape = () => {},
	}: {
		open?: boolean;
		dismissible?: boolean;
		busy?: boolean;
		autoFocus?: boolean;
		onEscape?: () => void;
	} = $props();
</script>

{#if open}
	<div class="harness-backdrop" role="presentation">
		<div
			class="harness-dialog"
			role="dialog"
			aria-modal="true"
			aria-label="Focus Harness"
			tabindex="-1"
			use:dialogFocus={{ onEscape, dismissible, busy, autoFocus }}
		>
			<input data-testid="first-input" aria-label="first input" />
			<button type="button" data-testid="confirm">Confirm</button>
		</div>
	</div>
{/if}
