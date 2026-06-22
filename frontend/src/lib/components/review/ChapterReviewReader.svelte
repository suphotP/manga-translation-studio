<!--
ChapterReviewReader — the QC READING / REVIEW surface (owner's vision).

Replaces the cluttered task-heavy QC experience with an EXPORT-like reader:
- LONG continuous scroll OR PAGE-BY-PAGE (reviewer's choice).
- Renders the lightweight downscaled `fit=inside` preview (NOT full-res) and
  VIRTUALIZES the long strip (only the visible window + a small overscan mount an
  <img>) so it stays smooth on big real scans / long chapters — same perf model as
  the editor strip, but a separate read-only component (the editor owns CanvasArea).
- LAYER TOGGLE — reveal/hide the translated-text overlay to compare against the
  cleaned art ("ตีกลับ layer ... แบบจะเห็น").
- ANNOTATE — circle / freehand / rect / pin directly on a page; each mark persists
  as an anchored review COMMENT (reuses the comments model — no heavy task per mark).

It is shown/hidden by WorkspaceShell via the `workspaceView === "review"` class,
mirroring the other workspace views; the nav entry is wired separately.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.js";
	import { buildReviewReaderPages, initialReaderPageHeight, type ReviewLayerView } from "$lib/project/review-reader.js";
	import { pageAnnotations, openAnnotationCount } from "$lib/project/review-annotations.js";
	import { centeredPageForScroll, computeStripWindow, DEFAULT_STRIP_GAP, stripScrollOffsetForIndex } from "$lib/project/strip-virtualization.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { _ } from "$lib/i18n";
	import type { PageReviewDecisionStatus, ReviewAnnotation, ReviewAnnotationShape } from "$lib/types.js";
	import ReviewPageCanvas from "./ReviewPageCanvas.svelte";
	import AssignReviewPanel from "./AssignReviewPanel.svelte";
	import RevisionSendBackDialog from "./RevisionSendBackDialog.svelte";
	import { permissions } from "$lib/stores/permissions.svelte.ts";
	import { currentDutyCapabilities } from "$lib/editor/duty-profile.ts";

	// Localised string with an English fallback (mirrors the WorkspaceSidebar pattern):
	// svelte-i18n returns the key itself when a message is missing, so fall back to the
	// supplied English literal instead of leaking a raw key to the user.
	function msg(key: string, fallback: string, vars?: Record<string, string | number>): string {
		const value = vars ? $_(key, { values: vars }) : $_(key);
		return value && value !== key ? value : fallback;
	}

	type ReaderMode = "long" | "paged";

	let mode = $state<ReaderMode>("long");
	let layerView = $state<ReviewLayerView>("translated");
	let tool = $state<ReviewAnnotationShape | null>(null);
	let pagedIndex = $state(0);
	let assignOpen = $state(false);
	let revisionOpen = $state(false);

	// Page approve/request-changes is the REVIEW DUTY action (backend: update:project
	// {taskType:"review"}) — a QC reviewer must keep it, so gate on the review cap, NOT
	// isAdmin. Assign/send-back below are manage_members (admin) — gated separately.
	let reviewCaps = $derived(currentDutyCapabilities());

	// Comment composer for a just-drawn mark (kept tiny — one note per mark).
	let pendingAnnotation = $state<{ pageIndex: number; annotation: ReviewAnnotation } | null>(null);
	let pendingBody = $state("");
	let saving = $state(false);

	let scrollEl = $state<HTMLDivElement | null>(null);
	let scrollTop = $state(0);
	let viewportHeight = $state(0);
	let columnWidth = $state(0);
	// Measured page heights (px), index-aligned; estimate until the <img> decodes.
	let measuredHeights = $state<Record<number, number>>({});

	const project = $derived(projectStore.project);
	const projectId = $derived(project?.projectId ?? "");
	const pages = $derived(buildReviewReaderPages(project, getPagePreviewImageId));
	const comments = $derived(projectStore.comments);
	const totalReviewMarks = $derived(comments.filter((c) => c.annotation && c.status !== "resolved").length);
	const activeAssignmentCount = $derived(projectStore.reviewAssignments.filter((a) => a.status !== "cancelled").length);
	// Open revisions = still need fixing (not accepted / cancelled). Shown on the send-back CTA.
	const openRevisionCount = $derived(projectStore.revisionRequests.filter((r) => r.status !== "accepted" && r.status !== "cancelled").length);

	const isWebtoon = $derived(projectStore.readingDirection === "vertical");
	const DIVIDER_HEIGHT = 64; // height of page divider and badge (24px divider + 32px badge + 8px margin-bottom)

	// Honest per-page slot heights: a measured DOM height once a page decodes, else an
	// estimate from THAT page's own source aspect (a wide spread vs a tall scan), so the
	// strip geometry spans the whole chapter from the first paint instead of collapsing
	// the virtualization window to ~1 page (BUG 1).
	// We add DIVIDER_HEIGHT to accommodate the clear per-page separator line and page label badge.
	const heights = $derived(
		pages.map(
			(page, index) => (measuredHeights[index] ?? initialReaderPageHeight(page, columnWidth || 720)) + DIVIDER_HEIGHT,
		),
	);
	// Use a sane viewport fallback so the window never collapses to a single page before
	// the container has been measured (clientHeight can read 0 on the first frame).
	const effectiveViewportHeight = $derived(viewportHeight > 0 ? viewportHeight : 900);
	const stripWindow = $derived(
		computeStripWindow({
			pageHeights: heights,
			scrollTop,
			viewportHeight: effectiveViewportHeight,
			gap: DEFAULT_STRIP_GAP,
		}),
	);

	const activePagedPage = $derived(pages[Math.min(pagedIndex, Math.max(0, pages.length - 1))] ?? null);

	// The page the reviewer is "on" — in paged mode the visible page, in long-scroll the
	// page whose slot center is nearest the viewport center. Drives the "enter editor"
	// button (BUG 2) so it opens the page the reviewer is actually looking at.
	const centeredIndex = $derived(
		mode === "paged"
			? Math.min(pagedIndex, Math.max(0, pages.length - 1))
			: centeredPageForScroll(stripWindow.offsets, heights, scrollTop, effectiveViewportHeight),
	);
	let openingEditor = $state(false);

	// Reset the in-progress "request changes" note when the centered page changes, so a
	// half-typed reason never carries to a different page.
	$effect(() => {
		void centeredIndex;
		decidingChanges = false;
		decisionNote = "";
	});

	$effect(() => {
		if (editorUiStore.workspaceView === "review") {
			queueMicrotask(measureViewport);
		}
	});

	function onScroll(): void {
		if (!scrollEl) return;
		scrollTop = scrollEl.scrollTop;
	}

	function measureViewport(): void {
		if (!scrollEl) return;
		viewportHeight = scrollEl.clientHeight;
		if (isWebtoon) {
			columnWidth = scrollEl.clientWidth - 32;
		} else {
			columnWidth = Math.min(scrollEl.clientWidth - 32, 900);
		}
	}

	function onMeasured(pageIndex: number, height: number): void {
		if (measuredHeights[pageIndex] === height) return;
		measuredHeights = { ...measuredHeights, [pageIndex]: height };
	}

	onMount(() => {
		measureViewport();
		if (typeof window !== "undefined") {
			window.addEventListener("resize", measureViewport);
			return () => window.removeEventListener("resize", measureViewport);
		}
	});

	function handleKeyDown(e: KeyboardEvent): void {
		if (editorUiStore.workspaceView !== "review") return;
		// Ignore if typing in inputs/textareas
		const target = e.target as HTMLElement;
		if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
			return;
		}

		if (e.key === "ArrowLeft" || e.key === "PageUp") {
			e.preventDefault();
			const current = mode === "paged" ? pagedIndex : centeredIndex;
			jumpTo(current - 1);
		} else if (e.key === "ArrowRight" || e.key === "PageDown") {
			e.preventDefault();
			const current = mode === "paged" ? pagedIndex : centeredIndex;
			jumpTo(current + 1);
		}
	}

	function setMode(next: ReaderMode): void {
		mode = next;
		if (next === "long") queueMicrotask(measureViewport);
	}

	function jumpTo(index: number): void {
		const clamped = Math.max(0, Math.min(index, pages.length - 1));
		if (mode === "paged") {
			pagedIndex = clamped;
			return;
		}
		if (!scrollEl) return;
		const offset = stripScrollOffsetForIndex(clamped, {
			offsets: stripWindow.offsets,
			totalHeight: stripWindow.totalHeight,
			viewportHeight,
			margin: 8,
		});
		scrollEl.scrollTo({ top: offset, behavior: "smooth" });
	}

	function toggleTool(next: ReviewAnnotationShape): void {
		tool = tool === next ? null : next;
	}

	// BUG 2: open the EDITOR on the page currently centered in the reader. Review itself
	// stays read-only (no Fabric drag/edit here); this is the explicit hand-off to the
	// editor for the page the reviewer is looking at.
	async function openEditorAtCentered(): Promise<void> {
		if (openingEditor || pages.length === 0) return;
		const target = pages[Math.min(centeredIndex, pages.length - 1)] ?? pages[0];
		if (!target) return;
		openingEditor = true;
		try {
			if (projectStore.project && projectStore.project.currentPage !== target.pageIndex) {
				const opened = await projectStore.goToPage(target.pageIndex, editorStore.editor);
				if (!opened) return;
				editorStore.refreshTextLayers();
			}
			editorUiStore.openEditor();
			// URL must follow the editor state. The review reader lives on the
			// standalone `/projects/<id>/review` route, whose layout re-derives the
			// workspace view FROM the URL on reload / back. Without this navigation the
			// URL stays on …/review while the editor view is showing, so reload and the
			// back button bounce the user back into the reader. Sync the URL to the
			// editor page so it matches the visible state.
			syncEditorUrl(target.pageIndex);
		} finally {
			openingEditor = false;
		}
	}

	// Keep the URL in lock-step with the editor hand-off (BUG: review→editor URL
	// desync). Mirrors the shell's own editor navigation so back/reload behave.
	function syncEditorUrl(pageIndex: number): void {
		const projectId = projectStore.project?.projectId;
		if (!projectId) return;
		queueWorkspaceNavigation({ view: "editor", projectId, pageIndex });
	}

	function onDrawAnnotation(pageIndex: number, annotation: ReviewAnnotation): void {
		pendingAnnotation = { pageIndex, annotation };
		pendingBody = "";
	}

	async function savePendingAnnotation(): Promise<void> {
		if (!pendingAnnotation) return;
		const body = pendingBody.trim() || annotationFallbackNote(pendingAnnotation.annotation.shape);
		saving = true;
		try {
			await projectStore.addPageComment(body, undefined, undefined, {
				annotation: pendingAnnotation.annotation,
				pageIndex: pendingAnnotation.pageIndex,
			});
		} finally {
			saving = false;
			pendingAnnotation = null;
			pendingBody = "";
		}
	}

	function cancelPendingAnnotation(): void {
		pendingAnnotation = null;
		pendingBody = "";
	}

	function annotationFallbackNote(shape: ReviewAnnotationShape): string {
		const keys: Record<ReviewAnnotationShape, [string, string]> = {
			pin: ["review.notePin", "Pinned this spot"],
			circle: ["review.noteCircle", "Circled this spot for review"],
			rect: ["review.noteRect", "Boxed this spot for review"],
			freehand: ["review.noteFreehand", "Marked this for review"],
		};
		const [key, fallback] = keys[shape];
		return msg(key, fallback);
	}

	function selectAnnotation(commentId: string): void {
		projectStore.selectProjectComment(commentId);
	}

	// Hand a specific review mark off to the editor: jump to its page, KEEP it
	// selected (so the editor's CommentRegionOverlay highlights + focuses it), and
	// open the editor. The mark's region overlay then renders the exact shape the
	// reviewer drew at the right spot. Per the review UX spec ("Open in editor from
	// review must select the mark and focus image region").
	async function openEditorAtMark(commentId: string): Promise<void> {
		if (openingEditor) return;
		const comment = comments.find((c) => c.id === commentId);
		if (!comment) return;
		projectStore.selectProjectComment(commentId);
		openingEditor = true;
		try {
			if (projectStore.project && projectStore.project.currentPage !== comment.pageIndex) {
				const opened = await projectStore.goToPage(comment.pageIndex, editorStore.editor);
				if (!opened) return;
				editorStore.refreshTextLayers();
			}
			editorUiStore.setRightPanelMode("work");
			editorUiStore.openEditor();
			// Same URL/state sync as openEditorAtCentered — keep the address bar on the
			// editor page the mark lives on so reload/back don't drop back into review.
			syncEditorUrl(comment.pageIndex);
		} finally {
			openingEditor = false;
		}
	}

	const selectedCommentId = $derived(projectStore.selectedProjectCommentId);
	// "Open mark in editor" is only meaningful for an actual review MARK (annotation
	// comment). A plain comment selected elsewhere (Work/Editor) must NOT surface a
	// mark-specific action that would jump to a non-mark comment's page.
	const selectedMarkIsAnnotation = $derived(
		Boolean(selectedCommentId && comments.find((c) => c.id === selectedCommentId)?.annotation),
	);

	// --- per-page review decision (approve / request changes) for the centered page ---
	// The reader is the reviewer's surface, so it surfaces the decision the work board
	// already models (createReviewDecision). We target the page the reviewer is looking
	// at (centeredIndex), independent of the editor's open page.
	const decisionsLoading = $derived(projectStore.reviewDecisionsLoading);
	const centeredDecision = $derived(
		projectStore.reviewDecisions
			.filter((d) => d.pageIndex === (pages[centeredIndex]?.pageIndex ?? -1))
			.slice()
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null,
	);
	let decidingChanges = $state(false);
	let decisionNote = $state("");

	async function decide(status: PageReviewDecisionStatus): Promise<void> {
		if (decisionsLoading || pages.length === 0) return;
		const target = pages[centeredIndex] ?? pages[0];
		if (!target) return;
		if (status === "changes_requested" && !decidingChanges) {
			// First click opens a small reason box; the reviewer confirms to send back.
			decidingChanges = true;
			return;
		}
		const note = status === "changes_requested" ? decisionNote.trim() : "";
		await projectStore.createReviewDecision(status, note, target.pageIndex);
		decidingChanges = false;
		decisionNote = "";
	}

	function cancelChangesNote(): void {
		decidingChanges = false;
		decisionNote = "";
	}

	const TOOLS = $derived<{ id: ReviewAnnotationShape; label: string; icon: string }[]>([
		{ id: "circle", label: msg("review.toolCircle", "Circle"), icon: "○" },
		{ id: "rect", label: msg("review.toolRect", "Box"), icon: "▢" },
		{ id: "freehand", label: msg("review.toolFreehand", "Draw"), icon: "✎" },
		{ id: "pin", label: msg("review.toolPin", "Pin"), icon: "📍" },
	]);
	const LAYER_VIEWS = $derived<{ id: ReviewLayerView; label: string }[]>([
		{ id: "translated", label: msg("review.layerTranslated", "Translated") },
		{ id: "original", label: msg("review.layerOriginal", "Original") },
		{ id: "both", label: msg("review.layerBoth", "Compare") },
	]);

	// Reset the in-progress "request changes" note when the centered page changes, so a
	// half-typed reason never carries to a different page.
	$effect(() => {
		void centeredIndex;
		decidingChanges = false;
		decisionNote = "";
	});

	$effect(() => {
		if (editorUiStore.workspaceView === "review") {
			queueMicrotask(measureViewport);
		}
	});
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if editorUiStore.workspaceView === "review"}
	<section class="review-reader ws-sans" aria-label={msg("review.sectionAria", "Read / review chapter")}>
		<header class="review-toolbar ws-panel">
			<div class="review-toolbar-row">
				<div class="ws-panel-quiet inline-flex items-center gap-1 rounded-ws-ctrl p-0.5" role="tablist" aria-label={msg("review.readingModeAria", "Reading mode")}>
					<button type="button" role="tab" aria-selected={mode === "paged"} class={`ws-seg min-h-9 rounded-ws-ctrl px-3 text-[11px] font-medium ${mode === "paged" ? "ws-seg-on" : ""}`} onclick={() => setMode("paged")}>{msg("review.modePaged", "One page")}</button>
					<button type="button" role="tab" aria-selected={mode === "long"} class={`ws-seg min-h-9 rounded-ws-ctrl px-3 text-[11px] font-medium ${mode === "long" ? "ws-seg-on" : ""}`} onclick={() => setMode("long")}>{msg("review.modeLong", "Long scroll")}</button>
				</div>

				<div class="ws-panel-quiet inline-flex items-center gap-1 rounded-ws-ctrl p-0.5" role="group" aria-label={msg("review.layersAria", "Layers")}>
					{#each LAYER_VIEWS as v (v.id)}
						<button type="button" aria-pressed={layerView === v.id} class={`ws-seg min-h-9 rounded-ws-ctrl px-2.5 text-[11px] font-medium ${layerView === v.id ? "ws-seg-on" : ""}`} onclick={() => (layerView = v.id)}>{v.label}</button>
					{/each}
				</div>

				<div class="review-tools ws-panel-quiet" role="group" aria-label={msg("review.toolsAria", "Mark tools")}>
					{#each TOOLS as t (t.id)}
						<button
							type="button"
							aria-pressed={tool === t.id}
							class="review-tool ws-btn-ghost"
							class:review-tool-on={tool === t.id}
							title={msg("review.toolTitle", `Mark: ${t.label}`, { label: t.label })}
							onclick={() => toggleTool(t.id)}
						><span class="review-tool-icon" aria-hidden="true">{t.icon}</span><span class="review-tool-label">{t.label}</span></button>
					{/each}
				</div>

				<!-- per-page decision (approve / request changes) for the centered page -->
				<div class="review-decision" role="group" aria-label={msg("review.decisionAria", "Page review decision")}>
					{#if centeredDecision}
						<span class={`review-decision-badge ${centeredDecision.status === "approved" ? "approved" : "changes"}`}>
							{centeredDecision.status === "approved" ? msg("review.decisionApproved", "Approved") : msg("review.decisionChanges", "Changes requested")}
						</span>
					{/if}
					{#if reviewCaps.canReviewQC}
					<button
						type="button"
						class="review-decision-btn approve ws-btn-ghost"
						title={msg("review.approveTitle", "Approve this page")}
						disabled={!project || pages.length === 0 || decisionsLoading}
						onclick={() => decide("approved")}
					>✓ {msg("review.approve", "Approve")}</button>
					<button
						type="button"
						class="review-decision-btn changes ws-btn-ghost"
						class:active={decidingChanges}
						title={msg("review.requestChangesTitle", "Send this page back for changes")}
						disabled={!project || pages.length === 0 || decisionsLoading}
						onclick={() => decide("changes_requested")}
					>↩ {msg("review.requestChanges", "Request changes")}</button>
					{/if}
				</div>

				{#if permissions.canManageReviewAssignments}
				<button
					type="button"
					class="review-assign-btn ws-btn-ghost"
					data-testid="review-assign-open"
					title={msg("review.assignTitle", "Assign review")}
					disabled={!project || pages.length === 0}
					onclick={() => (assignOpen = true)}
				>{msg("review.assignCta", "Assign review")}{#if activeAssignmentCount > 0}<span class="review-assign-count tabular-nums">{activeAssignmentCount}</span>{/if}</button>
				{/if}

				{#if permissions.canManageReviewAssignments}
				<button
					type="button"
					class="review-revision-btn ws-btn-ghost"
					data-testid="review-revision-open"
					title={msg("revision.openTitle", "Send this work back to a team member for revision")}
					disabled={!project || pages.length === 0}
					onclick={() => (revisionOpen = true)}
				>↩ {msg("revision.cta", "Send back")}{#if openRevisionCount > 0}<span class="review-revision-count tabular-nums">{openRevisionCount}</span>{/if}</button>
				{/if}

				<button
					type="button"
					class="review-edit-btn ws-grad-primary"
					title={msg("review.enterEditorTitle", "Open this page in the editor")}
					disabled={!project || pages.length === 0 || openingEditor}
					onclick={openEditorAtCentered}
				>{msg("review.enterEditor", "Edit / open editor")}<span class="review-edit-page tabular-nums">{msg("review.pageBadge", `Page ${centeredIndex + 1}`, { n: centeredIndex + 1 })}</span></button>

				{#if selectedMarkIsAnnotation}
					<button
						type="button"
						class="review-edit-btn review-edit-mark ws-btn-ghost"
						title={msg("review.openMarkInEditorTitle", "Open this mark in the editor")}
						disabled={!project || openingEditor}
						onclick={() => selectedCommentId && openEditorAtMark(selectedCommentId)}
					>{msg("review.openMarkInEditor", "Open mark in editor")}</button>
				{/if}

				<span class="review-count ws-panel-quiet" title={msg("review.marksTitle", "Open marks")}>{msg("review.marksCount", `${totalReviewMarks} marks`, { n: totalReviewMarks })}</span>
			</div>

			{#if decidingChanges}
				<div class="review-changes-note">
					<input
						type="text"
						bind:value={decisionNote}
						placeholder={msg("review.decisionNotePlaceholder", "Reason / note (optional)")}
						disabled={decisionsLoading}
						onkeydown={(e) => { if (e.key === "Enter") decide("changes_requested"); if (e.key === "Escape") cancelChangesNote(); }}
					/>
					<button type="button" class="review-decision-btn changes active ws-btn-ghost" disabled={decisionsLoading} onclick={() => decide("changes_requested")}>{decisionsLoading ? msg("review.decisionSaving", "Saving…") : msg("review.requestChanges", "Request changes")}</button>
					<button type="button" class="review-changes-cancel ws-btn-ghost" disabled={decisionsLoading} onclick={cancelChangesNote}>{msg("review.composerCancel", "Cancel")}</button>
				</div>
			{/if}
		</header>

		{#if !project}
			<div class="review-empty">{msg("review.emptyNoProject", "Pick a chapter to start reviewing")}</div>
		{:else if pages.length === 0}
			<div class="review-empty">{msg("review.emptyNoPages", "This chapter has no pages yet")}</div>
		{:else}
			<div class="review-body">
				<!-- page rail -->
				<nav class="review-rail ws-panel-quiet" aria-label={msg("review.railAria", "Go to page")}>
					{#each pages as p (p.pageIndex)}
						{@const marks = openAnnotationCount(comments, p.pageIndex)}
						<button
							type="button"
							class={`review-rail-item ws-btn-ghost ${(mode === "paged" ? pagedIndex : centeredIndex) === p.pageIndex ? "active" : ""}`}
							onclick={() => jumpTo(p.pageIndex)}
						>
							<span class="tabular-nums">{p.pageIndex + 1}</span>
							{#if marks > 0}<span class="review-rail-dot" title={msg("review.railMarksTitle", `${marks} marks`, { n: marks })}>{marks}</span>{/if}
							{#if p.textless}<span class="review-rail-textless" title={msg("review.railTextless", "No text")}>·</span>{/if}
						</button>
					{/each}
				</nav>

				<!-- reading surface -->
				{#if mode === "paged"}
					<div bind:this={scrollEl} class="review-scroll" onscroll={onScroll}>
						{#if activePagedPage}
							<div class="review-page-wrap" style={`max-width:${columnWidth || 900}px`}>
								<ReviewPageCanvas
									page={activePagedPage}
									{projectId}
									columnWidth={columnWidth || 720}
									{layerView}
									{tool}
									{selectedCommentId}
									annotations={pageAnnotations(comments, activePagedPage.pageIndex)}
									{onMeasured}
									{onDrawAnnotation}
									onSelectAnnotation={selectAnnotation}
								/>
								<div class="review-pager">
									<button type="button" class="review-pager-btn ws-btn-ghost" disabled={pagedIndex <= 0} onclick={() => jumpTo(pagedIndex - 1)}>{msg("review.pagerPrev", "Previous")}</button>
									<span class="tabular-nums">{msg("review.pagerStatus", `Page ${pagedIndex + 1} / ${pages.length}`, { n: pagedIndex + 1, total: pages.length })}</span>
									<button type="button" class="review-pager-btn ws-btn-ghost" disabled={pagedIndex >= pages.length - 1} onclick={() => jumpTo(pagedIndex + 1)}>{msg("review.pagerNext", "Next")}</button>
								</div>
							</div>
						{/if}
					</div>
				{:else}
					<div class="review-scroll-container">
						<div bind:this={scrollEl} class="review-scroll" onscroll={onScroll}>
							<!-- virtualized long strip: a spacer of the full total height keeps the scrollbar honest -->
							<div class="review-strip" style={`height:${stripWindow.totalHeight}px;max-width:${isWebtoon ? '100%' : (columnWidth || 900) + 'px'}`}>
								{#each pages as p, index (p.pageIndex)}
									{#if index >= stripWindow.startIndex && index <= stripWindow.endIndex}
										<div class="review-strip-slot" style={`transform:translateY(${stripWindow.offsets[index]}px);height:${heights[index]}px`}>
											<!-- Per-page Divider Line -->
											<div class="review-page-divider" class:first={index === 0}>
												<span class="review-divider-line"></span>
											</div>

											<!-- Sticky Page Badge -->
											<div class="review-page-badge-sticky">
												<span class="badge-content ws-panel-quiet">
													{msg("review.pageBadge", `Page ${p.pageIndex + 1}`, { n: p.pageIndex + 1 })}
												</span>
											</div>

											<!-- Page Canvas Container -->
											<div class="review-page-canvas-container">
												<ReviewPageCanvas
													page={p}
													{projectId}
													columnWidth={columnWidth || 720}
													{layerView}
													{tool}
													{selectedCommentId}
													annotations={pageAnnotations(comments, p.pageIndex)}
													{onMeasured}
													{onDrawAnnotation}
													onSelectAnnotation={selectAnnotation}
												/>
											</div>
										</div>
									{/if}
								{/each}
							</div>
						</div>

						<!-- Floating Current Page Indicator -->
						{#if pages.length > 0}
							<div class="review-scroll-progress-floating" aria-hidden="true">
								<span class="scroll-progress-content ws-panel-quiet">
									{msg("review.pagerStatus", `Page ${centeredIndex + 1} / ${pages.length}`, { n: centeredIndex + 1, total: pages.length })}
								</span>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		<!-- new-mark note composer -->
		{#if pendingAnnotation}
			<div class="review-composer ws-panel" role="dialog" aria-label={msg("review.composerAria", "Add a review note")}>
				<strong>{msg("review.composerTitle", `Mark page ${pendingAnnotation.pageIndex + 1}`, { n: pendingAnnotation.pageIndex + 1 })}</strong>
				<textarea class="review-composer-textarea ws-panel-quiet" bind:value={pendingBody} rows="2" placeholder={msg("review.composerPlaceholder", "Note for this spot (optional)")} disabled={saving}></textarea>
				<div class="review-composer-actions">
					<button type="button" class="review-composer-btn ws-btn-ghost" onclick={cancelPendingAnnotation} disabled={saving}>{msg("review.composerCancel", "Cancel")}</button>
					<button type="button" class="review-composer-btn primary ws-grad-primary" onclick={savePendingAnnotation} disabled={saving}>{msg("review.composerSave", "Save mark")}</button>
				</div>
			</div>
		{/if}

		<AssignReviewPanel open={assignOpen} currentPageIndex={centeredIndex} onClose={() => (assignOpen = false)} />
		<RevisionSendBackDialog open={revisionOpen} currentPageIndex={centeredIndex} onClose={() => (revisionOpen = false)} />
	</section>
{/if}

<style>
	.review-reader {
		/* Overlay the shell's canvas-area exactly like every other workspace
		   surface (.ws-surface: position:absolute; inset:0; z-index:48 in app.css).
		   Without this the reader is position:static and falls into normal flow
		   BELOW the always-mounted Fabric CanvasArea (~1334px tall) in the same
		   grid cell, pushing the toolbar + pages off-screen. As an absolute
		   overlay it fills the canvas-area, owns its own scroll, and renders at
		   the TOP of the content area like dashboard/library/etc. */
		position: absolute;
		inset: 0;
		z-index: 48;
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: 0;
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
	}
	.review-toolbar {
		flex: 0 0 auto;
		padding: 10px 14px;
		border-bottom: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-bg) 82%, var(--color-ws-surface) 18%);
	}
	.review-toolbar-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}
	.review-tools {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px;
		border-radius: var(--radius-ws-ctrl, 10px);
	}
	.review-tool {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 36px;
		padding: 0 10px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 700;
		cursor: pointer;
	}
	.review-tool:hover {
		color: var(--color-ws-ink);
	}
	.review-tool-on {
		border-color: color-mix(in srgb, var(--color-ws-accent) 60%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		color: var(--color-ws-ink);
	}
	.review-tool-icon {
		font-size: 13px;
		line-height: 1;
	}
	.review-tool-label {
		line-height: 1;
	}
	.review-assign-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-left: auto;
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 800;
		cursor: pointer;
	}
	.review-assign-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
	}
	.review-assign-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.review-assign-count {
		min-width: 16px;
		padding: 1px 5px;
		border-radius: var(--radius-ws-card, 12px);
		background: var(--color-ws-accent);
		color: var(--color-ws-ink);
		font-weight: 800;
		text-align: center;
	}
	.review-revision-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 800;
		cursor: pointer;
	}
	.review-revision-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
	}
	.review-revision-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.review-revision-count {
		min-width: 16px;
		padding: 1px 5px;
		border-radius: var(--radius-ws-card, 12px);
		background: var(--color-ws-accent);
		color: var(--color-ws-ink);
		font-weight: 800;
		text-align: center;
	}
	.review-edit-btn {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 800;
		cursor: pointer;
	}
	.review-edit-btn:hover:not(:disabled) {
		filter: brightness(1.08);
	}
	.review-edit-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.review-edit-mark {
		margin-left: 8px;
		background: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		color: var(--color-ws-accent);
	}
	.review-edit-page {
		padding: 1px 6px;
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-bg) 42%, transparent);
		font-weight: 800;
	}
	.review-count {
		padding: 3px 9px;
		border-radius: var(--radius-ws-card, 12px);
		font-size: 11px;
		font-weight: 800;
		color: var(--color-ws-text);
	}
	.review-decision {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.review-decision-badge {
		padding: 2px 8px;
		border-radius: var(--radius-ws-card, 12px);
		font-size: 10px;
		font-weight: 800;
		white-space: nowrap;
	}
	.review-decision-badge.approved {
		background: color-mix(in srgb, var(--color-ws-green) 18%, transparent);
		color: var(--color-ws-green);
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 40%, transparent);
	}
	.review-decision-badge.changes {
		background: color-mix(in srgb, var(--color-ws-amber) 18%, transparent);
		color: var(--color-ws-amber);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 40%, transparent);
	}
	.review-decision-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 36px;
		padding: 0 10px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 700;
		cursor: pointer;
	}
	.review-decision-btn.approve:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--color-ws-green) 60%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 16%, transparent);
		color: var(--color-ws-green);
	}
	.review-decision-btn.changes:hover:not(:disabled),
	.review-decision-btn.changes.active {
		border-color: color-mix(in srgb, var(--color-ws-amber) 60%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 16%, transparent);
		color: var(--color-ws-amber);
	}
	.review-decision-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.review-changes-note {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
	}
	.review-changes-note input {
		flex: 1;
		min-width: 0;
		max-width: 420px;
		min-height: 36px;
		padding: 6px 10px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
	}
	.review-changes-cancel {
		min-height: 36px;
		padding: 0 10px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 700;
		cursor: pointer;
	}
	.review-changes-cancel:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.review-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		color: var(--color-ws-text);
		font-size: 13px;
	}
	.review-body {
		display: grid;
		grid-template-columns: 56px minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}
	.review-rail {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 6px;
		overflow-y: auto;
		border-right: 1px solid var(--ws-hair);
	}
	.review-rail-item {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}
	.review-rail-item.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 60%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		color: var(--color-ws-ink);
	}
	.review-rail-dot {
		position: absolute;
		top: -4px;
		right: -4px;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: var(--radius-ws-card, 12px);
		background: var(--color-ws-amber);
		color: var(--color-ws-bg);
		font-size: 9px;
		font-weight: 900;
		line-height: 15px;
	}
	.review-rail-textless {
		position: absolute;
		bottom: 2px;
		font-size: 10px;
		opacity: 0.5;
	}
	.review-scroll-container {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
		width: 100%;
	}
	.review-scroll {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 16px;
		min-height: 0;
	}
	.review-strip {
		position: relative;
		margin: 0 auto;
		width: 100%;
	}
	.review-strip-slot {
		position: absolute;
		left: 0;
		right: 0;
		width: 100%;
		content-visibility: auto;
		display: flex;
		flex-direction: column;
	}
	.review-page-divider {
		display: flex;
		align-items: center;
		height: 24px;
		width: 100%;
		padding: 0 8px;
	}
	.review-divider-line {
		flex: 1;
		height: 1px;
		background: var(--ws-hair);
	}
	.review-page-divider.first .review-divider-line {
		opacity: 0;
	}
	.review-page-badge-sticky {
		position: sticky;
		top: 8px;
		z-index: 20;
		display: flex;
		justify-content: center;
		height: 32px;
		pointer-events: none;
		margin-bottom: 8px;
	}
	.review-page-badge-sticky .badge-content {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		padding: 4px 12px;
		border-radius: var(--radius-ws-card, 12px);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.05em;
		color: var(--color-ws-ink);
		backdrop-filter: blur(4px);
	}
	.review-page-canvas-container {
		display: flex;
		justify-content: center;
		width: 100%;
	}
	.review-scroll-progress-floating {
		position: absolute;
		bottom: 20px;
		left: 76px;
		z-index: 40;
		pointer-events: none;
	}
	.review-scroll-progress-floating .scroll-progress-content {
		display: inline-flex;
		align-items: center;
		padding: 6px 12px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 700;
		backdrop-filter: blur(8px);
	}
	.review-page-wrap {
		margin: 0 auto;
		width: 100%;
	}
	.review-pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 14px;
		margin-top: 14px;
		font-size: 12px;
		color: var(--color-ws-text);
	}
	.review-pager-btn {
		min-height: 36px;
		padding: 0 14px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}
	.review-pager-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.review-composer {
		position: absolute;
		inset: auto 18px 18px auto;
		z-index: 60;
		display: grid;
		gap: 8px;
		width: min(360px, calc(100% - 36px));
		padding: 12px 14px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 40%, transparent);
		border-radius: var(--radius-ws-card, 12px);
	}
	.review-composer strong {
		font-size: 12px;
		color: var(--color-ws-ink);
	}
	.review-composer textarea {
		width: 100%;
		resize: vertical;
		min-height: 64px;
		border-radius: var(--radius-ws-ctrl, 10px);
		padding: 8px;
		color: var(--color-ws-ink);
		font-size: 12px;
	}
	.review-composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.review-composer-btn {
		min-height: 36px;
		padding: 0 12px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}
	.review-composer-btn.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 60%, transparent);
		color: var(--color-ws-ink);
	}
	.review-composer-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
