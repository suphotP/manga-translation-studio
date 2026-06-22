<!-- ImportEmptyState - dashed-border empty hint used by WorkspaceImportReviewView.
	Pure presentation. The empty hint uses the same quiet workspace surface tone as
	nearby cards so the import page does not drift into one-off styling. -->
<script lang="ts">
	let {
		message,
	}: {
		message: string;
	} = $props();
</script>

<div class="empty-state" role="note">{message}</div>

<style>
	.empty-state {
		display: flex;
		min-height: 74px;
		align-items: center;
		justify-content: center;
		border: 1px dashed var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 50%, transparent);
		color: var(--color-ws-text);
		font-size: 12px;
		line-height: 1.35;
		text-align: center;
	}
</style>
