<!-- Toolbar - compact workspace chrome -->
<script lang="ts">
	import type { ProjectSummary } from "$lib/api/client.js";
	import { _ } from "$lib/i18n";
	import { adminStore } from "$lib/stores/admin.svelte.ts";
	import { permissions } from "$lib/stores/permissions.svelte.ts";
	import { queueWorkspaceHrefNavigation } from "$lib/navigation/workspace-navigation.js";
	import { hrefForWorkspaceView } from "$lib/navigation/workspace-routes.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore, type WorkspaceMode, type WorkspaceView } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { trackTextLayers } from "$lib/project/language-tracks.js";
	import { commandPaletteStore } from "$lib/stores/command-palette.svelte.ts";
	import { shortcutsHelpStore } from "$lib/stores/shortcuts-help.svelte.ts";
	import AuthAccountMenu from "./AuthAccountMenu.svelte";
	import RecentProjectPicker from "./RecentProjectPicker.svelte";
	import AIModeToggle from "./editor/AIModeToggle.svelte";
	import EditorOverflowMenu from "./editor/EditorOverflowMenu.svelte";

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	function buildRecentProjectsForPicker(): ProjectSummary[] {
		const project = projectStore.project;
		if (!project) return projectStore.recentProjects;
		if (projectStore.recentProjects.some((item) => item.projectId === project.projectId)) {
			return projectStore.recentProjects;
		}

		const tasks = project.tasks ?? projectStore.tasks;
		const comments = project.comments ?? projectStore.comments;
		const textLayerCount = project.pages.reduce((total, page) => total + trackTextLayers(page, project.targetLang).length, 0);
		const currentSummary: ProjectSummary = {
			projectId: project.projectId,
			name: project.name,
			createdAt: project.createdAt,
			updatedAt: project.createdAt,
			coverImageId: project.coverImageId,
			coverOriginalName: project.coverOriginalName,
			targetLang: project.targetLang,
			pageCount: project.pages.length,
			textLayerCount,
			taskCount: tasks.length,
			openTaskCount: tasks.filter((task) => task.status !== "done").length,
			reviewTaskCount: tasks.filter((task) => task.status === "review").length,
			commentCount: comments.length,
			openCommentCount: comments.filter((comment) => comment.status !== "resolved").length,
		};

		return [currentSummary, ...projectStore.recentProjects];
	}

	let labels = $derived({
		open: msg("toolbar.open", "เปิด"),
		openFolder: msg("toolbar.openFolder", "ตอน"),
		home: msg("toolbar.home", "หน้าแรก"),
		workspace: msg("toolbar.workspace", "Workspace"),
		library: msg("toolbar.library", "คลัง"),
		manga: msg("toolbar.manga", "Manga"),
		pages: msg("toolbar.pages", "หน้า"),
		queue: msg("toolbar.queue", "Queue"),
		work: msg("toolbar.work", "งาน"),
		tasks: msg("toolbar.tasks", "tasks"),
		canvas: msg("toolbar.canvas", "แก้หน้า"),
		edit: msg("toolbar.edit", "แก้"),
		noQueue: msg("toolbar.noQueue", "ยังไม่มีคิว"),
		inspector: msg("toolbar.inspector", "คุณสมบัติ"),
		openState: msg("toolbar.openState", "เปิด"),
		hiddenState: msg("toolbar.hiddenState", "ซ่อน"),
		settings: msg("toolbar.admin", "ตั้งค่า"),
		undo: msg("toolbar.undo", "ย้อนกลับ"),
		redo: msg("toolbar.redo", "ทำซ้ำ"),
		multiPage: msg("toolbar.multiPage", "ข้ามหน้า"),
		multiPageOn: msg("toolbar.multiPageOn", "เปิด"),
		multiPageOff: msg("toolbar.multiPageOff", "ปิด"),
		search: msg("commandPalette.trigger", "ค้นหา"),
		searchHint: msg("commandPalette.triggerHint", "ค้นหาหรือกระโดดไปยัง…"),
		shortcuts: msg("toolbar.shortcuts", "คีย์ลัด"),
		shortcutsHint: msg("toolbar.shortcutsHint", "เปิดคีย์ลัดทั้งหมด"),
	});
	// Show the platform-correct accelerator hint on the search affordance.
	let isMac = $derived(
		typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent),
	);
	let commandPaletteShortcut = $derived(isMac ? "⌘K" : "Ctrl K");
	// Platform-correct undo/redo accelerators for the toolbar tooltips.
	let undoShortcut = $derived(isMac ? "⌘Z" : "Ctrl+Z");
	let redoShortcut = $derived(isMac ? "⇧⌘Z" : "Ctrl+Y");
	let selectedRecentProjectId = $derived(projectStore.project?.projectId ?? "");
	let recentProjectsForPicker = $derived(buildRecentProjectsForPicker());
	let librarySurfaceActive = $derived(editorUiStore.workspaceView === "library" || editorUiStore.workspaceView === "pages");
	let showWorkNav = $derived(Boolean(projectStore.project || editorUiStore.workspaceView === "work"));
	// `$derived` so the option labels/titles re-localize when the locale changes
	// (a plain `const` would freeze them at first render — Svelte 5 reactivity).
	let workspaceModeOptions = $derived<Array<{ id: WorkspaceMode; label: string; detail: string; title: string }>>([
		{ id: "solo", label: "Solo", detail: msg("toolbar.soloDetail", "เบา"), title: msg("toolbar.soloTitle", "โหมดทำคนเดียว: ลดคิวทีมและพิธีตรวจที่ไม่จำเป็น") },
		{ id: "team", label: "Team", detail: msg("toolbar.teamDetail", "ครบ"), title: msg("toolbar.teamTitle", "โหมดทีม: เปิดคิว QC, รีวิว, ส่งต่อ และอัปเดตงานเต็ม") },
	]);
	let compactWorkspaceModeSwitch = $derived(editorUiStore.workspaceView === "editor");
	let activeWorkspaceModeOption = $derived(
		workspaceModeOptions.find((option) => option.id === editorUiStore.workspaceMode) ?? workspaceModeOptions[0],
	);
	let nextWorkspaceModeOption = $derived(
		workspaceModeOptions.find((option) => option.id !== editorUiStore.workspaceMode) ?? workspaceModeOptions[1],
	);

	// W3.15 — if the user loses Cleaner/Typesetter capability (sign-out / role
	// downgrade) while cross-page mode is on, actively turn it off so the editor
	// does not keep its cross-page clip disabled. canToggleMultiPageMode reads
	// authStore.capabilities, so this effect re-runs whenever the role changes.
	$effect(() => {
		if (!editorStore.canToggleMultiPageMode && editorStore.multiPageMode) {
			editorStore.revalidateMultiPageMode();
		}
	});

	async function handleRecentProjectSelect(projectId: string): Promise<void> {
		if (!projectId) return;
		const opened = await projectStore.openProject(projectId, editorStore.editor);
		if (opened === false) return;
		if (!projectStore.project?.pages.length) {
			projectStore.setStatusMsg(msg("toolbar.statusZeroPage", "ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า"));
			editorUiStore.openLibrary();
			editorUiStore.openChapterSetup({
				mode: "fill-existing-zero-page",
				projectId: projectStore.project?.projectId ?? projectId,
			});
			pushWorkspaceUrl("library");
			return;
		}
		editorUiStore.openEditor();
		pushWorkspaceUrl("editor");
	}

	function setWorkspaceView(view: WorkspaceView): void {
		const project = projectStore.project;
		if (view === "editor" && !project) {
			editorUiStore.setWorkspaceView("dashboard");
			projectStore.setStatusMsg(msg("toolbar.statusOpenChapterFirst", "เปิดหรือสร้างตอนก่อนเข้าแก้หน้า"));
			queueWorkspaceHrefNavigation("/dashboard");
			return;
		}
		if (view === "editor" && project && project.pages.length === 0) {
			editorUiStore.openLibrary();
			editorUiStore.openChapterSetup({
				mode: "fill-existing-zero-page",
				projectId: project.projectId,
			});
			projectStore.setStatusMsg(msg("toolbar.statusZeroPage", "ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า"));
			queueWorkspaceHrefNavigation("/library");
			return;
		}
		editorUiStore.setWorkspaceView(view);
		pushWorkspaceUrl(view);
	}

	function setWorkspaceMode(mode: WorkspaceMode): void {
		editorUiStore.setWorkspaceMode(mode);
		if (projectStore.project) {
			projectStore.updateProductionMode(mode);
		} else {
			projectStore.setStatusMsg(mode === "solo"
				? msg("toolbar.statusSoloMode", "ใช้โหมด Solo: ลดคิวทีมและแสดงเฉพาะงานที่ต้องทำจริง")
				: msg("toolbar.statusTeamMode", "ใช้โหมด Team: เปิดคิวทีม รีวิว QC และงานส่งต่อเต็ม"));
		}
	}

	function toggleWorkspaceMode(): void {
		setWorkspaceMode(nextWorkspaceModeOption.id);
	}

	function pushWorkspaceUrl(view = editorUiStore.workspaceView): void {
		const href = hrefForWorkspaceView(
			view,
			projectStore.project?.projectId,
			projectStore.project?.currentPage,
		);
		queueWorkspaceHrefNavigation(href);
	}

</script>

<div class="topbar">
	<div class="topbar-left">
		<div class="command-cluster project-cluster" aria-label={$_("toolbar.commandsAria")}>
			{#if permissions.canCreateChapter}
			<button
				class="command-button primary"
				onclick={() => editorUiStore.openChapterSetup()}
				title={$_("toolbar.openChapterTitle")}
			>
				<span class="command-copy">
					<strong>{labels.open}</strong>
					<small>{labels.openFolder}</small>
				</span>
			</button>
			{/if}
			<RecentProjectPicker
				projects={recentProjectsForPicker}
				selectedProjectId={selectedRecentProjectId}
				loading={projectStore.recentProjectsLoading}
				error={projectStore.recentProjectsError}
				onSelect={handleRecentProjectSelect}
				onRefresh={() => void projectStore.loadRecentProjects()}
			/>
		</div>
	</div>

	<div class="topbar-right">
		{#if compactWorkspaceModeSwitch}
			<button
				type="button"
				class="workspace-mode-compact"
				aria-label={$_("toolbar.modeCompactAria", { values: { current: activeWorkspaceModeOption.label, next: nextWorkspaceModeOption.label } })}
				title={$_("toolbar.modeCompactTitle", { values: { title: activeWorkspaceModeOption.title, next: nextWorkspaceModeOption.label } })}
				onclick={toggleWorkspaceMode}
			>
				<strong>{activeWorkspaceModeOption.label}</strong>
				<small>{activeWorkspaceModeOption.detail}</small>
			</button>
		{:else}
			<div class="workspace-mode-switch" aria-label={$_("toolbar.workMode")}>
				{#each workspaceModeOptions as option (option.id)}
					<button
						type="button"
						class:active={editorUiStore.workspaceMode === option.id}
						aria-pressed={editorUiStore.workspaceMode === option.id}
						title={option.title}
						onclick={() => setWorkspaceMode(option.id)}
					>
						<strong>{option.label}</strong>
						<small>{option.detail}</small>
					</button>
				{/each}
			</div>
		{/if}
		<span class="project-chip" title={projectStore.projectName}>{projectStore.projectName}</span>
		<div class="history-buttons" aria-label={$_("toolbar.cmdHistory")}>
			{#if editorStore.canUndo}
				<button
					class="command-button compact"
					onclick={() => editorStore.undo()}
					title={`${labels.undo} (${undoShortcut})`}
					aria-label={$_("toolbar.undoAria")}
				>
					<span class="command-copy"><strong>{labels.undo}</strong></span>
				</button>
			{:else}
				<span class="command-button compact command-receipt" aria-label={$_("toolbar.noUndo")}>
					<span class="command-copy"><strong>{labels.undo}</strong></span>
				</span>
			{/if}
			{#if editorStore.canRedo}
				<button
					class="command-button compact"
					onclick={() => editorStore.redo()}
					title={`${labels.redo} (${redoShortcut})`}
					aria-label={$_("toolbar.redoAria")}
				>
					<span class="command-copy"><strong>{labels.redo}</strong></span>
				</button>
			{:else}
				<span class="command-button compact command-receipt" aria-label={$_("toolbar.noRedo")}>
					<span class="command-copy"><strong>{labels.redo}</strong></span>
				</span>
			{/if}
		</div>
		{#if editorUiStore.workspaceView === "editor"}
			<AIModeToggle />
			{#if editorStore.canToggleMultiPageMode && editorStore.editor && editorStore.editor.getPageSegmentCount?.() > 1}
				<button
					class="command-button compact multi-page-toggle"
					class:toggle-active={editorStore.multiPageMode}
					onclick={() => editorStore.toggleMultiPageMode()}
					aria-pressed={editorStore.multiPageMode}
					title={editorStore.multiPageMode
						? $_("toolbar.multiPageOnTitle")
						: $_("toolbar.multiPageOffTitle")}
				>
					<span class="command-copy">
						<strong>{labels.multiPage}</strong>
						<small>{editorStore.multiPageMode ? labels.multiPageOn : labels.multiPageOff}</small>
					</span>
				</button>
			{/if}
			<button
				class="command-button compact inspector-toggle"
				class:toggle-active={editorUiStore.inspectorOpen}
				onclick={() => editorUiStore.toggleInspector()}
				aria-pressed={editorUiStore.inspectorOpen}
				title={editorUiStore.inspectorOpen ? $_("toolbar.inspectorHide") : $_("toolbar.inspectorShow")}
			>
				<span class="command-copy">
					<strong>{labels.inspector}</strong>
					<small>{editorUiStore.inspectorOpen ? labels.openState : labels.hiddenState}</small>
				</span>
			</button>
		{/if}
		<button
			type="button"
			class="command-button compact shortcuts-help-trigger"
			onclick={() => shortcutsHelpStore.openHelp()}
			title={`${labels.shortcutsHint} (?)`}
			aria-label={`${labels.shortcutsHint} (?)`}
			aria-keyshortcuts="?"
		>
			<span class="command-copy">
				<strong>?</strong>
				<small>{labels.shortcuts}</small>
			</span>
		</button>
		<button
			type="button"
			class="command-palette-trigger"
			onclick={() => commandPaletteStore.openPalette()}
			title={`${labels.searchHint} (${commandPaletteShortcut})`}
			aria-label={`${labels.searchHint} (${commandPaletteShortcut})`}
			aria-keyshortcuts="Meta+K Control+K"
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
				<circle cx="11" cy="11" r="7" />
				<path d="m21 21-4.3-4.3" />
			</svg>
			<span class="command-palette-trigger-label">{labels.search}</span>
			<kbd>{commandPaletteShortcut}</kbd>
		</button>
		<button class="command-button compact settings" onclick={() => void adminStore.open()} title={$_("toolbar.admin")} aria-label={$_("toolbar.admin")}>
			<span class="command-copy"><strong>{labels.settings}</strong></span>
		</button>
		<AuthAccountMenu />

		<!-- Mobile-only overflow: the controls hidden from the single phone row live
		     here so every action stays reachable. Hidden on desktop by the component. -->
		<EditorOverflowMenu label={$_("toolbar.moreTools")}>
			{#if permissions.canCreateChapter}
			<button
				type="button"
				class="overflow-row primary"
				onclick={() => editorUiStore.openChapterSetup()}
			>
				<strong>{labels.open} {labels.openFolder}</strong>
				<small>{$_("toolbar.openChapterTitle")}</small>
			</button>
			{/if}
			<div class="overflow-mode" aria-label={$_("toolbar.workMode")}>
				{#each workspaceModeOptions as option (option.id)}
					<button
						type="button"
						class:active={editorUiStore.workspaceMode === option.id}
						aria-pressed={editorUiStore.workspaceMode === option.id}
						onclick={() => setWorkspaceMode(option.id)}
					>
						<strong>{option.label}</strong>
						<small>{option.detail}</small>
					</button>
				{/each}
			</div>
			<button type="button" class="overflow-row" onclick={() => commandPaletteStore.openPalette()}>
				<strong>{labels.search}</strong>
				<small>{commandPaletteShortcut}</small>
			</button>
			<button type="button" class="overflow-row" onclick={() => shortcutsHelpStore.openHelp()}>
				<strong>{labels.shortcuts}</strong>
				<small>?</small>
			</button>
			<button type="button" class="overflow-row" onclick={() => void adminStore.open()}>
				<strong>{labels.settings}</strong>
				<small>{$_("toolbar.settingsAdmin")}</small>
			</button>
			<div class="overflow-inline" aria-label={$_("toolbar.accountAndLang")}>
				<AuthAccountMenu />
			</div>
		</EditorOverflowMenu>
	</div>
</div>

<style>
	.topbar {
		position: relative;
		z-index: 120;
		display: flex;
		justify-content: space-between;
		align-items: center;
		height: var(--editor-main-toolbar-h, 64px);
		min-height: var(--editor-main-toolbar-h, 64px);
		gap: 12px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-bg) 78%, transparent);
		box-shadow: none;
		font-family: var(--font-ws-sans);
	}

	.topbar-left,
	.topbar-right,
	.history-buttons,
	.command-cluster {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 8px;
	}

	.topbar-right {
		justify-content: flex-end;
	}

	.topbar-left {
		overflow: visible;
		gap: 8px;
	}

	.command-cluster {
		flex: 0 1 auto;
		min-height: 44px;
		padding: 4px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 38%, transparent);
		box-shadow: none;
	}

	.project-cluster {
		width: 100%;
		max-width: 340px;
	}

	.command-button {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 36px;
		padding: 4px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 40%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-family: inherit;
		font-size: 11px;
		font-weight: 760;
		letter-spacing: 0;
		white-space: nowrap;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, filter 0.14s ease;
	}

	.command-button.compact {
		width: auto;
		padding-right: 9px;
	}

	.command-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 1px;
		line-height: 1;
	}

	.command-copy strong,
	.command-copy small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-copy strong {
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
	}

	.command-copy small {
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 800;
	}

	.command-button:hover {
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		color: var(--color-ws-ink);
	}

	.command-button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 58%, transparent);
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
		box-shadow: 0 8px 24px -10px color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
	}

	.command-button.primary:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 74%, transparent);
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
		filter: brightness(1.08);
	}

	.command-button.primary .command-copy strong {
		color: var(--color-ws-ink);
	}

	.command-button.primary .command-copy small {
		color: color-mix(in srgb, var(--color-ws-ink) 78%, transparent);
	}

	.command-button.toggle-active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 48%, transparent);
		background: linear-gradient(100deg,
			color-mix(in srgb, var(--color-ws-accent) 22%, transparent),
			color-mix(in srgb, var(--color-ws-violet) 10%, transparent));
		color: var(--color-ws-ink);
	}

	.command-button.toggle-active .command-copy small {
		color: var(--color-ws-blue);
	}

	.command-receipt {
		cursor: default;
		opacity: 0.38;
	}

	.project-chip {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		max-width: 190px;
		min-height: 22px;
		padding: 2px 7px;
		overflow: hidden;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workspace-mode-switch {
		display: grid;
		grid-template-columns: repeat(2, minmax(48px, 1fr));
		flex: 0 0 auto;
		gap: 2px;
		min-height: 40px;
		padding: 3px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 40%, transparent);
	}

	.workspace-mode-compact {
		display: inline-flex;
		flex: 0 0 auto;
		min-width: 62px;
		min-height: 36px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		padding: 4px 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 44%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(100deg,
			color-mix(in srgb, var(--color-ws-accent) 18%, transparent),
			color-mix(in srgb, var(--color-ws-violet) 8%, transparent));
		color: var(--color-ws-ink);
		cursor: pointer;
		font-family: inherit;
		letter-spacing: 0;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	.workspace-mode-switch button {
		display: inline-flex;
		min-width: 48px;
		min-height: 36px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		padding: 3px 8px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: transparent;
		color: var(--color-ws-text);
		cursor: pointer;
		font-family: inherit;
		letter-spacing: 0;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
	}

	.workspace-mode-switch button:hover {
		color: var(--color-ws-ink);
	}

	.workspace-mode-switch button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 48%, transparent);
		background: linear-gradient(100deg,
			color-mix(in srgb, var(--color-ws-accent) 22%, transparent),
			color-mix(in srgb, var(--color-ws-violet) 10%, transparent));
		color: var(--color-ws-ink);
	}

	.workspace-mode-switch strong {
		font-size: 10px;
		font-weight: 820;
		line-height: 1;
	}

	.workspace-mode-compact strong {
		font-size: 10px;
		font-weight: 850;
		line-height: 1;
	}

	.workspace-mode-switch small {
		color: var(--color-ws-faint);
		font-size: 8px;
		font-weight: 700;
		line-height: 1;
	}

	.workspace-mode-compact small {
		color: var(--color-ws-blue);
		font-size: 8px;
		font-weight: 760;
		line-height: 1;
	}

	.workspace-mode-compact:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 62%, transparent);
		background: linear-gradient(100deg,
			color-mix(in srgb, var(--color-ws-accent) 26%, transparent),
			color-mix(in srgb, var(--color-ws-violet) 12%, transparent));
	}

	.workspace-mode-switch button.active small {
		color: var(--color-ws-blue);
	}

	@media (max-width: 1520px) {
		.topbar {
			grid-template-columns: minmax(230px, 300px) minmax(330px, 400px) minmax(170px, 1fr);
			gap: 8px;
			padding: 0 8px;
		}

		.project-chip,
		.history-buttons {
			display: none;
		}

		.topbar-left :global(.recent-project-picker) {
			flex-basis: 188px;
			min-width: 150px;
			max-width: 188px;
		}

		.topbar-left :global(.recent-trigger) {
			grid-template-columns: 24px minmax(0, 1fr) 10px;
		}

		.topbar-left :global(.recent-trigger-copy) {
			display: none;
		}

		.topbar-left :global(.recent-trigger.has-project .recent-trigger-copy) {
			display: flex;
		}

		.topbar-left :global(.recent-trigger-meta) {
			max-width: none;
			text-align: left;
		}

		.topbar-left :global(.recent-trigger.has-project .recent-trigger-meta) {
			display: none;
		}
	}

	@media (max-width: 1120px) {
		.topbar {
			grid-template-columns: minmax(0, 1fr) minmax(270px, auto) auto;
		}

		.command-cluster {
			border-color: transparent;
			background: transparent;
			padding: 0;
		}

		.project-chip,
		.history-buttons,
		.topbar-left {
			display: none;
		}
	}

	@media (max-width: 1380px) {
		.project-chip {
			display: none;
		}
	}

	@media (max-width: 1040px) {
		.topbar {
			grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
		}

		.command-button {
			min-height: 40px;
			padding-block: 4px;
		}

		.topbar-left :global(.recent-project-picker),
		.topbar-right :global(.account-menu),
		.history-buttons {
			display: none;
		}

		.workspace-mode-switch small,
		.workspace-mode-compact small {
			display: none;
		}

		.topbar-right .settings {
			display: inline-flex;
			min-width: 40px;
			padding-inline: 7px;
		}

		.project-cluster {
			flex: 0 0 auto;
		}

		.topbar-right {
			justify-content: flex-end;
		}
	}

	@media (max-width: 700px) {
		.topbar {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.command-copy small {
			display: none;
		}

		.topbar-left :global(.recent-project-picker),
		.project-chip {
			display: none;
		}

		.workspace-mode-switch {
			grid-template-columns: 1fr;
		}

		.workspace-mode-switch small,
		.workspace-mode-compact small {
			display: none;
		}
	}

	@media (max-width: 900px) and (orientation: portrait) {
		.command-button {
			min-height: 40px;
		}

		.topbar-left :global(.recent-project-picker) {
			display: none;
		}

		.topbar-right :global(.account-menu) {
			display: none;
		}

		.workspace-mode-switch small,
		.workspace-mode-compact small {
			display: none;
		}

		.project-cluster {
			flex: 0 0 auto;
		}

		.history-buttons {
			display: none;
		}

		.topbar-right .settings {
			display: inline-flex;
		}
	}

	@media (min-width: 901px) and (max-width: 1180px) and (pointer: coarse) {
		.command-button {
			min-height: 40px;
			padding-inline: 11px;
		}
	}

	/* Premium dashboard alignment: the editor top chrome now shares the workspace
	   token vocabulary (ws surface/hairline/violet accent) so it reads as the same
	   app as the Dashboard/Library command dock. */
	.command-button {
		font-weight: 720;
	}

	.command-copy strong {
		font-weight: 720;
	}

	.command-copy small {
		font-weight: 650;
	}

	/* ⌘K affordance: a quiet search pill that opens the command palette. */
	.command-palette-trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 40%, transparent);
		color: var(--color-ws-text);
		font: inherit;
		cursor: pointer;
		transition: border-color 0.14s ease, color 0.14s ease, background 0.14s ease;
	}

	.command-palette-trigger:hover,
	.command-palette-trigger:focus-visible {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-ink);
		outline: none;
	}

	.command-palette-trigger svg {
		width: 15px;
		height: 15px;
		flex-shrink: 0;
		stroke-width: 1.9;
	}

	.command-palette-trigger-label {
		font-size: 12.5px;
		font-weight: 600;
	}

	.command-palette-trigger kbd {
		padding: 2px 6px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-ws-bg) 70%, var(--color-ws-surface2) 30%);
		color: inherit;
		font-size: 10.5px;
		font-weight: 700;
		font-family: inherit;
		line-height: 1;
	}

	/* On narrow chrome the label collapses to just the icon + shortcut. */
	@media (max-width: 720px) {
		.command-palette-trigger-label {
			display: none;
		}
	}

	/* ── Mobile editor chrome (≤640px) ───────────────────────────────────────
	   Collapse the top bar to a single tidy, non-wrapping row: keep the essential
	   controls inline (project context + AI + Inspector) and push everything else
	   (Open Folder, Solo/Team, Commands, Settings, account, language) into the
	   "⋯" overflow popover. This block only fires on phones, so the desktop
	   layout/handlers are untouched. */
	@media (max-width: 640px) {
		.topbar {
			height: var(--editor-main-toolbar-h, 56px);
			min-height: var(--editor-main-toolbar-h, 56px);
			gap: 8px;
			padding: 8px 10px;
			flex-wrap: nowrap;
		}

		.topbar-right {
			flex: 1 1 auto;
			min-width: 0;
			gap: 6px;
			overflow: hidden;
		}

		/* Tucked into the overflow popover on mobile — hide the inline copies. */
		.topbar-right .workspace-mode-switch,
		.topbar-right .workspace-mode-compact,
		.topbar-right .command-palette-trigger,
		.topbar-right .settings,
		.topbar-right :global(.account-menu),
		.topbar-right :global(.language-switcher),
		.topbar-left {
			display: none;
		}

		/* Keep the AI toggle + inspector toggle compact + inline (icon-forward). */
		.topbar-right :global(.ai-mode-toggle),
		.inspector-toggle,
		.multi-page-toggle {
			flex: 0 0 auto;
		}

		.command-button.compact {
			padding-inline: 8px;
		}
	}

	/* Overflow popover row styling (full-width tappable rows). */
	.overflow-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 44px;
		padding: 8px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 40%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-family: inherit;
		text-align: left;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	.overflow-row:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
	}

	.overflow-row.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 58%, transparent);
		background: linear-gradient(100deg,
			color-mix(in srgb, var(--color-ws-violet) 95%, transparent),
			color-mix(in srgb, var(--color-ws-accent) 90%, transparent));
		color: var(--color-ws-ink);
	}

	.overflow-row strong {
		font-size: 12px;
		font-weight: 760;
		line-height: 1.1;
	}

	.overflow-row small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.1;
	}

	.overflow-row.primary small {
		color: color-mix(in srgb, var(--color-ws-ink) 82%, transparent);
	}

	.overflow-mode {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
	}

	.overflow-mode button {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		min-height: 44px;
		padding: 6px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 40%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font-family: inherit;
	}

	.overflow-mode button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 48%, transparent);
		background: linear-gradient(100deg,
			color-mix(in srgb, var(--color-ws-accent) 22%, transparent),
			color-mix(in srgb, var(--color-ws-violet) 10%, transparent));
		color: var(--color-ws-ink);
	}

	.overflow-mode button strong {
		font-size: 11px;
		font-weight: 820;
	}

	.overflow-mode button small {
		font-size: 9px;
		font-weight: 700;
	}

	.overflow-inline {
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: space-between;
		padding-top: 4px;
		border-top: 1px solid var(--ws-hair);
	}
</style>
