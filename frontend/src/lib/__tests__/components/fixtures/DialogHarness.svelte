<!-- Test-only harness for the shared Dialog atom. Provides slotted body + footer
	controls so focus-trap / escape behavior can be exercised. -->
<script lang="ts">
	import Dialog from "$lib/components/ui/Dialog.svelte";

	let {
		open = true,
		dismissible = true,
		busy = false,
		customHeader = false,
		onClose = () => {},
	}: {
		open?: boolean;
		dismissible?: boolean;
		busy?: boolean;
		customHeader?: boolean;
		onClose?: () => void;
	} = $props();
</script>

{#if customHeader}
	<Dialog
		{open}
		{dismissible}
		{busy}
		{onClose}
		role="alertdialog"
		ariaLabelledby="harness-custom-title"
		ariaDescribedby="harness-custom-copy"
	>
		{#snippet header()}
			<header>
				<h2 id="harness-custom-title">Custom Header Dialog</h2>
			</header>
		{/snippet}
		<p id="harness-custom-copy">Custom safety copy</p>
		<input data-testid="first-input" aria-label="first input" />
	</Dialog>
{:else}
	<Dialog
		{open}
		{dismissible}
		{busy}
		{onClose}
		title="Harness Dialog"
		description="Test dialog body"
		eyebrow="Test"
	>
		<input data-testid="first-input" aria-label="first input" />
		<button type="button" data-testid="body-button">Body action</button>
		{#snippet footer()}
			<button type="button" data-testid="cancel">Cancel</button>
			<button type="button" data-testid="confirm">Confirm</button>
		{/snippet}
	</Dialog>
{/if}
