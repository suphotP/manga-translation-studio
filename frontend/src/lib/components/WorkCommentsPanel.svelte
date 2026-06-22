<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { ProjectComment } from "$lib/types.js";

	type CommentAnchorMode = "page" | "layer" | "region";
	type CommentFilter = "open" | "all" | "resolved";

	interface Props {
		projectOpen: boolean;
		loading: boolean;
		commentText: string;
		anchorMode: CommentAnchorMode;
		selectedLayerAvailable: boolean;
		selectedLayerLabel: string;
		regionAvailable: boolean;
		comments: ProjectComment[];
		selectedCommentId: string | null;
		getAnchorLabel: (comment: ProjectComment) => string | null;
		onCommentTextChange: (value: string) => void;
		onAnchorModeChange: (mode: CommentAnchorMode) => void;
		onAddComment: () => void | Promise<void>;
		onFocusAnchor: (comment: ProjectComment) => void;
		onUseCommentAsReviewNote?: (comment: ProjectComment) => void;
		onUseOpenCommentsAsReviewNote?: (comments: ProjectComment[]) => void;
		onResolveComment: (commentId: string) => void;
	}

	let {
		projectOpen,
		loading,
		commentText,
		anchorMode,
		selectedLayerAvailable,
		selectedLayerLabel,
		regionAvailable,
		comments,
		selectedCommentId,
		getAnchorLabel,
		onCommentTextChange,
		onAnchorModeChange,
		onAddComment,
		onFocusAnchor,
		onUseCommentAsReviewNote = () => {},
		onUseOpenCommentsAsReviewNote = () => {},
		onResolveComment,
	}: Props = $props();

	let anchorReady = $derived(
		anchorMode === "page"
			|| (anchorMode === "layer" && selectedLayerAvailable)
			|| (anchorMode === "region" && regionAvailable)
	);
	const compactCommentLimit = 12;
	let commentFilter = $state<CommentFilter>("open");
	let showAllComments = $state(false);
	let canAddComment = $derived(projectOpen && Boolean(commentText.trim()) && !loading && anchorReady);
	let openComments = $derived(comments.filter((comment) => comment.status !== "resolved"));
	let resolvedComments = $derived(comments.filter((comment) => comment.status === "resolved"));
	let openCommentCount = $derived(openComments.length);
	let resolvedCommentCount = $derived(resolvedComments.length);
	let filteredComments = $derived(sortCommentsForReview(
		commentFilter === "all"
			? comments
			: commentFilter === "resolved"
				? resolvedComments
				: openComments,
		selectedCommentId
	));
	let visibleComments = $derived(showAllComments ? filteredComments : filteredComments.slice(0, compactCommentLimit));
	let hiddenCommentCount = $derived(Math.max(0, filteredComments.length - visibleComments.length));
	let canToggleAllComments = $derived(hiddenCommentCount > 0 || (showAllComments && filteredComments.length > compactCommentLimit));
	let draftMentions = $derived(extractMentions(commentText));
	let currentAnchorLabel = $derived(getCurrentAnchorLabel());
	let composerOpenByDefault = $derived(!comments.length || Boolean(commentText.trim()));
	let filteredEmptyLabel = $derived(getFilteredEmptyLabel());
	let selectedCommentIndex = $derived(filteredComments.findIndex((comment) => comment.id === selectedCommentId));
	let activeCommentIndex = $derived(selectedCommentIndex >= 0 ? selectedCommentIndex : -1);
	let displayedCommentIndex = $derived(activeCommentIndex >= 0 ? activeCommentIndex : filteredComments.length > 0 ? 0 : -1);
	let focusedCommentDetail = $derived(
		displayedCommentIndex >= 0 ? filteredComments[displayedCommentIndex] ?? null : null
	);
	let focusedCommentAnchorLabel = $derived(focusedCommentDetail ? normalizeAnchorLabel(getAnchorLabel(focusedCommentDetail)) : null);
	let reviewReadyComments = $derived(sortCommentsForReview(openComments.filter(canUseAsReviewNote), selectedCommentId));
	let selectedReviewComment = $derived(
		focusedCommentDetail && reviewReadyComments.some((comment) => comment.id === focusedCommentDetail?.id)
			? focusedCommentDetail
			: null
	);
	let reviewAnchorSummary = $derived(buildReviewAnchorSummary(reviewReadyComments));
	let reviewMentionCount = $derived(countUniqueMentions(reviewReadyComments));
	let commentPositionLabel = $derived(
		displayedCommentIndex >= 0 ? `${displayedCommentIndex + 1}/${filteredComments.length}` : `0/${filteredComments.length}`
	);

	function updateCommentText(event: Event): void {
		onCommentTextChange((event.currentTarget as HTMLTextAreaElement).value);
	}

	function handleCommentKeydown(event: KeyboardEvent): void {
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canAddComment) {
			event.preventDefault();
			void onAddComment();
		}
	}

	function extractMentions(value: string): string[] {
		const names = value.matchAll(/@([a-zA-Z0-9._-]{2,32})/g);
		return [...new Set([...names].map((match) => match[1]))];
	}

	function sortCommentsForReview(items: ProjectComment[], selectedId: string | null): ProjectComment[] {
		return [...items].sort((a, b) => {
			if (selectedId) {
				if (a.id === selectedId && b.id !== selectedId) return -1;
				if (b.id === selectedId && a.id !== selectedId) return 1;
			}
			const statusDelta = Number(a.status === "resolved") - Number(b.status === "resolved");
			if (statusDelta !== 0) return statusDelta;
			return commentTimestamp(b) - commentTimestamp(a);
		});
	}

	function commentTimestamp(comment: ProjectComment): number {
		const raw = comment.updatedAt || comment.createdAt;
		const value = new Date(raw).getTime();
		return Number.isNaN(value) ? 0 : value;
	}

	function getFilteredEmptyLabel(): string {
		if (commentFilter === "resolved") return $_("workComments.emptyResolved");
		if (commentFilter === "all") return $_("workComments.emptyAll");
		return $_("workComments.emptyOpen");
	}

	function commentStatusLabel(status: ProjectComment["status"]): string {
		return status === "resolved" ? $_("workComments.statusResolved") : $_("workComments.statusOpen");
	}

	function getCurrentAnchorLabel(): string {
		if (anchorMode === "layer") {
			return selectedLayerAvailable ? selectedLayerLabel : $_("workComments.selectLayerFirst");
		}
		if (anchorMode === "region") {
			return regionAvailable ? $_("workComments.selectedRegion") : $_("workComments.drawRegionFirst");
		}
		return $_("workComments.wholePage");
	}

	function addCommentReceiptLabel(): string {
		if (loading) return $_("workComments.syncingNote");
		if (!projectOpen) return $_("workComments.openWorkBeforeAdd");
		if (!commentText.trim()) return $_("workComments.typeNoteBeforeAdd");
		if (!anchorReady) return $_("workComments.selectValidAnchor");
		return $_("workComments.cannotAddYet");
	}

	function formatCommentTime(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		return new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}

	function canUseAsReviewNote(comment: ProjectComment): boolean {
		return comment.status !== "resolved" && Boolean(comment.body.trim());
	}

	function commentAnchorKindLabel(comment: ProjectComment): string {
		if (comment.region) return $_("workComments.anchorRegion");
		if (comment.layerId) return $_("workComments.anchorLayer");
		return $_("workComments.wholePage");
	}

	function normalizeAnchorLabel(value: string | null): string | null {
		if (!value) return null;
		return value
			.replace(/^Page note$/i, $_("workComments.wholePage"))
			.replace(/^Layer:/i, `${$_("workComments.anchorLayer")}:`)
			.replace(/^Region:/i, $_("workComments.anchorRegionPrefix"))
			.replace(/^Page:/i, $_("workComments.wholePagePrefix"));
	}

	function useOpenCommentsAsReviewNote(): void {
		onUseOpenCommentsAsReviewNote(reviewReadyComments);
	}

	function selectCommentByStep(direction: -1 | 1): void {
		if (filteredComments.length === 0) return;
		const baseIndex = activeCommentIndex >= 0
			? activeCommentIndex
			: direction > 0
				? -1
				: filteredComments.length;
		const nextIndex = (baseIndex + direction + filteredComments.length) % filteredComments.length;
		onFocusAnchor(filteredComments[nextIndex]);
	}

	function buildReviewAnchorSummary(items: ProjectComment[]): string {
		const anchorCounts = items.reduce(
			(acc, comment) => {
				if (comment.region) acc.region += 1;
				else if (comment.layerId) acc.layer += 1;
				else acc.page += 1;
				return acc;
			},
			{ page: 0, layer: 0, region: 0 }
		);
		const parts = [
			anchorCounts.page ? $_("workComments.anchorSummaryPages", { values: { count: anchorCounts.page } }) : "",
			anchorCounts.layer ? $_("workComments.anchorSummaryLayers", { values: { count: anchorCounts.layer } }) : "",
			anchorCounts.region ? $_("workComments.anchorSummaryRegions", { values: { count: anchorCounts.region } }) : "",
		].filter(Boolean);
		return parts.length ? parts.join(" / ") : $_("workComments.anchorSummaryEmpty");
	}

	function countUniqueMentions(items: ProjectComment[]): number {
		const mentions: string[] = [];
		for (const comment of items) {
			for (const mention of comment.mentions ?? []) {
				const normalized = mention.toLowerCase();
				if (!mentions.includes(normalized)) mentions.push(normalized);
			}
		}
		return mentions.length;
	}
</script>

<div class="comments-panel" class:has-comments={comments.length > 0}>
	<details class="comment-composer-drawer" open={composerOpenByDefault}>
		<summary>
			<span>{$_("workComments.addNote")}</span>
			<em>{comments.length ? $_("workComments.drawerOpenHint") : $_("workComments.drawerReadyHint")}</em>
		</summary>
		<div class="comment-composer">
			<div class="comment-composer-head">
				<div>
					<span>{$_("workComments.newNote")}</span>
					<strong>{currentAnchorLabel}</strong>
				</div>
				<small>{$_("workComments.openDoneCount", { values: { open: openCommentCount, done: resolvedCommentCount } })}</small>
			</div>
			<textarea
				class="comment-input"
				value={commentText}
				placeholder={$_("workComments.inputPlaceholder")}
				readonly={!projectOpen || loading}
				aria-label={$_("workComments.newNoteAria")}
				oninput={updateCommentText}
				onkeydown={handleCommentKeydown}
			></textarea>
			<div class="comment-anchor-options" aria-label={$_("workComments.anchorOptionsAria")}>
				<label class="comment-anchor-toggle" class:active={anchorMode === "page"}>
					<input
						type="radio"
						value="page"
						checked={anchorMode === "page"}
						onchange={() => onAnchorModeChange("page")}
					/>
					<span>{$_("workComments.wholePage")}</span>
				</label>
				<label
					class="comment-anchor-toggle"
					class:active={anchorMode === "layer"}
					class:unavailable={!selectedLayerAvailable}
					title={selectedLayerAvailable
						? $_("workComments.anchorLayerTitle", { values: { label: selectedLayerLabel } })
							: $_("workComments.anchorLayerUnavailableTitle")}
				>
					{#if selectedLayerAvailable}
						<input
							type="radio"
							value="layer"
							checked={anchorMode === "layer"}
							onchange={() => onAnchorModeChange("layer")}
						/>
					{/if}
					<span>{$_("workComments.anchorLayer")}</span>
				</label>
				<label
					class="comment-anchor-toggle"
					class:active={anchorMode === "region"}
					class:unavailable={anchorMode === "region" && !regionAvailable}
					title={regionAvailable
						? $_("workComments.anchorRegionTitle")
						: $_("workComments.anchorRegionUnavailableTitle")}
				>
					<input
						type="radio"
						value="region"
						checked={anchorMode === "region"}
						onchange={() => onAnchorModeChange("region")}
					/>
					<span>{$_("workComments.anchorRegion")}</span>
				</label>
			</div>
			{#if draftMentions.length}
				<div class="comment-draft-mentions" aria-label={$_("workComments.draftMentionsAria")}>
					{#each draftMentions as mention (mention)}
						<span>@{mention}</span>
					{/each}
				</div>
			{/if}
			<div class="comment-composer-actions">
				<small>{anchorReady ? $_("workComments.ctrlEnterToAdd") : $_("workComments.selectValidAnchor")}</small>
				{#if canAddComment}
					<button
						class="layer-action-btn comment-add-btn"
						onclick={onAddComment}
						aria-label={$_("workComments.addNote")}
					>
						{$_("workComments.addNote")}
					</button>
				{:else}
					<span class="comment-action-receipt">{addCommentReceiptLabel()}</span>
				{/if}
			</div>
		</div>
	</details>

	{#if !projectOpen}
		<div class="empty-state">
			<strong>{$_("workComments.openWorkFirst")}</strong>
			<span>{$_("workComments.openWorkFirstDetail")}</span>
		</div>
	{:else if loading && !comments.length}
		<div class="empty-state">{$_("workComments.loadingNotes")}</div>
	{:else if !comments.length}
		<div class="empty-state">
			<strong>{$_("workComments.noNotesTitle")}</strong>
			<span>{$_("workComments.noNotesDetail")}</span>
		</div>
	{:else}
		<div class="comment-filter-bar" aria-label={$_("workComments.filterBarAria")}>
			<button
				type="button"
				class:active={commentFilter === "open"}
				aria-pressed={commentFilter === "open"}
				onclick={() => commentFilter = "open"}
			>
				{$_("workComments.filterOpen")} <span>{openCommentCount}</span>
			</button>
			<button
				type="button"
				class:active={commentFilter === "all"}
				aria-pressed={commentFilter === "all"}
				onclick={() => commentFilter = "all"}
			>
				{$_("workComments.filterAll")} <span>{comments.length}</span>
			</button>
			<button
				type="button"
				class:active={commentFilter === "resolved"}
				aria-pressed={commentFilter === "resolved"}
				onclick={() => commentFilter = "resolved"}
			>
				{$_("workComments.filterResolved")} <span>{resolvedCommentCount}</span>
			</button>
		</div>
		<div class="comment-nav" aria-label={$_("workComments.navAria")}>
			{#if filteredComments.length}
				<button
					type="button"
					class="comment-nav-btn"
					onclick={() => selectCommentByStep(-1)}
					aria-label={$_("workComments.prevNote")}
					title={$_("workComments.prevNote")}
				>&lt;</button>
				<span class="comment-nav-position">{commentPositionLabel}</span>
				<button
					type="button"
					class="comment-nav-btn"
					onclick={() => selectCommentByStep(1)}
					aria-label={$_("workComments.nextNote")}
					title={$_("workComments.nextNote")}
				>&gt;</button>
			{:else}
				<span class="comment-nav-receipt">{$_("workComments.noNotesInFilter")}</span>
			{/if}
		</div>
		{#if focusedCommentDetail}
			<section class="selected-comment-detail" aria-label={$_("workComments.selectedDetailAria")}>
				<div class="selected-comment-copy">
					<span>{selectedCommentId === focusedCommentDetail.id ? $_("workComments.selectedNote") : $_("workComments.nextNoteLabel")}</span>
					<strong>{focusedCommentDetail.body}</strong>
					<small>
						{focusedCommentDetail.author}
						/ {commentAnchorKindLabel(focusedCommentDetail)}
						{#if focusedCommentAnchorLabel}
							/ {focusedCommentAnchorLabel}
						{/if}
					</small>
				</div>
				<div class="selected-comment-actions">
					{#if focusedCommentAnchorLabel}
						<button
							type="button"
							onclick={() => onFocusAnchor(focusedCommentDetail)}
							aria-label={$_("workComments.openAnchorAria")}
						>
							{$_("workComments.openAnchor")}
						</button>
					{/if}
					{#if canUseAsReviewNote(focusedCommentDetail)}
						<button
							type="button"
							onclick={() => onUseCommentAsReviewNote(focusedCommentDetail)}
							aria-label={$_("workComments.useAsReviewNoteAria", { values: { author: focusedCommentDetail.author } })}
						>
							{$_("workComments.useAsReviewNote")}
						</button>
					{/if}
					{#if focusedCommentDetail.status !== "resolved" && !loading}
						<button
							type="button"
							onclick={() => onResolveComment(focusedCommentDetail.id)}
							aria-label={$_("workComments.resolveNoteAria")}
						>
							{$_("workComments.resolveNote")}
						</button>
					{:else}
						<span class="comment-action-receipt">{loading ? $_("workComments.syncingNote") : $_("workComments.statusResolved")}</span>
					{/if}
				</div>
			</section>
		{/if}
		{#if reviewReadyComments.length}
			<div class="comment-review-bridge">
				<div class="comment-review-copy">
						<span>{$_("workComments.reviewSetLabel")}</span>
					<strong>
						<span>{$_("workComments.openNotesCount", { values: { count: reviewReadyComments.length } })}</span>
							<em>{$_("workComments.readyToReview")}</em>
					</strong>
					<small>
						{reviewAnchorSummary}
						{#if reviewMentionCount}
							/ {$_("workComments.mentionCount", { values: { count: reviewMentionCount } })}
						{/if}
					</small>
				</div>
				<div class="comment-review-actions">
					{#if selectedReviewComment}
						<button
							type="button"
							onclick={() => onUseCommentAsReviewNote(selectedReviewComment)}
							aria-label={$_("workComments.useSelectedAsReviewNoteAria", { values: { author: selectedReviewComment.author } })}
						>
							{$_("workComments.useSelected")}
						</button>
					{/if}
					<button
						type="button"
						onclick={useOpenCommentsAsReviewNote}
						aria-label={$_("workComments.useAllOpenAsReviewNoteAria", { values: { count: reviewReadyComments.length } })}
					>
						{$_("workComments.useAll")}
					</button>
				</div>
			</div>
		{/if}
		<div class="comment-list">
			{#if !visibleComments.length}
				<div class="empty-state">{filteredEmptyLabel}</div>
			{:else}
				{#each visibleComments as comment (comment.id)}
					{@const anchorLabel = normalizeAnchorLabel(getAnchorLabel(comment))}
					{@const showResolvedRowState = comment.status === "resolved"}
					<div
						class={`comment-row ${comment.status}`}
						class:selected={selectedCommentId === comment.id}
					>
						<div class="comment-main">
							<div class="comment-meta">
								<strong>{comment.author}</strong>
								<small>{formatCommentTime(comment.createdAt)}</small>
								<em class="anchor-kind">{commentAnchorKindLabel(comment)}</em>
								<em class={comment.status}>{commentStatusLabel(comment.status)}</em>
							</div>
							<span class="comment-body" title={comment.body}>{comment.body}</span>
							{#if comment.mentions?.length}
								<div class="comment-mention-list" aria-label={$_("workComments.mentionsAria")}>
									{#each comment.mentions as mention (mention)}
										<span class="comment-mention-chip">@{mention}</span>
									{/each}
								</div>
							{/if}
							{#if anchorLabel}
								<button
									type="button"
									class="comment-anchor-chip"
									onclick={() => onFocusAnchor(comment)}
								>
									{anchorLabel}
								</button>
							{/if}
						</div>
						{#if showResolvedRowState}
							<div class="comment-row-actions">
								<span class="comment-action-receipt">{$_("workComments.statusResolved")}</span>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
			{#if hiddenCommentCount}
				<button
					type="button"
					class="comment-more-row"
					onclick={() => showAllComments = true}
					aria-label={$_("workComments.showAllNotesAria", { values: { count: filteredComments.length } })}
				>
					<span>{$_("workComments.hiddenOldNotes", { values: { count: hiddenCommentCount } })}</span>
					<strong>{$_("workComments.showAll")}</strong>
				</button>
			{:else if canToggleAllComments}
				<button
					type="button"
					class="comment-more-row expanded"
					onclick={() => showAllComments = false}
					aria-label={$_("workComments.collapseNotesAria")}
				>
					<span>{$_("workComments.showingAllNotes", { values: { count: filteredComments.length } })}</span>
					<strong>{$_("workComments.collapse")}</strong>
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.comments-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: var(--color-ws-ink);
	}

	.comment-composer-drawer {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset;
	}

	.comments-panel.has-comments .comment-composer-drawer {
		order: 2;
	}

	.comment-composer-drawer summary {
		display: flex;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 7px 10px;
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
		text-transform: none;
		cursor: pointer;
	}

	.comment-composer-drawer summary em {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-style: normal;
		font-weight: 700;
		text-overflow: ellipsis;
		text-transform: none;
		white-space: nowrap;
	}

	.comment-composer {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: linear-gradient(
			180deg,
			color-mix(in srgb, var(--color-ws-surface2) 92%, transparent),
			color-mix(in srgb, var(--color-ws-surface) 94%, transparent)
		);
	}

	.comment-composer-head,
	.comment-composer-actions,
	.comment-meta,
	.comment-row-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.comment-composer-head {
		justify-content: space-between;
	}

	.comment-composer-head > div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.comment-composer-head span,
	.comment-meta strong {
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 800;
		text-transform: none;
	}

	.comment-composer-head strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.comment-composer-head small,
	.comment-composer-actions small,
	.comment-meta small {
		color: var(--color-ws-text);
		font-size: 10px;
	}

	.comment-input {
		width: 100%;
		min-height: 72px;
		resize: vertical;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		padding: 9px 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 36%, var(--color-ws-surface));
		color: var(--color-ws-ink);
		font-size: 12px;
		line-height: 1.4;
	}

	.comment-input::placeholder {
		color: var(--color-ws-faint);
	}

	.comment-anchor-options {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}

	.comment-anchor-toggle {
		position: relative;
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 40px;
		padding: 5px 7px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
		text-transform: none;
	}

	.comment-anchor-toggle span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.comment-anchor-toggle.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 62%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 16%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
	}

	.comment-anchor-toggle.unavailable {
		opacity: 0.62;
	}

	.comment-anchor-toggle input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		min-height: 40px;
		margin: 0;
		appearance: none;
		cursor: inherit;
		opacity: 0;
	}

	.layer-action-btn {
		min-height: 40px;
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(100deg, var(--color-ws-violet), color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-violet)));
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
		line-height: 1;
		cursor: pointer;
		box-shadow: 0 10px 24px -18px color-mix(in srgb, var(--color-ws-accent) 78%, transparent);
	}

	.layer-action-btn:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 64%, transparent);
		filter: brightness(1.07);
	}

	.comment-add-btn {
		width: 132px;
		margin-left: auto;
	}

	.comment-action-receipt,
	.comment-nav-receipt {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		padding: 0 10px;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 850;
		line-height: 1.2;
		text-align: center;
	}

	.comment-nav-receipt {
		grid-column: 1 / -1;
	}

	.comment-draft-mentions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.comment-draft-mentions span {
		padding: 2px 6px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 38%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
		color: var(--color-ws-amber);
		font-size: 10px;
		font-weight: 800;
	}

	.comment-filter-bar {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}

	.comment-nav {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr) 40px;
		align-items: center;
		gap: 6px;
	}

	.comment-nav-btn {
		width: 40px;
		min-height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 11px;
		font-weight: 900;
		line-height: 1;
	}

	.comment-nav-btn:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, var(--color-ws-surface2));
	}

	.comment-nav-position {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 800;
		text-align: center;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-comment-detail {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, var(--color-ws-surface));
	}

	.selected-comment-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.selected-comment-copy span {
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 900;
		text-transform: none;
	}

	.selected-comment-copy strong {
		overflow-wrap: anywhere;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
		line-height: 1.3;
	}

	.selected-comment-copy small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 760;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-comment-actions {
		display: grid;
		gap: 5px;
	}

	.selected-comment-actions button {
		min-width: 70px;
		min-height: 40px;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-family: inherit;
		font-size: 10px;
		font-weight: 850;
		white-space: nowrap;
	}

	.selected-comment-actions button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 11%, var(--color-ws-surface2));
	}

	.comment-review-bridge {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 24%, transparent);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-amber) 7%, var(--color-ws-surface));
	}

	.comment-review-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.comment-review-copy span {
		color: var(--color-ws-amber);
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0;
		text-transform: none;
	}

	.comment-review-copy strong {
		display: flex;
		min-width: 0;
		flex-wrap: wrap;
		gap: 4px;
		color: var(--color-ws-ink);
		font-size: 12px;
		line-height: 1.15;
	}

	.comment-review-copy strong span,
	.comment-review-copy strong em {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.comment-review-copy strong em {
		color: var(--color-ws-amber);
		font-style: normal;
	}

	.comment-review-copy small {
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.25;
	}

	.comment-review-actions {
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.comment-review-actions button {
		min-height: 40px;
		padding: 0 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-amber) 8%, transparent);
		color: var(--color-ws-amber);
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
		text-transform: none;
		white-space: nowrap;
	}

	.comment-review-actions button:hover {
		border-color: color-mix(in srgb, var(--color-ws-amber) 48%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 13%, transparent);
	}

	.comment-filter-bar button {
		min-width: 0;
		min-height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 11px;
		font-weight: 800;
		text-transform: none;
	}

	.comment-filter-bar button span {
		color: var(--color-ws-ink);
		font-weight: 900;
	}

	.comment-filter-bar button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 62%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 16%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
	}

	.comment-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.comment-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
	}

	.comment-row.selected {
		border-color: color-mix(in srgb, var(--color-ws-accent) 62%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, var(--color-ws-surface));
	}

	.comment-row.selected .comment-body {
		display: block;
		overflow: visible;
		text-overflow: unset;
		-webkit-line-clamp: unset;
	}

	.comment-row.resolved {
		opacity: 0.58;
	}

	.comment-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.comment-body {
		overflow: hidden;
		color: var(--color-ws-ink);
		display: -webkit-box;
		font-size: 12px;
		line-height: 1.35;
		text-overflow: ellipsis;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
	}

	.comment-meta {
		min-width: 0;
		flex-wrap: wrap;
	}

	.comment-meta em {
		padding: 2px 5px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-style: normal;
		font-weight: 800;
		text-transform: none;
	}

	.comment-meta em.open {
		background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent);
		color: var(--color-ws-amber);
	}

	.comment-meta em.anchor-kind {
		background: color-mix(in srgb, var(--color-ws-accent) 11%, transparent);
		color: var(--color-ws-blue);
	}

	.comment-meta em.resolved {
		background: color-mix(in srgb, var(--color-ws-green) 12%, transparent);
		color: var(--color-ws-green);
	}

	.comment-row-actions {
		align-self: start;
		flex-direction: column;
	}

	.comment-anchor-chip {
		align-self: flex-start;
		max-width: 100%;
		min-height: 40px;
		padding: 3px 6px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 45%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 10px;
		font-weight: 700;
		line-height: 1.1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.comment-more-row {
		display: flex;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		padding: 8px 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-accent) 7%, var(--color-ws-surface));
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 11px;
		text-align: left;
	}

	.comment-more-row strong {
		color: var(--color-ws-blue);
		font-size: 10px;
		letter-spacing: 0.03em;
		text-transform: none;
		white-space: nowrap;
	}

	.comment-more-row:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 11%, var(--color-ws-surface2));
	}

	.comment-more-row.expanded {
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
	}

	.comment-anchor-chip:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 80%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 20%, transparent);
	}

	.comment-mention-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.comment-mention-chip {
		max-width: 100%;
		padding: 2px 5px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 42%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent);
		color: var(--color-ws-amber);
		font-size: 10px;
		font-weight: 700;
		line-height: 1.15;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 12px;
		border: 1px dashed var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-text);
		font-size: 11px;
	}

	.empty-state strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
	}

	@media (min-width: 861px) and (max-width: 1040px) {
		.layer-action-btn,
		.comment-composer-drawer summary,
		.comment-anchor-toggle,
		.comment-filter-bar button,
		.comment-nav-btn,
		.selected-comment-actions button,
		.comment-review-actions button,
		.comment-anchor-chip,
		.comment-more-row {
			min-height: 40px;
		}

		.comment-input {
			min-height: 84px;
			font-size: 12px;
		}

		.comment-row {
			min-height: 64px;
		}
	}

	@media (max-width: 720px) {
		.comment-anchor-options,
		.comment-row,
		.selected-comment-detail,
		.comment-review-bridge {
			grid-template-columns: 1fr;
		}

		.comment-row-actions,
		.selected-comment-actions,
		.comment-review-actions {
			flex-direction: row;
			justify-content: flex-start;
		}

		.selected-comment-actions {
			display: flex;
			flex-wrap: wrap;
		}

		.comment-add-btn {
			width: auto;
		}
	}
</style>
