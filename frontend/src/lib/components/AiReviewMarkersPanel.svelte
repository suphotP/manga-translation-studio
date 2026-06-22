<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { openAiReviewMarkerTarget, openAiReviewMarkerTargetOnPage } from "$lib/navigation/ai-review-navigation.js";
	import { getAiMarkerLinkedReferenceIssue, summarizeAiMarkerLinks } from "$lib/project/ai-marker-links.js";
	import { getAiMarkerReferenceIssue } from "$lib/project/ai-marker-reference.js";
	import {
		aiReviewMarkerPageReferenceLabel,
		aiReviewMarkerReferenceLabel,
		aiReviewResultStateLabel,
		aiReviewRowIntentLabel,
		aiReviewRowStatusLabel,
		aiReviewStatusLabel,
		aiReviewTierLabel,
		findAiResultMarkerForLayer,
		hasAiResultLayer,
		isAiResultPlacementNeeded,
	} from "$lib/project/ai-review-marker-intent.js";
	import { formatAssigneeHandle } from "$lib/project/assignees.js";
	import { sanitizeAiMarkerError } from "$lib/project/ai-job-copy.js";
	import {
		buildAiRegionHistories,
		findAiRegionHistoryForMarker,
		findAiRegionVersion,
		type AiRegionHistory,
	} from "$lib/project/ai-review-region-history.js";
	import { thbToCredits, formatCreditsCompact, creditUnitLabel } from "$lib/stores/usage.svelte.ts";
	import AiResultComparisonSlider from "$lib/components/AiResultComparisonSlider.svelte";
	import { type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import type { AiReviewMarker, AiReviewMarkerStatus } from "$lib/types.js";

	interface Props {
		// When embedded inside the AI mode panel's "ผล AI บนหน้านี้" section, that
		// section already supplies a header + result count, so we suppress this
		// panel's own duplicate title bar to avoid the doubled/nested AI frame.
		embedded?: boolean;
	}
	let { embedded = false }: Props = $props();

	// On open, durably recover any AI result that finished while the client poll
	// loop was closed (user navigated away mid-gen): a stale `processing` marker
	// self-heals to its job's terminal result without a live poll. No-op when
	// nothing is stale; the store also guards behind an actual processing marker.
	onMount(() => {
		void projectStore.reconcileAiReviewMarkers();
	});

	type MarkerScope = "page" | "chapter";
	type FocusPrimaryActionKind = "focus" | "approve" | "place" | "open-layer" | "details";
	type FocusPrimaryAction = {
		kind: FocusPrimaryActionKind;
		label: string;
		title?: string;
		disabled?: boolean;
	};

	const secondaryActionStatuses: Array<{ status: AiReviewMarkerStatus; labelKey: string }> = [
		{ status: "rejected", labelKey: "aiMarkers.dontUseResult" },
	];

	let markerScope = $state<MarkerScope>("page");
	const maxVisibleMarkerRows = 8;
	let showAllMarkerRows = $state(false);
	let pageMarkers = $derived(projectStore.currentPageAiReviewMarkers);
	let chapterMarkers = $derived(projectStore.aiReviewMarkers);
	let markers = $derived(markerScope === "chapter" ? chapterMarkers : pageMarkers);
	// Per-region generation histories within the current scope, so the focus card
	// can offer accept/revert/cycle across older + newer AI runs of the same crop.
	let regionHistories = $derived(buildAiRegionHistories(markers));
	let sortedMarkers = $derived([...markers].sort(compareMarkersForReview));
	let selectedAiLayerMarker = $derived(findAiResultMarkerForLayer(markers, editorStore.selectedImageLayer?.id));
	let projectSelectedMarker = $derived(
		projectStore.selectedAiReviewMarker
			&& markers.some((marker) => marker.id === projectStore.selectedAiReviewMarker?.id)
			? projectStore.selectedAiReviewMarker
			: null
	);
	let selectedMarker = $derived(selectedAiLayerMarker ?? projectSelectedMarker ?? sortedMarkers[0] ?? null);
	let selectedMarkerIsExplicit = $derived(Boolean(selectedAiLayerMarker || projectSelectedMarker));
	let reviewRowMarkers = $derived(sortedMarkers.filter((marker) => marker.id !== selectedMarker?.id));
	let visibleMarkerRows = $derived(showAllMarkerRows ? reviewRowMarkers : reviewRowMarkers.slice(0, maxVisibleMarkerRows));
	let hiddenMarkerRowCount = $derived(Math.max(0, reviewRowMarkers.length - visibleMarkerRows.length));
	let attentionMarkers = $derived(
		markers
			.filter((marker) => marker.id !== selectedMarker?.id && markerNeedsAttention(marker))
			.sort((a, b) => markerAttentionPriority(a) - markerAttentionPriority(b))
	);
	let attentionNeedsReviewCount = $derived(markers.filter((marker) => marker.status === "needs_review").length);
	let attentionPlacementCount = $derived(markers.filter((marker) => isAiResultPlacementNeeded(projectStore.project, marker)).length);
	let firstAttentionMarker = $derived(attentionMarkers[0] ?? null);
	let detailDrawerMarkerId = $state<string | null>(null);
	let explicitlySelectedMarkerId = $derived(selectedAiLayerMarker?.id ?? projectSelectedMarker?.id ?? null);
	let commentDraftByMarkerId = $state<Record<string, string>>({});
	let retryPromptDraftByMarkerId = $state<Record<string, string>>({});
	let retryEditorOpenByMarkerId = $state<Record<string, boolean>>({});

	function statusLabel(markerOrStatus: AiReviewMarker | AiReviewMarkerStatus): string {
		return $_(`aiReviewMarker.status.${aiReviewStatusLabel(markerOrStatus)}`);
	}

	function tierLabel(marker: AiReviewMarker): string {
		return aiReviewTierLabel(marker);
	}

	function formatCost(marker: AiReviewMarker): string {
		if (!marker.costEstimate) return $_("aiMarkers.creditPending");
		// Show the op cost in CREDITS, not baht. Prefer the backend's quality-flat
		// creditUnits — that IS the number charged and the pre-gen quote (1/9/36). Only
		// fall back to the THB→credit conversion when creditUnits is truly absent
		// (legacy markers), and mark THAT number approximate (~) so a derived figure
		// that differs from the flat quote is never mistaken for the exact charge.
		const exact = marker.costEstimate.creditUnits;
		if (exact !== undefined && exact !== null) {
			return `${formatCreditsCompact(exact)} ${creditUnitLabel()}`;
		}
		const approx = thbToCredits(marker.costEstimate.estimatedThb);
		return `~${formatCreditsCompact(approx)} ${creditUnitLabel()}`;
	}

	function hasAppliedResultLayer(marker: AiReviewMarker): boolean {
		return hasAiResultLayer(projectStore.project, marker);
	}

	function resultStateLabel(marker: AiReviewMarker): string {
		return $_(`aiReviewMarker.resultState.${aiReviewResultStateLabel(projectStore.project, marker)}`);
	}

	function combinedStateLabel(marker: AiReviewMarker): string {
		const status = statusLabel(marker);
		const result = resultStateLabel(marker);
		return status === result ? status : `${status} ${result}`;
	}

	function rowIntentLabel(marker: AiReviewMarker): string {
		return $_(`aiReviewMarker.rowIntent.${aiReviewRowIntentLabel(projectStore.project, marker)}`);
	}

	function rowStatusLabel(marker: AiReviewMarker): string {
		return $_(`aiReviewMarker.rowStatus.${aiReviewRowStatusLabel(projectStore.project, marker)}`);
	}

	function rowIntentTone(marker: AiReviewMarker): string {
		if (marker.status === "failed" || (marker.status === "applied" && marker.resultImageId && !hasAppliedResultLayer(marker))) return "danger";
		if (isAiResultPlacementNeeded(projectStore.project, marker)) return "placement";
		if (marker.status === "applied" && marker.resultImageId && hasAppliedResultLayer(marker)) return "done";
		if (marker.resultImageId) return "ready";
		if (marker.status === "processing" || marker.status === "retry_requested") return "running";
		return "review";
	}

	function markerNeedsAttention(marker: AiReviewMarker): boolean {
		return marker.status === "needs_review"
			|| marker.status === "failed"
			|| marker.status === "retry_requested"
			|| marker.status === "processing"
			|| isAiResultPlacementNeeded(projectStore.project, marker)
			|| (marker.status === "applied" && Boolean(marker.resultImageId) && !hasAppliedResultLayer(marker));
	}

	function markerAttentionPriority(marker: AiReviewMarker): number {
		if (isAiResultPlacementNeeded(projectStore.project, marker)) return 0;
		if (marker.status === "needs_review") return 1;
		if (marker.status === "failed") return 2;
		if (marker.status === "retry_requested") return 3;
		if (marker.status === "processing") return 4;
		if (marker.status === "applied" && marker.resultImageId && !hasAppliedResultLayer(marker)) return 5;
		return 9;
	}

	function markerStableTime(marker: AiReviewMarker): number {
		return Date.parse(marker.createdAt || marker.updatedAt || "") || 0;
	}

	function compareMarkersForReview(a: AiReviewMarker, b: AiReviewMarker): number {
		const priorityDelta = markerAttentionPriority(a) - markerAttentionPriority(b);
		if (priorityDelta !== 0) return priorityDelta;
		const pageDelta = a.pageIndex - b.pageIndex;
		if (pageDelta !== 0) return pageDelta;
		const timeDelta = markerStableTime(a) - markerStableTime(b);
		if (timeDelta !== 0) return timeDelta;
		return a.id.localeCompare(b.id);
	}

	function attentionSummary(): string {
		const parts = [
			attentionNeedsReviewCount ? $_("aiMarkers.countNeedsReview", { values: { count: attentionNeedsReviewCount } }) : null,
			attentionPlacementCount ? $_("aiMarkers.countNeedsPlacement", { values: { count: attentionPlacementCount } }) : null,
		].filter(Boolean);
		return parts.length ? parts.join(" · ") : $_("aiMarkers.countNeedsCheck", { values: { count: attentionMarkers.length } });
	}

	function formatRegion(marker: AiReviewMarker): string {
		const { x, y, w, h } = marker.region;
		return `${Math.round(x)},${Math.round(y)} / ${Math.round(w)}x${Math.round(h)}`;
	}

	function formatPage(marker: AiReviewMarker): string {
		return `P${marker.pageIndex + 1}`;
	}

	function markerReference(marker: AiReviewMarker): string {
		return aiReviewMarkerReferenceLabel(projectStore.aiReviewMarkers, marker);
	}

	function markerPageReference(marker: AiReviewMarker): string {
		return aiReviewMarkerPageReferenceLabel(projectStore.aiReviewMarkers, marker);
	}

	function scopeLabel(scope: MarkerScope): string {
		return scope === "chapter" ? $_("aiMarkers.scopeChapter") : $_("aiMarkers.scopePage");
	}

	function formatLinks(marker: AiReviewMarker): string {
		const summary = summarizeAiMarkerLinks(marker, projectStore.comments, projectStore.tasks);
		const comments = summary.commentIds.length;
		const tasks = summary.taskIds.length;
		if (!comments && !tasks) return $_("aiMarkers.noNotesOrTasks");
		if (!summary.hasMissingLinks) return $_("aiMarkers.linksSummary", { values: { tasks, comments } });
		return $_("aiMarkers.linksSummaryPartial", { values: { liveTasks: summary.liveTaskIds.length, tasks, liveComments: summary.liveCommentIds.length, comments } });
	}

	function focusTone(marker: AiReviewMarker): string {
		if (getAiMarkerReferenceIssue(projectStore.project, marker)) return "danger";
		if (getAiMarkerLinkedReferenceIssue(marker, projectStore.comments, projectStore.tasks)) return "danger";
		if (marker.status === "failed" || marker.status === "rejected") return "danger";
		if (marker.status === "accepted") return hasAppliedResultLayer(marker) ? "done" : "review";
		if (marker.status === "applied") return "done";
		if (marker.status === "processing") return "running";
		return "review";
	}

	function focusTitle(marker: AiReviewMarker): string {
		if (getAiMarkerReferenceIssue(projectStore.project, marker)) return $_("aiMarkers.titleSourceChanged");
		if (getAiMarkerLinkedReferenceIssue(marker, projectStore.comments, projectStore.tasks)) return $_("aiMarkers.titleLinkedLost");
		if (marker.status === "processing") return $_("aiMarkers.titleProcessing");
		if (marker.status === "failed") return $_("aiMarkers.titleFailed");
		if (marker.status === "accepted") return hasAppliedResultLayer(marker) ? $_("aiMarkers.titleAcceptedApplied") : $_("aiMarkers.titleAcceptedPending");
		if (marker.status === "applied") return hasAppliedResultLayer(marker) ? $_("aiMarkers.titleApplied") : $_("aiMarkers.titleAppliedLayerLost");
		if (marker.status === "rejected") return $_("aiMarkers.titleRejected");
		if (marker.status === "retry_requested") return $_("aiMarkers.titleRetryRequested");
		return $_("aiMarkers.titleReview");
	}

	function focusDetail(marker: AiReviewMarker): string {
		const referenceIssue = getAiMarkerReferenceIssue(projectStore.project, marker);
		if (referenceIssue) return referenceIssue.message;
		const linkedReferenceIssue = getAiMarkerLinkedReferenceIssue(marker, projectStore.comments, projectStore.tasks);
		if (linkedReferenceIssue) return linkedReferenceIssue.message;
		if (marker.status === "retry_requested") return $_("aiMarkers.detailRetryRequested");
		const safeError = sanitizeAiMarkerError(marker.error);
		if (safeError) return safeError;
		if (marker.status === "processing") return $_("aiMarkers.detailProcessing");
		if (marker.status === "failed") return $_("aiMarkers.detailFailed");
		if (marker.status === "accepted") return $_("aiMarkers.detailAccepted");
		if (marker.status === "applied") return hasAppliedResultLayer(marker)
			? $_("aiMarkers.detailAppliedLayered")
			: $_("aiMarkers.detailAppliedLayerLost");
		if (marker.status === "rejected") return $_("aiMarkers.detailRejected");
		if (marker.resultImageId) return $_("aiMarkers.detailResultReady");
		return $_("aiMarkers.detailDefault");
	}

	function focusNextStepTitle(marker: AiReviewMarker): string {
		if (getAiMarkerReferenceIssue(projectStore.project, marker)) return $_("aiMarkers.nextSourceChanged");
		if (getAiMarkerLinkedReferenceIssue(marker, projectStore.comments, projectStore.tasks)) return $_("aiMarkers.nextClearLinks");
		if (marker.status === "accepted" && marker.resultImageId && !hasAppliedResultLayer(marker)) return $_("aiMarkers.nextPlaceBeforeExport");
		if (marker.status === "applied" && marker.resultImageId) return hasAppliedResultLayer(marker) ? $_("aiMarkers.nextEditLayer") : $_("aiMarkers.nextRecoverLayer");
		if (marker.status === "processing") return $_("aiMarkers.nextWaitProcessing");
		if (marker.status === "failed") return $_("aiMarkers.nextOpenDetailsRerun");
		if (marker.status === "retry_requested") return $_("aiMarkers.nextCheckRetryQueue");
		if (marker.status === "rejected") return $_("aiMarkers.nextKeepReason");
		if (marker.resultImageId) return $_("aiMarkers.nextReviewBeforeConfirm");
		return $_("aiMarkers.nextFocusRegion");
	}

	function focusNextStepDetail(marker: AiReviewMarker): string {
		if (getAiMarkerReferenceIssue(projectStore.project, marker)) return $_("aiMarkers.nextDetailSourceChanged");
		if (getAiMarkerLinkedReferenceIssue(marker, projectStore.comments, projectStore.tasks)) return $_("aiMarkers.nextDetailLinkedLost");
		if (marker.status === "accepted" && marker.resultImageId && !hasAppliedResultLayer(marker)) return $_("aiMarkers.nextDetailPlaceBeforeExport");
		if (marker.status === "applied" && marker.resultImageId) return hasAppliedResultLayer(marker)
			? $_("aiMarkers.nextDetailEditLayer")
			: $_("aiMarkers.nextDetailRecoverLayer");
		if (marker.status === "processing") return $_("aiMarkers.nextDetailProcessing");
		if (marker.status === "failed") return $_("aiMarkers.nextDetailFailed");
		if (marker.status === "retry_requested") return $_("aiMarkers.nextDetailRetryRequested");
		if (marker.status === "rejected") return $_("aiMarkers.nextDetailRejected");
		if (marker.resultImageId) return $_("aiMarkers.nextDetailResultReady");
		return $_("aiMarkers.nextDetailDefault");
	}

	function focusPrimaryAction(marker: AiReviewMarker): FocusPrimaryAction {
		const referenceIssue = getAiMarkerReferenceIssue(projectStore.project, marker);
		if (referenceIssue) return { kind: "details", label: $_("aiMarkers.actionOpenDetailsFix"), title: referenceIssue.message };
		const linkedIssue = getAiMarkerLinkedReferenceIssue(marker, projectStore.comments, projectStore.tasks);
		if (linkedIssue) return { kind: "details", label: $_("aiMarkers.actionOpenDetailsFix"), title: linkedIssue.message };
		if (marker.status === "accepted" && marker.resultImageId && !hasAppliedResultLayer(marker)) {
			return { kind: "place", label: $_("aiMarkers.actionPlaceLayer") };
		}
		if (marker.status === "applied" && marker.resultImageId) {
			return hasAppliedResultLayer(marker)
				? { kind: "open-layer", label: $_("aiMarkers.actionOpenLayer") }
				: { kind: "place", label: $_("aiMarkers.actionRecoverLayer") };
		}
		if (canApproveMarker(marker)) return { kind: "approve", label: $_("aiMarkers.actionApprove") };
		if (marker.status === "processing" || marker.status === "failed" || marker.status === "retry_requested" || marker.status === "rejected") {
			return { kind: "details", label: $_("aiMarkers.actionOpenDetails") };
		}
		if (marker.resultImageId) {
			return { kind: "focus", label: $_("aiMarkers.actionViewResult"), disabled: projectStore.pageNavigationBusy };
		}
		return { kind: "focus", label: $_("aiMarkers.actionGoToRegion"), disabled: projectStore.pageNavigationBusy };
	}

	function canApproveMarker(marker: AiReviewMarker): boolean {
		return marker.status === "needs_review" && !getAiMarkerReferenceIssue(projectStore.project, marker);
	}

	function canApplyMarker(marker: AiReviewMarker): boolean {
		return Boolean(marker.resultImageId)
			&& marker.status === "accepted"
			&& !getAiMarkerReferenceIssue(projectStore.project, marker);
	}

	function canRerunMarker(marker: AiReviewMarker): boolean {
		return marker.status === "failed" || marker.status === "retry_requested";
	}

	function canRequestRetry(marker: AiReviewMarker): boolean {
		return marker.status !== "retry_requested";
	}

	function canUpdateMarkerTo(marker: AiReviewMarker, status: AiReviewMarkerStatus): boolean {
		if (marker.status === status) return false;
		if (status === "accepted") return canApproveMarker(marker);
		if (status === "applied") return canApplyMarker(marker);
		return true;
	}

	function commentDraft(marker: AiReviewMarker): string {
		return commentDraftByMarkerId[marker.id] ?? "";
	}

	function setCommentDraft(marker: AiReviewMarker, event: Event): void {
		const target = event.currentTarget as HTMLTextAreaElement;
		commentDraftByMarkerId = {
			...commentDraftByMarkerId,
			[marker.id]: target.value,
		};
	}

	async function focusMarker(marker: AiReviewMarker): Promise<void> {
		projectStore.selectAiReviewMarker(marker.id);
		const project = projectStore.project;
		if (!project) return;
		if (!project.pages[marker.pageIndex]) {
			projectStore.setStatusMsg($_("aiMarkers.statusPageGone", { values: { page: marker.pageIndex + 1 } }));
			return;
		}
		const outcome = await openAiReviewMarkerTargetOnPage(marker, { defaultPanelMode: null, placementPanelMode: null });
		if (outcome === "applied-layer") {
			projectStore.setStatusMsg($_("aiMarkers.statusLayerOpened", { values: { page: formatPage(marker) } }));
			return;
		}
		if (project.currentPage !== marker.pageIndex && projectStore.project?.currentPage !== marker.pageIndex) {
			projectStore.setStatusMsg($_("aiMarkers.statusOpenPageFailed", { values: { page: marker.pageIndex + 1 } }));
			return;
		}
		projectStore.setStatusMsg($_("aiMarkers.statusFocused", { values: { page: formatPage(marker) } }));
	}

	async function locateMarkerRegion(marker: AiReviewMarker): Promise<void> {
		projectStore.selectAiReviewMarker(marker.id);
		const project = projectStore.project;
		if (!project) return;
		if (!project.pages[marker.pageIndex]) {
			projectStore.setStatusMsg($_("aiMarkers.statusPageGone", { values: { page: marker.pageIndex + 1 } }));
			return;
		}
		if (project.currentPage !== marker.pageIndex) {
			const opened = await projectStore.goToPage(marker.pageIndex, editorStore.editor);
			if (!opened && project.currentPage !== marker.pageIndex) {
				projectStore.setStatusMsg($_("aiMarkers.statusOpenPageFailed", { values: { page: marker.pageIndex + 1 } }));
				return;
			}
			projectStore.selectAiReviewMarker(marker.id);
		}
		editorStore.editor?.focusImageRegion?.(marker.region);
		projectStore.setStatusMsg($_("aiMarkers.statusRegionFocused", { values: { page: formatPage(marker) } }));
	}

	async function selectMarker(marker: AiReviewMarker): Promise<void> {
		await openAiReviewMarkerTargetOnPage(marker, { defaultPanelMode: null, placementPanelMode: null });
	}

	function markerHistory(marker: AiReviewMarker): AiRegionHistory | null {
		return findAiRegionHistoryForMarker(regionHistories, marker.id);
	}

	function markerVersionNumber(marker: AiReviewMarker): number {
		return findAiRegionVersion(markerHistory(marker), marker.id)?.version ?? 1;
	}

	function markerVersionCount(marker: AiReviewMarker): number {
		return markerHistory(marker)?.versions.length ?? 1;
	}

	function hasVersionHistory(marker: AiReviewMarker): boolean {
		return markerVersionCount(marker) > 1;
	}

	// Switch the focus card to an adjacent generation of the SAME region (older /
	// newer). Selecting the sibling marker re-anchors the canvas overlay + slider
	// to that version's result, so accept/revert always acts on the right run.
	async function stepVersion(marker: AiReviewMarker, delta: number): Promise<void> {
		const history = markerHistory(marker);
		if (!history) return;
		const current = findAiRegionVersion(history, marker.id);
		if (!current) return;
		const target = history.versions[current.version - 1 + delta]?.marker;
		if (!target || target.id === marker.id) return;
		await selectMarker(target);
	}

	async function updateMarker(marker: AiReviewMarker, status: AiReviewMarkerStatus): Promise<void> {
		if (status === "applied") {
			const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer(marker.id, editorStore.editor);
			if (layer) {
				editorUiStore.focusImageInspector(layer.id);
			}
			return;
		}
		await projectStore.updateAiReviewMarkerStatus(marker.id, status);
	}

	async function runFocusPrimaryAction(marker: AiReviewMarker): Promise<void> {
		const action = focusPrimaryAction(marker);
		if (action.disabled) return;
		if (action.kind === "focus" || action.kind === "open-layer") {
			await focusMarker(marker);
			return;
		}
		if (action.kind === "approve") {
			await updateMarker(marker, "accepted");
			return;
		}
		if (action.kind === "place") {
			await updateMarker(marker, "applied");
			return;
		}
		detailDrawerMarkerId = marker.id;
	}

	function toggleDetailDrawer(marker: AiReviewMarker, event: Event): void {
		const target = event.currentTarget as HTMLDetailsElement;
		detailDrawerMarkerId = target.open ? marker.id : null;
	}

	function rerunMarker(marker: AiReviewMarker): void {
		void aiJobsStore.rerunAiReviewMarker(marker, editorStore.editor);
	}

	// W3.18: show a bounded before/after comparison instead of dumping the AI
	// result full-size. The "before" is the marker's source image; the "after"
	// is the AI result image.
	function hasComparablePreview(marker: AiReviewMarker): boolean {
		return Boolean(marker.resultImageId && marker.imageId);
	}

	function beforeImageUrl(marker: AiReviewMarker): string {
		return projectStore.getImageUrl(marker.imageId);
	}

	function afterImageUrl(marker: AiReviewMarker): string {
		return projectStore.getImageUrl(marker.resultImageId ?? marker.imageId);
	}

	// Signed-asset params for the comparison slider. A browser <img src> cannot
	// send the Authorization header, so the owned-project source + AI-result
	// assets need a short-lived signed assetToken or they 401 (the result asset
	// in particular, /api/images/<projectId>/result_<uuid>.png). signedAssetSrc
	// mints the token BEFORE setting src and retries once on a token-expiry 401,
	// so the result never flashes a 401 / broken image. blob: local previews pass
	// through the action unchanged. Reuse the "editor_preview" purpose the canvas
	// and the in-canvas AiReviewRegionOverlay already load these assets with.
	function comparisonImageParams(marker: AiReviewMarker, imageId: string | undefined): SignedAssetSrcParams | null {
		const projectId = projectStore.project?.projectId;
		if (!projectId || !imageId) return null;
		return {
			projectId,
			imageId,
			url: projectStore.getImageUrl(imageId),
			purpose: "editor_preview",
		};
	}

	function beforeImageParams(marker: AiReviewMarker): SignedAssetSrcParams | null {
		return comparisonImageParams(marker, marker.imageId);
	}

	function afterImageParams(marker: AiReviewMarker): SignedAssetSrcParams | null {
		return comparisonImageParams(marker, marker.resultImageId ?? marker.imageId);
	}

	function retryPromptDraft(marker: AiReviewMarker): string {
		return retryPromptDraftByMarkerId[marker.id] ?? marker.customPrompt ?? "";
	}

	function setRetryPromptDraft(marker: AiReviewMarker, event: Event): void {
		const target = event.currentTarget as HTMLTextAreaElement;
		retryPromptDraftByMarkerId = {
			...retryPromptDraftByMarkerId,
			[marker.id]: target.value,
		};
	}

	function retryEditorOpen(marker: AiReviewMarker): boolean {
		return retryEditorOpenByMarkerId[marker.id] === true;
	}

	function toggleRetryEditor(marker: AiReviewMarker): void {
		const next = !retryEditorOpen(marker);
		retryEditorOpenByMarkerId = {
			...retryEditorOpenByMarkerId,
			[marker.id]: next,
		};
		if (next && retryPromptDraftByMarkerId[marker.id] === undefined) {
			retryPromptDraftByMarkerId = {
				...retryPromptDraftByMarkerId,
				[marker.id]: marker.customPrompt ?? "",
			};
		}
	}

	function canRetryWithPrompt(marker: AiReviewMarker): boolean {
		return marker.status === "needs_review"
			|| marker.status === "failed"
			|| marker.status === "retry_requested"
			|| marker.status === "accepted"
			|| marker.status === "rejected";
	}

	async function submitRetryWithPrompt(marker: AiReviewMarker): Promise<void> {
		const prompt = retryPromptDraft(marker).trim();
		if (!prompt) {
			projectStore.setStatusMsg($_("aiMarkers.statusEnterPrompt"));
			return;
		}
		const ok = await aiJobsStore.retryAiReviewMarkerWithPrompt(marker, prompt, editorStore.editor);
		if (ok) {
			retryEditorOpenByMarkerId = {
				...retryEditorOpenByMarkerId,
				[marker.id]: false,
			};
		}
	}

	function assignMarker(marker: AiReviewMarker, event: Event): void {
		const target = event.currentTarget as HTMLInputElement;
		void projectStore.assignAiReviewMarker(marker.id, target.value);
	}

	function createComment(marker: AiReviewMarker): void {
		const body = commentDraft(marker).trim();
		void projectStore.createAiReviewMarkerComment(marker.id, body || undefined).then((comment) => {
			if (comment) {
				commentDraftByMarkerId = {
					...commentDraftByMarkerId,
					[marker.id]: "",
				};
			}
		});
	}

	function linkReviewTask(marker: AiReviewMarker): void {
		void projectStore.linkAiReviewMarkerReviewTask(marker.id, marker.assignee);
	}

	function clearStaleLinks(marker: AiReviewMarker): void {
		const summary = summarizeAiMarkerLinks(marker, projectStore.comments, projectStore.tasks);
		void projectStore.updateAiReviewMarker(marker.id, {
			status: marker.status,
			linkedCommentIds: summary.liveCommentIds,
			linkedTaskIds: summary.liveTaskIds,
		});
	}

</script>

<div class="ai-marker-panel" class:embedded>
	<div class="ai-marker-toolbar" class:embedded>
		{#if !embedded}
			<div class="ai-marker-toolbar-copy">
				<span>{$_("aiMarkers.queueTitle")}</span>
				<small>{$_("aiMarkers.resultCountScope", { values: { count: markers.length, scope: scopeLabel(markerScope) } })}</small>
			</div>
		{/if}
		<div class="ai-marker-toolbar-controls">
			<div class="ai-marker-scope ws-panel-quiet" aria-label={$_("aiMarkers.chooseScopeAria")}>
				<button
					type="button"
					class="ws-btn-ghost"
					class:active={markerScope === "page"}
					aria-label={$_("aiMarkers.viewPageScopeAria", { values: { count: pageMarkers.length } })}
					onclick={() => markerScope = "page"}
				>
					{$_("aiMarkers.scopePageCount", { values: { count: pageMarkers.length } })}
				</button>
				<button
					type="button"
					class="ws-btn-ghost"
					class:active={markerScope === "chapter"}
					aria-label={$_("aiMarkers.viewChapterScopeAria", { values: { count: chapterMarkers.length } })}
					onclick={() => markerScope = "chapter"}
				>
					{$_("aiMarkers.scopeChapterCount", { values: { count: chapterMarkers.length } })}
				</button>
			</div>
			{#if projectStore.aiReviewMarkersLoading}
				<span class="ai-marker-refresh-state">{$_("aiMarkers.loading")}</span>
			{:else if projectStore.project}
				<button
					class="ai-marker-refresh ws-btn-ghost"
					onclick={() => projectStore.loadAiReviewMarkers()}
					aria-label={$_("aiMarkers.reloadAria")}
				>
					{$_("aiMarkers.reload")}
				</button>
			{/if}
		</div>
	</div>

	{#if !projectStore.project}
		<div class="empty-state">{$_("aiMarkers.emptyOpenProject")}</div>
	{:else if projectStore.aiReviewMarkersLoading && !markers.length}
		<div class="empty-state">{$_("aiMarkers.emptyLoading")}</div>
	{:else if !markers.length}
			<div class="empty-state">{$_("aiMarkers.emptyScope", { values: { scope: scopeLabel(markerScope) } })}</div>
	{:else}
		{#if selectedMarker && !markerNeedsAttention(selectedMarker) && attentionMarkers.length && firstAttentionMarker}
			<section class="ai-marker-debt-card ws-panel" aria-label={$_("aiMarkers.pendingWorkAria")}>
				<div class="ai-marker-debt-copy">
					<span>{$_("aiMarkers.debtTitle")}</span>
					<strong>{attentionSummary()}</strong>
					<small>{$_("aiMarkers.debtDetail")}</small>
				</div>
				<button
					type="button"
					class="layer-action-btn review-primary"
					onclick={() => void selectMarker(firstAttentionMarker!)}
				>
					{$_("aiMarkers.openReference", { values: { reference: markerReference(firstAttentionMarker) } })}
				</button>
			</section>
		{/if}

		{#if selectedMarker}
			<section class={`ai-marker-focus-card ws-panel ${focusTone(selectedMarker)}`} aria-label={$_("aiMarkers.selectedResultAria")}>
				<div class="ai-marker-focus-copy">
					<span>{markerPageReference(selectedMarker)} / {statusLabel(selectedMarker)}{selectedMarkerIsExplicit ? "" : $_("aiMarkers.autoSuggestedSuffix")}</span>
					<strong>{focusTitle(selectedMarker)}</strong>
					<small>{focusDetail(selectedMarker)}</small>
					{#if !selectedMarkerIsExplicit}
						<small class="ai-marker-auto-selection">{$_("aiMarkers.autoSelectionNote")}</small>
					{/if}
				</div>
				<div class="ai-marker-next-step" aria-label={$_("aiMarkers.nextStepAria")}>
					<span>{$_("aiMarkers.nextStepLabel")}</span>
					<strong>{focusNextStepTitle(selectedMarker)}</strong>
				</div>
				{#if hasComparablePreview(selectedMarker)}
					<div class="ai-marker-focus-preview" data-testid="ai-marker-focus-preview" aria-label={$_("aiMarkers.compareAria")}>
						<AiResultComparisonSlider
							beforeUrl={beforeImageUrl(selectedMarker)}
							afterUrl={afterImageUrl(selectedMarker)}
							beforeParams={beforeImageParams(selectedMarker)}
							afterParams={afterImageParams(selectedMarker)}
							beforeCrop={selectedMarker.region}
							alt={$_("aiMarkers.resultAlt", { values: { reference: markerReference(selectedMarker) } })}
						/>
					</div>
				{/if}
				<div class="ai-marker-focus-chips" aria-label={$_("aiMarkers.contextChipsAria")}>
					<span class="tier">{tierLabel(selectedMarker)}</span>
					<span class="region">{formatRegion(selectedMarker)}</span>
					<span class="result">{resultStateLabel(selectedMarker)}</span>
				</div>
				{#if hasVersionHistory(selectedMarker)}
					<div class="ai-marker-version-picker" aria-label={$_("aiMarkers.versionHistoryAria")} data-testid="ai-marker-version-picker">
						<button
							type="button"
							class="ai-marker-version-step"
							data-testid="ai-marker-version-prev"
							disabled={markerVersionNumber(selectedMarker) <= 1}
							aria-label={$_("aiMarkers.versionPrevAria")}
							onclick={() => void stepVersion(selectedMarker!, -1)}
						>{$_("aiMarkers.versionPrev")}</button>
						<span class="ai-marker-version-count" aria-live="polite">
							{$_("aiMarkers.versionCount", { values: { current: markerVersionNumber(selectedMarker), total: markerVersionCount(selectedMarker) } })}
						</span>
						<button
							type="button"
							class="ai-marker-version-step"
							data-testid="ai-marker-version-next"
							disabled={markerVersionNumber(selectedMarker) >= markerVersionCount(selectedMarker)}
							aria-label={$_("aiMarkers.versionNextAria")}
							onclick={() => void stepVersion(selectedMarker!, 1)}
						>{$_("aiMarkers.versionNext")}</button>
					</div>
				{/if}
				<div class="ai-marker-focus-actions">
					{#if focusPrimaryAction(selectedMarker).disabled}
						<span class="ai-marker-action-receipt">{$_("aiMarkers.receiptOpeningPage")}</span>
					{:else}
						<button
							class="layer-action-btn review-primary"
							onclick={() => void runFocusPrimaryAction(selectedMarker!)}
							title={focusPrimaryAction(selectedMarker).title}
						>
							{focusPrimaryAction(selectedMarker).label}
						</button>
					{/if}
						{#if focusPrimaryAction(selectedMarker).kind !== "focus"}
							{#if projectStore.pageNavigationBusy}
								<span class="ai-marker-action-receipt">{$_("aiMarkers.receiptOpeningRegion")}</span>
							{:else}
							<button
								class="layer-action-btn review-jump"
								onclick={() => void (focusPrimaryAction(selectedMarker!).kind === "open-layer" ? locateMarkerRegion(selectedMarker!) : focusMarker(selectedMarker!))}
							>
								{$_("aiMarkers.viewRegion")}
							</button>
						{/if}
						{/if}
				</div>
			</section>
		{/if}

		{#if reviewRowMarkers.length}
			<div class="ai-marker-list">
				{#each visibleMarkerRows as marker (marker.id)}
					<button
						class="ai-marker-row"
						class:selected={explicitlySelectedMarkerId === marker.id}
						onclick={() => marker.pageIndex === projectStore.project?.currentPage ? void selectMarker(marker) : void focusMarker(marker)}
						aria-label={$_("aiMarkers.openResultRowAria", { values: { page: formatPage(marker), tier: tierLabel(marker), state: combinedStateLabel(marker) } })}
					>
						<span class={`ai-marker-status ${marker.status}`}>{rowStatusLabel(marker)}</span>
						<span class="ai-marker-ref">{markerReference(marker)}</span>
						<span class="ai-marker-page">{formatPage(marker)}</span>
						<span class="ai-marker-main">
							<strong>{tierLabel(marker)}</strong>
							<small>
								<span>{resultStateLabel(marker)}</span>
								<span class="ai-marker-region-detail"> · {formatRegion(marker)}</span>
							</small>
						</span>
						<span class={`ai-marker-result-state ${rowIntentTone(marker)}`}>{rowIntentLabel(marker)}</span>
					</button>
				{/each}
				{#if reviewRowMarkers.length > maxVisibleMarkerRows}
					<button
						type="button"
						class="ai-marker-list-overflow ws-btn-ghost"
						onclick={() => showAllMarkerRows = !showAllMarkerRows}
					>
						{#if showAllMarkerRows}
							{$_("aiMarkers.collapseList")}
						{:else}
							{$_("aiMarkers.showMoreResults", { values: { count: hiddenMarkerRowCount } })}
						{/if}
					</button>
				{/if}
			</div>
		{/if}

		{#if selectedMarker}
			<details
				class="ai-marker-detail-drawer ws-panel"
				open={detailDrawerMarkerId === selectedMarker.id}
				ontoggle={(event) => toggleDetailDrawer(selectedMarker!, event)}
			>
				<summary class="ai-marker-detail-summary">
					<span>{$_("aiMarkers.detailsTitle")}</span>
					<small>{formatCost(selectedMarker)} / {formatLinks(selectedMarker)} / {formatAssigneeHandle(selectedMarker.assignee)}</small>
				</summary>
				<div class="ai-marker-detail">
					<div class="ai-marker-detail-title">
						<span>{tierLabel(selectedMarker)}</span>
						<small>{$_("aiMarkers.jobInfo")}</small>
					</div>
					<div class="ai-marker-detail-grid">
						<span>{$_("aiMarkers.fieldStatus")}</span>
						<strong>{statusLabel(selectedMarker)}</strong>
						<span>{$_("aiMarkers.fieldJob")}</span>
						<strong>{formatPage(selectedMarker)} / {tierLabel(selectedMarker)}</strong>
						<span>{$_("aiMarkers.fieldCredit")}</span>
						<strong>{formatCost(selectedMarker)}</strong>
						<span>{$_("aiMarkers.fieldRegion")}</span>
						<strong>{formatRegion(selectedMarker)}</strong>
						<span>{$_("aiMarkers.fieldResult")}</span>
						<strong>{selectedMarker.resultImageId ? $_("aiMarkers.resultHasImage") : $_("aiMarkers.resultNone")}</strong>
						<span>{$_("aiMarkers.fieldAdvice")}</span>
						<strong>{focusNextStepDetail(selectedMarker)}</strong>
						<span>{$_("aiMarkers.fieldNotesTasks")}</span>
						<strong>{formatLinks(selectedMarker)}</strong>
					</div>
					<label class="ai-marker-field">
						<span>{$_("aiMarkers.fieldAssignee")}</span>
							<input
								name={`ai-marker-assignee-${selectedMarker.id}`}
								value={selectedMarker.assignee ?? ""}
								placeholder={$_("aiMarkers.assigneePlaceholder")}
								readonly={projectStore.aiReviewMarkersLoading}
							onchange={(event) => assignMarker(selectedMarker!, event)}
						/>
					</label>
					{#if hasComparablePreview(selectedMarker)}
						<div class="ai-marker-preview" aria-label={$_("aiMarkers.compareAria")}>
							<AiResultComparisonSlider
								beforeUrl={beforeImageUrl(selectedMarker)}
								afterUrl={afterImageUrl(selectedMarker)}
								beforeParams={beforeImageParams(selectedMarker)}
								afterParams={afterImageParams(selectedMarker)}
								beforeCrop={selectedMarker.region}
								alt={$_("aiMarkers.resultAlt", { values: { reference: markerReference(selectedMarker) } })}
							/>
						</div>
					{/if}
					{#if selectedMarker.customPrompt}
						<p class="ai-marker-prompt">{selectedMarker.customPrompt}</p>
					{/if}
					{#if getAiMarkerReferenceIssue(projectStore.project, selectedMarker)}
						<p class="ai-marker-error">{getAiMarkerReferenceIssue(projectStore.project, selectedMarker)?.message}</p>
					{/if}
					{#if getAiMarkerLinkedReferenceIssue(selectedMarker, projectStore.comments, projectStore.tasks)}
						<p class="ai-marker-error">{getAiMarkerLinkedReferenceIssue(selectedMarker, projectStore.comments, projectStore.tasks)?.message}</p>
					{/if}
					{#if sanitizeAiMarkerError(selectedMarker.error) && selectedMarker.status === "retry_requested"}
						<p class="ai-marker-audit-note">{$_("aiMarkers.auditNote", { values: { error: sanitizeAiMarkerError(selectedMarker.error) } })}</p>
					{:else if sanitizeAiMarkerError(selectedMarker.error)}
						<p class="ai-marker-error">{sanitizeAiMarkerError(selectedMarker.error)}</p>
					{/if}
						<textarea
							class="ai-marker-comment"
							name={`ai-marker-comment-${selectedMarker.id}`}
							value={commentDraft(selectedMarker)}
							placeholder={$_("aiMarkers.commentPlaceholder")}
						rows="3"
						oninput={(event) => setCommentDraft(selectedMarker!, event)}
					></textarea>
					{#if hasComparablePreview(selectedMarker) && !projectStore.aiReviewMarkersLoading}
						<div class="ai-marker-result-actions" aria-label={$_("aiMarkers.decideAria")}>
							{#if canApproveMarker(selectedMarker)}
								<button
									class="layer-action-btn review-primary"
									data-testid="ai-marker-resolve"
									onclick={() => void updateMarker(selectedMarker!, "accepted")}
								>
									{$_("aiMarkers.resolveResult")}
								</button>
							{/if}
							{#if canRetryWithPrompt(selectedMarker)}
								<button
									class="layer-action-btn review-retry"
									data-testid="ai-marker-retry-toggle"
									aria-expanded={retryEditorOpen(selectedMarker)}
									onclick={() => toggleRetryEditor(selectedMarker!)}
								>
									{$_("aiMarkers.retryWithPrompt")}
								</button>
							{/if}
							{#if canUpdateMarkerTo(selectedMarker, "rejected")}
								<button
									class="layer-action-btn review-reject"
									data-testid="ai-marker-reject"
									onclick={() => void updateMarker(selectedMarker!, "rejected")}
								>
									{$_("aiMarkers.rejectResult")}
								</button>
							{/if}
						</div>
						{#if retryEditorOpen(selectedMarker)}
							<div class="ai-marker-retry-editor" data-testid="ai-marker-retry-editor">
								<label class="ai-marker-field">
									<span>{$_("aiMarkers.editPromptRerun")}</span>
									<textarea
										class="ai-marker-retry-prompt"
										name={`ai-marker-retry-prompt-${selectedMarker.id}`}
										data-testid="ai-marker-retry-prompt"
										value={retryPromptDraft(selectedMarker)}
										placeholder={$_("aiMarkers.retryPromptPlaceholder")}
										rows="3"
										oninput={(event) => setRetryPromptDraft(selectedMarker!, event)}
									></textarea>
								</label>
								<button
									class="layer-action-btn review-primary"
									data-testid="ai-marker-retry-submit"
									onclick={() => void submitRetryWithPrompt(selectedMarker!)}
								>
									{$_("aiMarkers.rerunWithThisPrompt")}
								</button>
							</div>
						{/if}
					{/if}
					<div class="ai-marker-actions" aria-label={$_("aiMarkers.secondaryCommandsAria")}>
						{#if projectStore.aiReviewMarkersLoading}
							<span class="ai-marker-action-receipt">{$_("aiMarkers.receiptSyncingResults")}</span>
						{:else}
							{#if canRerunMarker(selectedMarker)}
								<button
									class="layer-action-btn review-rerun"
									onclick={() => rerunMarker(selectedMarker!)}
								>
									{$_("aiMarkers.rerunFromRegion")}
								</button>
							{/if}
							{#if canRequestRetry(selectedMarker)}
								<button
									class="layer-action-btn review-retry"
									onclick={() => void updateMarker(selectedMarker!, "retry_requested")}
								>
									{$_("aiMarkers.requestRerun")}
								</button>
							{/if}
							{#if getAiMarkerLinkedReferenceIssue(selectedMarker, projectStore.comments, projectStore.tasks)}
								<button
									class="layer-action-btn review-clear"
									onclick={() => clearStaleLinks(selectedMarker!)}
								>
									{$_("aiMarkers.clearStaleLinks")}
								</button>
							{/if}
							{#if projectStore.commentsLoading}
								<span class="ai-marker-action-receipt">{$_("aiMarkers.receiptSyncingNotes")}</span>
							{:else}
								<button
									class="layer-action-btn"
									onclick={() => createComment(selectedMarker!)}
								>
									{$_("aiMarkers.addFixNote")}
								</button>
							{/if}
							{#if projectStore.workflowLoading}
								<span class="ai-marker-action-receipt">{$_("aiMarkers.receiptSyncingTasks")}</span>
							{:else}
								<button
									class="layer-action-btn"
									onclick={() => linkReviewTask(selectedMarker!)}
								>
									{$_("aiMarkers.createFixTask")}
								</button>
							{/if}
							{#each secondaryActionStatuses.filter(action => canUpdateMarkerTo(selectedMarker, action.status)) as action (action.status)}
								<button
									class="layer-action-btn"
									onclick={() => void updateMarker(selectedMarker!, action.status)}
								>
									{$_(action.labelKey)}
								</button>
							{/each}
						{/if}
					</div>
				</div>
			</details>
		{/if}
	{/if}
</div>

<style>
	.ai-marker-panel {
		--ai-review: var(--color-ws-amber);
		--ai-running: var(--color-ws-violet);
		--ai-done: var(--color-ws-green);
		--ai-danger: var(--color-ws-rose);
		--ai-info: var(--color-ws-blue);
		--ai-muted-surface: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		--ai-review-soft: color-mix(in srgb, var(--ai-review) 14%, transparent);
		--ai-running-soft: color-mix(in srgb, var(--ai-running) 14%, transparent);
		--ai-done-soft: color-mix(in srgb, var(--ai-done) 13%, transparent);
		--ai-danger-soft: color-mix(in srgb, var(--ai-danger) 14%, transparent);
		--ai-info-soft: color-mix(in srgb, var(--ai-info) 12%, transparent);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.ai-marker-toolbar {
		display: grid;
		gap: 7px;
		padding: 2px 0 4px;
		color: var(--color-ws-text);
	}

	/* Embedded in the AI panel's results section: the section header already
	   names the queue + count, so this keeps one clean frame instead of nesting. */
	.ai-marker-panel.embedded {
		gap: 7px;
	}

	.ai-marker-toolbar.embedded {
		padding: 0 0 2px;
	}

	.ai-marker-toolbar-copy {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.ai-marker-toolbar-copy span {
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 860;
		line-height: 1.2;
	}

	.ai-marker-toolbar-copy small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.2;
		white-space: nowrap;
	}

	.ai-marker-toolbar-controls {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: stretch;
		gap: 6px;
		min-width: 0;
	}

	.ai-marker-scope {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		align-items: center;
		gap: 2px;
		padding: 2px;
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
	}

	.ai-marker-scope button {
		min-height: 40px;
		padding: 0 7px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 820;
		cursor: pointer;
		white-space: nowrap;
	}

	.ai-marker-scope button.active {
		border-color: color-mix(in srgb, var(--ai-done) 34%, transparent);
		background: var(--ai-done-soft);
		color: color-mix(in srgb, var(--ai-done) 78%, var(--color-ws-ink));
	}

	.ai-marker-refresh,
	.ai-marker-refresh-state {
		min-width: 74px;
		min-height: 44px;
		padding: 0 9px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 840;
		white-space: nowrap;
	}

	.ai-marker-refresh {
		cursor: pointer;
	}

	.ai-marker-refresh-state {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--ws-hair);
		background: var(--ai-muted-surface);
	}

	.ai-marker-refresh:hover {
		border-color: color-mix(in srgb, var(--ai-info) 38%, transparent);
		color: color-mix(in srgb, var(--ai-info) 76%, var(--color-ws-ink));
	}

	.ai-marker-debt-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 9px;
		border-color: color-mix(in srgb, var(--ai-review) 36%, transparent);
		border-radius: var(--radius-ws-card);
		background:
			linear-gradient(135deg, var(--ai-review-soft), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.ai-marker-debt-copy {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	.ai-marker-debt-copy span {
		color: color-mix(in srgb, var(--ai-review) 78%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 860;
		line-height: 1.2;
	}

	.ai-marker-debt-copy strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 880;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	.ai-marker-debt-copy small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.ai-marker-panel :global(.layer-action-btn) {
		min-height: 40px;
		padding: 6px 9px;
		border-radius: var(--radius-ws-ctrl);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-marker-toolbar :global(.layer-action-btn) {
		min-height: 40px;
	}

	.ai-marker-focus-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border-color: color-mix(in srgb, var(--ai-review) 38%, transparent);
		border-radius: var(--radius-ws-card);
		background:
			linear-gradient(135deg, var(--ai-review-soft), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.ai-marker-focus-card.running {
		border-color: color-mix(in srgb, var(--ai-running) 38%, transparent);
		background:
			linear-gradient(135deg, var(--ai-running-soft), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.ai-marker-focus-card.done {
		border-color: color-mix(in srgb, var(--ai-done) 36%, transparent);
		background:
			linear-gradient(135deg, var(--ai-done-soft), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.ai-marker-focus-card.danger {
		border-color: color-mix(in srgb, var(--ai-danger) 42%, transparent);
		background:
			linear-gradient(135deg, var(--ai-danger-soft), color-mix(in srgb, var(--color-ws-surface2) 88%, transparent)),
			var(--color-ws-surface);
	}

	.ai-marker-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.ai-marker-focus-copy span {
		color: color-mix(in srgb, var(--ai-review) 78%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 820;
		line-height: 1.2;
		text-transform: none;
	}

	.ai-marker-focus-card.running .ai-marker-focus-copy span {
		color: color-mix(in srgb, var(--ai-running) 78%, var(--color-ws-ink));
	}

	.ai-marker-focus-card.done .ai-marker-focus-copy span {
		color: color-mix(in srgb, var(--ai-done) 78%, var(--color-ws-ink));
	}

	.ai-marker-focus-card.danger .ai-marker-focus-copy span {
		color: color-mix(in srgb, var(--ai-danger) 78%, var(--color-ws-ink));
	}

	.ai-marker-focus-copy strong {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 820;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	.ai-marker-focus-copy small {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 620;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.ai-marker-focus-copy .ai-marker-auto-selection {
		padding: 6px 7px;
		border: 1px solid color-mix(in srgb, var(--ai-review) 28%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--ai-review) 9%, transparent);
		color: color-mix(in srgb, var(--ai-review) 70%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 760;
	}

	.ai-marker-focus-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.ai-marker-focus-chips span {
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		padding: 2px 7px;
		background: var(--ai-muted-surface);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
	}

	.ai-marker-version-picker {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 6px;
		padding: 5px 6px;
		border: 1px solid color-mix(in srgb, var(--ai-info) 34%, transparent);
		border-radius: var(--radius-ws-card);
		background: var(--ai-info-soft);
	}

	.ai-marker-version-step {
		min-height: 40px;
		padding: 0 8px;
		border: 1px solid color-mix(in srgb, var(--ai-info) 40%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--ai-info) 12%, transparent);
		color: color-mix(in srgb, var(--ai-info) 76%, var(--color-ws-ink));
		font-size: 11px;
		font-weight: 840;
		line-height: 1.1;
		cursor: pointer;
		white-space: nowrap;
	}

	.ai-marker-version-step:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--ai-info) 60%, transparent);
		background: color-mix(in srgb, var(--ai-info) 18%, transparent);
	}

	.ai-marker-version-step:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ai-marker-version-count {
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 880;
		line-height: 1;
		text-align: center;
		white-space: nowrap;
	}

	.ai-marker-next-step {
		display: grid;
		gap: 3px;
		padding: 8px 9px;
		border: 1px solid color-mix(in srgb, var(--ai-done) 24%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--ai-done) 8%, transparent);
	}

	.ai-marker-next-step span {
		color: color-mix(in srgb, var(--ai-done) 76%, var(--color-ws-ink));
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
		text-transform: none;
	}

	.ai-marker-next-step strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
		line-height: 1.2;
	}

	.ai-marker-focus-preview {
		margin: 0;
	}

	.ai-marker-focus-preview :global(.ai-result-frame) {
		height: 150px;
		max-height: 28vh;
		border-radius: var(--radius-ws-ctrl);
	}

	.ai-marker-focus-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 4px;
	}

	.ai-marker-focus-actions :global(.layer-action-btn) {
		min-width: 0;
		min-height: 40px;
		white-space: normal;
		line-height: 1.15;
	}

	.ai-marker-focus-actions :global(.layer-action-btn.review-primary) {
		grid-column: 1 / -1;
		border-color: color-mix(in srgb, var(--ai-done) 48%, transparent);
		background: color-mix(in srgb, var(--ai-done) 14%, transparent);
		color: color-mix(in srgb, var(--ai-done) 82%, var(--color-ws-ink));
		font-weight: 900;
	}

	.ai-marker-debt-card :global(.layer-action-btn.review-primary) {
		min-width: 74px;
		border-color: color-mix(in srgb, var(--ai-review) 44%, transparent);
		background: color-mix(in srgb, var(--ai-review) 14%, transparent);
		color: color-mix(in srgb, var(--ai-review) 82%, var(--color-ws-ink));
	}

	.ai-marker-focus-actions :global(.layer-action-btn.review-accept),
	.ai-marker-focus-actions :global(.layer-action-btn.review-apply) {
		border-color: color-mix(in srgb, var(--ai-done) 40%, transparent);
		color: color-mix(in srgb, var(--ai-done) 78%, var(--color-ws-ink));
	}

	.ai-marker-focus-actions :global(.layer-action-btn.review-jump),
	.ai-marker-focus-actions :global(.layer-action-btn.review-rerun) {
		border-color: color-mix(in srgb, var(--ai-running) 44%, transparent);
		color: color-mix(in srgb, var(--ai-running) 78%, var(--color-ws-ink));
	}

	.ai-marker-focus-actions :global(.layer-action-btn.review-convert) {
		grid-column: 1 / -1;
		border-color: color-mix(in srgb, var(--ai-done) 48%, transparent) !important;
		background: color-mix(in srgb, var(--ai-done) 17%, transparent) !important;
		color: color-mix(in srgb, var(--ai-done) 78%, var(--color-ws-ink)) !important;
		font-weight: 900;
	}

	.ai-marker-focus-actions :global(.layer-action-btn.review-convert:hover) {
		background: color-mix(in srgb, var(--ai-done) 26%, transparent) !important;
		border-color: color-mix(in srgb, var(--ai-done) 62%, transparent) !important;
	}

	.ai-marker-action-receipt {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: var(--ai-muted-surface);
		padding: 0 10px;
		color: color-mix(in srgb, var(--color-ws-ink) 76%, var(--color-ws-text));
		font-size: 11px;
		font-weight: 850;
		line-height: 1.2;
		text-align: center;
	}

	.ai-marker-focus-actions :global(.layer-action-btn.review-retry) {
		border-color: color-mix(in srgb, var(--ai-review) 40%, transparent);
		color: color-mix(in srgb, var(--ai-review) 78%, var(--color-ws-ink));
	}

	.ai-marker-focus-actions :global(.layer-action-btn.review-clear) {
		border-color: color-mix(in srgb, var(--ai-danger) 40%, transparent);
		color: color-mix(in srgb, var(--ai-danger) 78%, var(--color-ws-ink));
	}

	.ai-marker-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.ai-marker-list-overflow {
		min-height: 40px;
		border: 1px dashed color-mix(in srgb, var(--ai-info) 32%, transparent);
		border-radius: var(--radius-ws-ctrl);
		color: color-mix(in srgb, var(--ai-running) 78%, var(--color-ws-ink));
		font-size: 11px;
		font-weight: 820;
		cursor: pointer;
	}

	.ai-marker-list-overflow:hover {
		border-color: color-mix(in srgb, var(--ai-info) 46%, transparent);
		background: var(--ai-info-soft);
	}

	.ai-marker-row {
		position: relative;
		display: grid;
		grid-template-areas:
			"status ref page intent"
			"main main main main";
		grid-template-columns: auto auto auto minmax(0, 1fr);
		align-items: center;
		gap: 6px;
		width: 100%;
		min-height: 58px;
		padding: 8px 9px 8px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--ai-muted-surface);
		color: var(--color-ws-ink);
		text-align: left;
		cursor: pointer;
	}

	.ai-marker-row::before {
		position: absolute;
		inset: 10px auto 10px 0;
		width: 3px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--ai-running) 72%, transparent);
		content: "";
	}

	.ai-marker-row:hover,
	.ai-marker-row.selected {
		border-color: color-mix(in srgb, var(--ai-running) 58%, transparent);
		background: color-mix(in srgb, var(--ai-running) 12%, transparent);
	}

	.ai-marker-status {
		grid-area: status;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		height: 22px;
		padding: 0 6px;
		border-radius: 999px;
		background: var(--ai-muted-surface);
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 800;
		line-height: 1;
		text-transform: none;
		white-space: nowrap;
	}

	.ai-marker-ref,
	.ai-marker-page {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 24px;
		border: 1px solid color-mix(in srgb, var(--ai-info) 24%, transparent);
		border-radius: 999px;
		background: var(--ai-info-soft);
		color: color-mix(in srgb, var(--ai-running) 76%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 850;
		line-height: 1;
	}

	.ai-marker-ref {
		grid-area: ref;
		border-color: color-mix(in srgb, var(--ai-done) 24%, transparent);
		background: color-mix(in srgb, var(--ai-done) 9%, transparent);
		color: color-mix(in srgb, var(--ai-done) 78%, var(--color-ws-ink));
	}

	.ai-marker-page {
		grid-area: page;
	}

	.ai-marker-status.needs_review,
	.ai-marker-status.retry_requested {
		color: color-mix(in srgb, var(--ai-review) 78%, var(--color-ws-ink));
		background: color-mix(in srgb, var(--ai-review) 18%, transparent);
	}

	.ai-marker-status.processing {
		color: color-mix(in srgb, var(--ai-running) 78%, var(--color-ws-ink));
		background: color-mix(in srgb, var(--ai-running) 18%, transparent);
	}

	.ai-marker-status.accepted,
	.ai-marker-status.applied {
		color: color-mix(in srgb, var(--ai-done) 78%, var(--color-ws-ink));
		background: color-mix(in srgb, var(--ai-done) 18%, transparent);
	}

	.ai-marker-status.rejected,
	.ai-marker-status.failed {
		color: color-mix(in srgb, var(--ai-danger) 78%, var(--color-ws-ink));
		background: color-mix(in srgb, var(--ai-danger) 18%, transparent);
	}

	.ai-marker-main {
		grid-area: main;
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.ai-marker-main strong {
		overflow-wrap: anywhere;
		font-size: 11px;
		font-weight: 760;
		line-height: 1.15;
		white-space: normal;
	}

	.ai-marker-detail-title span {
		overflow: hidden;
		font-size: 12px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-marker-main small,
	.ai-marker-cost,
	.ai-marker-detail-title small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-marker-main small {
		overflow: visible;
		line-height: 1.25;
		text-overflow: clip;
		white-space: normal;
	}

	.ai-marker-result-state {
		grid-area: intent;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		justify-self: end;
		max-width: 100%;
		min-height: 24px;
		padding: 2px 7px;
		border: 1px solid transparent;
		border-radius: 999px;
		background: var(--ai-muted-surface);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 850;
		line-height: 1.1;
		text-align: center;
		white-space: normal;
	}

	.ai-marker-result-state.ready,
	.ai-marker-result-state.review,
	.ai-marker-result-state.done {
		border-color: color-mix(in srgb, var(--ai-done) 34%, transparent);
		background: color-mix(in srgb, var(--ai-done) 14%, transparent);
		color: color-mix(in srgb, var(--ai-done) 82%, var(--color-ws-ink));
	}

	.ai-marker-result-state.placement {
		border-color: color-mix(in srgb, var(--ai-review) 38%, transparent);
		background: color-mix(in srgb, var(--ai-review) 16%, transparent);
		color: color-mix(in srgb, var(--ai-review) 78%, var(--color-ws-ink));
	}

	.ai-marker-result-state.running {
		border-color: color-mix(in srgb, var(--ai-running) 34%, transparent);
		background: color-mix(in srgb, var(--ai-running) 14%, transparent);
		color: color-mix(in srgb, var(--ai-running) 78%, var(--color-ws-ink));
	}

	.ai-marker-result-state.danger {
		border-color: color-mix(in srgb, var(--ai-danger) 38%, transparent);
		background: color-mix(in srgb, var(--ai-danger) 16%, transparent);
		color: color-mix(in srgb, var(--ai-danger) 78%, var(--color-ws-ink));
	}

	.ai-marker-detail-drawer {
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
	}

	.ai-marker-detail-summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2px;
		min-height: 40px;
		padding: 8px 10px;
		cursor: pointer;
		list-style: none;
	}

	.ai-marker-detail-summary::-webkit-details-marker {
		display: none;
	}

	.ai-marker-detail-summary span {
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
	}

	.ai-marker-detail-summary small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-marker-detail {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
		border-top: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--ai-running) 7%, transparent);
	}

	.ai-marker-detail-drawer:not([open]) .ai-marker-detail {
		display: none;
	}

	.ai-marker-detail-title {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.ai-marker-detail-grid {
		display: grid;
		grid-template-columns: 52px minmax(0, 1fr);
		gap: 4px 8px;
		color: var(--color-ws-text);
		font-size: 11px;
	}

	.ai-marker-detail-grid strong {
		min-width: 0;
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-marker-field {
		display: grid;
		grid-template-columns: 52px minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		color: var(--color-ws-text);
		font-size: 11px;
	}

	.ai-marker-field input,
	.ai-marker-comment,
	.ai-marker-retry-prompt {
		min-width: 0;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
	}

	.ai-marker-field input {
		height: 40px;
		padding: 0 8px;
	}

	.ai-marker-comment {
		width: 100%;
		resize: vertical;
		padding: 7px 8px;
		font-size: 11px;
		line-height: 1.35;
	}

	.ai-marker-prompt,
	.ai-marker-audit-note,
	.ai-marker-error {
		max-height: 64px;
		overflow: hidden;
		margin: 0;
		color: var(--color-ws-text);
		font-size: 11px;
		line-height: 1.35;
	}

	.ai-marker-error {
		color: var(--ai-danger);
	}

	.ai-marker-audit-note {
		color: color-mix(in srgb, var(--ai-review) 70%, var(--color-ws-text));
	}

	.ai-marker-workflow-actions,
	.ai-marker-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 4px;
	}

	.ai-marker-actions :global(.layer-action-btn),
	.ai-marker-result-actions :global(.layer-action-btn) {
		min-height: 40px;
	}

	.ai-marker-preview {
		margin: 4px 0 2px;
	}

	.ai-marker-result-actions {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 4px;
		margin-bottom: 4px;
	}

	.ai-marker-result-actions :global(.layer-action-btn.review-reject) {
		color: color-mix(in srgb, var(--ai-danger) 82%, var(--color-ws-ink));
	}

	.ai-marker-retry-editor {
		display: grid;
		gap: 6px;
		margin-bottom: 6px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--ai-done) 24%, transparent);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--ai-done) 7%, transparent);
	}

	.ai-marker-retry-prompt {
		width: 100%;
		min-height: 60px;
		resize: vertical;
	}

	@media (max-width: 1100px) {
		.ai-marker-focus-card {
			gap: 6px;
			padding: 9px;
		}

		.ai-marker-focus-copy {
			gap: 2px;
		}

		.ai-marker-focus-copy strong {
			font-size: 12px;
		}

		.ai-marker-focus-copy small {
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			overflow: hidden;
		}

		.ai-marker-focus-chips span.region {
			display: none;
		}

		.ai-marker-next-step {
			padding: 7px 8px;
		}

		.ai-marker-row {
			grid-template-areas:
				"status ref page"
				"main main main"
				"intent intent intent";
			grid-template-columns: auto auto minmax(0, 1fr);
			min-height: 76px;
			padding: 8px 10px 9px 12px;
		}

		.ai-marker-page {
			justify-self: start;
		}

		.ai-marker-result-state {
			justify-self: start;
			min-height: 22px;
			padding: 0;
			border-color: transparent;
			background: transparent;
		}

		.ai-marker-region-detail {
			display: none;
		}
	}
</style>
