<!-- Test-only harness reproducing a CONFIRMATION dialog nested inside a PANEL
	dialog (e.g. CancelReviewDialog inside AssignReviewPanel). Regression guard:
	the outer dialog's capture-phase background-click guard must NOT swallow clicks
	on the inner dialog's own controls. -->
<script lang="ts">
	import Dialog from "$lib/components/ui/Dialog.svelte";

	let {
		onConfirm = () => {},
	}: {
		onConfirm?: () => void;
	} = $props();

	let outerOpen = $state(true);
	let innerOpen = $state(false);
</script>

<Dialog open={outerOpen} title="Outer panel" onClose={() => (outerOpen = false)}>
	<button type="button" data-testid="open-inner" onclick={() => (innerOpen = true)}>Open confirm</button>
</Dialog>

<Dialog open={innerOpen} role="alertdialog" title="Confirm" onClose={() => (innerOpen = false)}>
	<button type="button" data-testid="inner-confirm" onclick={() => onConfirm()}>Confirm action</button>
</Dialog>
