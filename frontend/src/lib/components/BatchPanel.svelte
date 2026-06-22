<!-- BatchPanel - Queue management UI with skeleton loading, job cards, and controls -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { aiJobsStore, type BatchJob } from "$lib/stores/ai-jobs.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { thbToCredits, formatCreditsCompact, creditUnitLabel } from "$lib/stores/usage.svelte.ts";

	interface Props {
		compactWhenReviewing?: boolean;
	}

	let { compactWhenReviewing = false }: Props = $props();

	let idleExpanded = $state(false);
	const batchBodyId = "ai-batch-queue-body";
	let queueHasJobs = $derived(aiJobsStore.queue.length > 0);

	// $derived (not a frozen const) so the stage labels re-localize on locale change.
	let stages = $derived<Record<string, string>>({
		uploading: $_("batchPanel.stageUploading"),
		processing: $_("batchPanel.stageProcessing"),
		downloading: $_("batchPanel.stageDownloading"),
		complete: $_("batchPanel.stageComplete"),
		failed: $_("batchPanel.stageFailed"),
		cancelled: $_("batchPanel.stageCancelled"),
	});

	function getStageColor(stage: string): string {
		switch (stage) {
			case "uploading": return "var(--color-ws-accent)";
			case "processing": return "var(--color-ws-accent)";
			case "downloading": return "var(--color-ws-accent)";
			case "complete": return "var(--color-ws-green)";
			case "cancelled": return "var(--color-ws-amber)";
			case "failed": return "var(--color-ws-rose)";
			default: return "var(--color-ws-text)";
		}
	}

	function formatCost(job: BatchJob): string {
		const estimate = job.costEstimate;
		if (!estimate) return "";
		// User-facing AI cost is CREDITS, not baht. Prefer the backend's quality-flat
		// creditUnits; fall back to the THB→credit conversion only if it's missing.
		const credits = estimate.creditUnits ?? thbToCredits(estimate.estimatedThb);
		return $_("batchPanel.costEstimate", { values: { credits: formatCreditsCompact(credits), unit: creditUnitLabel() } });
	}

	function formatCredit(job: BatchJob): string {
		const reservation = job.creditReservation;
		if (!reservation) return "";
		const labels: Record<string, string> = {
			pending: $_("batchPanel.creditPending"),
			held: $_("batchPanel.creditHeld"),
			settled: $_("batchPanel.creditSettled"),
			released: $_("batchPanel.creditReleased"),
		};
		return labels[reservation.status] ?? $_("batchPanel.creditFallback", { values: { status: reservation.status } });
	}

	function formatCrop(job: BatchJob): string {
		return `${Math.round(job.crop?.w || 0)}x${Math.round(job.crop?.h || 0)}`;
	}

	function formatPage(job: BatchJob): string {
		return typeof job.pageIndex === "number" ? $_("batchPanel.pageNumber", { values: { n: job.pageIndex + 1 } }) : $_("batchPanel.pageCurrent");
	}

	function formatQueueFocusDetail(job: BatchJob | null): string {
		if (!job) return $_("batchPanel.focusDetailIdle");
		if (job.status === "cancelled") return job.error ?? $_("batchPanel.focusDetailCancelled");
		if (job.status === "error") return job.error ?? $_("batchPanel.focusDetailError");
		if (job.status === "done") {
			return job.resultImageId
				? $_("batchPanel.focusDetailDone", { values: { id: job.resultImageId.slice(0, 10) } })
				: $_("batchPanel.focusDetailDoneNoImage");
		}
		if (job.status === "pending") return $_("batchPanel.focusDetailPending");
		return $_("batchPanel.focusDetailRunning", { values: { progress: job.progress } });
	}

	let activeJobCount = $derived(aiJobsStore.queueStats.pending + aiJobsStore.queueStats.processing);
	let attentionJobCount = $derived(aiJobsStore.queueStats.error + aiJobsStore.queueStats.cancelled);
	let collapseResolvedReviewDebt = $derived(compactWhenReviewing && activeJobCount === 0);
	let batchOpen = $derived((queueHasJobs && !collapseResolvedReviewDebt) || idleExpanded);
	let activeQueueLabel = $derived(
		aiJobsStore.queueStats.processing > 0
			? `${$_("batchPanel.countRunning", { values: { n: aiJobsStore.queueStats.processing } })}${aiJobsStore.queueStats.pending > 0 ? ` / ${$_("batchPanel.countQueued", { values: { n: aiJobsStore.queueStats.pending } })}` : ""}`
			: aiJobsStore.queueStats.pending > 0
				? $_("batchPanel.countQueued", { values: { n: aiJobsStore.queueStats.pending } })
				: "",
	);
	let batchSummary = $derived(
		!queueHasJobs
			? $_("batchPanel.queueEmpty")
			: attentionJobCount > 0
				? activeQueueLabel
					? `${activeQueueLabel} / ${$_("batchPanel.countNeedReview", { values: { n: attentionJobCount } })}`
					: $_("batchPanel.countNeedReview", { values: { n: attentionJobCount } })
				: activeQueueLabel
					? `${activeQueueLabel} / ${$_("batchPanel.countDone", { values: { n: aiJobsStore.queueStats.done } })}`
					: $_("batchPanel.countDone", { values: { n: aiJobsStore.queueStats.done } }),
	);
	let batchMeter = $derived(
		!queueHasJobs
			? $_("batchPanel.meterEmpty")
			: aiJobsStore.queueStats.processing > 0
				? $_("batchPanel.meterRunning", { values: { n: aiJobsStore.queueStats.processing, max: aiJobsStore.maxConcurrent } })
				: aiJobsStore.queueStats.pending > 0
					? $_("batchPanel.countQueued", { values: { n: aiJobsStore.queueStats.pending } })
					: attentionJobCount > 0
						? $_("batchPanel.countNeedReview", { values: { n: attentionJobCount } })
						: $_("batchPanel.countDone", { values: { n: aiJobsStore.queueStats.done } }),
	);
	let focusJob = $derived(
		aiJobsStore.completedJobs.find((job) => job.status === "error")
			?? aiJobsStore.completedJobs.find((job) => job.status === "cancelled")
			?? aiJobsStore.activeJobs[0]
			?? aiJobsStore.completedJobs[0]
			?? null,
	);
	let queueFocusTone = $derived(
		!focusJob ? "idle" : (focusJob.status === "error" ? "error" : (focusJob.status === "cancelled" ? "cancelled" : (focusJob.status === "done" ? "done" : "running"))),
	);
	let queueFocusEyebrow = $derived(
			!focusJob ? $_("batchPanel.eyebrowIdle") : (focusJob.status === "error" ? $_("batchPanel.eyebrowNeedReview") : (focusJob.status === "cancelled" ? $_("batchPanel.eyebrowCancelled") : (focusJob.status === "done" ? $_("batchPanel.eyebrowReadyToCheck") : $_("batchPanel.eyebrowRunning")))),
	);
	let queueFocusTitle = $derived(
		focusJob ? `${formatPage(focusJob)} / ${formatCrop(focusJob)} / ${stages[focusJob.stage] ?? focusJob.stage}` : $_("batchPanel.focusTitleEmpty"),
	);
	let queueFocusDetail = $derived(formatQueueFocusDetail(focusJob));
	let queueFocusStage = $derived(focusJob ? `${focusJob.progress}% ${stages[focusJob.stage] ?? focusJob.stage}` : $_("batchPanel.focusStageReady"));

	function cancelJob(jobId: string) {
		void aiJobsStore.cancelJob(jobId, editorStore.editor);
	}

	function clearCompleted() {
		aiJobsStore.clearCompleted();
	}

	function moveJob(job: BatchJob, direction: number) {
		const active = aiJobsStore.activeJobs;
		const idx = active.findIndex(j => j.id === job.id);
		if (idx === -1) return;

		const newIdx = idx + direction;
		if (newIdx < 0 || newIdx >= active.length) return;

		aiJobsStore.reorderQueue(idx, newIdx);
	}

	function canMoveJob(job: BatchJob, direction: number): boolean {
		if (job.status !== "pending") return false;
		const active = aiJobsStore.activeJobs;
		const idx = active.findIndex(j => j.id === job.id);
		if (idx === -1) return false;
		const newIdx = idx + direction;
		return newIdx >= 0 && newIdx < active.length;
	}
</script>

<div class="panel-section ws-panel">
	<button
		type="button"
		class="panel-section-header batch-section-header ws-btn-ghost"
		aria-label={`${$_("batchPanel.queueLabel")} ${batchOpen ? $_("batchPanel.expanded") : $_("batchPanel.collapsed")}: ${batchSummary}`}
		aria-expanded={batchOpen}
		aria-controls={batchBodyId}
		onclick={() => {
			if (collapseResolvedReviewDebt || !queueHasJobs) idleExpanded = !idleExpanded;
		}}
	>
		<span class="batch-section-copy">
			<span>{$_("batchPanel.queueLabel")}</span>
			<small>{batchSummary}</small>
		</span>
		<span class="batch-section-meter" class:attention={aiJobsStore.queueStats.error > 0}>
			{batchMeter}
		</span>
		<span class="batch-section-chevron" class:open={batchOpen} aria-hidden="true"></span>
	</button>

	{#if batchOpen}
		<div id={batchBodyId} class="panel-section-body flex flex-col gap-2">
			<section class={`queue-focus-card ws-panel ${queueFocusTone}`} aria-label={$_("batchPanel.focusCardAria")}>
				<div class="queue-focus-copy">
					<span>{queueFocusEyebrow}</span>
					<strong>{queueFocusTitle}</strong>
					<small>{queueFocusDetail}</small>
				</div>
				<div class="queue-focus-chips" aria-label={$_("batchPanel.statusChipsAria")}>
					<span>{queueHasJobs ? batchMeter : $_("batchPanel.readyForWork")}</span>
					<span>{$_("batchPanel.countQueued", { values: { n: aiJobsStore.queueStats.pending } })}</span>
					<span>{$_("batchPanel.countDone", { values: { n: aiJobsStore.queueStats.done } })}</span>
					{#if aiJobsStore.queueStats.error > 0}
						<span class="error-chip">{$_("batchPanel.countNeedFix", { values: { n: aiJobsStore.queueStats.error } })}</span>
					{/if}
					{#if aiJobsStore.queueStats.cancelled > 0}
						<span class="cancelled-chip">{$_("batchPanel.countCancelled", { values: { n: aiJobsStore.queueStats.cancelled } })}</span>
					{/if}
					<span>{queueFocusStage}</span>
				</div>
			</section>

			<!-- Queue Stats -->
			<div class="queue-stats flex items-center justify-between">
				<span>{$_("batchPanel.statRunning", { values: { n: aiJobsStore.queueStats.processing, max: aiJobsStore.maxConcurrent } })}</span>
				<span>{$_("batchPanel.statDone", { values: { n: aiJobsStore.queueStats.done } })}</span>
				{#if aiJobsStore.queueStats.error > 0}
					<span class="queue-stat-error">{$_("batchPanel.statNeedFix", { values: { n: aiJobsStore.queueStats.error } })}</span>
				{/if}
				{#if aiJobsStore.queueStats.cancelled > 0}
					<span class="queue-stat-cancelled">{$_("batchPanel.statCancelled", { values: { n: aiJobsStore.queueStats.cancelled } })}</span>
				{/if}
			</div>

			<!-- Active Jobs -->
			{#each aiJobsStore.activeJobs as job (job.id)}
				<div class="job-card ws-panel-quiet" style="border-left: 3px solid {getStageColor(job.stage)};">
					<div class="job-header">
						<div class="job-thumbnail">
							{#if job.thumbnail}
								<img src={job.thumbnail} alt="" />
							{:else}
								<div class="skeleton-box"></div>
							{/if}
						</div>
						<div class="job-info">
							<span class="job-title">{$_("batchPanel.jobArea", { values: { dimensions: `${Math.round(job.crop?.w || 0)}x${Math.round(job.crop?.h || 0)}` } })}</span>
							<span class="job-status" style="color: {getStageColor(job.stage)};">
								{stages[job.stage] || job.stage}
								{#if job.stage === 'uploading' || job.stage === 'processing'}
									<span class="job-progress-text"> ({job.progress}%)</span>
								{/if}
							</span>
							<span class="job-cost">
								{job.tier}
								{#if job.costEstimate} / {formatCost(job)}{/if}
								{#if job.creditReservation} / {formatCredit(job)}{/if}
							</span>
							{#if job.creditReservation}
								<span class="job-credit-pill" class:released={job.creditReservation.status === "released"}>
									{job.creditReservation.status}
								</span>
							{/if}
						</div>
						<div class="job-actions">
							{#if job.status === "pending"}
								{#if canMoveJob(job, -1)}
									<button
										class="icon-btn ws-btn-ghost"
										onclick={() => moveJob(job, -1)}
										aria-label={$_("batchPanel.moveUpAria")}
										title={$_("batchPanel.moveUpTitle")}
									>↑</button>
								{/if}
								{#if canMoveJob(job, 1)}
									<button
										class="icon-btn ws-btn-ghost"
										onclick={() => moveJob(job, 1)}
										aria-label={$_("batchPanel.moveDownAria")}
										title={$_("batchPanel.moveDownTitle")}
									>↓</button>
								{/if}
							{/if}
							<button
								class="icon-btn icon-btn-danger ws-btn-ghost"
								onclick={() => cancelJob(job.id)}
								aria-label={$_("batchPanel.cancelJobAria")}
								title={$_("batchPanel.cancelJobTitle")}
							>×</button>
						</div>
					</div>

					<!-- Progress Bar -->
					<div class="progress-container">
						<div class="progress-bar" style="width: {job.progress}%; background: {getStageColor(job.stage)};"></div>
					</div>

					<!-- Skeleton Loading for Active Jobs -->
					{#if job.status === "processing" || job.status === "pending"}
						<div class="skeleton-details">
							<div class="skeleton-line" style="width: 60%"></div>
							<div class="skeleton-line" style="width: 40%"></div>
						</div>
					{/if}
				</div>
			{/each}

			<!-- Completed Jobs (Collapsed) -->
			{#if aiJobsStore.completedJobs.length > 0}
				<div class="completed-section">
					<div class="completed-header">
						{$_("batchPanel.completedHeader", { values: { n: aiJobsStore.completedJobs.length } })}
					</div>
					{#each aiJobsStore.completedJobs.slice(0, 3) as job (job.id)}
						<div class="job-card job-card-compact">
							<div class="job-thumbnail job-thumbnail-small">
								{#if job.thumbnail}
									<img src={job.thumbnail} alt="" />
								{/if}
							</div>
							<span class="completed-job-copy">
								{job.resultImageId ? $_("batchPanel.stageComplete") : $_("batchPanel.stageFailed")} #{job.id.slice(0, 8)}
							</span>
						</div>
					{/each}
					{#if aiJobsStore.completedJobs.length > 3}
						<span class="completed-more">
							{$_("batchPanel.moreItems", { values: { n: aiJobsStore.completedJobs.length - 3 } })}
						</span>
					{/if}
				</div>
			{/if}

			<!-- Clear Button — gated on rows the action actually removes (done/error/
			     cancelled), so it never shows as a no-op when only needs_review rows
			     remain. -->
			{#if aiJobsStore.clearableJobs.length > 0}
				<button
					class="panel-btn panel-btn-secondary ws-btn-ghost clear-completed-btn"
					onclick={clearCompleted}
					style="min-height: 40px;"
				>
					{$_("batchPanel.clearCompleted")}
				</button>
			{/if}

			<!-- Empty State -->
			{#if aiJobsStore.queue.length === 0}
				<div class="empty-state">
					<span>{$_("batchPanel.emptyState")}</span>
				</div>
			{/if}

		</div>
	{/if}
</div>

<style>
	.panel-section {
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
	}

	.batch-section-header {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 40px;
		padding: 8px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		text-align: left;
		text-transform: none;
	}

	.batch-section-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.batch-section-copy > span {
		overflow: hidden;
		text-overflow: ellipsis;
		text-transform: none;
		white-space: nowrap;
	}

	.batch-section-copy small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: none;
	}

	.batch-section-meter {
		border: 1px solid color-mix(in srgb, var(--color-ws-blue) 34%, transparent);
		border-radius: 999px;
		padding: 2px 7px;
		background: color-mix(in srgb, var(--color-ws-blue) 11%, transparent);
		color: color-mix(in srgb, var(--color-ws-blue) 72%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
		white-space: nowrap;
		text-transform: none;
	}

	.batch-section-meter.attention {
		border-color: color-mix(in srgb, var(--color-ws-rose) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 13%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 78%, var(--color-ws-ink));
	}

	.batch-section-chevron {
		justify-self: end;
		width: 7px;
		height: 7px;
		border-right: 1.5px solid var(--color-ws-text);
		border-bottom: 1.5px solid var(--color-ws-text);
		transform: rotate(-45deg);
		transition: transform 120ms ease, border-color 120ms ease;
	}

	.batch-section-header:hover .batch-section-chevron,
	.batch-section-chevron.open {
		border-color: var(--color-ws-ink);
	}

	.batch-section-chevron.open {
		transform: rotate(45deg);
	}

	.queue-focus-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border-color: color-mix(in srgb, var(--color-ws-blue) 32%, transparent);
		border-radius: var(--radius-ws-card);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-blue) 14%, transparent), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.queue-focus-card.idle {
		border-color: var(--ws-hair-strong);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-ink) 5%, transparent), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.queue-focus-card.done {
		border-color: color-mix(in srgb, var(--color-ws-green) 36%, transparent);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-green) 14%, transparent), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.queue-focus-card.error {
		border-color: color-mix(in srgb, var(--color-ws-rose) 40%, transparent);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-rose) 15%, transparent), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.queue-focus-card.cancelled {
		border-color: color-mix(in srgb, var(--color-ws-amber) 40%, transparent);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-amber) 14%, transparent), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.queue-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.queue-focus-copy span {
		color: color-mix(in srgb, var(--color-ws-blue) 78%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 820;
		line-height: 1.2;
		text-transform: none;
	}

	.queue-focus-card.done .queue-focus-copy span {
		color: color-mix(in srgb, var(--color-ws-green) 78%, var(--color-ws-ink));
	}

	.queue-focus-card.error .queue-focus-copy span {
		color: color-mix(in srgb, var(--color-ws-rose) 78%, var(--color-ws-ink));
	}

	.queue-focus-card.cancelled .queue-focus-copy span {
		color: color-mix(in srgb, var(--color-ws-amber) 78%, var(--color-ws-ink));
	}

	.queue-focus-card.idle .queue-focus-copy span {
		color: var(--color-ws-text);
	}

	.queue-focus-copy strong {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 820;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	.queue-focus-copy small {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 620;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.queue-focus-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.queue-focus-chips span {
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		padding: 2px 7px;
		background: color-mix(in srgb, var(--color-ws-surface2) 54%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
	}

	.queue-focus-chips .error-chip {
		border-color: color-mix(in srgb, var(--color-ws-rose) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose) 78%, var(--color-ws-ink));
	}

	.queue-focus-chips .cancelled-chip {
		border-color: color-mix(in srgb, var(--color-ws-amber) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent);
		color: color-mix(in srgb, var(--color-ws-amber) 78%, var(--color-ws-ink));
	}

	.queue-stats {
		color: var(--color-ws-text);
		font-size: 11px;
	}

	.queue-stat-error {
		color: var(--color-ws-rose);
	}

	.queue-stat-cancelled {
		color: var(--color-ws-amber);
	}

	.job-card {
		padding: 8px;
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		transition: transform 0.15s ease, box-shadow 0.15s ease;
	}

	.job-card:hover {
		transform: translateY(-1px);
		box-shadow: 0 12px 26px -22px var(--color-ws-ink);
	}

	.job-card-compact {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px;
	}

	.job-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.job-thumbnail {
		width: 40px;
		height: 40px;
		border-radius: var(--radius-ws-ctrl);
		overflow: hidden;
		flex-shrink: 0;
		background: var(--color-ws-bg);
	}

	.job-thumbnail-small {
		width: 24px;
		height: 24px;
	}

	.job-thumbnail img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.skeleton-box {
		width: 100%;
		height: 100%;
		background: linear-gradient(90deg,
			var(--color-ws-bg) 25%,
			var(--ws-hair-strong) 50%,
			var(--color-ws-bg) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}

	.job-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.job-title {
		font-size: 11px;
		font-weight: 500;
		color: var(--color-ws-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.job-progress-text,
	.job-status {
		font-size: 10px;
		text-transform: none;
		letter-spacing: 0;
	}

	.job-progress-text {
		opacity: 0.7;
	}

	.job-cost {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.job-credit-pill {
		align-self: flex-start;
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 40%, transparent);
		border-radius: 999px;
		padding: 1px 6px;
		color: var(--color-ws-green);
		font-size: 10px;
		line-height: 1.4;
	}

	.job-credit-pill.released {
		border-color: color-mix(in srgb, var(--color-ws-rose) 40%, transparent);
		color: var(--color-ws-rose);
	}

	.job-actions {
		display: flex;
		gap: 2px;
	}

	.icon-btn {
		min-width: 40px;
		height: 40px;
		border-radius: var(--radius-ws-ctrl);
		padding: 0 5px;
		color: var(--color-ws-ink);
		font-size: 9px;
		font-weight: 750;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.icon-btn:hover {
		background: color-mix(in srgb, var(--color-ws-surface2) 80%, transparent);
	}

	.icon-btn-danger:hover {
		background: color-mix(in srgb, var(--color-ws-rose) 28%, transparent);
		color: var(--color-ws-ink);
		border-color: color-mix(in srgb, var(--color-ws-rose) 48%, transparent);
	}

	.progress-container {
		height: 4px;
		background: var(--color-ws-bg);
		border-radius: var(--radius-ws-ctrl);
		overflow: hidden;
		margin-top: 4px;
	}

	.progress-bar {
		height: 100%;
		transition: width 0.3s ease, background 0.3s ease;
		border-radius: var(--radius-ws-ctrl);
	}

	.skeleton-details {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 6px;
	}

	.skeleton-line {
		height: 8px;
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(90deg,
			var(--color-ws-bg) 25%,
			var(--ws-hair-strong) 50%,
			var(--color-ws-bg) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	.completed-section {
		border-top: 1px solid var(--ws-hair);
		padding-top: 6px;
		margin-top: 4px;
	}

	.completed-header {
		margin-bottom: 4px;
		color: var(--color-ws-text);
		font-size: 11px;
	}

	.completed-job-copy {
		color: var(--color-ws-text);
		font-size: 11px;
	}

	.completed-more {
		color: var(--color-ws-text);
		font-size: 10px;
	}

	.clear-completed-btn {
		min-height: 40px;
		padding: 8px 10px;
		border-radius: var(--radius-ws-ctrl);
		font-size: 11px;
	}

	.empty-state {
		padding: 16px;
		text-align: center;
		background: var(--color-ws-bg);
		border-radius: var(--radius-ws-card);
		border: 1px dashed var(--ws-hair-strong);
	}

	.empty-state span {
		color: var(--color-ws-text);
		font-size: 12px;
	}
</style>
