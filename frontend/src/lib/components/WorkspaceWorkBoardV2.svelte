<!--
	Work Board V2 (2026-06-13) — แทนบอร์ดเบนช์เดิมทั้งหมด (ห้ามให้เห็นของเก่า).

	โมเดล: ตาราง "หน้า × หน้าที่" ของตอนที่เปิดอยู่ — อ่านแถวเดียวรู้ทั้งสถานะหน้า:
	ใครจอง (รับงาน) อยู่ช่องไหน, หน้าไหนส่งต่อแล้ว (handoff), หน้าไหนติดธงต้องเช็คใหม่,
	ใครกำลังเปิดหน้านั้นอยู่ (lock). คนทำงานกด "รับงาน" เพื่อจองช่องของหน้าที่ตัวเอง
	จะทำ (กันทำชนกัน), เปิดหน้าเพื่อทำงาน, แล้วกด "ส่งต่อ" เมื่อเสร็จ.

	ข้อมูลทั้งหมด reuse ของเดิม: projectStore.tasks (+ updateTaskAssignee /
	submitTaskToNextStage), handoff บน page, locksStore, duty-profile.
-->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { locksStore } from "$lib/stores/locks.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { resolveDutyCapabilities } from "$lib/editor/duty-profile.ts";
	import { formatAssigneeHandle, normalizeAssigneeHandle } from "$lib/project/assignees.ts";
	import { pageLockId } from "$lib/collab/page-lock-id.ts";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.ts";
	import { pageOutput } from "$lib/project/language-tracks.ts";
	import { signedAssetSrc } from "$lib/actions/signedAssetSrc.ts";
	import type { WorkflowTask, WorkflowTaskType } from "$lib/types.js";
	import { armEasyModeRecipeById } from "$lib/editor/easy-mode-activator.ts";
	import type { EasyModeId } from "$lib/editor/tool-help.ts";

	// #E5: a task stage maps to the Easy-Mode recipe that arms its tool. "review" (QC)
	// has no editor recipe, so opening a review page leaves the tool unchanged.
	const TASK_TO_RECIPE: Partial<Record<WorkflowTaskType, EasyModeId>> = {
		clean: "clean",
		translate: "translate",
		typeset: "typeset",
	};

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value === key ? fallback : value;
	}

	const DUTY_COLUMNS: Array<{ type: WorkflowTaskType; labelKey: string; fallback: string; capability: "canTranslate" | "canClean" | "canTypeset" | "canReviewQC" }> = [
		{ type: "translate", labelKey: "workBoardV2.colTranslate", fallback: "แปล", capability: "canTranslate" },
		{ type: "clean", labelKey: "workBoardV2.colClean", fallback: "คลีน", capability: "canClean" },
		{ type: "typeset", labelKey: "workBoardV2.colTypeset", fallback: "ลงคำ", capability: "canTypeset" },
		{ type: "review", labelKey: "workBoardV2.colReview", fallback: "ตรวจ", capability: "canReviewQC" },
	];

	let project = $derived(projectStore.project);
	let pages = $derived(project?.pages ?? []);
	let tasks = $derived(projectStore.tasks);
	let dutyCaps = $derived(resolveDutyCapabilities({
		userId: authStore.user?.id,
		email: authStore.user?.email,
		accountRole: authStore.role,
		memberStudioRole: projectStore.currentWorkspaceMember?.memberStudioRole,
		chapterTeam: project?.chapterTeam,
		storyRoles: projectStore.viewerStoryDutyRoles,
	}));
	let myHandle = $derived(normalizeAssigneeHandle(authStore.user?.email ?? authStore.user?.id ?? "") ?? "");
	// The board stamps DIFFERENT keys by path: a self-claim writes the email
	// (myHandle), a manager-assign writes the member userId. The backend My-Work
	// matcher tolerates either (workspaces.ts), so `isMine` must match BOTH — else
	// a manager-assigned task wouldn't be recognized as the assignee's own.
	let myHandles = $derived(
		new Set(
			[authStore.user?.email, authStore.user?.id]
				.map((h) => normalizeAssigneeHandle(h ?? ""))
				.filter((h): h is string => Boolean(h)),
		),
	);

	// Managers (workspace owner/admin) can ASSIGN any cell to a member and UNDO a
	// finished task — not just claim for themselves (issue #5a/#5d).
	let isManager = $derived(workspacesStore.isAdmin);
	// A zero-duty, non-manager member has nothing to bulk-claim — hide the dead
	// affordance (it would make no API calls anyway). Managers always keep it.
	let hasAnyDuty = $derived(DUTY_COLUMNS.some((column) => dutyCaps[column.capability]));

	// Assignee candidates: workspace members (now name-enriched, #2) unioned with
	// the chapter team, deduped by userId. Each carries a display label, the
	// userId (stamped by manager-assign) AND the email (stamped by self-claim) so
	// labels resolve regardless of which key landed on the task.
	interface AssignCandidate { userId: string; label: string; email?: string; }
	let assignCandidates = $derived.by<AssignCandidate[]>(() => {
		const byId = new Map<string, AssignCandidate>();
		for (const m of workspacesStore.members) {
			if (m.disabledAt) continue;
			const label = m.displayName?.trim() || m.email?.trim() || m.userId;
			byId.set(m.userId, { userId: m.userId, label, email: m.email?.trim() || undefined });
		}
		for (const member of project?.chapterTeam ?? []) {
			if (member.status !== "active" || !member.userId) continue;
			const label = member.displayName?.trim() || member.email?.trim() || member.userId;
			if (!byId.has(member.userId)) byId.set(member.userId, { userId: member.userId, label, email: member.email?.trim() || undefined });
		}
		return [...byId.values()];
	});

	// Resolve an assignee handle to a friendly name (matches either key, #5 review).
	function assigneeLabel(handle: string): string {
		const normalized = normalizeAssigneeHandle(handle);
		const match = assignCandidates.find(
			(c) =>
				normalizeAssigneeHandle(c.userId) === normalized ||
				(c.email ? normalizeAssigneeHandle(c.email) === normalized : false),
		);
		return match?.label ?? formatAssigneeHandle(handle, "?");
	}

	function taskFor(pageIndex: number, type: WorkflowTaskType): WorkflowTask | null {
		// งานแปล/ลงคำ/ตรวจ ผูกกับ language track; งานคลีนเป็นของภาพต้นฉบับ (ไม่ผูกภาษา)
		const activeLang = projectStore.activeTargetLang;
		const defaultLang = project?.targetLang ?? activeLang;
		return tasks.find((task) => {
			if (task.pageIndex !== pageIndex || task.type !== type) return false;
			if (type === "clean") return true;
			return (task.targetLang ?? defaultLang) === activeLang;
		}) ?? null;
	}

	function isMine(task: WorkflowTask | null): boolean {
		if (!task?.assignee || myHandles.size === 0) return false;
		const normalized = normalizeAssigneeHandle(task.assignee);
		return normalized !== null && myHandles.has(normalized);
	}

	let doneCount = $derived(tasks.filter((task) => task.status === "done").length);
	let progressPct = $derived(tasks.length === 0 ? 0 : Math.round((doneCount / tasks.length) * 100));
	let myOpenCount = $derived(tasks.filter((task) => task.status !== "done" && isMine(task)).length);

	function pageFlags(pageIndex: number): string[] {
		const page = pages[pageIndex];
		if (!page) return [];
		const flags: string[] = [];
		// translation/qc handoff อยู่ราย language track; cleaning อยู่กับภาพต้นฉบับ (flat)
		const output = pageOutput(page, projectStore.activeTargetLang);
		if (output.translationHandoff?.status === "translated") flags.push(msg("workBoardV2.flagTranslated", "แปลแล้ว"));
		if (page.cleaningHandoff?.status === "clean_ready") flags.push(msg("workBoardV2.flagCleanReady", "คลีนพร้อม"));
		if (page.cleaningHandoff?.typesetRecheckStatus === "needs_adjustment") flags.push(msg("workBoardV2.flagRecheck", "⚠ เช็คใหม่"));
		if (output.qcHandoff?.status === "ready") flags.push(msg("workBoardV2.flagQcReady", "ตรวจผ่าน"));
		if (output.qcHandoff?.status === "needs_fix") flags.push(msg("workBoardV2.flagNeedsFix", "⚠ ต้องแก้"));
		return flags;
	}

	function lockOwner(pageIndex: number): string | null {
		if (!project) return null;
		const lock = locksStore.getByScope("page", pageLockId(project.projectId, pageIndex));
		return lock?.owner ? formatAssigneeHandle(lock.owner, "") : null;
	}

	let busyTaskId = $state<string | null>(null);

	async function claimTask(task: WorkflowTask): Promise<void> {
		if (!myHandle || busyTaskId) return;
		busyTaskId = task.id;
		try {
			await projectStore.updateTaskAssignee(task.id, myHandle);
		} finally {
			busyTaskId = null;
		}
	}

	async function releaseTask(task: WorkflowTask): Promise<void> {
		if (busyTaskId) return;
		busyTaskId = task.id;
		try {
			await projectStore.bulkUpdateTaskAssignee([task.id], null);
		} finally {
			busyTaskId = null;
		}
	}

	async function sendForward(task: WorkflowTask): Promise<void> {
		if (busyTaskId) return;
		busyTaskId = task.id;
		try {
			await projectStore.submitTaskToNextStage(task.id);
		} finally {
			busyTaskId = null;
		}
	}

	// Boss assigns a cell to a specific member (issue #5a) — distinct from a worker
	// claiming for themselves.
	async function assignTask(task: WorkflowTask, userId: string): Promise<void> {
		if (!userId || busyTaskId) return;
		busyTaskId = task.id;
		try {
			await projectStore.updateTaskAssignee(task.id, userId);
		} finally {
			busyTaskId = null;
		}
	}

	// Undo an accidental "done"/"ส่งต่อ" (issue #5d): reopen the task to "doing".
	// (submitTaskToNextStage marks done + may open the next stage; reopening the
	// task itself cancels the "เผลอเสร็จ" — the next stage is the natural pipeline.)
	async function undoTask(task: WorkflowTask): Promise<void> {
		if (busyTaskId) return;
		busyTaskId = task.id;
		try {
			await projectStore.updateTaskStatus(task.id, "doing");
		} finally {
			busyTaskId = null;
		}
	}

	// ── Bulk select + actions (issue #5b: 300-500 pages, no one-by-one) ──────────
	let selectionMode = $state(false);
	let selectedTaskIds = $state<Set<string>>(new Set());
	let bulkBusy = $state(false);
	let bulkAssignUser = $state("");

	function toggleSelectionMode(): void {
		selectionMode = !selectionMode;
		if (!selectionMode) selectedTaskIds = new Set();
	}

	function toggleTaskSelected(taskId: string): void {
		const next = new Set(selectedTaskIds);
		if (next.has(taskId)) next.delete(taskId);
		else next.add(taskId);
		selectedTaskIds = next;
	}

	// Every task id in a duty column across ALL pages (not just the visible page).
	function columnTaskIds(type: WorkflowTaskType, opts: { onlyOpen?: boolean; onlyUnassigned?: boolean } = {}): string[] {
		const ids: string[] = [];
		for (let i = 0; i < pages.length; i++) {
			const task = taskFor(i, type);
			if (!task) continue;
			if (opts.onlyOpen && task.status === "done") continue;
			if (opts.onlyUnassigned && task.assignee) continue;
			ids.push(task.id);
		}
		return ids;
	}

	function selectWholeColumn(type: WorkflowTaskType): void {
		// Defense-in-depth: a non-manager may only mass-select a column they have
		// duty for (the button is already duty-gated, but never trust the caller).
		const column = DUTY_COLUMNS.find((c) => c.type === type);
		if (!isManager && !(column && dutyCaps[column.capability])) return;
		selectionMode = true;
		const next = new Set(selectedTaskIds);
		for (const id of columnTaskIds(type)) next.add(id);
		selectedTaskIds = next;
	}

	function clearSelection(): void {
		selectedTaskIds = new Set();
	}

	async function runBulk(fn: () => Promise<unknown>): Promise<void> {
		if (bulkBusy) return;
		bulkBusy = true;
		try {
			await fn();
		} finally {
			bulkBusy = false;
		}
	}

	// "รับทุกหน้าของหน้าที่ฉัน": claim every open+unassigned task in the columns the
	// viewer has duty for, across all pages.
	async function bulkClaimMyDuties(): Promise<void> {
		if (!myHandle) return;
		const ids: string[] = [];
		for (const column of DUTY_COLUMNS) {
			if (!dutyCaps[column.capability]) continue;
			ids.push(...columnTaskIds(column.type, { onlyOpen: true, onlyUnassigned: true }));
		}
		if (ids.length === 0) return;
		await runBulk(() => projectStore.bulkUpdateTaskAssignee(ids, myHandle));
	}

	async function bulkAssignSelected(): Promise<void> {
		if (!bulkAssignUser || selectedTaskIds.size === 0) return;
		const ids = [...selectedTaskIds];
		await runBulk(async () => {
			await projectStore.bulkUpdateTaskAssignee(ids, bulkAssignUser);
			clearSelection();
		});
	}

	async function bulkClaimSelected(): Promise<void> {
		if (!myHandle || selectedTaskIds.size === 0) return;
		const ids = [...selectedTaskIds];
		await runBulk(async () => {
			await projectStore.bulkUpdateTaskAssignee(ids, myHandle);
			clearSelection();
		});
	}

	async function bulkReleaseSelected(): Promise<void> {
		if (selectedTaskIds.size === 0) return;
		const ids = [...selectedTaskIds];
		await runBulk(async () => {
			await projectStore.bulkUpdateTaskAssignee(ids, null);
			clearSelection();
		});
	}

	// ── Pagination (issue #5b/#9b: a 500-page chapter must not render 500 rows) ──
	const BOARD_PAGE_SIZE = 50;
	let boardPage = $state(0);
	let pageCount = $derived(Math.max(1, Math.ceil(pages.length / BOARD_PAGE_SIZE)));
	let boardPageStart = $derived(Math.min(boardPage, pageCount - 1) * BOARD_PAGE_SIZE);
	// Rows for the current board page, paired with their absolute page index.
	let visiblePageRows = $derived(
		pages.slice(boardPageStart, boardPageStart + BOARD_PAGE_SIZE).map((page, offset) => ({ page, pageIndex: boardPageStart + offset })),
	);
	function setBoardPage(next: number): void {
		boardPage = Math.min(Math.max(0, next), pageCount - 1);
	}
	// Re-clamp when the chapter shrinks (pages deleted) so the pager label and the
	// prev/next disabled state never reference a page that no longer exists.
	$effect(() => {
		if (boardPage > pageCount - 1) boardPage = pageCount - 1;
	});

	// Managers need the member roster for the assign picker; it's admin-gated so a
	// worker's load is a harmless no-op/403 the store swallows. Load once per board.
	let membersLoadedFor = $state<string | null>(null);
	$effect(() => {
		if (!isManager || !project) return;
		const wsId = workspacesStore.currentWorkspace?.workspaceId;
		if (!wsId || membersLoadedFor === wsId || workspacesStore.members.length > 0) return;
		membersLoadedFor = wsId;
		void workspacesStore.listMembers(wsId, { silent: true }).catch(() => undefined);
	});

	// #E5: pick the recipe to auto-arm when a worker opens this page. Conservative on
	// purpose — only when the intent is unambiguous, so we never yank a manager onto a
	// "clean" tool just because a clean task exists:
	//   1) a stage the viewer has personally claimed here (mine, not done), else
	//   2) for a non-manager single-duty worker, the one capable stage with an open task.
	// armEasyModeRecipeById re-checks duty capability, so this never arms a forbidden tool.
	function resolveOpenArmRecipe(pageIndex: number): EasyModeId | null {
		for (const col of DUTY_COLUMNS) {
			const task = taskFor(pageIndex, col.type);
			if (task && isMine(task) && task.status !== "done") {
				return TASK_TO_RECIPE[col.type] ?? null;
			}
		}
		if (!isManager) {
			const openMine = DUTY_COLUMNS.filter((col) => {
				if (!dutyCaps[col.capability]) return false;
				const task = taskFor(pageIndex, col.type);
				return Boolean(task && task.status !== "done");
			});
			if (openMine.length === 1) return TASK_TO_RECIPE[openMine[0].type] ?? null;
		}
		return null;
	}

	async function openPage(pageIndex: number): Promise<void> {
		const armRecipe = resolveOpenArmRecipe(pageIndex);
		await projectStore.goToPage(pageIndex, editorStore.editor);
		editorStore.refreshTextLayers();
		editorUiStore.setWorkspaceView("editor");
		// Arm AFTER the page is loaded and the editor view is on screen, so the dock the
		// recipe targets is mounted and the tool's onActivate can take effect.
		if (armRecipe) armEasyModeRecipeById(armRecipe);
	}

	function previewParams(pageIndex: number) {
		const page = pages[pageIndex];
		if (!project || !page) return null;
		const imageId = getPagePreviewImageId(page, projectStore.localImageUrls);
		if (!imageId) return null;
		const url = projectStore.getImageUrl(imageId);
		if (!url) return null;
		return { projectId: project.projectId, imageId, url, purpose: "editor_preview" as const };
	}

	function statusLabel(task: WorkflowTask): string {
		switch (task.status) {
			case "todo": return msg("workBoardV2.statusTodo", "รอทำ");
			case "doing": return msg("workBoardV2.statusDoing", "กำลังทำ");
			case "review": return msg("workBoardV2.statusReview", "รอตรวจ");
			case "done": return msg("workBoardV2.statusDone", "เสร็จ");
		}
	}
</script>

{#if editorUiStore.workspaceView === "work"}
	<section class="ws-surface workspace-work-shell" aria-label={msg("workBoardV2.boardAria", "บอร์ดงานทีม")}>
		<div class="ws-surface-inner wb2">
			{#if !project}
				<div class="wb2-empty">{msg("workBoardV2.noProject", "เปิดตอนจากคลังก่อน แล้วบอร์ดงานของตอนนั้นจะแสดงที่นี่")}</div>
			{:else}
				<header class="wb2-head">
					<div class="wb2-title">
						<h1>{project.name}</h1>
						<p>
							{msg("workBoardV2.progress", "ความคืบหน้า")} {progressPct}% ·
							{doneCount}/{tasks.length} {msg("workBoardV2.tasksUnit", "งาน")}
							{#if myOpenCount > 0}
								· <strong>{msg("workBoardV2.myOpen", "ค้างของฉัน")} {myOpenCount}</strong>
							{/if}
						</p>
					</div>
					<div class="wb2-progress" role="progressbar" aria-valuenow={progressPct} aria-valuemin="0" aria-valuemax="100">
						<span style={`width:${progressPct}%`}></span>
					</div>
				</header>

				<!-- Quick bulk actions (issue #5b): claim/select across ALL pages at once. -->
				<div class="wb2-toolbar">
					{#if isManager || hasAnyDuty}
					<button type="button" class="wb2-tool" disabled={bulkBusy} onclick={() => void bulkClaimMyDuties()}>
						{msg("workBoardV2.claimAllMyDuty", "รับทุกหน้าของหน้าที่ฉัน")}
					</button>
					{/if}
					<button type="button" class="wb2-tool ghost" class:active={selectionMode} onclick={toggleSelectionMode}>
						{selectionMode ? msg("workBoardV2.selectionOff", "ออกจากโหมดเลือก") : msg("workBoardV2.selectionOn", "เลือกหลายงาน")}
					</button>
				</div>

				{#if selectionMode}
					<div class="wb2-bulkbar" role="group" aria-label={msg("workBoardV2.bulkBarAria", "การกระทำกับงานที่เลือก")}>
						<span class="wb2-bulk-count">{msg("workBoardV2.selectedCount", "เลือกแล้ว")} {selectedTaskIds.size}</span>
						<button type="button" disabled={bulkBusy || selectedTaskIds.size === 0} onclick={() => void bulkClaimSelected()}>{msg("workBoardV2.claimSelected", "รับงานที่เลือก")}</button>
						{#if isManager}
							<span class="wb2-bulk-assign">
								<select bind:value={bulkAssignUser} disabled={bulkBusy} aria-label={msg("workBoardV2.assignToAria", "มอบให้")}>
									<option value="">{msg("workBoardV2.assignPick", "มอบให้…")}</option>
									{#each assignCandidates as cand (cand.userId)}
										<option value={cand.userId}>{cand.label}</option>
									{/each}
								</select>
								<button type="button" disabled={bulkBusy || !bulkAssignUser || selectedTaskIds.size === 0} onclick={() => void bulkAssignSelected()}>{msg("workBoardV2.assignSelected", "มอบงานที่เลือก")}</button>
							</span>
						{/if}
						<button type="button" class="ghost" disabled={bulkBusy || selectedTaskIds.size === 0} onclick={() => void bulkReleaseSelected()}>{msg("workBoardV2.releaseSelected", "คืนงานที่เลือก")}</button>
						<button type="button" class="ghost" disabled={bulkBusy || selectedTaskIds.size === 0} onclick={clearSelection}>{msg("workBoardV2.clearSelection", "ล้างที่เลือก")}</button>
					</div>
				{/if}

				{#if pages.length === 0}
					<div class="wb2-empty">{msg("workBoardV2.noPages", "ตอนนี้ยังไม่มีหน้า — เพิ่มรูปหน้าก่อน")}</div>
				{:else}
					<div class="wb2-table" role="table" aria-label={msg("workBoardV2.tableAria", "สถานะงานรายหน้า")}>
						<div class="wb2-row wb2-row-head" role="row">
							<div class="wb2-cell wb2-cell-page" role="columnheader">{msg("workBoardV2.colPage", "หน้า")}</div>
							{#each DUTY_COLUMNS as column (column.type)}
								<div class="wb2-cell" role="columnheader" class:my-duty={dutyCaps[column.capability]}>
									{msg(column.labelKey, column.fallback)}
									{#if dutyCaps[column.capability]}
										<span class="wb2-duty-badge">{msg("workBoardV2.yourDuty", "หน้าที่คุณ")}</span>
									{/if}
									{#if selectionMode && (isManager || dutyCaps[column.capability])}
										<button type="button" class="wb2-col-select" title={msg("workBoardV2.selectColumn", "เลือกทั้งคอลัมน์")} onclick={() => selectWholeColumn(column.type)}>＋</button>
									{/if}
								</div>
							{/each}
						</div>
						{#each visiblePageRows as { page, pageIndex } (page.imageId + pageIndex)}
							{@const flags = pageFlags(pageIndex)}
							{@const presence = lockOwner(pageIndex)}
							{@const preview = previewParams(pageIndex)}
							<div class="wb2-row" role="row">
								<div class="wb2-cell wb2-cell-page" role="cell">
									<button type="button" class="wb2-page-open" onclick={() => void openPage(pageIndex)} title={msg("workBoardV2.openPage", "เปิดหน้านี้ในเอดิเตอร์")}>
										{#if preview}
											<img class="wb2-thumb" alt="" use:signedAssetSrc={preview} />
										{:else}
											<span class="wb2-thumb wb2-thumb-blank" aria-hidden="true"></span>
										{/if}
										<span class="wb2-page-no">{pageIndex + 1}</span>
									</button>
									<div class="wb2-page-meta">
										{#each flags as flag (flag)}
											<span class="wb2-flag" class:warn={flag.startsWith("⚠")}>{flag}</span>
										{/each}
										{#if presence}
											<span class="wb2-presence" title={msg("workBoardV2.presenceTitle", "กำลังเปิดหน้านี้อยู่")}>👤 {presence}</span>
										{/if}
									</div>
								</div>
								{#each DUTY_COLUMNS as column (column.type)}
									{@const task = taskFor(pageIndex, column.type)}
									<div class="wb2-cell" role="cell" class:my-duty={dutyCaps[column.capability]}>
										{#if !task}
											<span class="wb2-none">—</span>
										{:else}
											<div class="wb2-task" class:mine={isMine(task)} class:done={task.status === "done"}>
												{#if selectionMode && (isManager || dutyCaps[column.capability])}
													<label class="wb2-pick">
														<input
															type="checkbox"
															checked={selectedTaskIds.has(task.id)}
															onchange={() => toggleTaskSelected(task.id)}
															aria-label={msg("workBoardV2.selectTask", "เลือกงานนี้")}
														/>
													</label>
												{/if}
												<span class="wb2-status {task.status}">{statusLabel(task)}</span>
												{#if task.assignee}
													<span class="wb2-assignee" class:me={isMine(task)}>
														{isMine(task) ? msg("workBoardV2.me", "ฉัน") : assigneeLabel(task.assignee)}
													</span>
													{#if task.status === "done"}
														{#if isMine(task) || isManager}
															<span class="wb2-actions">
																<button type="button" class="ghost" disabled={busyTaskId === task.id} onclick={() => void undoTask(task)} title={msg("workBoardV2.undoTitle", "ยกเลิกการทำเสร็จ กลับไปกำลังทำ")}>{msg("workBoardV2.undo", "ยกเลิกเสร็จ")}</button>
															</span>
														{/if}
													{:else if isMine(task)}
														<span class="wb2-actions">
															<button type="button" disabled={busyTaskId === task.id} onclick={() => void sendForward(task)} title={msg("workBoardV2.sendForwardTitle", "ทำเสร็จแล้ว ส่งต่อขั้นถัดไป")}>{msg("workBoardV2.sendForward", "เสร็จ → ขั้นถัดไป")}</button>
															<button type="button" class="ghost" disabled={busyTaskId === task.id} onclick={() => void releaseTask(task)}>{msg("workBoardV2.release", "คืนงาน")}</button>
														</span>
													{:else if isManager}
														<span class="wb2-actions">
															<button type="button" class="ghost" disabled={busyTaskId === task.id} onclick={() => void releaseTask(task)} title={msg("workBoardV2.reassignTitle", "คืนงานเพื่อมอบหมายใหม่")}>{msg("workBoardV2.release", "คืนงาน")}</button>
														</span>
													{/if}
												{:else if task.status === "done"}
													{#if isManager}
														<span class="wb2-actions">
															<button type="button" class="ghost" disabled={busyTaskId === task.id} onclick={() => void undoTask(task)}>{msg("workBoardV2.undo", "ยกเลิกเสร็จ")}</button>
														</span>
													{:else}
														<span class="wb2-unassigned">{statusLabel(task)}</span>
													{/if}
												{:else}
													<div class="wb2-claim-row">
														{#if dutyCaps[column.capability]}
															<button type="button" class="wb2-claim" disabled={busyTaskId === task.id} onclick={() => void claimTask(task)}>
																{msg("workBoardV2.claim", "รับงาน")}
															</button>
														{:else}
															<span class="wb2-unassigned">{msg("workBoardV2.unassigned", "ยังว่าง")}</span>
														{/if}
														{#if isManager && assignCandidates.length > 0}
															<select
																class="wb2-assign-pick"
																disabled={busyTaskId !== null}
																aria-label={msg("workBoardV2.assignToAria", "มอบให้")}
																value=""
																onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ""; if (v) void assignTask(task, v); }}
															>
																<option value="">{msg("workBoardV2.assignPick", "มอบให้…")}</option>
																{#each assignCandidates as cand (cand.userId)}
																	<option value={cand.userId}>{cand.label}</option>
																{/each}
															</select>
														{/if}
													</div>
												{/if}
											</div>
										{/if}
									</div>
								{/each}
							</div>
						{/each}
					</div>
						{#if pageCount > 1}
							<nav class="wb2-pager" aria-label={msg("workBoardV2.pagerAria", "เปลี่ยนหน้าของบอร์ด")}>
								<button type="button" disabled={boardPage === 0} onclick={() => setBoardPage(boardPage - 1)}>‹ {msg("workBoardV2.prevPage", "ก่อนหน้า")}</button>
								<span class="wb2-pager-info">
									{msg("workBoardV2.pageOf", "หน้า")} {boardPage + 1}/{pageCount}
									· {boardPageStart + 1}–{Math.min(boardPageStart + BOARD_PAGE_SIZE, pages.length)} / {pages.length}
								</span>
								<button type="button" disabled={boardPage >= pageCount - 1} onclick={() => setBoardPage(boardPage + 1)}>{msg("workBoardV2.nextPage", "ถัดไป")} ›</button>
							</nav>
						{/if}
				{/if}
			{/if}
		</div>
	</section>
{/if}

<style>
	.wb2 { display: flex; flex-direction: column; gap: 14px; padding: 16px; min-height: 0; overflow-y: auto; }
	.wb2-empty { border: 1px dashed var(--ws-hair-strong); border-radius: var(--radius-ws-card); padding: 28px; text-align: center; color: var(--color-ws-text); font-size: 13px; }
	.wb2-head { display: grid; gap: 8px; }
	.wb2-title h1 { font-size: 17px; font-weight: 800; color: var(--color-ws-ink); margin: 0; }
	.wb2-title p { font-size: 12px; color: var(--color-ws-text); margin: 2px 0 0; }
	.wb2-title strong { color: var(--color-ws-accent); }
	.wb2-progress { height: 6px; border-radius: 999px; background: var(--color-ws-surface2); overflow: hidden; }
	.wb2-progress span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--color-ws-accent), var(--color-ws-violet)); transition: width 0.3s ease; }
	.wb2-table { display: grid; gap: 6px; }
	.wb2-row { display: grid; grid-template-columns: minmax(150px, 1.2fr) repeat(4, minmax(120px, 1fr)); gap: 6px; align-items: stretch; }
	.wb2-row-head .wb2-cell { font-size: 11px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ws-faint); background: transparent; border: none; padding: 4px 10px; display: flex; align-items: center; gap: 6px; }
	.wb2-cell { background: var(--color-ws-surface); border: 1px solid var(--ws-hair); border-radius: var(--radius-ws-card); padding: 8px 10px; min-width: 0; }
	.wb2-cell.my-duty { border-color: color-mix(in srgb, var(--color-ws-accent) 35%, transparent); }
	.wb2-row-head .wb2-cell.my-duty { color: var(--color-ws-accent); }
	.wb2-duty-badge { font-size: 9px; font-weight: 800; background: var(--color-ws-accent); color: white; border-radius: 999px; padding: 1px 6px; text-transform: none; letter-spacing: 0; }
	.wb2-cell-page { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	.wb2-page-open { display: flex; align-items: center; gap: 8px; border: none; background: transparent; cursor: pointer; padding: 0; }
	.wb2-thumb { width: 34px; height: 48px; object-fit: cover; border-radius: 6px; border: 1px solid var(--ws-hair-strong); background: var(--color-ws-surface2); }
	.wb2-thumb-blank { display: inline-block; }
	.wb2-page-no { font-size: 14px; font-weight: 800; color: var(--color-ws-ink); }
	.wb2-page-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
	.wb2-flag { font-size: 10px; font-weight: 700; color: var(--color-ws-green); }
	.wb2-flag.warn { color: var(--color-ws-amber); }
	.wb2-presence { font-size: 10px; color: var(--color-ws-cyan); }
	.wb2-none { color: var(--color-ws-faint); }
	.wb2-task { display: flex; flex-direction: column; gap: 5px; }
	.wb2-task.done { opacity: 0.55; }
	.wb2-status { font-size: 10.5px; font-weight: 800; border-radius: 999px; padding: 2px 8px; width: fit-content; }
	.wb2-status.todo { background: var(--color-ws-surface2); color: var(--color-ws-text); }
	.wb2-status.doing { background: color-mix(in srgb, var(--color-ws-cyan) 18%, transparent); color: var(--color-ws-cyan); }
	.wb2-status.review { background: color-mix(in srgb, var(--color-ws-amber) 18%, transparent); color: var(--color-ws-amber); }
	.wb2-status.done { background: color-mix(in srgb, var(--color-ws-green) 18%, transparent); color: var(--color-ws-green); }
	.wb2-assignee { font-size: 11.5px; color: var(--color-ws-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.wb2-assignee.me { color: var(--color-ws-accent); font-weight: 800; }
	.wb2-claim { border: 1px dashed var(--color-ws-accent); background: transparent; color: var(--color-ws-accent); border-radius: 8px; padding: 4px 10px; font-size: 11px; font-weight: 800; cursor: pointer; width: fit-content; }
	.wb2-claim:hover { background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent); }
	.wb2-unassigned { font-size: 11px; color: var(--color-ws-faint); }
	.wb2-actions { display: flex; gap: 5px; }
	.wb2-actions button { border: none; border-radius: 7px; padding: 3px 9px; font-size: 10.5px; font-weight: 800; cursor: pointer; background: var(--color-ws-accent); color: white; }
	.wb2-actions button.ghost { background: transparent; border: 1px solid var(--ws-hair-strong); color: var(--color-ws-text); }
	.wb2-actions button:disabled, .wb2-claim:disabled { opacity: 0.5; cursor: progress; }
	.wb2-toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
	.wb2-tool { border: 1px solid var(--ws-hair-strong); background: var(--color-ws-surface); color: var(--color-ws-text); border-radius: 8px; padding: 6px 12px; font-size: 12px; font-weight: 800; cursor: pointer; }
	.wb2-tool:not(.ghost) { border-color: var(--color-ws-accent); color: var(--color-ws-accent); }
	.wb2-tool.active { background: color-mix(in srgb, var(--color-ws-accent) 16%, transparent); color: var(--color-ws-accent); border-color: var(--color-ws-accent); }
	.wb2-tool:disabled { opacity: 0.5; cursor: progress; }
	.wb2-bulkbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--color-ws-accent); border-radius: var(--radius-ws-card); background: color-mix(in srgb, var(--color-ws-accent) 7%, transparent); }
	.wb2-bulkbar button { border: 1px solid var(--color-ws-accent); background: var(--color-ws-accent); color: white; border-radius: 7px; padding: 4px 11px; font-size: 11.5px; font-weight: 800; cursor: pointer; }
	.wb2-bulkbar button.ghost { background: transparent; color: var(--color-ws-text); border-color: var(--ws-hair-strong); }
	.wb2-bulkbar button:disabled { opacity: 0.5; cursor: not-allowed; }
	.wb2-bulk-count { font-size: 12px; font-weight: 800; color: var(--color-ws-accent); }
	.wb2-bulk-assign { display: flex; gap: 6px; align-items: center; }
	.wb2-col-select { margin-left: auto; border: 1px solid var(--color-ws-accent); background: transparent; color: var(--color-ws-accent); border-radius: 6px; width: 20px; height: 20px; font-size: 13px; font-weight: 800; cursor: pointer; line-height: 1; padding: 0; }
	.wb2-pick { display: inline-flex; align-items: center; }
	.wb2-pick input { width: 15px; height: 15px; accent-color: var(--color-ws-accent); cursor: pointer; }
	.wb2-claim-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
	.wb2-assign-pick { font-size: 10.5px; padding: 3px 6px; border-radius: 7px; border: 1px solid var(--ws-hair-strong); background: var(--color-ws-surface2); color: var(--color-ws-text); max-width: 130px; }
	.wb2-pager { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px 0 2px; }
	.wb2-pager button { border: 1px solid var(--ws-hair-strong); background: var(--color-ws-surface); color: var(--color-ws-text); border-radius: 8px; padding: 5px 12px; font-size: 12px; font-weight: 800; cursor: pointer; }
	.wb2-pager button:disabled { opacity: 0.45; cursor: default; }
	.wb2-pager-info { font-size: 12px; color: var(--color-ws-text); font-variant-numeric: tabular-nums; }
	@media (max-width: 900px) {
		.wb2-row { grid-template-columns: 1fr; }
		.wb2-row-head { display: none; }
	}
</style>
