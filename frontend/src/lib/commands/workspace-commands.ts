// Builds the live command list for the Cmd-K palette by wiring the pure
// registry shape to workspace stores + navigation. Kept out of the component
// so the palette stays a dumb view and the action set is easy to extend.
//
// Labels are resolved through an injected `t(key, fallback)` translator so the
// palette speaks the active UI locale; the fallbacks (Thai, the app default)
// keep this module usable in tests without booting svelte-i18n.

import type { Command, CommandSection } from "$lib/commands/command-registry.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { adminStore } from "$lib/stores/admin.svelte.ts";
import { commandPaletteStore } from "$lib/stores/command-palette.svelte.ts";
import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
import { setLocale } from "$lib/i18n";

/** Translator shape (matches the `msg(key, fallback)` helper used in views). */
export type CommandTranslator = (key: string, fallback: string) => string;

interface BuildCommandsContext {
	/** Localised label resolver. Defaults to fallbacks so tests need no i18n. */
	t?: CommandTranslator;
	/** Locales the palette can switch to (code + display name). */
	locales?: Array<{ code: string; name: string }>;
	/** Sign the user out (auth.signOut + invalidate). Injected so the pure module
	 *  does not import SvelteKit navigation; the palette wires the real handler. */
	signOut?: () => void | Promise<void>;
	/** Open the keyboard-shortcut / help surface, if the host provides one. */
	openShortcutsHelp?: () => void;
	/**
	 * Cross-project / cross-chapter jump rows, built by the async
	 * `project-jump-source` from the FULL project listing and injected here so
	 * the synchronous builder stays pure (no fetch). When absent (e.g. the
	 * listing hasn't loaded yet), the builder falls back to the recent-projects
	 * shortcut so the palette still offers SOMETHING to jump to immediately.
	 */
	projectJumpRows?: Command[];
}

const DEFAULT_LOCALES = [
	{ code: "th", name: "ไทย" },
	{ code: "en", name: "English" },
	{ code: "ko", name: "한국어" },
	{ code: "ja", name: "日本語" },
	{ code: "zh", name: "中文" },
];

const identityTranslator: CommandTranslator = (_key, fallback) => fallback;

function gotoWorkspaceView(view: Parameters<typeof queueWorkspaceNavigation>[0]["view"]): void {
	const projectId = projectStore.project?.projectId ?? undefined;
	queueWorkspaceNavigation({ view, projectId });
}

/**
 * Open the editor surface AND queue the matching route so the URL/history stay
 * in sync (reload, share, Back restore the editor — not the prior surface).
 * Mirrors the `nav-editor` command, including the empty-chapter guard, so every
 * editor entry point (nav + tool commands) behaves identically.
 *
 * @returns true when the editor was actually entered, false when blocked
 *          (no pages) so callers can skip follow-up actions like tool selection.
 */
function enterEditor(t: CommandTranslator): boolean {
	const project = projectStore.project;
	if (!project?.pages.length) {
		projectStore.setStatusMsg(
			t("commandPalette.noPages", "ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า"),
		);
		editorUiStore.openLibrary();
		queueWorkspaceNavigation({ view: "library" });
		return false;
	}
	editorUiStore.openEditor();
	queueWorkspaceNavigation({
		view: "editor",
		projectId: project.projectId,
		pageIndex: project.currentPage,
	});
	return true;
}

export function buildWorkspaceCommands(context: BuildCommandsContext = {}): Command[] {
	const t = context.t ?? identityTranslator;
	const hasProject = Boolean(projectStore.project);
	const locales = context.locales ?? DEFAULT_LOCALES;

	const commands: Command[] = [
		// ── Navigate ──────────────────────────────────────────────
		{
			id: "nav-dashboard",
			title: t("commandPalette.navDashboard", "แดชบอร์ด"),
			subtitle: t("commandPalette.navDashboardSub", "ภาพรวมเวิร์กสเปซ"),
			section: "navigate",
			keywords: ["dashboard", "home", "หน้าหลัก", "ภาพรวม"],
			run: () => {
				editorUiStore.openDashboard();
				gotoWorkspaceView("dashboard");
			},
		},
		{
			id: "nav-library",
			title: t("commandPalette.navLibrary", "คลังการ์ตูน"),
			subtitle: t("commandPalette.navLibrarySub", "เรื่อง · ตอน · ภาษา"),
			section: "navigate",
			keywords: ["library", "คลัง", "เรื่อง", "ตอน", "manga", "comic"],
			run: () => {
				editorUiStore.openLibrary();
				queueWorkspaceNavigation({ view: "library" });
			},
		},
	];

	if (hasProject) {
		commands.push(
			{
				id: "nav-pages",
				title: t("commandPalette.navPages", "หน้า / Export"),
				subtitle: t("commandPalette.navPagesSub", "คิวหน้าและการ Export"),
				section: "navigate",
				// คง alias ไทยให้ค้นเจอเสมอ — haystack สร้างจาก title/subtitle/keywords เท่านั้น (codex P2)
				keywords: ["pages", "หน้า", "export", "ส่งออก"],
				run: () => {
					editorUiStore.openPages();
					gotoWorkspaceView("pages");
				},
			},
			{
				id: "nav-work",
				title: t("commandPalette.navWork", "บอร์ดทีม"),
				subtitle: t("commandPalette.navWorkSub", "งานที่ได้รับมอบหมาย"),
				section: "navigate",
				keywords: ["work", "board", "kanban", "บอร์ด", "ทีม"],
				run: () => {
					editorUiStore.openWorkBoard();
					gotoWorkspaceView("work");
				},
			},
			{
				id: "nav-import",
				title: t("commandPalette.navImport", "รีวิวงาน (Import / Review)"),
				subtitle: t("commandPalette.navImportSub", "Import และรีวิวคิว"),
				section: "navigate",
				keywords: ["import", "review", "นำเข้า", "ตรวจ"],
				run: () => {
					editorUiStore.openImportReview();
					gotoWorkspaceView("import");
				},
			},
			{
				id: "nav-editor",
				title: t("commandPalette.navEditor", "เอดิเตอร์แก้หน้า"),
				subtitle: t("commandPalette.navEditorSub", "เปิดแคนวาสแก้ไข"),
				section: "navigate",
				keywords: ["editor", "canvas", "แคนวาส", "แก้หน้า"],
				run: () => {
					enterEditor(t);
				},
			},
		);

		// ── Tools (editor-scoped) ─────────────────────────────────
		commands.push(
			{
				id: "tool-select",
				title: t("commandPalette.toolSelect", "เครื่องมือเลือก (Select)"),
				section: "tools",
				keywords: ["select", "move", "เลือก", "ย้าย"],
				run: () => {
					if (enterEditor(t)) editorStore.setTool("select");
				},
			},
			{
				id: "tool-text",
				title: t("commandPalette.toolText", "เครื่องมือข้อความ (Text)"),
				section: "tools",
				keywords: ["text", "ข้อความ", "typeset"],
				run: () => {
					if (enterEditor(t)) editorStore.setTool("text");
				},
			},
		);
	}

	// ── Create ─────────────────────────────────────────────────
	// Catalog shaping (เพิ่มเรื่อง/เพิ่มตอน) is owner/admin-only (2026-06-13);
	// worker seats get a palette without create entries. Backend manage_projects
	// is the real gate — this only stops advertising actions that would 403.
	const canShapeCatalog = workspacesStore.isAdmin;
	if (canShapeCatalog) commands.push(
		{
			id: "create-project",
			title: t("commandPalette.createProject", "สร้างเรื่องใหม่"),
			subtitle: t("commandPalette.createProjectSub", "ตั้งชื่อเรื่องและสร้างตอนแรก"),
			section: "create",
			keywords: ["new project", "create", "story", "สร้าง", "เรื่อง", "ใหม่"],
			run: () => {
				editorUiStore.openChapterSetup({ mode: "create" });
			},
		},
	);
	if (canShapeCatalog && hasProject && projectStore.project) {
		const projectId = projectStore.project.projectId;
		commands.push({
			id: "create-chapter",
			title: t("commandPalette.createChapter", "สร้างตอนใหม่"),
			subtitle: t("commandPalette.createChapterSub", "เพิ่มตอนในเรื่องที่เปิดอยู่"),
			section: "create",
			keywords: ["new chapter", "chapter", "ตอน", "สร้างตอน", "เพิ่ม"],
			run: () => {
				editorUiStore.openChapterSetup({
					mode: "add-chapter-to-title",
					projectId,
					titleKey: editorUiStore.workspaceTitleKey,
				});
			},
		});
	}

	// ── Open project / chapter (cross-project / cross-chapter jump) ─
	// Prefer the injected jump rows (built from the FULL project listing by the
	// async `project-jump-source`, so any project/chapter is reachable from
	// anywhere — not just the recent few). Until that listing has loaded, fall
	// back to the recent-projects shortcut so the palette is never empty here.
	if (context.projectJumpRows && context.projectJumpRows.length > 0) {
		commands.push(...context.projectJumpRows);
	} else {
		const recent = projectStore.recentProjects.slice(0, 8);
		for (const summary of recent) {
			if (summary.projectId === projectStore.project?.projectId) continue;
			const storyTitle = summary.storyTitle?.trim();
			const subtitleParts = [
				summary.chapterLabel?.trim() || summary.chapterTitle?.trim(),
				summary.targetLang?.toUpperCase(),
			].filter(Boolean);
			commands.push({
				id: `open-project-${summary.projectId}`,
				title: t("commandPalette.openProjectPrefix", "เปิด") + ` ${storyTitle || summary.name}`,
				subtitle: subtitleParts.join(" · ") || undefined,
				section: "navigate",
				keywords: [
					"open",
					"project",
					"chapter",
					"เปิด",
					"ตอน",
					summary.name,
					storyTitle ?? "",
					summary.targetLang ?? "",
				],
				run: () => {
					void openProjectChapter(summary.projectId);
				},
			});
		}
	}

	// ── Workspace ──────────────────────────────────────────────
	commands.push(
		{
			id: "ws-notifications",
			title: t("commandPalette.notifications", "การแจ้งเตือน"),
			subtitle: t("commandPalette.notificationsSub", "เปิดแผงแจ้งเตือน"),
			section: "workspace",
			keywords: ["notifications", "alerts", "แจ้งเตือน", "bell"],
			run: () => editorUiStore.openNotificationPanel(),
		},
		{
			id: "ws-toggle-inspector",
			title: editorUiStore.inspectorOpen
				? t("commandPalette.hideInspector", "ซ่อนแผงตรวจสอบ (Inspector)")
				: t("commandPalette.showInspector", "แสดงแผงตรวจสอบ (Inspector)"),
			subtitle: t("commandPalette.toggleInspectorSub", "สลับแผงด้านขวา"),
			section: "workspace",
			keywords: ["inspector", "panel", "แผง", "ขวา"],
			run: () => editorUiStore.toggleInspector(),
		},
	);

	// Switch workspace (dynamic, only when the user belongs to more than one).
	const otherWorkspaces = workspacesStore.workspaces.filter(
		(workspace) => workspace.workspaceId !== workspacesStore.currentWorkspaceId,
	);
	for (const workspace of otherWorkspaces.slice(0, 8)) {
		commands.push({
			id: `ws-switch-${workspace.workspaceId}`,
			title: t("commandPalette.switchWorkspacePrefix", "สลับไปเวิร์กสเปซ") + ` ${workspace.name}`,
			subtitle: workspace.planId?.toUpperCase(),
			section: "workspace",
			keywords: ["switch", "workspace", "สลับ", "พื้นที่", workspace.name],
			run: () => {
				// เหมือน sidebar switchWorkspace: เคลียร์ recent ของบ้านเก่าก่อนสลับ
				// แล้วโหลดของบ้านใหม่ — เดิมเส้นนี้สลับเปล่าๆ ทำคลังโชว์เรื่องข้ามบ้าน
				projectStore.clearRecentProjects();
				void Promise.resolve(workspacesStore.switchTo(workspace.workspaceId)).then(() =>
					projectStore.loadRecentProjects({ background: true, silentFailure: true, workspaceId: workspace.workspaceId }),
				);
			},
		});
	}

	// ── Settings ───────────────────────────────────────────────
	commands.push(
		{
			id: "set-open-settings",
			title: t("commandPalette.openSettings", "ตั้งค่าเวิร์กสเปซ"),
			subtitle: t("commandPalette.openSettingsSub", "สมาชิก · บิล · การใช้งาน"),
			section: "settings",
			keywords: ["settings", "preferences", "ตั้งค่า", "billing", "บิล", "usage", "members"],
			run: () => void adminStore.open(),
		},
	);

	// Settings: language switch.
	for (const lang of locales) {
		commands.push({
			id: `set-locale-${lang.code}`,
			title: t("commandPalette.switchLanguagePrefix", "เปลี่ยนภาษาเป็น") + ` ${lang.name}`,
			subtitle: lang.code.toUpperCase(),
			section: "settings",
			keywords: ["language", "locale", "ภาษา", lang.name, lang.code],
			run: () => {
				void setLocale(lang.code);
			},
		});
	}

	// ── Account ────────────────────────────────────────────────
	if (context.openShortcutsHelp) {
		commands.push({
			id: "account-shortcuts",
			title: t("commandPalette.shortcutsHelp", "คีย์ลัดทั้งหมด"),
			subtitle: t("commandPalette.shortcutsHelpSub", "ดูปุ่มลัดของแอป"),
			section: "account",
			keywords: ["shortcuts", "keyboard", "help", "คีย์ลัด", "ปุ่มลัด"],
			shortcut: "?",
			run: () => context.openShortcutsHelp?.(),
		});
	}
	if (authStore.isAuthenticated && context.signOut) {
		commands.push({
			id: "account-signout",
			title: t("commandPalette.signOut", "ออกจากระบบ"),
			subtitle: authStore.user?.email,
			section: "account",
			keywords: ["sign out", "logout", "log out", "ออกจากระบบ", "ล็อกเอาท์"],
			run: () => void context.signOut?.(),
		});
	}

	return commands;
}

/**
 * Open a project/chapter from a command. Routes into the editor when the chapter
 * has pages, otherwise lands on the library (mirrors the recent-project picker
 * so the two entry points behave identically). The actual project load is owned
 * by `WorkspaceShell.syncRouteTarget` once the URL changes; here we only need to
 * pick the right destination view + push the route.
 */
export async function openProjectChapter(projectId: string): Promise<void> {
	const opened = await projectStore.openProject(projectId, editorStore.editor);
	if (opened === false) return;
	const project = projectStore.project;
	if (!project || !project.pages.length) {
		editorUiStore.openLibrary();
		queueWorkspaceNavigation({ view: "library" });
		return;
	}
	editorUiStore.openEditor();
	queueWorkspaceNavigation({
		view: "editor",
		projectId: project.projectId,
		pageIndex: project.currentPage,
	});
}

// Re-export the section type for callers that build their own commands.
export type { CommandSection };
