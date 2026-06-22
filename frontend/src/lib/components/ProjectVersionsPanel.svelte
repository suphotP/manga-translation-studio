<script lang="ts">
	import type { ProjectVersion, ProjectVersionDetail } from "$lib/api/client.js";
	import type { VersionReviewRequest, VersionReviewStatus } from "$lib/types.js";
	import { _ } from "$lib/i18n";

	interface Props {
		projectOpen: boolean;
		versionsLoading: boolean;
		versionDetailLoading: boolean;
		versionReviewLoading: boolean;
		versions: ProjectVersion[];
		versionDetail: ProjectVersionDetail | null;
		reviewNote: string;
		maxLabelLength?: number;
		formatSource: (value: ProjectVersion["source"]) => string;
		formatDate: (value: string) => string;
		formatDelta: (value: number) => string;
		onRefresh: () => void | Promise<void>;
		onSaveVersion: (label: string) => boolean | void | Promise<boolean | void>;
		onViewVersion: (versionId: string) => void | Promise<void>;
		onRestoreVersion: (versionId: string) => void | Promise<void>;
		onReviewNoteChange: (value: string) => void;
		onRequestReview: () => void | Promise<void>;
		onDecideReview: (status: VersionReviewStatus) => void | Promise<void>;
	}

	let {
		projectOpen,
		versionsLoading,
		versionDetailLoading,
		versionReviewLoading,
		versions,
		versionDetail,
		reviewNote,
		maxLabelLength = 120,
		formatSource,
		formatDate,
		formatDelta,
		onRefresh,
		onSaveVersion,
		onViewVersion,
		onRestoreVersion,
		onReviewNoteChange,
		onRequestReview,
		onDecideReview,
	}: Props = $props();

	let versionLabel = $state("");
	let canSaveVersion = $derived(projectOpen && !versionsLoading && versionLabel.trim().length > 0);

	async function submitNamedVersion(): Promise<void> {
		const label = versionLabel.trim();
		if (!label || versionsLoading || !projectOpen) return;
		// Only clear the input once the snapshot was actually created; on failure
		// (network/auth/conflict) keep the typed label so the user can retry without
		// retyping. `onSaveVersion` returns false/undefined when nothing was saved.
		const saved = await onSaveVersion(label);
		if (saved) versionLabel = "";
	}

	function onLabelKeydown(event: KeyboardEvent): void {
		if (event.key === "Enter") {
			event.preventDefault();
			void submitNamedVersion();
		}
	}

	function versionPrimaryLabel(version: ProjectVersion): string {
		return version.label?.trim() || formatSource(version.source);
	}

	let openReview = $derived(
		versionDetail?.reviews.find((review) => review.status === "open") ?? null
	);
	let latestReview: VersionReviewRequest | null = $derived(versionDetail?.reviews[0] ?? null);
	let focusedVersion = $derived(versionDetail?.version ?? versions[0] ?? null);
	let focusedVersionHasDetail = $derived(
		Boolean(focusedVersion && versionDetail?.version.versionId === focusedVersion.versionId)
	);
	let focusedReviewLabel = $derived(getFocusedReviewLabel());
	let canRefreshVersions = $derived(projectOpen && !versionsLoading);
	let versionsRefreshReceipt = $derived(projectOpen ? $_("projectVersions.loading") : $_("projectVersions.openWorkBeforeLoad"));
	let versionActionBlocked = $derived(versionsLoading || versionDetailLoading);

	function reviewStatusLabel(status: VersionReviewStatus): string {
		const labels: Record<VersionReviewStatus, string> = {
			open: $_("projectVersions.reviewOpen"),
			approved: $_("projectVersions.reviewApproved"),
			changes_requested: $_("projectVersions.reviewChangesRequested"),
		};
		return labels[status];
	}

	function updateReviewNote(event: Event): void {
		onReviewNoteChange((event.currentTarget as HTMLTextAreaElement).value);
	}

	function getFocusedReviewLabel(): string {
		if (!focusedVersionHasDetail) return $_("projectVersions.openDetailBeforeReview");
		if (!latestReview) return $_("projectVersions.noRequestYet");
		return reviewStatusLabel(latestReview.status);
	}

	function versionDetailReceiptLabel(): string {
		if (versionsLoading || versionDetailLoading) return $_("projectVersions.loadingDetail");
		if (focusedVersionHasDetail) return $_("projectVersions.opened");
		return $_("projectVersions.cannotOpenYet");
	}

	function versionRestoreReceiptLabel(): string {
		return versionsLoading || versionDetailLoading ? $_("projectVersions.waitingForVersion") : $_("projectVersions.cannotRestoreYet");
	}

	function reviewDecisionReceiptLabel(): string {
		if (versionReviewLoading) return $_("projectVersions.savingResult");
		if (!openReview) return $_("projectVersions.noOpenRequest");
		return $_("projectVersions.cannotDecideYet");
	}

	function formatPageCount(value: number): string {
		return $_("projectVersions.pageCount", { values: { n: value } });
	}

	function formatTextLayerCount(value: number): string {
		return $_("projectVersions.textLayerCount", { values: { n: value } });
	}

	function formatVersionCount(value: number): string {
		return $_("projectVersions.versionCount", { values: { n: value } });
	}

	function formatChangedPageLabel(label: string): string {
		const pageMatch = label.match(/^p(\d+)$/i);
		return pageMatch ? $_("projectVersions.pageLabel", { values: { n: pageMatch[1] } }) : label;
	}
</script>

<div class="version-panel">
	<div class="version-toolbar">
		<span class="version-count">
			{formatVersionCount(versions.length)}
		</span>
		{#if canRefreshVersions}
			<button class="layer-action-btn ws-btn-ghost" onclick={onRefresh}>
				{$_("projectVersions.reload")}
			</button>
		{:else}
			<span class="layer-action-receipt">{versionsRefreshReceipt}</span>
		{/if}
	</div>

	{#if projectOpen}
		<div class="version-save" aria-label={$_("projectVersions.saveNamedVersion")}>
			<input
				class="version-save-input"
				type="text"
				bind:value={versionLabel}
				maxlength={maxLabelLength}
				placeholder={$_("projectVersions.namePlaceholder")}
				aria-label={$_("projectVersions.versionName")}
				disabled={versionsLoading}
				onkeydown={onLabelKeydown}
			/>
			<button
				class="layer-action-btn version-save-btn ws-grad-primary"
				disabled={!canSaveVersion}
				onclick={() => void submitNamedVersion()}
				aria-label={$_("projectVersions.saveNamedVersion")}
			>
				{versionsLoading ? $_("projectVersions.saving") : $_("projectVersions.saveVersion")}
			</button>
		</div>
	{/if}

	{#if !projectOpen}
		<div class="empty-state">{$_("projectVersions.openWorkToView")}</div>
	{:else if versionsLoading}
		<div class="empty-state">{$_("projectVersions.loadingHistory")}</div>
	{:else if !versions.length}
		<div class="empty-state">{$_("projectVersions.emptyHistory")}</div>
	{:else}
		{#if focusedVersion}
			<section class="version-focus-card ws-panel" aria-label={$_("projectVersions.selectedVersion")}>
				<div class="version-focus-copy">
					<span>{focusedVersionHasDetail ? $_("projectVersions.selectedSnapshot") : $_("projectVersions.latestSnapshot")}</span>
					<strong>{versionPrimaryLabel(focusedVersion)}</strong>
					<small>
						{formatSource(focusedVersion.source)} / {formatDate(focusedVersion.createdAt)}
						{#if focusedVersion.author}/ {focusedVersion.author}{/if}
						/ {focusedReviewLabel}
					</small>
				</div>
				<div class="version-focus-stats" aria-label={$_("projectVersions.selectedVersionSize")}>
					<div>
						<span>{$_("projectVersions.pages")}</span>
						<strong>{focusedVersion.pageCount}</strong>
					</div>
					<div>
						<span>{$_("projectVersions.textLayers")}</span>
						<strong>{focusedVersion.textLayerCount}</strong>
					</div>
				</div>
				<div class="version-focus-actions">
					{#if !versionActionBlocked && !focusedVersionHasDetail}
						<button
							class="layer-action-btn ws-btn-ghost"
							onclick={() => onViewVersion(focusedVersion.versionId)}
							aria-label={$_("projectVersions.openSelectedDetail")}
						>
							{$_("projectVersions.detail")}
						</button>
					{:else}
						<span class="layer-action-receipt">{versionDetailReceiptLabel()}</span>
					{/if}
					{#if !versionActionBlocked}
						<button
							class="layer-action-btn ws-btn-ghost"
							onclick={() => onRestoreVersion(focusedVersion.versionId)}
							aria-label={$_("projectVersions.restoreSelected")}
						>
							{$_("projectVersions.restore")}
						</button>
					{:else}
						<span class="layer-action-receipt">{versionRestoreReceiptLabel()}</span>
					{/if}
				</div>
			</section>
		{/if}
		{#if versionDetailLoading}
			<div class="version-detail">{$_("projectVersions.loadingDetailFull")}</div>
		{:else if versionDetail}
			<div class="version-detail ws-panel">
				<div class="version-detail-title">
					{formatSource(versionDetail.version.source)}
					<span>{formatDate(versionDetail.version.createdAt)}</span>
				</div>
				<div class="version-detail-grid">
					<span>{$_("projectVersions.current")}</span>
					<strong>
						{formatPageCount(versionDetail.diff.current.pageCount)} /
						{formatTextLayerCount(versionDetail.diff.current.textLayerCount)}
					</strong>
					<span>{$_("projectVersions.snapshot")}</span>
					<strong>
						{formatPageCount(versionDetail.diff.snapshot.pageCount)} /
						{formatTextLayerCount(versionDetail.diff.snapshot.textLayerCount)}
					</strong>
				</div>
				<div class="version-meta">
					{$_("projectVersions.diffSummary", {
						values: {
							pageDelta: formatDelta(versionDetail.diff.pageDelta),
							textLayerDelta: formatDelta(versionDetail.diff.textLayerDelta),
							changedPages: versionDetail.diff.changedPageCount,
						},
					})}
				</div>
				{#if versionDetail.diff.changedPages.length}
					<div class="version-changed-pages">
						{#each versionDetail.diff.changedPages.slice(0, 3) as page (page.pageIndex)}
							<span>
								{formatChangedPageLabel(page.label)}: {page.currentTextLayerCount} -> {page.snapshotTextLayerCount}
							</span>
						{/each}
					</div>
				{/if}
				<div class="version-review-card">
					<div class="version-review-head">
						<span>{$_("projectVersions.reviewVersion")}</span>
						<small class={latestReview?.status ?? "open"}>
							{latestReview ? reviewStatusLabel(latestReview.status) : $_("projectVersions.noRequestYet")}
						</small>
					</div>
					{#if latestReview}
						<div class="version-review-latest">
							<span>{latestReview.body ?? $_("projectVersions.noNoteYet")}</span>
							<small>
								{latestReview.reviewer ?? latestReview.requester}
								/ {formatDate(latestReview.updatedAt)}
							</small>
							{#if latestReview.mentions?.length}
								<div class="version-review-mentions" aria-label={$_("projectVersions.mentionedInReview")}>
									{#each latestReview.mentions as mention (mention)}
										<em>@{mention}</em>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
					<textarea
						class="version-review-input"
						value={reviewNote}
						rows="2"
						placeholder={openReview ? $_("projectVersions.decisionNotePlaceholder") : $_("projectVersions.requestNotePlaceholder")}
						readonly={versionReviewLoading}
						aria-label={$_("projectVersions.reviewNoteLabel")}
						oninput={updateReviewNote}
					></textarea>
					<div class="version-review-actions">
						{#if !versionReviewLoading}
							<button
							class="layer-action-btn ws-btn-ghost"
								onclick={onRequestReview}
							>
								{$_("projectVersions.requestReview")}
							</button>
						{:else}
							<span class="layer-action-receipt">{$_("projectVersions.sendingReview")}</span>
						{/if}
						{#if openReview && !versionReviewLoading}
							<button
								class="layer-action-btn ws-btn-ghost review-approve-btn"
								onclick={() => onDecideReview("approved")}
							>
								{$_("projectVersions.approve")}
							</button>
							<button
								class="layer-action-btn ws-btn-ghost review-change-btn"
								onclick={() => onDecideReview("changes_requested")}
							>
								{$_("projectVersions.sendBack")}
							</button>
						{:else}
							<span class="layer-action-receipt">{reviewDecisionReceiptLabel()}</span>
							<span class="layer-action-receipt">{reviewDecisionReceiptLabel()}</span>
						{/if}
					</div>
				</div>
			</div>
		{/if}
		<div class="version-list">
			{#each versions.slice(0, 8) as version (version.versionId)}
				<div class="version-row ws-panel-quiet" class:focused={focusedVersion?.versionId === version.versionId}>
					<div class="version-main">
						<span class="version-title">
							{versionPrimaryLabel(version)}
							{#if version.source === "manual"}<em class="version-named-badge">{$_("projectVersions.named")}</em>{/if}
						</span>
						<span class="version-date">
							{formatDate(version.createdAt)}
							{#if version.author}/ {version.author}{/if}
						</span>
					</div>
					<div class="version-meta">
						{formatPageCount(version.pageCount)} / {formatTextLayerCount(version.textLayerCount)}
					</div>
					<div class="version-actions">
						{#if !versionActionBlocked}
							<button
								class="layer-action-btn ws-btn-ghost"
								onclick={() => onViewVersion(version.versionId)}
							>
								{$_("projectVersions.detail")}
							</button>
							<button
								class="layer-action-btn ws-btn-ghost"
								onclick={() => onRestoreVersion(version.versionId)}
							>
								{$_("projectVersions.restore")}
							</button>
						{:else}
							<span class="layer-action-receipt">{$_("projectVersions.loading")}</span>
							<span class="layer-action-receipt">{$_("projectVersions.loading")}</span>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.version-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.layer-action-btn {
		min-height: 40px;
		min-width: 0;
		padding: 0 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface, #15151D) 42%, transparent);
		color: var(--color-ws-text, #9A9AA8);
		font-size: 12px;
		font-weight: 760;
		line-height: 1;
		cursor: pointer;
	}

	.layer-action-receipt {
		display: grid;
		min-height: 40px;
		min-width: 0;
		align-items: center;
		justify-items: center;
		padding: 0 10px;
		border: 1px dashed var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 38%, transparent);
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.15;
		text-align: center;
	}

	.layer-action-btn:hover {
		color: var(--color-ws-ink, #ECECF2);
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 44%, transparent);
	}

	.layer-action-btn.ws-grad-primary:not(:disabled) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 52%, transparent);
		background: linear-gradient(100deg, var(--color-ws-violet, #8B5CF6) 0%, var(--color-ws-accent, #7C5CFF) 100%);
		color: var(--color-ws-ink, #ECECF2);
	}

	.version-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.version-save {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		align-items: center;
	}

	.version-save-input {
		min-width: 0;
		min-height: 40px;
		padding: 0 10px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 70%, transparent);
		color: var(--color-ws-ink, #ECECF2);
		font-size: 12px;
	}

	.version-save-input::placeholder {
		color: var(--color-ws-text, #9A9AA8);
	}

	.version-save-input:disabled {
		opacity: 0.6;
	}

	.version-save-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 64%, transparent);
		color: var(--color-ws-text, #9A9AA8);
	}

	.version-named-badge {
		margin-left: 6px;
		padding: 1px 5px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 40%, transparent);
		border-radius: 999px;
		color: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 66%, var(--color-ws-ink, #ECECF2));
		font-size: 9px;
		font-style: normal;
		font-weight: 850;
	}

	.version-count,
	.version-date,
	.version-meta {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
	}

	.version-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.version-focus-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		padding: 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 22%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 12%, transparent),
			color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 78%, transparent)
		);
	}

	.version-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.version-focus-copy span,
	.version-focus-stats span {
		color: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 66%, var(--color-ws-ink, #ECECF2));
		font-size: 9px;
		font-weight: 900;
		text-transform: none;
	}

	.version-focus-copy strong {
		overflow: hidden;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 13px;
		font-weight: 850;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.version-focus-copy small {
		overflow: hidden;
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 760;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.version-focus-stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(42px, auto));
		gap: 5px;
	}

	.version-focus-stats div {
		min-width: 42px;
		padding: 5px 6px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 64%, transparent);
		text-align: center;
	}

	.version-focus-stats strong {
		display: block;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 13px;
		font-weight: 850;
	}

	.version-focus-actions {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
	}

	.version-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 76px;
		gap: 6px 10px;
		align-items: center;
		padding: 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 42%, transparent);
	}

	.version-row.focused {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 8%, var(--color-ws-surface, #15151D));
	}

	.version-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.version-title {
		overflow: hidden;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 12px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.version-meta {
		grid-column: 1 / 2;
	}

	.version-actions {
		display: flex;
		grid-row: 1 / 3;
		grid-column: 2 / 3;
		flex-direction: column;
		gap: 6px;
	}

	.version-actions .layer-action-btn,
	.version-actions .layer-action-receipt {
		width: 76px;
	}

	.version-detail {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 28%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 8%, var(--color-ws-surface, #15151D));
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
	}

	.version-detail-title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 12px;
		font-weight: 600;
	}

	.version-detail-title span {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 400;
	}

	.version-detail-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 4px 8px;
	}

	.version-detail-grid strong {
		color: var(--color-ws-ink, #ECECF2);
		font-size: 11px;
		font-weight: 600;
	}

	.version-changed-pages {
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow: hidden;
	}

	.version-changed-pages span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.version-review-card {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding-top: 6px;
		border-top: 1px solid var(--ws-hair);
	}

	.version-review-head,
	.version-review-actions,
	.version-review-latest {
		display: flex;
		gap: 6px;
	}

	.version-review-head {
		align-items: center;
		justify-content: space-between;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 11px;
		font-weight: 800;
		text-transform: none;
	}

	.version-review-head small {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
	}

	.version-review-head small.approved {
		color: var(--color-ws-green, #34D399);
	}

	.version-review-head small.changes_requested,
	.version-review-head small.open {
		color: var(--color-ws-amber, #FBBF24);
	}

	.version-review-latest {
		min-width: 0;
		flex-direction: column;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 11px;
	}

	.version-review-latest span,
	.version-review-latest small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.version-review-latest small {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		text-transform: none;
	}

	.version-review-input {
		width: 100%;
		min-height: 48px;
		resize: vertical;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		padding: 7px 8px;
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 70%, transparent);
		color: var(--color-ws-ink, #ECECF2);
		font-size: 11px;
		line-height: 1.35;
	}

	.version-review-input::placeholder {
		color: var(--color-ws-text, #9A9AA8);
	}

	.version-review-actions {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.review-approve-btn {
		border-color: color-mix(in srgb, var(--color-ws-green, #34D399) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-green, #34D399) 14%, transparent);
	}

	.review-change-btn {
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 14%, transparent);
	}

	.version-review-mentions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.version-review-mentions em {
		padding: 1px 4px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 38%, transparent);
		border-radius: 999px;
		color: var(--color-ws-amber, #FBBF24);
		font-size: 10px;
		font-style: normal;
		font-weight: 700;
	}

	.empty-state {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
	}
</style>
