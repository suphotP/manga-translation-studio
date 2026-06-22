<script lang="ts">
	import { thumbnailUrl as buildThumbnailUrl, type ProjectSummary, type WorkspaceHomeRecentProject } from "$lib/api/client.js";
	import { type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { queueWorkspaceHrefNavigation } from "$lib/navigation/workspace-navigation.js";
	import { buildChapterDashboard } from "$lib/project/chapter-dashboard.js";
	import { hrefForWorkspaceView } from "$lib/navigation/workspace-routes.js";
	import {
		formatPageWorkName,
		resolveVisiblePageLayerCount,
		summarizePageBatch,
		summarizePageWork,
		type PageWorkSummary,
	} from "$lib/project/page-work-summary.js";
	import {
		buildWorkspaceAssignedWork,
		buildWorkspaceProjectBrowser,
		buildWorkspaceInboxSummary,
		buildWorkspaceDashboardStats,
		buildDashboardTaskRows,
		buildWorkspaceJobLanes,
		getWorkspaceProjectChapterDisplayLabel,
		getWorkspaceProjectStoryTitle,
		getWorkspaceAttentionItems,
		getWorkspaceRecentProjects,
		openDashboardTaskRowProjectFirst,
		type DashboardTaskRow,
		type DashboardTaskRowCopy,
		type WorkspaceAssignedWorkGroup,
	} from "$lib/project/workspace-dashboard.js";
	import {
		formatRecentProjectDisambiguator,
		formatRecentProjectName,
		formatRecentProjectStats,
	} from "$lib/project/recent-projects.js";
	import { formatWorkflowDueDay } from "$lib/project/task-due.js";
	import { aiReviewStatusLabel } from "$lib/project/ai-review-marker-intent.js";
	import type { AiReviewMarkerStatus } from "$lib/types.js";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { authStore, rolePermissionProfile } from "$lib/stores/auth.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { usageStore, formatBytes, thbToCredits, formatCreditsCompact } from "$lib/stores/usage.svelte.ts";
	import { _, locale } from "$lib/i18n";
	import WorkspaceSuspendedBanner from "$lib/components/WorkspaceSuspendedBanner.svelte";
	import Avatar from "$lib/components/ui/Avatar.svelte";
	import DefaultCover from "$lib/components/ui/DefaultCover.svelte";
	import CoverCard from "$lib/components/ui/CoverCard.svelte";
	import NumberValue from "$lib/components/ui/NumberValue.svelte";
	import CreditAmount from "$lib/components/ui/CreditAmount.svelte";
	import SparkleIcon from "$lib/components/ui/SparkleIcon.svelte";
	import StatTile from "$lib/components/ui/StatTile.svelte";
	import PipelineStage, { type PipelineTone } from "$lib/components/ui/PipelineStage.svelte";
	import SectionBand from "$lib/components/ui/SectionBand.svelte";
	import AttentionRow, { type AttentionTone } from "$lib/components/ui/AttentionRow.svelte";
	import LanguageCoverageChips from "$lib/components/ui/LanguageCoverageChips.svelte";
	import WorkspaceTopUtilityBar from "./WorkspaceTopUtilityBar.svelte";
	import WorkspaceAnalytics from "./WorkspaceAnalytics.svelte";
	import type { PipelineStageInput } from "$lib/project/workspace-analytics.js";
	import OnboardingTour from "./OnboardingTour.svelte";
	import type { WorkInboxItem } from "$lib/project/work-inbox.js";
	import type {
		ProjectState,
		WorkflowTask,
		WorkspaceFeedItem,
	} from "$lib/types.js";
	import type { WorkspaceHomeFeedItem } from "$lib/api/client.js";

	type DashboardSearchResult = {
		id: string;
		type: string;
		title: string;
		subtitle: string;
		detail: string;
		accent: DashboardTaskRow["accent"];
		open: () => void | Promise<void>;
	};

	type DashboardRecentActivityRow = {
		id: string;
		actor: string;
		initial: string;
		title: string;
		detail: string;
		time: string;
		tone: "hot" | "warn" | "info";
		projectId: string;
	};

	const MAX_ACTIVITY_ROWS = 4;

	// A feed item is "attention-worthy" when it is a problem/urgent signal — used
	// only for the per-chapter fallback when the cross-project aggregate (which
	// already pre-filters its `attention` list) has not loaded yet.
	function isAttentionFeedItem(item: WorkspaceFeedItem): boolean {
		return item.severity === "error"
			|| item.severity === "warning"
			|| item.priority === "urgent"
			|| item.dueState === "overdue";
	}

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	// Locale-aware "Updated …" relative time for the hero + recent rails. The shared
	// recent-projects formatter returns Thai; this version renders in the active app
	// locale so an EN/JA/KO/ZH customer never sees a Thai timestamp on the dashboard.
	const RELATIVE_TIME_BCP47: Record<string, string> = {
		th: "th-TH",
		en: "en-US",
		ja: "ja-JP",
		ko: "ko-KR",
		zh: "zh-CN",
	};
	function dashboardUpdatedAt(updatedAt: string, nowMs = Date.now()): string {
		const updatedMs = Date.parse(updatedAt);
		if (!Number.isFinite(updatedMs)) return msg("dashboard.updatedUnknown", "ยังไม่รู้เวลาอัปเดต");
		const diffMs = Math.max(0, nowMs - updatedMs);
		const minute = 60 * 1000;
		const hour = 60 * minute;
		const day = 24 * hour;
		if (diffMs < minute) return msg("dashboard.updatedJustNow", "อัปเดตเมื่อกี้");
		if (diffMs < hour) return $_("dashboard.updatedMinutesAgo", { values: { count: Math.max(1, Math.round(diffMs / minute)) } });
		if (diffMs < day) return $_("dashboard.updatedHoursAgo", { values: { count: Math.max(1, Math.round(diffMs / hour)) } });
		if (diffMs < 7 * day) return $_("dashboard.updatedDaysAgo", { values: { count: Math.max(1, Math.round(diffMs / day)) } });
		const bcp47 = RELATIVE_TIME_BCP47[$locale ?? "th"] ?? "en-US";
		const date = new Date(updatedMs).toLocaleDateString(bcp47, { day: "numeric", month: "short" });
		return $_("dashboard.updatedOnDate", { values: { date } });
	}

	let thumbnailFailures = $state<Record<string, boolean>>({});
	let dashboardSearchQuery = $state("");
	let copy = $derived({
		workspace: msg("dashboard.workspace", "เวิร์กสเปซ"),
		openChapterTitle: msg("dashboard.openChapterTitle", "เริ่มงานแปลตอน"),
		openChapterCopy: msg("dashboard.openChapterCopy", "เปิดโฟลเดอร์รูปหน้า แล้วเริ่มแก้ข้อความ รีวิวงาน และ Export"),
		projectHomeCopy: msg("dashboard.projectHomeCopy", "แก้หน้า เช็กปัญหา แล้ว Export จากทางเดินงานที่ชัดเจน"),
		mangaTitle: msg("dashboard.mangaTitle", "ชื่อเรื่อง"),
		ready: msg("dashboard.ready", "พร้อม"),
		attention: msg("dashboard.attention", "ต้องเช็ก"),
		risk: msg("dashboard.risk", "เสี่ยง"),
		handoffs: msg("dashboard.handoffs", "งานต่อ"),
		overdue: msg("dashboard.overdue", "เกินกำหนด"),
		mode: msg("dashboard.mode", "โหมด"),
		openChapter: msg("dashboard.openChapter", "เปิดตอน"),
		canvas: msg("dashboard.canvas", "แก้หน้า"),
		focus: msg("dashboard.focus", "โฟกัส"),
		today: msg("dashboard.today", "วันนี้"),
		todayTitle: msg("dashboard.todayTitle", "งานวันนี้"),
		todayCopy: msg("dashboard.todayCopy", "เลือกงานถัดไป แก้ในหน้า แล้วเช็กก่อน Export"),
		openTasks: msg("dashboard.openTasks", "งานเปิด"),
		comments: msg("dashboard.comments", "คอมเมนต์"),
		aiChecks: msg("dashboard.aiChecks", "ผล AI"),
		startHere: msg("dashboard.startHere", "เริ่มตรงนี้"),
		noProjectTitle: msg("dashboard.noProjectTitle", "ยังไม่ได้เปิดตอน"),
		noProjectCopy: msg("dashboard.noProjectCopy", "ตั้งชื่อเรื่อง เลือกรูปหน้า แล้วเริ่มจากงานถัดไปที่ควรทำ"),
		continueLatestTitle: msg("dashboard.continueLatestTitle", "ทำต่อจากตอนล่าสุด"),
		continueLatestCopy: msg("dashboard.continueLatestCopy", "มีงานล่าสุดพร้อมเปิดต่อ เลือกทำต่อ หรือสร้างตอนใหม่เมื่อจะเริ่มงานอีกชุด"),
		continueLatestAction: msg("dashboard.continueLatestAction", "ทำต่อจากล่าสุด"),
		createNewChapter: msg("dashboard.createNewChapter", "สร้างตอนใหม่"),
		workspaceResolving: msg("dashboard.workspaceResolving", "กำลังตั้งค่าเวิร์กสเปซ…"),
		openChapterFolder: msg("dashboard.openChapterFolder", "สร้างหรือเปิดตอน"),
		nextTask: msg("dashboard.nextTask", "งานถัดไป"),
		openCanvas: msg("dashboard.openCanvas", "เปิดหน้าแก้"),
		assignedWork: msg("dashboard.assignedWork", "งานที่รับไว้"),
		unassignedWork: msg("dashboard.unassignedWork", "งานยังไม่รับ"),
		openJobsIn: msg("dashboard.openJobsIn", "งานเปิดใน"),
		pickNextTask: msg("dashboard.pickNextTask", "ทำงานถัดไปของตอนนี้"),
		clear: msg("dashboard.clear", "เรียบร้อย"),
		clearTitle: msg("dashboard.clearTitle", "ตอนนี้ไม่มีงานด่วน"),
		clearCopy: msg("dashboard.clearCopy", "เปิดหน้าปัจจุบันหรือคิวหน้าเมื่อพร้อมทำรอบถัดไป"),
		nextHandoffs: msg("dashboard.nextHandoffs", "งานต่อไป"),
		project: msg("dashboard.project", "ทั้งตอน"),
		noPagePreview: msg("dashboard.noPagePreview", "ไม่มีภาพหน้า"),
		openWorkspacePreview: msg("dashboard.openWorkspacePreview", "เปิดตอนเพื่อดูบริบทของหน้า"),
		steps: msg("dashboard.steps", "ขั้นตอนงาน"),
		stepsReady: msg("dashboard.stepsReady", "งานตอนนี้ถูกแยกเป็นพื้นที่ที่ชัดเจนแล้ว"),
		stepsLocked: msg("dashboard.stepsLocked", "เปิดตอนเพื่อเริ่มทางเดินงาน"),
		lockedProjectSteps: msg("dashboard.lockedProjectSteps", "หน้า / งาน / โฟกัส"),
		lockedProjectStepsCopy: msg("dashboard.lockedProjectStepsCopy", "เปิดตอนแล้วเวิร์กสเปซพวกนี้จะใช้งานได้"),
		library: msg("dashboard.library", "คลังงาน"),
		openLibrary: msg("dashboard.openLibrary", "เปิดคลังงาน"),
		titleLanguage: msg("dashboard.titleLanguage", "เรื่อง / ภาษา"),
		pages: msg("dashboard.pages", "หน้า"),
		chapterMap: msg("dashboard.chapterMap", "แผนที่หน้า"),
		tasks: msg("dashboard.tasks", "งาน"),
		teamQc: msg("dashboard.teamQc", "ทีม / ตรวจคุณภาพ"),
		oneNextAction: msg("dashboard.oneNextAction", "งานเดียวถัดไป"),
		recentWork: msg("dashboard.recentWork", "งานล่าสุด"),
		refresh: msg("dashboard.refresh", "รีเฟรช"),
		syncing: msg("dashboard.syncing", "กำลังซิงก์"),
		latest: msg("dashboard.latest", "ล่าสุด"),
		chapterStartTitle: msg("dashboard.chapterStartTitle", "เริ่มตอนใหม่"),
		chapterStartCopy: msg("dashboard.chapterStartCopy", "เปิดโฟลเดอร์รูปหน้าก่อน แล้วค่อย Import ข้อความ แก้ในหน้า และ Export"),
		libraryStartTitle: msg("dashboard.libraryStartTitle", "เปิดคลังงาน"),
		libraryStartCopy: msg("dashboard.libraryStartCopy", "ดูปก เรื่อง ตอน ภาษา และงานค้าง โดยไม่ต้องเปิดหน้าแก้ทันที."),
		titlesCount: msg("dashboard.titlesCount", "เรื่อง"),
		recentCount: msg("dashboard.recentCount", "ล่าสุด"),
		currentChapter: msg("dashboard.currentChapter", "ตอนปัจจุบัน"),
		pagesReadyLabel: msg("dashboard.pagesReadyLabel", "หน้าพร้อม"),
		pagesNeedAttention: msg("dashboard.pagesNeedAttention", "หน้าต้องเช็ก"),
		exportReady: msg("dashboard.exportReady", "พร้อม Export"),
		workItems: msg("dashboard.workItems", "งานในคิว"),
		focusSummary: msg("dashboard.focusSummary", "จุดบล็อก งานรีวิว และคอมเมนต์ที่ต้องจัดการ"),
		noFocusQueue: msg("dashboard.noFocusQueue", "ไม่มีคิว Focus"),
		tasksLanes: msg("dashboard.tasksLanes", "งาน / เลน"),
		tasksSummary: msg("dashboard.tasksSummary", "งานต่อ งานเกินกำหนด และงานที่เสร็จแล้ว"),
		loadingRecent: msg("dashboard.loadingRecent", "กำลังโหลดงานล่าสุด"),
		noRecent: msg("dashboard.noRecent", "ยังไม่มีงานล่าสุด"),
		activity: msg("dashboard.activity", "ความเคลื่อนไหว"),
		openProjectActivity: msg("dashboard.openProjectActivity", "เปิดตอนเพื่อดูงานต่อและประวัติงาน"),
		noActivity: msg("dashboard.noActivity", "ยังไม่มีความเคลื่อนไหวในเวิร์กสเปซนี้"),
		greetingMorning: msg("dashboard.greetingMorning", "สวัสดีตอนเช้า"),
		greetingAfternoon: msg("dashboard.greetingAfternoon", "สวัสดีตอนบ่าย"),
		greetingEvening: msg("dashboard.greetingEvening", "สวัสดีตอนเย็น"),
		firstRunHeroTitle: msg("dashboard.firstRunHeroTitle", "เริ่มเรื่องแรกของคุณ"),
		firstRunWaitForLead: msg("dashboard.firstRunWaitForLead", "หัวหน้าหรือแอดมินของบ้านเป็นคนเพิ่มเรื่อง/ตอน — รอรับมอบหมายได้เลย"),
		firstRunHeroCopy: msg("dashboard.firstRunHeroCopy", "ตั้งชื่อเรื่อง เลือกรูปหน้า แล้วเริ่มทำงานแปลตอนแรก"),
		// Honest load/error states for the workspace-home aggregate. A transient backend
		// 500 / network drop must NEVER render the first-run "create your first story"
		// hero — that looks like a returning paying user's work vanished.
		homeLoadingTitle: msg("dashboard.homeLoadingTitle", "กำลังโหลดเวิร์กสเปซ…"),
		homeLoadingCopy: msg("dashboard.homeLoadingCopy", "กำลังดึงงาน ความคืบหน้า และกิจกรรมของทุกตอนในเวิร์กสเปซนี้"),
		homeErrorTitle: msg("dashboard.homeErrorTitle", "โหลดเวิร์กสเปซไม่สำเร็จ"),
		homeErrorCopy: msg("dashboard.homeErrorCopy", "งานของคุณยังอยู่ครบ — นี่เป็นปัญหาชั่วคราวในการดึงข้อมูล ลองใหม่อีกครั้ง"),
		homeRetry: msg("dashboard.homeRetry", "ลองใหม่"),
		homeRetrying: msg("dashboard.homeRetrying", "กำลังลองใหม่…"),
		// ── BODY (PR #289): pipeline / widgets / activity / search ──
		continueEyebrow: msg("dashboard.continueEyebrow", "ทำต่อ · continue"),
		overallTotal: msg("dashboard.overallTotal", "รวม"),
		noProgressYet: msg("dashboard.noProgressYet", "ยังไม่มีข้อมูลความคืบหน้า"),
		heroContinue: msg("dashboard.heroContinue", "ทำต่อ"),
		heroAddPages: msg("dashboard.heroAddPages", "เติมรูปหน้า"),
		bandPipelineSubtitle: msg("dashboard.bandPipelineSubtitle", "สายงานผลิต"),
		bandWorkAttention: msg("dashboard.bandWorkAttention", "งานและสิ่งที่ต้องสนใจ"),
		bandStudioOverview: msg("dashboard.bandStudioOverview", "ภาพรวมสตูดิโอ"),
		viewAll: msg("dashboard.viewAll", "ดูทั้งหมด"),
		myTasks: msg("dashboard.myTasks", "งานของฉัน"),
		tasksUnit: msg("dashboard.tasksUnit", "งาน"),
		filterAll: msg("dashboard.filterAll", "ทั้งหมด"),
		filterToday: msg("dashboard.filterToday", "วันนี้"),
		loadingMyTasks: msg("dashboard.loadingMyTasks", "กำลังโหลดงานของคุณ…"),
		loadMyTasksFailed: msg("dashboard.loadMyTasksFailed", "โหลดงานของคุณไม่สำเร็จ"),
		myTasksEmpty: msg("dashboard.myTasksEmpty", "ยังไม่มีงานที่มอบหมายให้คุณในเวิร์กสเปซนี้"),
		viewAllTasks: msg("dashboard.viewAllTasks", "ดูงานทั้งหมด"),
		itemsUnit: msg("dashboard.itemsUnit", "รายการ"),
		needsAttention: msg("dashboard.needsAttention", "ต้องสนใจ"),
		urgentUnit: msg("dashboard.urgentUnit", "ด่วน"),
		loadingAttention: msg("dashboard.loadingAttention", "กำลังโหลดรายการที่ต้องสนใจ…"),
		loadAttentionFailed: msg("dashboard.loadAttentionFailed", "โหลดรายการที่ต้องสนใจไม่สำเร็จ"),
		attentionEmpty: msg("dashboard.attentionEmpty", "ไม่มีรายการที่ต้องสนใจในเวิร์กสเปซนี้"),
		openInbox: msg("dashboard.openInbox", "เปิดกล่องข้อความ · inbox"),
		aiJobs: msg("dashboard.aiJobs", "งาน AI"),
		awaitingReviewShort: msg("dashboard.awaitingReviewShort", "รอรีวิว"),
		loadingAiJobs: msg("dashboard.loadingAiJobs", "กำลังโหลดงาน AI…"),
		loadAiJobsFailed: msg("dashboard.loadAiJobsFailed", "โหลดงาน AI ไม่สำเร็จ"),
		aiJobsEmpty: msg("dashboard.aiJobsEmpty", "ยังไม่มีงาน AI รอรีวิวในเวิร์กสเปซนี้"),
		pageWord: msg("dashboard.pageWord", "หน้า"),
		viewWord: msg("dashboard.viewWord", "ดู"),
		usage: msg("dashboard.usage", "การใช้งาน"),
		storageFrozen: msg("dashboard.storageFrozen", "เต็มแล้ว · เพิ่มพื้นที่"),
		storageWarning: msg("dashboard.storageWarning", "ใกล้เต็ม · เตือนที่ 80%"),
		storageOk: msg("dashboard.storageOk", "พื้นที่เหลือพอ"),
		remainingPrefix: msg("dashboard.remainingPrefix", "เหลือ"),
		usedPrefix: msg("dashboard.usedPrefix", "ใช้ไป"),
		unlimited: msg("dashboard.unlimited", "ไม่จำกัด"),
		addPackUpgrade: msg("dashboard.addPackUpgrade", "เพิ่มแพ็ก / อัปเกรด"),
		loadingUsage: msg("dashboard.loadingUsage", "กำลังโหลดการใช้งานของเวิร์กสเปซ…"),
		recentSeriesEyebrow: msg("dashboard.recentSeriesEyebrow", "เปิดล่าสุด"),
		openAll: msg("dashboard.openAll", "เปิดทั้งหมด"),
		teamActivity: msg("dashboard.teamActivity", "กิจกรรมทีม"),
		loadingActivity: msg("dashboard.loadingActivity", "กำลังโหลดกิจกรรม…"),
		loadActivityFailed: msg("dashboard.loadActivityFailed", "โหลดกิจกรรมไม่สำเร็จ"),
		metricAllTasks: msg("dashboard.metricAllTasks", "งานทั้งหมด"),
		metricDueSoon: msg("dashboard.metricDueSoon", "ใกล้ครบกำหนด"),
		metricNoChapters: msg("dashboard.metricNoChapters", "ยังไม่มีตอน"),
		langUnit: msg("dashboard.langUnit", "ภาษา"),
		searchType_task: msg("dashboard.searchType_task", "งาน"),
		searchType_story: msg("dashboard.searchType_story", "เรื่อง/ตอน"),
		searchType_command: msg("dashboard.searchType_command", "คำสั่ง"),
		searchNoMatch: msg("dashboard.searchNoMatch", "ไม่พบงานหรือเรื่องที่ตรงกัน"),
		searchHint: msg("dashboard.searchHint", "ค้นได้จากชื่องาน ชื่อเรื่อง ตอน ภาษา สถานะ หรือคำสั่ง เช่น “สร้างตอนใหม่”"),
		searchOpenStory: msg("dashboard.searchOpenStory", "เปิดเวิร์กสเปซของตอนนี้"),
		searchFillPages: msg("dashboard.searchFillPages", "เติมรูปหน้าเพื่อเริ่มตอน"),
		searchActionLibraryTitle: msg("dashboard.searchActionLibraryTitle", "เปิดคลังการ์ตูน"),
		searchActionLibrarySub: msg("dashboard.searchActionLibrarySub", "ดูรูปปก ชื่อเรื่อง และตอนล่าสุด"),
		searchActionLibraryDetail: msg("dashboard.searchActionLibraryDetail", "ไปหน้ารวมคลัง"),
		searchActionCreateTitle: msg("dashboard.searchActionCreateTitle", "สร้างตอนใหม่"),
		searchActionCreateSub: msg("dashboard.searchActionCreateSub", "ตั้งชื่อเรื่องและอัปโหลดรูปหน้า"),
		searchActionCreateDetail: msg("dashboard.searchActionCreateDetail", "เปิดหน้าสร้างตอน"),
		ariaSearchPanel: msg("dashboard.ariaSearchPanel", "ผลค้นหา แดชบอร์ด"),
		ariaMainDashboard: msg("dashboard.ariaMainDashboard", "แดชบอร์ดหลัก"),
		ariaFirstStory: msg("dashboard.ariaFirstStory", "เริ่มเรื่องแรก"),
		ariaContinueHero: msg("dashboard.ariaContinueHero", "ทำต่อจากตอนล่าสุด (Hero)"),
		ariaQuietMetrics: msg("dashboard.ariaQuietMetrics", "ตัวเลขสรุปเวิร์กสเปซ"),
		feedComment: msg("dashboard.feedComment", "คอมเมนต์"),
		feedReviewDecision: msg("dashboard.feedReviewDecision", "ผลรีวิว"),
		feedVersion: msg("dashboard.feedVersion", "เวอร์ชัน"),
		feedTask: msg("dashboard.feedTask", "งาน"),
		feedAiMarker: msg("dashboard.feedAiMarker", "ผล AI"),
		feedExport: msg("dashboard.feedExport", "Export"),
		feedMessage: msg("dashboard.feedMessage", "ข้อความ"),
		feedActivity: msg("dashboard.feedActivity", "กิจกรรม"),
		pipelineNotStarted: msg("dashboard.pipelineNotStarted", "ยังไม่เริ่ม"),
		pipelineDone: msg("dashboard.pipelineDone", "เสร็จแล้ว"),
		pipelineOverdue: msg("dashboard.pipelineOverdue", "เลยกำหนด"),
		pipelineInProgress: msg("dashboard.pipelineInProgress", "กำลังทำ"),
		pipelineAwaitingReview: msg("dashboard.pipelineAwaitingReview", "รอรีวิว"),
		chapterFallback: msg("dashboard.chapterFallback", "ตอน"),
		pagesCountUnit: msg("dashboard.pagesCountUnit", "หน้า"),
		dueOverdue: msg("dashboard.dueOverdue", "เกินกำหนด"),
		dueNone: msg("dashboard.dueNone", "ยังไม่กำหนด"),
		statusOverdue: msg("dashboard.statusOverdue", "เกินกำหนด"),
		statusTodo: msg("dashboard.statusTodo", "ยังไม่เริ่ม"),
		statusInProgress: msg("dashboard.statusInProgress", "กำลังดำเนินการ"),
		detailUrgent: msg("dashboard.detailUrgent", "ด่วน"),
		detailHigh: msg("dashboard.detailHigh", "สำคัญ"),
		detailNormal: msg("dashboard.detailNormal", "ปกติ"),
		detailDeletedPageComment: msg("dashboard.detailDeletedPageComment", "คอมเมนต์นี้ชี้ไปยังหน้าที่ถูกลบแล้ว"),
		detailDeletedPageReview: msg("dashboard.detailDeletedPageReview", "ผลรีวิวนี้ชี้ไปยังหน้าที่ถูกลบแล้ว"),
		detailOpenComment: msg("dashboard.detailOpenComment", "อ่านคอมเมนต์"),
		detailChangesRequested: msg("dashboard.detailChangesRequested", "ขอแก้ไข"),
		// Structured feed-title resolver (keyed off backend kind + status, NOT the
		// English title string) so the attention rail + activity titles localize.
		feedTitleHandoffNote: msg("dashboard.feedTitleHandoffNote", "บันทึกส่งต่องาน"),
		feedTitleOpenComment: msg("dashboard.feedTitleOpenComment", "คอมเมนต์ตรวจที่เปิดอยู่"),
		feedTitlePageApproved: msg("dashboard.feedTitlePageApproved", "อนุมัติหน้าแล้ว"),
		feedTitleChangesRequested: msg("dashboard.feedTitleChangesRequested", "ขอแก้ไข"),
		feedTitleVersionReviewRequested: msg("dashboard.feedTitleVersionReviewRequested", "ขอรีวิวเวอร์ชัน"),
		feedTitleVersionApproved: msg("dashboard.feedTitleVersionApproved", "อนุมัติเวอร์ชันแล้ว"),
		feedTitleVersionChangesRequested: msg("dashboard.feedTitleVersionChangesRequested", "ขอแก้ไขเวอร์ชัน"),
		feedTitleExportFailed: msg("dashboard.feedTitleExportFailed", "Export ไม่สำเร็จ"),
		feedTitleExportCompleted: msg("dashboard.feedTitleExportCompleted", "Export เสร็จแล้ว"),
		// Localized task-detail tokens (priority/status/due) composed from the
		// feed item's STRUCTURED fields (priority/status/dueState/dueAt/actor).
		detailTaskStatusTodo: msg("dashboard.detailTaskStatusTodo", "ยังไม่เริ่ม"),
		detailTaskStatusDoing: msg("dashboard.detailTaskStatusDoing", "กำลังทำ"),
		detailTaskStatusReview: msg("dashboard.detailTaskStatusReview", "กำลังตรวจ"),
		detailTaskStatusDone: msg("dashboard.detailTaskStatusDone", "เสร็จแล้ว"),
		detailDueOverdue: msg("dashboard.detailDueOverdue", "เลยกำหนด"),
		detailDueSoon: msg("dashboard.detailDueSoon", "ใกล้ครบกำหนด"),
		detailDue: msg("dashboard.detailDue", "กำหนด"),
	});
	let pageSummaries = $derived(buildPageSummaries(projectStore.project));
	let chapterBatchSummary = $derived(summarizePageBatch(pageSummaries));
	let chapterDashboard = $derived(buildChapterDashboard(pageSummaries, chapterBatchSummary));

	// --- Workspace-wide sources (KEYSTONE) -------------------------------------
	// The dashboard's My-Work / pipeline / activity / attention / AI-queue widgets
	// read the cross-project workspace-home AGGREGATE *only*. They are INTENTIONALLY
	// decoupled from whichever chapter happens to be open in the editor: opening a
	// chapter changes the right-panel inspector, NEVER these. There is deliberately
	// NO projectStore fallback here — a fallback would re-couple the dashboard to the
	// open chapter (so it would visibly change when a chapter opens) and would let a
	// single project's data masquerade as the whole workspace. While the aggregate is
	// loading we show a loading state; on failure an honest error; when it loaded but
	// is empty, a real empty state. Never a mock, never per-chapter data.
	let homeLoaded = $derived(workspaceHomeStore.hasLoaded);
	let homeLoading = $derived(workspaceHomeStore.loading && !homeLoaded);
	let homeError = $derived(!homeLoaded && !workspaceHomeStore.loading ? workspaceHomeStore.error : null);
	let workspaceTasks = $derived<WorkflowTask[]>(workspaceHomeStore.myTasks);
	let workspaceFeedItems = $derived<WorkspaceHomeFeedItem[]>(workspaceHomeStore.activity);
	// These carry project context (WorkspaceHomeFeedItem) straight from the aggregate.
	let workspaceAttentionFeed = $derived<WorkspaceHomeFeedItem[]>(workspaceHomeStore.attention);

	let workspaceStats = $derived(buildWorkspaceDashboardStats(workspaceTasks, workspaceFeedItems));
	let aiQueueAttentionCount = $derived(workspaceHomeStore.counts.aiJobs);
	// AI soft-queue rows carry the raw marker status ("needs_review"/"failed"/…).
	// Surface the localized label ("รอรีวิว"/"รันพลาด") instead of the raw enum, and
	// fall back to the raw value only for any unknown/future status the map misses.
	const AI_JOB_STATUSES = new Set<AiReviewMarkerStatus>([
		"processing", "needs_review", "accepted", "rejected", "retry_requested", "applied", "failed",
	]);
	function aiJobStatusLabel(status: string): string {
		return AI_JOB_STATUSES.has(status as AiReviewMarkerStatus)
			? $_(`aiReviewMarker.status.${aiReviewStatusLabel(status as AiReviewMarkerStatus)}`)
			: status;
	}
	let attentionItems = $derived(getWorkspaceAttentionItems(projectStore.workInbox));
	let inboxSummary = $derived(buildWorkspaceInboxSummary(projectStore.workInbox));
	let roleCapabilities = $derived(rolePermissionProfile(projectStore.currentWorkspaceMember?.memberStudioRole ?? authStore.role));
	let jobLanes = $derived(buildWorkspaceJobLanes(workspaceTasks, roleCapabilities));
	let assignedWorkGroups = $derived(buildWorkspaceAssignedWork(workspaceTasks));
	let activeLaneCount = $derived(jobLanes.filter((lane) => lane.openCount > 0).length);
	let primaryAttentionItem = $derived(attentionItems[0] ?? null);
	let secondaryAttentionItems = $derived(attentionItems.slice(1, 4));
	let primaryAssignedGroup = $derived(assignedWorkGroups[0] ?? null);
	let activityRows = $derived(workspaceFeedItems.slice(0, MAX_ACTIVITY_ROWS));
	let projectBrowserGroups = $derived(buildWorkspaceProjectBrowser(projectStore.recentProjects, undefined, undefined, copy.chapterFallback));
	let recentProjects = $derived(getWorkspaceRecentProjects(projectStore.recentProjects, 4));
	// Greeting uses the user's REAL display name only. A new account has no name set,
	// so we must NOT fall back to the email local-part (e.g. "qa1780576971898") — that
	// reads as a fabricated identity. When no name exists we greet generically (no name
	// at all) instead. Never invent a name.
	let dashboardUserName = $derived(authStore.user?.name?.trim() || "");
	// Plan label on the usage pill — same resolved plan that drives the AI-credit
	// allowance below it (usageStore), so the label can't disagree with the cap.
	// Falls back to the workspace's billing planId until usage loads.
	let dashboardPlanLabel = $derived(
		usageStore.resolvedPlanName
			? `${usageStore.resolvedPlanName} plan`
			: workspacesStore.currentWorkspace?.planId
				? `${workspacesStore.currentWorkspace.planId} plan`
				: "Workspace plan",
	);
	let dashboardTeamOnlineLabel = $derived(
		workspacesStore.members.length
			? $_("dashboard.teamOnline", { values: { count: workspacesStore.members.length } })
			: msg("dashboard.teamReady", "ทีมพร้อมเชื่อมต่อ"),
	);

	// Live workspace usage (storage + AI credits). Sidebar owns the polling
	// lifecycle; we read the same usageStore so the dashboard NEVER fabricates
	// quota/credit figures for a real account. No live dashboard => honest empty.
	let hasLiveUsage = $derived(Boolean(usageStore.dashboard));
	let storageUsedBytes = $derived(usageStore.storage?.usedBytes ?? 0);
	let storageLimitBytes = $derived(usageStore.storage?.limitBytes ?? 0);
	let storagePctValue = $derived(usageStore.storagePct);
	let storageBand = $derived(usageStore.storageBand);
	let aiWindow = $derived(usageStore.ai);
	let aiCommittedThb = $derived((aiWindow?.aiCommittedThb ?? 0) + (aiWindow?.aiActiveReservedThb ?? 0));
	let aiLimitThb = $derived(aiWindow?.limits.aiCreditThb ?? 0);
	// User-facing meter shows CREDITS, not baht (THB→credit is display-only conversion).
	let aiUsedCredits = $derived(thbToCredits(aiCommittedThb));
	let aiLimitCredits = $derived(thbToCredits(aiLimitThb));
	let aiPctValue = $derived(Math.min(100, usageStore.aiPct));
	// Remaining-countdown (issue #3): lead with what's LEFT, bars deplete.
	let storageRemainingBytes = $derived(usageStore.storageRemainingBytes);
	let storageRemainingPct = $derived(Math.max(0, 100 - storagePctValue));
	let aiUnlimited = $derived(usageStore.aiRemainingThb === null || aiLimitThb <= 0);
	let aiRemainingCredits = $derived(usageStore.aiRemainingCredits ?? 0);
	let aiRemainingPctValue = $derived(Math.max(0, 100 - aiPctValue));
	let heroStoragePctLabel = $derived(hasLiveUsage ? `storage ${storagePctValue.toFixed(0)}%` : "");
	let recentProjectActivityRows = $derived(buildRecentProjectActivityRows());
	let recentGalleryProjects = $derived(recentProjects.slice(1, 4));
	let contextRecentProjects = $derived(
		!projectStore.project && recentProjects.length > 1 ? recentProjects.slice(1) : recentProjects,
	);
	let dashboardProgressLabel = $derived(formatPercent(chapterDashboard.exportReadyCount, chapterDashboard.totalPages));
	let primaryWorkPageIndex = $derived(
		primaryAttentionItem?.pageIndex
			?? primaryAssignedGroup?.firstOpenPageIndex
			?? projectStore.project?.currentPage
			?? null,
	);
	let primaryWorkPage = $derived(
		primaryWorkPageIndex === null ? null : projectStore.project?.pages[primaryWorkPageIndex] ?? null,
	);
	let primaryWorkSummary = $derived(
		primaryWorkPageIndex === null ? null : pageSummaries[primaryWorkPageIndex] ?? null,
	);
	let dashboardTaskRows = $derived(buildDashboardTaskRows(workspaceHomeStore.myTasks, dashboardTaskRowCopy(), { limit: 5 }));
	let latestWorkspaceProjectId = $derived(workspaceHomeStore.recentProject?.projectId ?? null);
	let myTasksWorkBoardProjectId = $derived(dashboardTaskRows[0]?.projectId ?? latestWorkspaceProjectId);
	let attentionWorkBoardProjectId = $derived(workspaceAttentionFeed[0]?.projectId ?? latestWorkspaceProjectId);
	let aiJobsWorkBoardProjectId = $derived(workspaceHomeStore.aiJobs[0]?.projectId ?? latestWorkspaceProjectId);
	let activityWorkBoardProjectId = $derived(workspaceHomeStore.activity[0]?.projectId ?? latestWorkspaceProjectId);
	// Metric tiles summarize TASK counts, so they navigate to a task's project —
	// not wherever the latest activity happened (review #588 P2).
	let dueTaskWorkBoardProjectId = $derived(
		// dueToday is the aggregate the metric COUNTS, so its first row is the
		// correct click target even when the due task is outside this user's
		// My-Work slice (review #588 r2); the row scan is only a fallback.
		workspaceHomeStore.dueToday[0]?.projectId
			?? dashboardTaskRows.find((row) => row.statusClass === "late" || row.statusClass === "soon")?.projectId
			?? myTasksWorkBoardProjectId,
	);
	let myTasksWorkBoardUnavailable = $derived(!canOpenWorkBoard(myTasksWorkBoardProjectId));
	let attentionWorkBoardUnavailable = $derived(!canOpenWorkBoard(attentionWorkBoardProjectId));
	let aiJobsWorkBoardUnavailable = $derived(!canOpenWorkBoard(aiJobsWorkBoardProjectId));
	let activityWorkBoardUnavailable = $derived(!canOpenWorkBoard(activityWorkBoardProjectId));
	let normalizedDashboardSearch = $derived(normalizeDashboardSearch(dashboardSearchQuery));
	let dashboardSearchResults = $derived(buildDashboardSearchResults());
	let visibleDashboardSearchResults = $derived(dashboardSearchResults.slice(0, 6));

	function currentPageActionLabel(): string {
		return projectStore.project ? $_("dashboard.openPageNumber", { values: { page: projectStore.project.currentPage + 1 } }) : copy.openCanvas;
	}

	function normalizeDashboardSearch(value: string): string {
		return value.trim().toLocaleLowerCase();
	}

	// `getWorkspaceProjectStoryTitle` returns "" for an unnamed story; localize the
	// empty case here so non-Thai locales show "Untitled story" instead of a leaked
	// Thai fragment.
	function workspaceProjectDisplayTitle(project: ProjectSummary): string {
		return getWorkspaceProjectStoryTitle(project).trim() || $_("library.untitledStory");
	}

	function recentProjectStoryLabel(project: ProjectSummary): string {
		return workspaceProjectDisplayTitle(project);
	}

	function recentProjectChapterContextLabel(project: ProjectSummary): string {
		return `${getWorkspaceProjectChapterDisplayLabel(project, copy.chapterFallback)} · ${project.targetLang.toUpperCase()} · ${project.pageCount} ${copy.pagesCountUnit}`;
	}

	function searchableRecentProjectText(project: ProjectSummary): string {
		return [
			recentProjectStoryLabel(project),
			recentProjectChapterContextLabel(project),
			project.name,
			project.targetLang,
			project.storyTitle,
			project.chapterLabel,
			project.chapterNumber,
			project.chapterTitle,
			project.projectId,
		].filter(Boolean).join(" ").toLocaleLowerCase();
	}

	function searchableTaskRowText(row: DashboardTaskRow): string {
		return [row.title, row.lane, row.due, row.status].join(" ").toLocaleLowerCase();
	}

	function searchMatches(text: string): boolean {
		return text.toLocaleLowerCase().includes(normalizedDashboardSearch);
	}

	function dashboardTaskRowCopy(): DashboardTaskRowCopy {
		return {
			dueOverdue: copy.dueOverdue,
			dueNone: copy.dueNone,
			statusOverdue: copy.statusOverdue,
			statusTodo: copy.statusTodo,
			statusInProgress: copy.statusInProgress,
			taskPageLane: (page) => $_("dashboard.taskPageLane", { values: { page } }),
			taskTypePageTitle: (type, page) => $_("dashboard.taskTypePageTitle", { values: { type, page } }),
		};
	}

	function buildDashboardSearchResults(): DashboardSearchResult[] {
		if (!normalizedDashboardSearch) return [];
		const results: DashboardSearchResult[] = [];
		for (const project of recentProjects) {
			if (!searchMatches(searchableRecentProjectText(project))) continue;
			results.push({
				id: `project-${project.projectId}`,
				type: copy.searchType_story,
				title: recentProjectStoryLabel(project),
				subtitle: recentProjectChapterContextLabel(project),
				detail: project.pageCount > 0 ? copy.searchOpenStory : copy.searchFillPages,
				accent: "cyan",
				open: () => openRecentProject(project.projectId),
			});
		}
		for (const row of dashboardTaskRows) {
			if (!searchMatches(searchableTaskRowText(row))) continue;
			results.push({
				id: `task-${row.id}`,
				type: copy.searchType_task,
				title: row.title,
				subtitle: row.lane,
				detail: `${row.status} · ${row.due}`,
				accent: row.accent,
				open: () => openDashboardTaskRow(row),
			});
		}
		const actions: DashboardSearchResult[] = [
			{
				id: "action-library",
				type: copy.searchType_command,
				title: copy.searchActionLibraryTitle,
				subtitle: copy.searchActionLibrarySub,
				detail: copy.searchActionLibraryDetail,
				accent: "blue",
				open: openLibrary,
			},
			// "สร้างตอนใหม่" only for catalog shapers (owner/admin) — worker seats
			// would just hit the backend manage_projects 403.
			...(workspacesStore.isAdmin ? [{
				id: "action-create",
				type: copy.searchType_command,
				title: copy.searchActionCreateTitle,
				subtitle: copy.searchActionCreateSub,
				detail: copy.searchActionCreateDetail,
				accent: "violet" as const,
				open: createFirstChapter,
			}] : []),
			// The dashboard is workspace-scoped and decoupled from the open chapter
			// (the keystone invariant). Search must NOT add open-project/open-chapter
			// actions — their gate + labels (currentProject*/currentPageName) are
			// chapter-coupled, so they'd make search results change when a chapter
			// opens (sighted AND screen-reader). Jumping into a project is covered by
			// the recent-series rail, the cross-project Cmd-K palette, and the hero CTA.
		];
		for (const action of actions) {
			if (!searchMatches([action.title, action.subtitle, action.detail, action.type].join(" "))) continue;
			results.push(action);
		}
		return results;
	}

	function buildRecentProjectActivityRows(): DashboardRecentActivityRow[] {
		// Attribute recent-project activity to the REAL signed-in user instead of
		// inventing teammate names (was a fabricated "Mint/Tee/Pang/New" roster).
		const selfName = authStore.user?.name?.trim() || authStore.user?.email?.trim() || $_("dashboard.you");
		const selfInitial = selfName.charAt(0).toUpperCase() || "U";
		return recentProjects.slice(0, MAX_ACTIVITY_ROWS).map((project) => {
			const hasBlocker = (project.openCommentCount ?? 0) > 0 || (project.reviewTaskCount ?? 0) > 0;
			const hasOpenWork = (project.openTaskCount ?? 0) > 0;
			const verb = hasBlocker
				? $_("dashboard.activityVerbReviewWaiting")
				: hasOpenWork
					? $_("dashboard.activityVerbOpenWork")
					: project.pageCount > 0
						? $_("dashboard.activityVerbRecentlyOpened")
						: $_("dashboard.activityVerbAwaitingUpload");
			return {
				id: `recent-project-activity-${project.projectId}`,
				actor: selfName,
				initial: selfInitial,
				title: `${workspaceProjectDisplayTitle(project)} · ${verb}`,
				detail: `${getWorkspaceProjectChapterDisplayLabel(project, copy.chapterFallback)} · ${project.targetLang.toUpperCase()} · ${project.pageCount} ${copy.pagesCountUnit}`,
				time: dashboardUpdatedAt(project.updatedAt),
				tone: hasBlocker ? "warn" : hasOpenWork ? "info" : "hot",
				projectId: project.projectId,
			};
		});
	}

	function clearDashboardSearch(): void {
		dashboardSearchQuery = "";
	}

	function openFirstDashboardSearchResult(): void {
		if (!normalizedDashboardSearch) return;
		void dashboardSearchResults[0]?.open();
	}

	function handleDashboardSearchKeydown(event: KeyboardEvent): void {
		if (event.key === "Enter") {
			event.preventDefault();
			openFirstDashboardSearchResult();
		}
		if (event.key === "Escape") {
			event.preventDefault();
			clearDashboardSearch();
		}
	}

	function currentProjectStoryLabel(): string {
		const project = projectStore.project;
		if (!project) return "";
		return project.storyTitle?.trim() || formatRecentProjectName(project);
	}

	function currentProjectChapterContextLabel(): string {
		const project = projectStore.project;
		if (!project) return "";
		const explicit = project.chapterLabel?.trim();
		const number = project.chapterNumber?.trim();
		const title = project.chapterTitle?.trim();
		const chapter = explicit || [number ? $_("dashboard.chapterNumberLabel", { values: { number } }) : "", title].filter(Boolean).join(" - ") || copy.chapterFallback;
		return `${chapter} · ${project.targetLang.toUpperCase()} · ${project.pages.length} ${copy.pagesCountUnit}`;
	}

	// Hero labels sourced from the WORKSPACE-HOME aggregate's recent project (stable,
	// chapter-independent). The aggregate already resolves storyTitle/chapterLabel
	// server-side, so these are simple, honest formatters — never coupled to the
	// open chapter.
	function heroProjectStoryLabel(project: WorkspaceHomeRecentProject): string {
		return project.storyTitle?.trim() || project.projectName?.trim() || project.projectId;
	}

	function heroProjectChapterContextLabel(project: WorkspaceHomeRecentProject): string {
		const chapter = project.chapterLabel?.trim() || copy.chapterFallback;
		const lang = (project.targetLang ?? "th").toUpperCase();
		return `${chapter} · ${lang} · ${project.pageCount} ${copy.pagesCountUnit}`;
	}

	async function openDashboardTaskRow(row: DashboardTaskRow): Promise<void> {
		await openDashboardTaskRowProjectFirst(row, {
			currentProjectId: () => projectStore.project?.projectId,
			openProject: (projectId) => projectStore.openProject(projectId, editorStore.editor),
			openWorkBoard: () => editorUiStore.openWorkBoard(),
			openWorkBoardRoute: (projectId) => queueWorkspaceHrefNavigation(hrefForWorkspaceView("work", projectId)),
		});
	}

	function repairCurrentPageActionLabel(): string {
		return projectStore.project ? $_("dashboard.repairOnPage", { values: { page: projectStore.project.currentPage + 1 } }) : copy.openCanvas;
	}

	function dashboardEditorActionLabel(): string {
		return currentPageActionLabel();
	}

	function inboxEditorActionLabel(item: WorkInboxItem): string {
		if (!projectStore.project) return copy.openCanvas;
		if (item.pageIndex === undefined) return currentPageActionLabel();
		if (!projectStore.project.pages[item.pageIndex]) return repairCurrentPageActionLabel();
		return $_("dashboard.openPageNumber", { values: { page: item.pageIndex + 1 } });
	}

	function assignedGroupEditorActionLabel(group: WorkspaceAssignedWorkGroup): string {
		if (!projectStore.project) return copy.openCanvas;
		if (group.firstOpenPageIndex === null) return currentPageActionLabel();
		if (!projectStore.project.pages[group.firstOpenPageIndex]) return repairCurrentPageActionLabel();
		return $_("dashboard.openPageNumber", { values: { page: group.firstOpenPageIndex + 1 } });
	}

	function buildPageSummaries(project: ProjectState | null): PageWorkSummary[] {
		if (!project) return [];
		const qcIssues = projectStore.qcReport.issues;
		return project.pages.map((page, index) => summarizePageWork({
			page,
			pageIndex: index,
			layerCount: resolveVisiblePageLayerCount(
				page,
				project.currentPage === index,
				editorStore.textLayers.length,
				editorStore.hasImage,
			),
			assetIntegrity: projectStore.getPageAssetIntegrity(index),
			qcIssues,
			tasks: projectStore.tasks,
			comments: projectStore.comments,
			aiReviewMarkers: projectStore.aiReviewMarkers,
			reviewDecisions: projectStore.reviewDecisions,
			productionMode: project.productionMode ?? "solo",
		}));
	}

	function formatPercent(ready: number, total: number): string {
		if (total <= 0) return "0%";
		return `${Math.round((ready / total) * 100)}%`;
	}

	function formatFeedTime(item: WorkspaceFeedItem): string {
		const date = new Date(item.createdAt);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function feedTone(item: WorkspaceFeedItem): string {
		if (item.severity === "error" || item.dueState === "overdue" || item.priority === "urgent") return "hot";
		if (item.severity === "warning" || item.dueState === "soon" || item.priority === "high") return "warn";
		return "info";
	}

	function currentPageName(): string {
		if (!projectStore.project) return $_("dashboard.noChapterOpen");
		const page = projectStore.project.pages[projectStore.project.currentPage];
		return page ? $_("dashboard.pageNumber", { values: { page: projectStore.project.currentPage + 1 } }) : $_("dashboard.noPage");
	}

	function dashboardPageName(pageIndex: number | null | undefined, fallback = copy.noPagePreview): string {
		return pageIndex === null || pageIndex === undefined ? fallback : $_("dashboard.pageNumber", { values: { page: pageIndex + 1 } });
	}

	function dueLabel(summary: PageWorkSummary): string {
		if (summary.overdueTaskCount > 0) return $_("dashboard.overdueTaskCount", { values: { count: summary.overdueTaskCount } });
		if (summary.nextDueAt) return $_("dashboard.dueOn", { values: { date: formatWorkflowDueDay(summary.nextDueAt) } });
		return $_("dashboard.noDueYet");
	}

	function dashboardFeedKindLabel(kind: WorkspaceFeedItem["kind"]): string {
		if (kind === "comment") return copy.feedComment;
		if (kind === "review_decision") return copy.feedReviewDecision;
		if (kind === "version_review") return copy.feedVersion;
		if (kind === "task") return copy.feedTask;
		if (kind === "ai_marker") return copy.feedAiMarker;
		if (kind === "export_run") return copy.feedExport;
		if (kind === "message") return copy.feedMessage;
		return copy.feedActivity;
	}

	function dashboardDetailLabel(detail: string): string {
		// The backend emits these feed-detail tokens in English; localize them for
		// display so an EN/JA/KO/ZH customer never sees a wrong-language fragment.
		return detail
			.replace(/\bUrgent\b/g, copy.detailUrgent)
			.replace(/\bHigh\b/g, copy.detailHigh)
			.replace(/\bNormal\b/g, copy.detailNormal)
			.replace(/\bThis comment belongs to a deleted page\b/gi, copy.detailDeletedPageComment)
			.replace(/\bReview points at a deleted page\b/gi, copy.detailDeletedPageReview)
			.replace(/\bOpen comment\b/gi, copy.detailOpenComment)
			.replace(/\bChanges requested\b/gi, copy.detailChangesRequested)
			.replace(/\bPage\s+(\d+)\s+-\s+Review imported dialogue\b/gi, (_m, page) => $_("dashboard.detailReviewImported", { values: { page } }))
			.replace(/\bPage\s+(\d+)\s+-\s+Review ready\b/gi, (_m, page) => $_("dashboard.detailReviewReady", { values: { page } }))
			.replace(/\s+-\s+/g, " / ");
	}

	// Localized feed TITLE resolver. Keys off the STRUCTURED kind + status fields
	// the backend emits (NOT the English title string — that's fragile) so the
	// attention rail + activity titles render in the active locale. Kinds whose
	// title is user content (task = task.title) or free-form system text
	// (activity = event.message, which carries embedded user content and has no
	// fixed token set) fall back to the raw title.
	function dashboardFeedTitleLabel(item: WorkspaceFeedItem): string {
		switch (item.kind) {
			case "message":
				return copy.feedTitleHandoffNote;
			case "comment":
				return copy.feedTitleOpenComment;
			case "review_decision":
				return item.status === "approved" ? copy.feedTitlePageApproved : copy.feedTitleChangesRequested;
			case "version_review":
				if (item.status === "approved") return copy.feedTitleVersionApproved;
				if (item.status === "changes_requested") return copy.feedTitleVersionChangesRequested;
				return copy.feedTitleVersionReviewRequested;
			case "ai_marker": {
				// Backend title is `AI ${tier}` (tier is a slug, e.g. budget-clean).
				const tier = item.title.replace(/^AI\s+/i, "").trim() || item.title;
				return $_("dashboard.feedTitleAiReview", { values: { tier } });
			}
			case "export_run":
				return item.status === "error" ? copy.feedTitleExportFailed : copy.feedTitleExportCompleted;
			case "task":
				// task.title is user-authored content — never translate.
				return item.title;
			case "activity":
			default:
				// Prefer the structured localized-title key + params the backend now
				// emits (e.g. `activity.commentAdded {page}`) so the message renders
				// in the active locale. Fall back to the string-token localizer for
				// older events / un-keyed free-form messages (which embed user
				// content with no fixed token set).
				if (item.titleKey) {
					const localized = $_(item.titleKey, { values: item.titleParams ?? {} });
					if (localized && localized !== item.titleKey) return localized;
				}
				return dashboardDetailLabel(item.title);
		}
	}

	function dashboardTaskStatusLabel(status: string | undefined): string {
		if (status === "todo") return copy.detailTaskStatusTodo;
		if (status === "doing") return copy.detailTaskStatusDoing;
		if (status === "review") return copy.detailTaskStatusReview;
		if (status === "done") return copy.detailTaskStatusDone;
		return status ?? "";
	}

	function dashboardTaskDueLabel(item: WorkspaceFeedItem): string {
		if (!item.dueAt) return "";
		const date = item.dueAt.slice(0, 10);
		const label = item.dueState === "overdue"
			? copy.detailDueOverdue
			: item.dueState === "soon"
				? copy.detailDueSoon
				: copy.detailDue;
		return `${label} ${date}`.trim();
	}

	// Localized feed DETAIL resolver. For tasks the backend joins an English string
	// (`priority / status / @assignee / dueLabel date`); we recompose it from the
	// item's STRUCTURED fields (priority/status/dueState/dueAt/actor) so every
	// SYSTEM token localizes while the @assignee handle (user content) is kept. All
	// other kinds carry user/free-form detail (comment body, review note, version id,
	// export filename, AI status) → the string-token localizer, which only touches
	// known system fragments and passes user content through unchanged.
	function dashboardFeedDetailLabel(item: WorkspaceFeedItem): string {
		if (item.kind !== "task") return dashboardDetailLabel(item.detail);
		const priority = item.priority === "urgent"
			? copy.detailUrgent
			: item.priority === "high"
				? copy.detailHigh
				: copy.detailNormal;
		const parts = [priority, dashboardTaskStatusLabel(item.status)];
		const assignee = item.actor?.trim();
		if (assignee) parts.push(assignee.startsWith("@") ? assignee : `@${assignee}`);
		const due = dashboardTaskDueLabel(item);
		if (due) parts.push(due);
		return parts.filter(Boolean).join(" / ");
	}

	function pageWorkStatusLabel(summary: PageWorkSummary): string {
		if (summary.status === "blocked") return $_("dashboard.pageStatusBlocked");
		if (summary.status === "review") return $_("dashboard.pageStatusReview");
		if (summary.status === "empty") return $_("dashboard.pageStatusEmpty");
		if (summary.status === "ready") return $_("dashboard.pageStatusReady");
		return summary.statusLabel;
	}

	function pageWorkLayerLabel(summary: PageWorkSummary): string {
		return $_("dashboard.textLayerCount", { values: { count: summary.layerCount } });
	}

	function primaryThumbnailKey(): string | null {
		if (!projectStore.project || primaryWorkPageIndex === null || !primaryWorkPage) return null;
		const imageId = getPagePreviewImageId(primaryWorkPage);
		return imageId ? `${projectStore.project.projectId}:${primaryWorkPageIndex}:${imageId}` : null;
	}

	function getRecentThumbnailParams(project: ProjectSummary): SignedAssetSrcParams | null {
		const url = getRecentThumbnailUrl(project);
		if (!url || !project.coverImageId) return null;
		return { projectId: project.projectId, imageId: project.coverImageId, url, purpose: "thumbnail" };
	}

	function recentThumbnailKey(project: ProjectSummary): string | null {
		if (!project.coverImageId) return null;
		return `recent:${project.projectId}:${project.coverImageId}`;
	}

	function getRecentThumbnailUrl(project: ProjectSummary): string | null {
		const key = recentThumbnailKey(project);
		if (!project.coverImageId || !key || thumbnailFailures[key]) return null;
		return buildThumbnailUrl(project.projectId, project.coverImageId, 220, 320);
	}

	function markThumbnailFailed(): void {
		const key = primaryThumbnailKey();
		if (!key) return;
		thumbnailFailures = { ...thumbnailFailures, [key]: true };
	}

	function clearThumbnailFailure(): void {
		const key = primaryThumbnailKey();
		if (!key || !thumbnailFailures[key]) return;
		const nextFailures = { ...thumbnailFailures };
		delete nextFailures[key];
		thumbnailFailures = nextFailures;
	}

	function markRecentThumbnailFailed(project: ProjectSummary): void {
		const key = recentThumbnailKey(project);
		if (!key) return;
		thumbnailFailures = { ...thumbnailFailures, [key]: true };
	}

	function clearRecentThumbnailFailure(project: ProjectSummary): void {
		const key = recentThumbnailKey(project);
		if (!key || !thumbnailFailures[key]) return;
		const nextFailures = { ...thumbnailFailures };
		delete nextFailures[key];
		thumbnailFailures = nextFailures;
	}

	function pushWorkspaceUrl(view = editorUiStore.workspaceView): void {
		const href = hrefForWorkspaceView(
			view,
			projectStore.project?.projectId,
			projectStore.project?.currentPage,
		);
		queueWorkspaceHrefNavigation(href);
	}

	async function ensurePageSelected(pageIndex: number): Promise<boolean> {
		if (!projectStore.project) return false;
		if (projectStore.project.currentPage === pageIndex) return true;
		const pageOpened = await projectStore.goToPage(pageIndex, editorStore.editor);
		if (!pageOpened) return false;
		editorStore.refreshTextLayers();
		return true;
	}

	async function openPage(pageIndex: number): Promise<void> {
		if (projectStore.project && !projectStore.project.pages[pageIndex]) {
			projectStore.setStatusMsg($_("dashboard.workPageGone", { values: { page: pageIndex + 1 } }));
			return;
		}
		const pageOpened = await ensurePageSelected(pageIndex);
		if (!pageOpened) return;
		editorUiStore.openEditor();
		pushWorkspaceUrl("editor");
	}

	async function openRecentProject(projectId: string): Promise<void> {
		const opened = await projectStore.openProject(projectId, editorStore.editor);
		if (opened === false) return;
		if (!projectStore.project?.pages.length) {
			projectStore.setStatusMsg($_("dashboard.chapterNoPagesEdit"));
			editorUiStore.openChapterSetup({
				mode: "fill-existing-zero-page",
				projectId,
			});
			editorUiStore.openLibrary();
			pushWorkspaceUrl("library");
			return;
		}
		editorStore.refreshTextLayers();
		editorUiStore.openEditor({
			source: "library",
			projectId,
			titleKey: null,
			title: projectStore.project.name,
			chapterLabel: projectStore.project.name,
			language: projectStore.project.targetLang,
			reason: $_("dashboard.reasonContinueLatest"),
		});
		pushWorkspaceUrl("editor");
	}

	async function openRecentProjectImport(projectId: string): Promise<void> {
		const opened = await projectStore.openProject(projectId, editorStore.editor);
		if (opened === false) return;
		if (!projectStore.project?.pages.length) {
			projectStore.setStatusMsg($_("dashboard.chapterNoPagesImport"));
			editorUiStore.openChapterSetup({
				mode: "fill-existing-zero-page",
				projectId,
				completionView: "import-review",
			});
			editorUiStore.openLibrary();
			pushWorkspaceUrl("library");
			return;
		}
		editorStore.refreshTextLayers();
		editorUiStore.openImportReview();
		pushWorkspaceUrl("import");
	}

	function openDashboardEditor(): void {
		editorUiStore.setRightPanelMode("layers");
		editorUiStore.openEditor();
		pushWorkspaceUrl("editor");
	}

	function openLibrary(): void {
		editorUiStore.openLibrary();
		pushWorkspaceUrl("library");
	}

	function openBillingSettings(): void {
		queueWorkspaceHrefNavigation("/settings/billing");
	}

	// First-run guard: the create-chapter CTA must NOT open setup (and thus create a
	// project) before the workspace context resolves — otherwise the new chapter is
	// stamped from a stale/empty current-workspace id and lands UNSCOPED (orphan /
	// personal), invisible to every workspace dashboard. When the workspace isn't
	// resolved yet we block the CTA with a clear "setting up your workspace…" status and
	// kick a workspace reload to retry, instead of creating an orphan. Once resolved, the
	// store has persisted the live workspace id (workspacesStore.load → writeStoredWorkspaceId),
	// so the chapter-setup create reads it back and is correctly workspace-scoped.
	let workspaceReady = $derived(Boolean(workspacesStore.currentWorkspace?.workspaceId));

	// Retry the cross-project workspace-home aggregate after a failed load. The store's
	// load() coalesces concurrent calls and re-uses the current workspace id when omitted,
	// so this is safe to call from any dashboard error state without a full page reload.
	function retryHomeLoad(): void {
		void workspaceHomeStore.load(workspacesStore.currentWorkspace?.workspaceId ?? null);
	}

	function createFirstChapter(): void {
		if (!workspaceReady) {
			projectStore.setStatusMsg(copy.workspaceResolving);
			// Retry resolving the workspace so the user can simply click again once ready.
			void workspacesStore.load().catch(() => undefined);
			return;
		}
		editorUiStore.openChapterSetup();
	}

	function openChapterPages(): void {
		if (!projectStore.project) return;
		editorUiStore.openPages();
		pushWorkspaceUrl("pages");
	}

	function openTasksPage(): void {
		editorUiStore.openTasks();
		queueWorkspaceHrefNavigation("/tasks");
	}

	function resolveWorkBoardProjectId(projectId?: string | null): string | null {
		const requestedProjectId = projectId?.trim();
		return requestedProjectId || projectStore.project?.projectId || workspaceHomeStore.recentProject?.projectId || null;
	}

	function canOpenWorkBoard(projectId?: string | null): boolean {
		return resolveWorkBoardProjectId(projectId) !== null;
	}

	async function openWorkBoard(projectId?: string | null): Promise<void> {
		// Workspace-home rows are cross-project. When no chapter is open yet, open the
		// widget's own project first, falling back to the aggregate's latest project so
		// dashboard controls never become silent no-ops.
		const targetProjectId = resolveWorkBoardProjectId(projectId);
		if (!targetProjectId) return;
		if (projectStore.project?.projectId !== targetProjectId) {
			const opened = await projectStore.openProject(targetProjectId, editorStore.editor);
			if (opened === false) return;
		}
		editorUiStore.openWorkBoard();
		queueWorkspaceHrefNavigation(hrefForWorkspaceView("work", projectStore.project?.projectId ?? targetProjectId));
	}

	function inboxItemSourceExists(item: WorkInboxItem): boolean {
		if (item.kind === "comment") return projectStore.comments.some((comment) => comment.id === item.sourceId);
		if (item.kind === "ai_marker") return projectStore.aiReviewMarkers.some((marker) => marker.id === item.sourceId);
		if (item.kind === "workflow_task" || item.kind === "review_task") return projectStore.tasks.some((task) => task.id === item.sourceId);
		if (item.kind === "qc") return projectStore.qcReport.issues.some((issue) => issue.id === item.sourceId);
		return true;
	}

	function inboxItemMissingSourceStatus(item: WorkInboxItem): string {
		if (item.kind === "comment") return $_("dashboard.noteGone");
		if (item.kind === "ai_marker") return $_("dashboard.aiResultGone");
		if (item.kind === "workflow_task" || item.kind === "review_task") return $_("dashboard.taskGone");
		if (item.kind === "qc") return $_("dashboard.qcItemCleared");
		return $_("dashboard.workTargetGone");
	}

	function selectInboxMissingPageRepair(item: WorkInboxItem): boolean {
		if (item.kind === "comment") {
			projectStore.selectProjectComment(item.sourceId);
			projectStore.selectWorkflowTask(null);
			projectStore.selectAiReviewMarker(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("dashboard.notePageGoneRepair"));
			return true;
		}
		if (item.kind === "workflow_task" || item.kind === "review_task") {
			projectStore.selectWorkflowTask(item.sourceId);
			projectStore.selectAiReviewMarker(null);
			projectStore.selectProjectComment(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("dashboard.taskPageGoneRepair"));
			return true;
		}
		if (item.kind === "ai_marker") {
			projectStore.selectAiReviewMarker(item.sourceId);
			projectStore.selectWorkflowTask(null);
			projectStore.selectProjectComment(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("dashboard.aiResultPageGoneRepair"));
			return true;
		}
		projectStore.setStatusMsg(item.pageIndex === undefined ? $_("dashboard.workPageGoneNoIndex") : $_("dashboard.workPageGone", { values: { page: item.pageIndex + 1 } }));
		return false;
	}

	function canvasPageForInboxItem(item: WorkInboxItem): number | undefined {
		if (projectStore.project && item.pageIndex !== undefined && projectStore.project.pages[item.pageIndex]) return item.pageIndex;
		if (projectStore.project?.pages[projectStore.project.currentPage]) return projectStore.project.currentPage;
		return undefined;
	}

	function selectMissingPageTaskRepair(taskId: string | null): boolean {
		if (!taskId) return false;
		projectStore.selectWorkflowTask(taskId);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectProjectComment(null);
		projectStore.selectQcIssue(null);
		editorUiStore.setRightPanelMode("work");
		projectStore.setStatusMsg($_("dashboard.taskPageGoneRepair"));
		return true;
	}

	function workspaceItemSourceExists(item: WorkspaceFeedItem): boolean {
		if (item.kind === "comment") return projectStore.comments.some((comment) => comment.id === item.sourceId);
		if (item.kind === "ai_marker") return projectStore.aiReviewMarkers.some((marker) => marker.id === item.sourceId);
		if (item.kind === "task") return projectStore.tasks.some((task) => task.id === item.sourceId);
		if (item.kind === "review_decision") return projectStore.reviewDecisions.some((decision) => decision.id === item.sourceId);
		return true;
	}

	function workspaceItemMissingSourceStatus(item: WorkspaceFeedItem): string {
		if (item.kind === "comment") return $_("dashboard.noteGone");
		if (item.kind === "ai_marker") return $_("dashboard.aiResultGone");
		if (item.kind === "task") return $_("dashboard.taskGone");
		if (item.kind === "review_decision") return $_("dashboard.reviewResultGone");
		return $_("dashboard.itemGone");
	}

	function selectWorkspaceMissingPageRepair(item: WorkspaceFeedItem): boolean {
		if (item.kind === "comment") {
			projectStore.selectProjectComment(item.sourceId);
			projectStore.selectWorkflowTask(null);
			projectStore.selectAiReviewMarker(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("dashboard.notePageGoneRepair"));
			return true;
		}
		if (item.kind === "task") {
			projectStore.selectWorkflowTask(item.sourceId);
			projectStore.selectAiReviewMarker(null);
			projectStore.selectProjectComment(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("dashboard.taskPageGoneRepair"));
			return true;
		}
		if (item.kind === "review_decision") {
			projectStore.selectReviewDecision(item.sourceId);
			projectStore.selectWorkflowTask(null);
			projectStore.selectAiReviewMarker(null);
			projectStore.selectProjectComment(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("dashboard.reviewResultPageGoneRepair"));
			return true;
		}
		if (item.kind === "ai_marker") {
			projectStore.selectAiReviewMarker(item.sourceId);
			projectStore.selectWorkflowTask(null);
			projectStore.selectProjectComment(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("dashboard.aiResultPageGoneRepair"));
			return true;
		}
		projectStore.setStatusMsg(item.pageIndex === undefined ? $_("dashboard.itemPageGoneNoIndex") : $_("dashboard.itemPageGone", { values: { page: item.pageIndex + 1 } }));
		return false;
	}

	async function openActivityItem(item: WorkspaceFeedItem): Promise<void> {
		if (!projectStore.project) return;
		if (!workspaceItemSourceExists(item)) {
			projectStore.setStatusMsg(workspaceItemMissingSourceStatus(item));
			return;
		}
		if (item.kind === "export_run") {
			openChapterPages();
			return;
		}
		if (item.pageIndex !== undefined && !projectStore.project.pages[item.pageIndex]) {
			if (selectWorkspaceMissingPageRepair(item)) {
				editorUiStore.openEditor();
				pushWorkspaceUrl("editor");
			}
			return;
		}
		if (item.pageIndex !== undefined) {
			await openPage(item.pageIndex);
			return;
		}
		openWorkPanel();
	}

	async function selectInboxItem(item: WorkInboxItem): Promise<boolean> {
		if (!inboxItemSourceExists(item)) {
			projectStore.setStatusMsg(inboxItemMissingSourceStatus(item));
			return false;
		}
		if (projectStore.project && item.pageIndex !== undefined && !projectStore.project.pages[item.pageIndex]) {
			return selectInboxMissingPageRepair(item);
		}
		if (item.pageIndex !== undefined && projectStore.project?.currentPage !== item.pageIndex) {
			const pageOpened = await ensurePageSelected(item.pageIndex);
			if (!pageOpened) return false;
		}

		projectStore.selectAiReviewMarker(item.kind === "ai_marker" ? item.sourceId : null);
		projectStore.selectProjectComment(item.kind === "comment" ? item.sourceId : null);
		projectStore.selectWorkflowTask(
			item.kind === "workflow_task" || item.kind === "review_task" ? item.sourceId : null,
		);
		projectStore.selectQcIssue(item.kind === "qc" ? item.sourceId : null);
		editorUiStore.setRightPanelMode("work");
		return true;
	}

	async function openInboxItemInEditor(item: WorkInboxItem): Promise<void> {
		const selected = await selectInboxItem(item);
		if (!selected) return;
		editorUiStore.openEditor();
		const targetPage = canvasPageForInboxItem(item);
		const href = hrefForWorkspaceView("editor", projectStore.project?.projectId, targetPage);
		queueWorkspaceHrefNavigation(href);
	}

	async function openAssignedGroup(group: WorkspaceAssignedWorkGroup): Promise<void> {
		if (!projectStore.project || group.firstOpenPageIndex === null) return;
		if (!projectStore.project.pages[group.firstOpenPageIndex]) {
			if (selectMissingPageTaskRepair(group.firstOpenTaskId)) {
				editorUiStore.openEditor();
				pushWorkspaceUrl("editor");
			}
			return;
		}
		const pageOpened = await ensurePageSelected(group.firstOpenPageIndex);
		if (!pageOpened) return;
		projectStore.selectWorkflowTask(group.firstOpenTaskId);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectProjectComment(null);
		projectStore.selectQcIssue(null);
		editorUiStore.setRightPanelMode("work");
		editorUiStore.openEditor();
		pushWorkspaceUrl("editor");
	}

	function openWorkPanel(): void {
		editorUiStore.setRightPanelMode("work");
		editorUiStore.openEditor();
		pushWorkspaceUrl("editor");
	}

	function refreshRecentProjects(): void {
		void projectStore.loadRecentProjects();
	}

	function handleProjectTitleKeydown(event: KeyboardEvent): void {
		const input = event.currentTarget as HTMLInputElement;
		if (event.key === "Enter") {
			event.preventDefault();
			input.blur();
		} else if (event.key === "Escape") {
			input.value = projectStore.project?.name ?? "";
			input.blur();
		}
	}

	function renameProjectFromInput(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const currentName = projectStore.project?.name ?? "";
		const nextName = input.value.trim();
		if (!nextName || nextName === currentName) {
			input.value = currentName;
			return;
		}
		void projectStore.renameCurrentProject(nextName).then((renamed) => {
			if (!renamed) input.value = projectStore.project?.name ?? currentName;
		});
	}

	// ── Reskin helpers (presentational only; no new data sources) ──
	type DashboardPipelineStage = {
		id: string;
		labelTh: string;
		labelEn: string;
		dot: string;
		value: string;
		caption: string;
		captionTone: "green" | "violet" | "amber" | "faint";
		fillStyle: string;
		percent: number;
		active: boolean;
	};

	// `labelTh` is a never-rendered i18n FALLBACK only (the UI always shows
	// `pipelineStageLabel()` = `msg(labelKey, …)`, whose `dashboard.stage*` keys exist
	// in every locale incl. th). Its fallback string is the English label so no raw
	// Thai ships here; the th locale still renders the original Thai via the key.
	const PIPELINE_STAGE_META: Record<string, { labelTh: string; labelEn: string; labelKey: string }> = {
		clean: { labelTh: "Clean", labelEn: "Clean", labelKey: "dashboard.stageClean" },
		translate: { labelTh: "Translate", labelEn: "Translate", labelKey: "dashboard.stageTranslate" },
		typeset: { labelTh: "Typeset", labelEn: "Typeset", labelKey: "dashboard.stageTypeset" },
		review: { labelTh: "Quality", labelEn: "Quality", labelKey: "dashboard.stageQuality" },
	};

	// Localized primary label for a pipeline stage tile (the atom also shows the
	// English slug as a faint secondary, matching the bilingual section-band pattern).
	function pipelineStageLabel(stageId: string): string {
		const meta = PIPELINE_STAGE_META[stageId];
		return meta ? msg(meta.labelKey, meta.labelTh) : stageId;
	}

	// ── HERO — WORKSPACE-SCOPED + STABLE (keystone invariant) ──
	// The hero is the dashboard's "resume where you left off" card. It MUST be a
	// pure function of the workspace-home AGGREGATE (the stable, cross-project
	// slice that is independent of the open chapter) — NEVER of projectStore.project.
	// Opening/closing a chapter changes the right-panel inspector, not this hero.
	let heroProject = $derived(workspaceHomeStore.recentProject);
	let heroStoryTitle = $derived(
		heroProject
			? heroProjectStoryLabel(heroProject)
			: copy.noProjectTitle,
	);
	let heroLangCode = $derived((heroProject?.targetLang ?? "th").toUpperCase());
	// Real source language from the aggregate's recent project, with a neutral
	// fallback when the backend omits it — never a hard-coded "JP".
	let heroSourceLangCode = $derived(
		(heroProject?.sourceLang ?? "").trim().toUpperCase() || msg("dashboard.sourceLangFallback", "ต้นทาง"),
	);
	let heroPageCount = $derived(heroProject?.pageCount ?? 0);
	let heroChapterLabel = $derived(
		heroProject
			? heroProjectChapterContextLabel(heroProject)
			: copy.noProjectCopy,
	);
	let heroHasWork = $derived(Boolean(heroProject));
	let heroCoverSeed = $derived(heroProject?.projectId ?? "studio-nightfall");
	// Overall localization progress — ONLY from the aggregate's honest, server-derived
	// completion signal (share of pages whose latest review decision is approved).
	// `heroHasRealProgress` gates the meter so the UI shows an honest "unknown"
	// state instead of a fabricated percentage when no page has been reviewed yet.
	let heroHasRealProgress = $derived(Boolean(heroProject?.hasProgress));
	let heroOverallPercent = $derived(heroProject?.progressPercent ?? 0);

	// ── QUIET METRICS ROW — WORKSPACE-SCOPED (keystone invariant) ──
	// The "% localized" and "target languages" tiles are pure functions of the
	// workspace-home AGGREGATE, NEVER projectStore.project. Opening/closing a chapter
	// changes the right-panel inspector, not these tiles. `% localized` mirrors the
	// hero's honest progress gate (no fabricated 0% before any page is reviewed);
	// `target languages` counts the DISTINCT target langs across every visible project
	// (a real workspace metric), so it no longer collapses to "1 / the open chapter".
	let metricsHasWork = $derived(heroHasWork);
	let metricsHasRealProgress = $derived(heroHasRealProgress);
	let metricsLocalizedPercent = $derived(heroOverallPercent);
	let metricsTargetLangs = $derived(workspaceHomeStore.targetLangs);
	let metricsTargetLangCount = $derived(metricsTargetLangs.length);
	let metricsHasTargetLangs = $derived(metricsTargetLangCount > 0);
	// Show the count's headline code: the hero's target lang when it is in the set,
	// otherwise the first (sorted) workspace target lang. Never the open chapter.
	// Only rendered when metricsHasTargetLangs, so the `?? heroLangCode` is just a
	// type-narrowing fallback that never actually surfaces.
	let metricsTargetLangCode = $derived(
		(metricsTargetLangs.includes(heroLangCode) ? heroLangCode : metricsTargetLangs[0]) ?? heroLangCode,
	);

	function greetingLabel(): string {
		const hour = new Date().getHours();
		if (hour < 12) return copy.greetingMorning;
		if (hour < 17) return copy.greetingAfternoon;
		return copy.greetingEvening;
	}

	function pipelineStageFromLane(lane: { id: string; label: string; doneCount: number; totalCount: number; openCount: number; overdueCount: number }): DashboardPipelineStage {
		const meta = PIPELINE_STAGE_META[lane.id] ?? { labelTh: lane.label, labelEn: lane.label };
		const total = Math.max(0, lane.totalCount);
		const done = Math.max(0, lane.doneCount);
		const percent = total > 0 ? Math.round((done / total) * 100) : 0;
		const complete = total > 0 && done >= total;
		const active = lane.openCount > 0 && !complete;
		let caption = copy.pipelineNotStarted;
		let captionTone: DashboardPipelineStage["captionTone"] = "faint";
		let dot = "bg-ws-faint";
		let fillStyle = "width:0%;background:var(--color-ws-faint)";
		if (complete) {
			caption = copy.pipelineDone;
			captionTone = "green";
			dot = "bg-ws-green";
			fillStyle = "width:100%;background:var(--color-ws-green)";
		} else if (lane.overdueCount > 0) {
			caption = copy.pipelineOverdue;
			captionTone = "amber";
			dot = "bg-ws-amber";
			fillStyle = `width:${Math.max(8, percent)}%;background:var(--color-ws-amber)`;
		} else if (active) {
			caption = copy.pipelineInProgress;
			captionTone = "violet";
			dot = "bg-ws-violet";
			fillStyle = `width:${Math.max(8, percent)}%;background:linear-gradient(90deg,var(--color-ws-violet),var(--color-ws-accent))`;
		} else if (lane.openCount > 0) {
			caption = copy.pipelineAwaitingReview;
			captionTone = "amber";
			dot = "bg-ws-amber";
			fillStyle = `width:${Math.max(8, percent)}%;background:var(--color-ws-amber)`;
		}
		return {
			id: lane.id,
			labelTh: meta.labelTh,
			labelEn: meta.labelEn,
			dot,
			value: total > 0 ? `${done}/${total}` : `${lane.openCount}`,
			caption,
			captionTone,
			fillStyle,
			percent,
			active,
		};
	}

	let dashboardPipelineStages = $derived(buildDashboardPipelineStages());

	function buildDashboardPipelineStages(): DashboardPipelineStage[] {
		// KEYSTONE: the production pipeline reflects ALL tasks across every project
		// the member can see (the aggregate's server-side per-stage counts), not just
		// the open chapter. This is what makes the pipeline meaningful with no chapter
		// open — and it never re-couples to the open chapter via a fallback.
		if (homeLoaded) {
			const byStage = new Map(workspaceHomeStore.pipelineByStage.map((entry) => [entry.stage, entry]));
			return (["clean", "translate", "typeset", "review"] as const).map((id) => {
				const entry = byStage.get(id);
				return pipelineStageFromLane({
					id,
					label: id,
					doneCount: entry?.done ?? 0,
					totalCount: entry?.total ?? 0,
					openCount: entry?.open ?? 0,
					overdueCount: 0,
				});
			});
		}
		// Aggregate not loaded (loading or error) — show the real four stages at zero
		// rather than the open chapter's lanes or fabricated counts. The surrounding
		// section renders the loading/error state.
		return ["clean", "translate", "typeset", "review"].map((id) => {
			const meta = PIPELINE_STAGE_META[id] ?? { labelTh: id, labelEn: id };
			return {
				id,
				labelTh: meta.labelTh,
				labelEn: meta.labelEn,
				dot: "bg-ws-faint",
				value: "0",
				caption: copy.pipelineNotStarted,
				captionTone: "faint" as const,
				fillStyle: "width:0%;background:var(--color-ws-faint)",
				percent: 0,
				active: false,
			};
		});
	}

	// Real per-stage counts for the analytics charts (done/total/open), preserving
	// the raw numbers the presentational pipeline tiles flatten into "done/total".
	// Sourced ONLY from the aggregate (never the open chapter's lanes); until it
	// loads we emit the four stages at zero so the analytics section shows an honest
	// empty/loading state, never invented throughput and never per-chapter data.
	let analyticsPipelineStages = $derived<PipelineStageInput[]>(
		homeLoaded
			? (["clean", "translate", "typeset", "review"] as const).map((id) => {
					const entry = workspaceHomeStore.pipelineByStage.find((p) => p.stage === id);
					return {
						id,
						// `labelTh` is the chart's display label; feed the LOCALIZED stage label
						// so the analytics pipeline bars are not Thai for EN/JA/KO/ZH.
						labelTh: pipelineStageLabel(id),
						doneCount: entry?.done ?? 0,
						totalCount: entry?.total ?? 0,
						openCount: entry?.open ?? 0,
					};
				})
			: ["clean", "translate", "typeset", "review"].map((id) => ({
					id,
					labelTh: pipelineStageLabel(id),
					doneCount: 0,
					totalCount: 0,
					openCount: 0,
				})),
	);

	const PIPELINE_CAPTION_CLASS: Record<DashboardPipelineStage["captionTone"], string> = {
		green: "text-ws-green",
		violet: "text-ws-violet",
		amber: "text-ws-amber",
		faint: "text-ws-faint",
	};

	// ── Atom-prop adapters (presentational only; no new data sources) ──
	// Map the existing pipeline caption tone onto the PipelineStage atom's dot/fill tone.
	const PIPELINE_STAGE_TONE: Record<DashboardPipelineStage["captionTone"], PipelineTone> = {
		green: "green",
		violet: "violet",
		amber: "amber",
		faint: "faint",
	};

	function pipelineStageCount(stage: DashboardPipelineStage): number {
		// `value` is either "done/total" or a single open count — surface the leading number.
		const lead = stage.value.split("/")[0]?.replace(/[^\d.-]/g, "");
		const parsed = Number(lead);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	function pipelineStageCaption(stage: DashboardPipelineStage): string {
		// Preserve the "done/total" denominator in the caption since the atom shows one number.
		return stage.value.includes("/") ? `${stage.caption} · ${stage.value}` : stage.caption;
	}

	// Map an inbox item to the AttentionRow atom's semantic tone.
	function attentionRowTone(item: WorkInboxItem): AttentionTone {
		if (item.severity === "error" || item.overdue || item.priority === "urgent") return "urgent";
		if (item.kind === "ai_marker") return "ai";
		if (item.kind === "comment") return "mention";
		if (item.kind === "review_task" || item.severity === "warning" || item.priority === "high") return "review";
		return "ai";
	}

	// Tone for a cross-project aggregate attention item (a WorkspaceFeedItem with
	// project context). Mirrors attentionRowTone's severity/kind mapping.
	function feedAttentionRowTone(item: WorkspaceFeedItem): AttentionTone {
		if (item.severity === "error" || item.dueState === "overdue" || item.priority === "urgent") return "urgent";
		if (item.kind === "ai_marker") return "ai";
		if (item.kind === "comment" || item.kind === "message") return "mention";
		if (item.kind === "task" || item.kind === "review_decision" || item.kind === "version_review" || item.severity === "warning") return "review";
		return "ai";
	}

	// Per-target-language coverage chips for the hero (mirrors the inline language meters).
	// Only the real open/recent project's actual source→target language is shown — no
	// fabricated extra language pair (was a hard-coded JP→EN 40% demo chip) and no
	// invented completion percentage (0 until real progress is known).
	let heroLanguagePairs = $derived(
		heroHasWork
			? [{ from: heroSourceLangCode, to: heroLangCode, pct: heroHasRealProgress ? heroOverallPercent : 0 }]
			: [],
	);
	// The hero's optional attention chip — sourced from the STABLE cross-project
	// aggregate (workspaceAttentionFeed), NOT projectStore.workInbox, so the chip
	// (and thus the whole hero) is unchanged by opening/closing a chapter.
	let heroAttentionItem = $derived(workspaceAttentionFeed[0] ?? null);
	// Stable hero cover: built ONLY from the aggregate's recentProject (projectId +
	// coverImageId, which the workspace-home aggregate carries from the project's
	// own state). It NEVER reads projectStore or the recent-projects summary list,
	// so opening/closing a chapter (or any projectStore change) cannot move the hero
	// cover. Falls back to the seeded DefaultCover when the project has no cover.
	let heroCoverKey = $derived(
		heroProject?.coverImageId ? `hero:${heroProject.projectId}:${heroProject.coverImageId}` : null,
	);
	let heroCoverUrl = $derived(
		heroProject?.coverImageId && heroCoverKey && !thumbnailFailures[heroCoverKey]
			? buildThumbnailUrl(heroProject.projectId, heroProject.coverImageId, 220, 320)
			: null,
	);
	let heroCoverParams = $derived<SignedAssetSrcParams | null>(
		heroProject?.coverImageId && heroCoverUrl
			? { projectId: heroProject.projectId, imageId: heroProject.coverImageId, url: heroCoverUrl, purpose: "thumbnail" }
			: null,
	);
</script>

{#if editorUiStore.workspaceView === "dashboard"}
	<section class="ws-surface workspace-dashboard-shell ws-dash" aria-label="Workspace dashboard">
		<div class="ws-surface-inner ws-dash-inner">

			<WorkspaceSuspendedBanner />

			{#snippet dashboardSearchPanel()}
				{#if normalizedDashboardSearch}
					<div class="dashboard-search-panel" role="region" aria-label={copy.ariaSearchPanel}>
						<div class="dashboard-search-summary" role="status">
							<span>{$_("dashboard.searchFor", { values: { query: dashboardSearchQuery.trim() } })}</span>
							<strong>{$_("dashboard.searchResults", { values: { count: dashboardSearchResults.length } })}</strong>
						</div>
						{#if visibleDashboardSearchResults.length > 0}
							<div class="dashboard-search-list">
								{#each visibleDashboardSearchResults as result (result.id)}
									<button type="button" class="dashboard-search-result {result.accent}" onclick={() => result.open()}>
										<span class="search-result-type">{result.type}</span>
										<span class="search-result-main">
											<strong>{result.title}</strong>
											<small>{result.subtitle}</small>
										</span>
										<em>{result.detail}</em>
									</button>
								{/each}
							</div>
						{:else}
							<div class="dashboard-search-empty">
								<strong>{copy.searchNoMatch}</strong>
								<span>{copy.searchHint}</span>
							</div>
						{/if}
					</div>
				{/if}
			{/snippet}

			<!-- Shared retry control for the per-widget aggregate-load error states. Each
			     widget reads the SAME workspace-home aggregate, so a single load() re-fetches
			     them all; the user recovers without a full page reload. -->
			{#snippet dashboardRetryButton()}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 h-9 px-3 rounded-ws-ctrl text-[12px] font-semibold text-ws-ink ws-btn-ghost disabled:opacity-70 disabled:cursor-progress"
					onclick={retryHomeLoad}
					disabled={workspaceHomeStore.loading}
					data-testid="dashboard-widget-retry"
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3.5 12a8.5 8.5 0 1 1 2.49 6.01M3.5 18v-4h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
					<span>{workspaceHomeStore.loading ? copy.homeRetrying : copy.homeRetry}</span>
				</button>
			{/snippet}

			<WorkspaceTopUtilityBar
				bind:value={dashboardSearchQuery}
				onKeydown={handleDashboardSearchKeydown}
				onClear={clearDashboardSearch}
				searchPanel={dashboardSearchPanel}
			/>

			<!-- ===== 1. GREETING + HERO CONTINUE ===== -->
			<section class="ws-block" aria-label={copy.ariaMainDashboard} data-tour="hero">
				<div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
					<div class="min-w-0">
						<h1 class="text-[clamp(19px,2.4vw,23px)] font-semibold tracking-tight truncate text-ws-ink">
							{greetingLabel()}{#if dashboardUserName}, {dashboardUserName}{/if} <span class="ws-text-grad">✦</span>
						</h1>
						<p class="ws-num text-[13.5px] text-ws-text mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
							<span class="inline-flex items-center gap-1">{$_("dashboard.dueTodayLine", { values: { count: workspaceHomeStore.counts.dueToday } })}</span>
							<span aria-hidden="true">·</span>
							<span class="inline-flex items-center gap-1">{$_("dashboard.aiReviewLine", { values: { count: workspaceHomeStore.counts.aiJobs } })}</span>
							{#if heroStoragePctLabel}
								<span aria-hidden="true">·</span>
								<span class={storageBand === "ok" ? "text-ws-text" : "text-ws-amber"}>{heroStoragePctLabel}</span>
							{/if}
						</p>
					</div>
					<span class="ws-num hidden sm:inline-flex items-center gap-2 text-[12px] text-ws-text px-3 py-1.5 rounded-full ws-panel-quiet whitespace-nowrap shrink-0">
						<span class="ws-dot bg-ws-green"></span> {dashboardTeamOnlineLabel}
					</span>
				</div>

				{#if homeError}
					<!-- ERROR HERO — a transient backend 500 / network drop. We must NEVER
					     fall through to the first-run "create your first story" hero here:
					     to a returning paying user that reads as "my work vanished". Show an
					     honest error with a RETRY that re-fetches the aggregate in place. -->
					<div class="ws-panel rounded-ws p-[clamp(20px,2.4vw,30px)] flex flex-col md:flex-row md:items-center gap-5 overflow-hidden relative" role="alert" data-testid="dashboard-home-error">
						<div class="dashboard-hero-glow dashboard-hero-glow-error absolute -right-24 -top-24 w-72 h-72 rounded-full pointer-events-none"></div>
						<div class="flex-1 min-w-0 relative">
							<h2 class="text-[clamp(18px,2.2vw,22px)] font-semibold leading-snug text-ws-rose">{copy.homeErrorTitle}</h2>
							<p class="text-[13.5px] text-ws-text mt-1.5 max-w-[460px]">{copy.homeErrorCopy}</p>
							<p class="ws-num text-[11.5px] text-ws-faint mt-1 max-w-[460px] truncate" title={homeError}>{homeError}</p>
						</div>
						<div class="shrink-0 relative">
							<button
								type="button"
								class="ws-grad-primary dashboard-primary-action relative h-11 px-6 rounded-ws-card flex items-center gap-2 text-[14.5px] font-semibold text-ws-ink w-full md:w-auto justify-center disabled:opacity-70 disabled:cursor-progress"
								onclick={retryHomeLoad}
								disabled={workspaceHomeStore.loading}
								data-testid="dashboard-home-retry"
							>
								<span>{workspaceHomeStore.loading ? copy.homeRetrying : copy.homeRetry}</span>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3.5 12a8.5 8.5 0 1 1 2.49 6.01M3.5 18v-4h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
							</button>
						</div>
					</div>
				{:else if homeLoading}
					<!-- LOADING HERO — the aggregate is in flight on first load. A skeleton
					     placeholder so a returning user never flashes the first-run hero
					     (or zeros) before the real work arrives. -->
					<div class="ws-panel rounded-ws p-[clamp(20px,2.4vw,30px)] flex flex-col md:flex-row md:items-center gap-5 overflow-hidden relative animate-pulse" aria-busy="true" aria-label={copy.homeLoadingTitle} data-testid="dashboard-home-loading">
						<div class="dashboard-hero-glow absolute -right-24 -top-24 w-72 h-72 rounded-full pointer-events-none"></div>
						<div class="shrink-0 w-[112px] aspect-[3/4] rounded-ws bg-ws-line/15"></div>
						<div class="flex-1 min-w-0 relative grid gap-2.5">
							<div class="h-3.5 w-40 rounded bg-ws-line/15"></div>
							<div class="h-5 w-3/4 rounded bg-ws-line/15"></div>
							<div class="h-3 w-1/2 rounded bg-ws-line/15"></div>
							<div class="ws-track h-1.5 mt-2"><div class="ws-fill dashboard-fill-skeleton" style="width:40%"></div></div>
						</div>
						<div class="shrink-0 relative">
							<div class="h-11 w-32 rounded-ws-card bg-ws-line/15"></div>
						</div>
					</div>
				{:else if heroProject}
					<!-- hero card — only when a REAL in-progress project exists. The cover,
					     "continue" eyebrow, source→target chip, and progress meter all
					     describe genuine work; they must NEVER render for a brand-new account. -->
					<div class="ws-panel rounded-ws p-[clamp(16px,2vw,22px)] grid gap-5 items-stretch md:items-center overflow-hidden relative ws-hero-grid">
						<div class="dashboard-hero-glow absolute -right-24 -top-24 w-72 h-72 rounded-full pointer-events-none"></div>

						<!-- page thumbnail (CoverCard atom) -->
						<div class="dashboard-cover-shadow relative shrink-0 w-[112px]">
							<CoverCard seed={heroCoverSeed} imageUrl={heroCoverUrl ?? ""} assetProjectId={heroCoverParams?.projectId ?? ""} assetImageId={heroCoverParams?.imageId ?? ""} assetPurpose="thumbnail" ratio="portrait" class="border border-ws-line/10" />
							{#if heroPageCount > 0}
								<span class="dashboard-thumbnail-badge absolute top-1.5 left-1.5 z-10 text-[9px] font-semibold backdrop-blur px-1.5 py-0.5 rounded-full">{heroLangCode}</span>
							{/if}
						</div>

						<!-- continue info -->
						<div class="flex-1 min-w-0 relative">
							<div class="flex items-center gap-2 mb-1.5 flex-wrap">
								<span class="ws-eyebrow">{copy.continueEyebrow}</span>
								<span class="inline-flex items-center gap-1.5 text-[11px] font-medium text-ws-accent bg-ws-accent/10 border border-ws-accent/20 px-2 py-0.5 rounded-full">{heroSourceLangCode} → {heroLangCode}</span>
								{#if heroAttentionItem}
									<span class="inline-flex items-center gap-1.5 text-[11px] font-medium text-ws-amber bg-ws-amber/10 border border-ws-amber/20 px-2 py-0.5 rounded-full">
										<span class="ws-dot bg-ws-amber"></span> {dashboardFeedTitleLabel(heroAttentionItem)}
									</span>
								{/if}
							</div>
							<h2 class="text-[clamp(16px,2vw,18px)] font-semibold leading-snug truncate text-ws-ink" title={heroStoryTitle}>{heroStoryTitle}</h2>
							<p class="ws-num text-[13.5px] text-ws-text mt-0.5 truncate">{heroChapterLabel}</p>

							<!-- per-target-language status (the moat) — overall meter + coverage chips -->
							<div class="mt-3.5 max-w-[460px]">
								<div class="flex justify-between items-center gap-2 text-[11.5px] mb-1.5">
									<span class="flex items-center gap-1.5 text-ws-ink font-medium min-w-0"><span class="ws-dot dashboard-dot-violet-soft"></span><span class="truncate">{heroSourceLangCode} → {heroLangCode}</span></span>
									{#if heroHasRealProgress}
										<span class="ws-num text-ws-text whitespace-nowrap shrink-0">{copy.overallTotal} <NumberValue value={heroOverallPercent} suffix="%" compact={false} class="text-ws-ink font-medium" /></span>
									{:else}
										<span class="ws-num text-ws-faint whitespace-nowrap shrink-0">{copy.noProgressYet}</span>
									{/if}
								</div>
								<div class="ws-track h-1.5 mb-2.5"><div class="ws-fill dashboard-fill-primary" style={`width:${heroHasRealProgress ? Math.max(2, heroOverallPercent) : 0}%`}></div></div>
								<LanguageCoverageChips pairs={heroLanguagePairs} />
							</div>
						</div>

						<!-- the ONE dominant action — always targets the STABLE workspace hero
						     project (aggregate-sourced), so the CTA is unchanged by opening/
						     closing a chapter. -->
						<div class="shrink-0 relative flex md:flex-col gap-2 md:items-end">
							<button
								type="button"
								class="ws-grad-primary dashboard-primary-action relative h-11 px-6 rounded-ws-card flex items-center gap-2 text-[14.5px] font-semibold text-ws-ink w-full md:w-auto justify-center"
								aria-label={copy.ariaContinueHero}
								onclick={() => openRecentProject(heroProject.projectId)}
							>
								<span>{heroProject.pageCount > 0 ? copy.heroContinue : copy.heroAddPages}</span>
								<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
							</button>
							<span class="ws-num text-[11px] text-ws-faint relative text-center md:text-right whitespace-nowrap">
								{dashboardUpdatedAt(heroProject.updatedAt)}
							</span>
						</div>
					</div>
				{:else}
					<!-- FIRST-RUN EMPTY HERO — a brand-new workspace has no real in-progress
					     work, so we render an HONEST welcome instead of a fabricated "continue"
					     card: no generated cover, no continue eyebrow, no fake language chip,
					     no progress meter. Just a welcoming headline + the create CTA. -->
					<div class="ws-panel rounded-ws p-[clamp(20px,2.4vw,30px)] flex flex-col md:flex-row md:items-center gap-5 overflow-hidden relative" aria-label={copy.ariaFirstStory}>
						<div class="dashboard-hero-glow absolute -right-24 -top-24 w-72 h-72 rounded-full pointer-events-none"></div>
						<div class="flex-1 min-w-0 relative">
							<h2 class="text-[clamp(18px,2.2vw,22px)] font-semibold leading-snug text-ws-ink">{copy.firstRunHeroTitle}</h2>
							<p class="text-[13.5px] text-ws-text mt-1.5 max-w-[460px]">{copy.firstRunHeroCopy}</p>
						</div>
						<div class="shrink-0 relative">
							{#if !workspacesStore.isAdmin}
								<!-- Worker seat in an empty workspace: catalog shaping is the
									lead's job — say so instead of leaving a hollow hero card. -->
								<p class="text-[13px] font-semibold text-ws-text/70 max-w-[260px]">{copy.firstRunWaitForLead}</p>
							{/if}
							<button
								type="button"
								class="ws-grad-primary dashboard-primary-action relative h-11 px-6 rounded-ws-card flex items-center gap-2 text-[14.5px] font-semibold text-ws-ink w-full md:w-auto justify-center disabled:opacity-70 disabled:cursor-progress"
								class:hidden={!workspacesStore.isAdmin}
								onclick={createFirstChapter}
								disabled={!workspaceReady}
								aria-disabled={!workspaceReady}
								aria-live="polite"
							>
								<span>{workspaceReady ? copy.createNewChapter : copy.workspaceResolving}</span>
								<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
							</button>
						</div>
					</div>
				{/if}
			</section>

			<!-- ===== 2. PRODUCTION PIPELINE ===== -->
			<section class="ws-block">
				<SectionBand title="production pipeline" subtitle={copy.bandPipelineSubtitle} class="mb-3">
					{#snippet action()}
						<!-- The production pipeline is WORKSPACE-scoped (aggregate per-stage counts),
						     so "view all" always opens the workspace library — never the single
						     open chapter's pages. This keeps the action independent of the open chapter. -->
						<button type="button" class="h-9 px-2 rounded-ws-ctrl text-[12px] text-ws-text hover:text-ws-ink transition-colors flex items-center gap-1 shrink-0 ws-btn-ghost" onclick={openLibrary}>
							{copy.viewAll} <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
					{/snippet}
				</SectionBand>

				<!-- The per-stage counts are WORKSPACE-aggregate-derived, so on a failed/loading
				     aggregate they are unknown — dim the tiles (error) or pulse them (loading)
				     so the zeros can't read as "real, nothing in the pipeline". The hero card
				     above carries the retry; we don't duplicate it here. -->
				<div
					class="grid gap-3 ws-auto-grid transition-opacity"
					class:opacity-40={homeError}
					class:animate-pulse={homeLoading}
					style="--ws-min:150px"
					aria-busy={homeLoading}
				>
					{#each dashboardPipelineStages as stage (stage.id)}
						<PipelineStage
							label={pipelineStageLabel(stage.id)}
							labelEn={stage.labelEn}
							count={homeError ? 0 : pipelineStageCount(stage)}
							progress={homeError ? 0 : stage.percent}
							tone={homeError ? PIPELINE_STAGE_TONE.faint : PIPELINE_STAGE_TONE[stage.captionTone]}
							active={homeError ? false : stage.active}
							caption={homeError ? copy.homeErrorTitle : pipelineStageCaption(stage)}
						/>
					{/each}
				</div>
			</section>

			<!-- ===== BAND: WORK & ATTENTION ===== -->
			<SectionBand title="work &amp; attention" subtitle={copy.bandWorkAttention} class="pt-2" />

			<!-- ===== 3. TWO COLUMN: MY TASKS / NEEDS ATTENTION ===== -->
			<section class="grid gap-6 ws-two-col">

				<!-- LEFT: my tasks -->
				<div class="ws-panel rounded-ws p-[clamp(16px,1.8vw,20px)]" data-tour="my-tasks">
					<div class="flex items-center justify-between gap-2 mb-4 flex-wrap">
						<h3 class="text-[14px] font-semibold text-ws-ink inline-flex items-baseline gap-1">{copy.myTasks} <span class="ws-num text-ws-faint font-normal text-[12px]">· <NumberValue value={dashboardTaskRows.length} /> {copy.tasksUnit}</span></h3>
						<div class="flex items-center gap-1 text-[11px] ws-panel-quiet rounded-ws-ctrl p-0.5">
							<span class="dashboard-chip-active px-2.5 py-1 rounded-ws-ctrl text-ws-ink font-medium">{copy.filterAll}</span>
							<span class="px-2.5 py-1 rounded-ws-ctrl text-ws-text">{copy.filterToday}</span>
						</div>
					</div>

					<div class="space-y-1 -mx-1.5">
						{#if homeLoading}
							<div class="text-center py-8 text-ws-faint text-[12px]" data-testid="my-tasks-loading">{copy.loadingMyTasks}</div>
						{:else if homeError}
							<div class="flex flex-col items-center gap-2 py-8" data-testid="my-tasks-error">
								<span class="text-ws-rose text-[12px] text-center">{copy.loadMyTasksFailed} · {homeError}</span>
								{@render dashboardRetryButton()}
							</div>
						{:else}
							{#each dashboardTaskRows as row (row.id)}
								<button type="button" class="ws-row-hover w-full flex items-center gap-3 px-1.5 py-2.5 rounded-ws-ctrl text-left bg-transparent border-0 cursor-pointer" onclick={() => openDashboardTaskRow(row)}>
									<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 ws-tag-{row.accent}">{row.lane.split(' · ').slice(-2, -1)[0] ?? row.icon}</span>
									<span class="flex-1 min-w-0">
										<span class="block text-[13.5px] text-ws-ink truncate" title={row.title}>{row.title}</span>
										<span class="ws-num block text-[11.5px] text-ws-faint truncate">{row.lane}</span>
									</span>
									<span class="text-[11.5px] shrink-0 {row.statusClass === 'late' ? 'text-ws-rose' : row.statusClass === 'soon' ? 'text-ws-amber' : 'text-ws-text'}">{row.due}</span>
									<span class="ws-dot shrink-0 ws-dot-{row.accent}"></span>
								</button>
							{:else}
								<div class="text-center py-8 text-ws-faint text-[12px]" data-testid="my-tasks-empty">{copy.myTasksEmpty}</div>
							{/each}
						{/if}
					</div>

						<button type="button" class="ws-num mt-3 w-full min-h-9 flex items-center justify-center gap-1.5 text-[12.5px] text-ws-text hover:text-ws-ink transition-colors pt-3 pb-1 border-t border-ws-line/[0.07] bg-transparent cursor-pointer" onclick={openTasksPage}>
							<span class="inline-flex items-baseline gap-1">{copy.viewAllTasks} <NumberValue value={workspaceHomeStore.myTasks.length} /> {copy.itemsUnit}</span>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
				</div>

				<!-- RIGHT: needs attention (AttentionRow atoms) -->
				<div class="ws-panel rounded-ws p-[clamp(16px,1.8vw,20px)]" data-tour="needs-attention">
					<div class="flex items-center justify-between gap-2 mb-4 flex-wrap">
						<h3 class="text-[14px] font-semibold text-ws-ink inline-flex items-baseline gap-1">{copy.needsAttention} <span class="ws-num text-ws-faint font-normal text-[12px]">· <NumberValue value={workspaceAttentionFeed.length} /> {copy.itemsUnit}</span></h3>
						<span class="ws-num inline-flex items-center gap-1.5 text-[11px] font-medium text-ws-rose bg-ws-rose/10 border border-ws-rose/20 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">
							<span class="ws-dot bg-ws-rose"></span> <NumberValue value={workspaceHomeStore.counts.overdue} /> {copy.urgentUnit}
						</span>
					</div>

					<div class="space-y-1 -mx-1.5">
						{#if homeLoading}
							<div class="text-center py-8 text-ws-faint text-[12px]" data-testid="attention-loading">{copy.loadingAttention}</div>
						{:else if homeError}
							<div class="flex flex-col items-center gap-2 py-8" data-testid="attention-error">
								<span class="text-ws-rose text-[12px] text-center">{copy.loadAttentionFailed} · {homeError}</span>
								{@render dashboardRetryButton()}
							</div>
						{:else if workspaceAttentionFeed.length > 0}
								{#each workspaceAttentionFeed.slice(0, 7) as item (item.id)}
									<AttentionRow
										tone={feedAttentionRowTone(item)}
										text={dashboardFeedTitleLabel(item)}
										meta={[item.projectName, dashboardFeedDetailLabel(item)].filter(Boolean).join(" · ")}
										badge={dashboardFeedKindLabel(item.kind)}
										onclick={() => { void openWorkBoard(item.projectId); }}
									/>
								{/each}
							{:else}
								<div class="text-center py-8 text-ws-faint text-[12px]" data-testid="attention-empty">{copy.attentionEmpty}</div>
							{/if}
						</div>

						<button type="button" class="mt-3 w-full min-h-9 flex items-center justify-center gap-1.5 text-[12.5px] text-ws-text hover:text-ws-ink transition-colors pt-3 pb-1 border-t border-ws-line/[0.07] bg-transparent cursor-pointer" disabled={attentionWorkBoardUnavailable} title={attentionWorkBoardUnavailable ? copy.stepsLocked : undefined} onclick={() => { editorUiStore.openInbox(); queueWorkspaceHrefNavigation(hrefForWorkspaceView("inbox")); }}>
							{copy.openInbox}
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
				</div>
			</section>

			<!-- ===== 3.5 AI JOBS (collapsible) + USAGE ===== -->
			<section class="grid gap-6 ws-two-col">

				<!-- LEFT: AI jobs queue (collapsible) — AiJobCard atoms -->
				<details open class="ws-panel rounded-ws">
					<summary class="ws-summary flex items-center gap-2.5 px-[clamp(16px,1.8vw,20px)] py-4 flex-wrap">
						<svg class="ws-chev text-ws-faint" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
						<span class="w-6 h-6 rounded-ws-ctrl bg-ws-accent/15 border border-ws-accent/25 flex items-center justify-center shrink-0 text-ws-accent">
							<SparkleIcon size={12} />
						</span>
						<h3 class="text-[14px] font-semibold whitespace-nowrap text-ws-ink">{copy.aiJobs} <span class="text-ws-faint font-normal text-[12px] ml-1">· soft queue</span></h3>
						<span class="ws-num inline-flex items-baseline gap-1 text-[11px] font-medium text-ws-amber bg-ws-amber/10 border border-ws-amber/20 px-1.5 py-0.5 rounded-full whitespace-nowrap shrink-0"><NumberValue value={aiQueueAttentionCount} /> {copy.awaitingReviewShort}</span>
							<button type="button" class="ml-auto h-9 px-2 rounded-ws-ctrl text-[12px] text-ws-text hover:text-ws-ink transition-colors shrink-0 ws-btn-ghost" disabled={aiJobsWorkBoardUnavailable} title={aiJobsWorkBoardUnavailable ? copy.stepsLocked : undefined} onclick={() => openWorkBoard(aiJobsWorkBoardProjectId)}>{copy.viewAll}</button>
					</summary>

					<div class="px-[clamp(16px,1.8vw,20px)] pb-5">
						<div class="border-t border-ws-line/[0.07] pt-3.5 space-y-2.5">
							{#if homeLoading}
								<div class="text-center py-8 text-ws-faint text-[12px]" data-testid="ai-jobs-loading">{copy.loadingAiJobs}</div>
							{:else if homeError}
								<div class="flex flex-col items-center gap-2 py-8" data-testid="ai-jobs-error">
									<span class="text-ws-rose text-[12px] text-center">{copy.loadAiJobsFailed} · {homeError}</span>
									{@render dashboardRetryButton()}
								</div>
							{:else if workspaceHomeStore.aiJobs.length > 0}
									<!-- Cross-project AI soft-queue: real markers still needing review across every project. -->
									{#each workspaceHomeStore.aiJobs.slice(0, 6) as job (job.id)}
									<button type="button" class="ws-row-hover w-full flex items-center gap-3 px-1 py-2.5 rounded-ws-ctrl -mx-1 text-left bg-transparent border-0 cursor-pointer" onclick={() => openWorkBoard(job.projectId)}>
										<span class="w-7 h-7 rounded-ws-ctrl bg-ws-amber/10 border border-ws-amber/20 flex items-center justify-center shrink-0 text-ws-amber">
											<SparkleIcon size={13} />
										</span>
										<span class="flex-1 min-w-0">
											<span class="block text-[13px] text-ws-ink truncate">{job.tier} · {copy.pageWord} {job.pageIndex + 1}</span>
											<span class="ws-num block text-[11px] text-ws-faint mt-0.5 truncate">{[job.projectName, aiJobStatusLabel(job.status)].filter(Boolean).join(" · ")}</span>
										</span>
										<span class="text-[12px] text-ws-text flex items-center gap-1 shrink-0">{copy.viewWord} <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
									</button>
								{/each}
							{:else}
								<div class="text-center py-8 text-ws-faint text-[12px]" data-testid="ai-jobs-empty">{copy.aiJobsEmpty}</div>
							{/if}
						</div>
					</div>
				</details>

				<!-- RIGHT: usage (AI credits + storage + plan) -->
				<div class="ws-panel rounded-ws p-[clamp(16px,1.8vw,20px)]">
					<div class="flex items-center justify-between gap-2 mb-3.5 flex-wrap">
						<h3 class="text-[14px] font-semibold text-ws-ink">{copy.usage} <span class="text-ws-faint font-normal text-[12px] ml-1">· usage</span></h3>
						{#if workspacesStore.isAdmin}
						<span class="dashboard-plan-chip inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full ws-grad-primary-soft border">
							<span class="ws-dot dashboard-dot-violet-soft"></span> {dashboardPlanLabel}
						</span>
						{/if}
					</div>

					{#if hasLiveUsage}
						<!-- AI credits — live workspace usage in CREDITS, matches the top-bar meter -->
						<div class="mb-3.5">
							<div class="flex items-center justify-between gap-2 text-[12px] mb-1.5">
								<span class="flex items-center gap-1.5 text-ws-text">
									<SparkleIcon class="text-ws-accent" size={12} fillOpacity={0.9} />
									AI credits
								</span>
								<span class="ws-num text-ws-ink font-medium whitespace-nowrap inline-flex items-baseline gap-1">{#if aiUnlimited}<span>{copy.unlimited}</span>{:else}<span class="text-ws-faint font-normal text-[11px]">{copy.remainingPrefix}</span> <CreditAmount credits={aiRemainingCredits} size="sm" tone="ink" /> <span class="text-ws-faint font-normal">/ {aiLimitThb > 0 ? formatCreditsCompact(aiLimitCredits) : "—"}</span>{/if}</span>
							</div>
							<div class="ws-track h-1.5"><div class="ws-fill dashboard-fill-primary" style={`width:${aiUnlimited ? 100 : aiRemainingPctValue}%`}></div></div>
								<div class="text-[10.5px] text-ws-faint mt-1">{copy.usedPrefix} <CreditAmount credits={aiUsedCredits} size="xs" tone="faint" showLabel /></div>
						</div>

						{#if workspacesStore.isAdmin}
						<!-- storage meter — live workspace usage, matches the sidebar widget -->
						<div>
							<div class="flex items-center justify-between gap-2 text-[12px] mb-1.5">
								<span class="flex items-center gap-1.5 text-ws-text">
									<svg class="text-ws-amber" width="12" height="12" viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="6" rx="7" ry="2.6" stroke="currentColor" stroke-width="1.5"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" stroke="currentColor" stroke-width="1.5"/><path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" stroke="currentColor" stroke-width="1.5"/></svg>
									Storage
								</span>
								<span class="ws-num text-ws-ink font-medium whitespace-nowrap inline-flex items-baseline gap-1"><span class="text-ws-faint font-normal text-[11px]">{copy.remainingPrefix}</span> {formatBytes(storageRemainingBytes)} <span class="text-ws-faint font-normal">/ {storageLimitBytes > 0 ? formatBytes(storageLimitBytes) : "—"}</span></span>
							</div>
							<div class="ws-track h-1.5"><div class={`ws-fill ${storageBand === "ok" ? "dashboard-fill-primary" : "dashboard-fill-warning"}`} style={`width:${Math.min(100, Math.max(0, storageRemainingPct))}%`}></div></div>
								<div class="text-[10.5px] text-ws-faint mt-1">{copy.usedPrefix} {formatBytes(storageUsedBytes)}</div>
							<div class="flex items-center justify-between gap-2 mt-1.5 flex-wrap">
								<span class="ws-num text-[11px] {storageBand === "ok" ? "text-ws-faint" : "text-ws-amber"} whitespace-nowrap">{storageBand === "frozen" ? copy.storageFrozen : storageBand === "warning" ? copy.storageWarning : copy.storageOk}</span>
									<button type="button" class="h-9 px-2 rounded-ws-ctrl text-[11px] text-ws-text hover:text-ws-ink transition-colors whitespace-nowrap shrink-0 ws-btn-ghost" onclick={openBillingSettings}>{copy.addPackUpgrade}</button>
							</div>
						</div>
						{/if}
					{:else}
						<!-- Usage dashboard not loaded yet — honest placeholder, never fabricated numbers. -->
						<div class="text-center py-8 text-ws-faint text-[12px]">{copy.loadingUsage}</div>
					{/if}
				</div>
			</section>

			<!-- ===== 3.6 ANALYTICS (real metrics: pipeline / usage / team performance) ===== -->
			<section class="ws-block">
				<WorkspaceAnalytics pipelineStages={analyticsPipelineStages} hasProject={homeLoaded && !workspaceHomeStore.isEmpty} />
			</section>

			<!-- ===== BAND: STUDIO OVERVIEW ===== -->
			<SectionBand title="studio overview" subtitle={copy.bandStudioOverview} class="pt-2" />

			<!-- ===== 3.7 RECENT SERIES (collapsible quick-open rail with covers) ===== -->
			<details class="group ws-block">
				<summary class="ws-summary flex items-center justify-between gap-2 mb-3 flex-wrap">
					<span class="flex items-center gap-2">
						<svg class="ws-chev text-ws-faint" width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
						<span class="ws-eyebrow">recent series · {copy.recentSeriesEyebrow}</span>
						<span class="ws-num dashboard-chip-muted text-[11px] text-ws-faint px-1.5 py-0.5 rounded-full"><NumberValue value={recentProjects.length} /></span>
					</span>
					<button type="button" class="h-9 px-2 rounded-ws-ctrl text-[12px] text-ws-text group-hover:text-ws-ink transition-colors flex items-center gap-1 shrink-0 ws-btn-ghost" onclick={openLibrary}>
						{copy.openAll} <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
					</button>
				</summary>

				<div class="grid gap-4 ws-auto-grid" style="--ws-min:230px" data-testid="recent-series">
					{#each recentProjects as project (project.projectId)}
						{@const coverUrl = getRecentThumbnailUrl(project)}
						<button type="button" class="ws-row-hover ws-panel rounded-ws p-3 flex gap-3 items-center text-left cursor-pointer" onclick={() => openRecentProject(project.projectId)}>
							<div class="relative shrink-0 w-[58px]">
								{#if coverUrl}
									<CoverCard seed={project.projectId} imageUrl={coverUrl} assetProjectId={getRecentThumbnailParams(project)?.projectId ?? ""} assetImageId={getRecentThumbnailParams(project)?.imageId ?? ""} assetPurpose="thumbnail" ratio="portrait" class="border border-ws-line/10" />
								{:else}
									<CoverCard seed={project.projectId} ratio="portrait" class="border border-ws-line/10" />
								{/if}
							</div>
							<div class="flex-1 min-w-0">
								<p class="text-[13px] font-medium text-ws-ink truncate" title={recentProjectStoryLabel(project)}>{recentProjectStoryLabel(project)}</p>
								<p class="ws-num text-[11px] text-ws-faint mt-0.5 truncate">{getWorkspaceProjectChapterDisplayLabel(project, copy.chapterFallback)}</p>
								<div class="flex items-center gap-1 mt-2">
									<span class="text-[10px] font-medium text-ws-accent bg-ws-accent/10 border border-ws-accent/20 px-1.5 py-px rounded-full">{project.targetLang.toUpperCase()}</span>
								</div>
							</div>
						</button>
					{/each}
				</div>
			</details>

			<!-- ===== 4. TEAM ACTIVITY (collapsible) ===== -->
			<section class="ws-block">
				<details class="ws-panel rounded-ws">
					<summary class="ws-summary flex items-center gap-2.5 px-5 py-4">
						<svg class="ws-chev text-ws-faint" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
						<h3 class="text-[14px] font-semibold whitespace-nowrap text-ws-ink">{copy.teamActivity}</h3>
						<span class="dashboard-chip-muted text-[11px] text-ws-faint px-1.5 py-0.5 rounded-full whitespace-nowrap">{copy.filterToday}</span>
							<button type="button" class="ml-auto h-9 px-2 rounded-ws-ctrl text-[12px] text-ws-text hover:text-ws-ink transition-colors shrink-0 ws-btn-ghost" disabled={activityWorkBoardUnavailable} title={activityWorkBoardUnavailable ? copy.stepsLocked : undefined} onclick={() => openWorkBoard(activityWorkBoardProjectId)}>{copy.viewAll}</button>
					</summary>

					<div class="px-5 pb-5">
						<div class="border-t border-ws-line/[0.07] pt-4 space-y-4">
							{#if homeLoading}
								<div class="text-center py-6 text-ws-faint text-[12px]" data-testid="activity-loading">{copy.loadingActivity}</div>
							{:else if homeError}
								<div class="flex flex-col items-center gap-2 py-6" data-testid="activity-error">
									<span class="text-ws-rose text-[12px] text-center">{copy.loadActivityFailed} · {homeError}</span>
									{@render dashboardRetryButton()}
								</div>
							{:else if activityRows.length > 0}
								<!-- Cross-project activity from the workspace-home aggregate. Each row
								     carries its own project context; clicking opens the work board
								     (no per-open-chapter source lookup, which would be wrong here). -->
									{#each activityRows as item (item.id)}
									<button type="button" class="flex gap-3 w-full text-left bg-transparent border-0 cursor-pointer" onclick={() => openWorkBoard(item.projectId)}>
										<span class="ws-grad-primary w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold text-ws-ink">{dashboardFeedKindLabel(item.kind).charAt(0)}</span>
										<div class="flex-1 min-w-0 -mt-0.5">
											<p class="text-[13px] leading-relaxed text-ws-text">{dashboardFeedTitleLabel(item)}</p>
											<p class="ws-num text-[11.5px] text-ws-faint mt-0.5">{[("projectName" in item ? (item as { projectName?: string }).projectName : undefined), dashboardFeedKindLabel(item.kind), formatFeedTime(item)].filter(Boolean).join(" · ")}</p>
										</div>
									</button>
								{/each}
							{:else}
								<div class="text-center py-6 text-ws-faint text-[12px]" data-testid="activity-empty">{copy.noActivity}</div>
							{/if}
						</div>
					</div>
				</details>
			</section>

			<!-- ===== 5. QUIET METRICS ROW (NumberValue throughout) ===== -->
			<!-- These tiles are workspace-aggregate-derived; on a failed/loading aggregate they
			     are unknown, so dim (error) / pulse (loading) them rather than letting the zeros
			     read as a real "0 tasks / 0% / 0 languages". -->
			<section
					class="grid gap-4 pb-4 ws-auto-grid transition-opacity"
					class:opacity-40={homeError}
					class:animate-pulse={homeLoading}
					style="--ws-min:150px"
					aria-label={copy.ariaQuietMetrics}
					aria-busy={homeLoading}
					data-testid="quiet-metrics-row"
				>
					<button type="button" class="ws-panel-quiet rounded-ws-card px-4 py-3.5 text-left cursor-pointer ws-row-hover" disabled={myTasksWorkBoardUnavailable} title={myTasksWorkBoardUnavailable ? copy.stepsLocked : undefined} onclick={() => openWorkBoard(myTasksWorkBoardProjectId)}>
					<p class="text-[11.5px] text-ws-faint truncate">{copy.metricAllTasks}</p>
					<p class="mt-1 flex items-baseline gap-1 leading-none">
						<NumberValue value={workspaceHomeStore.counts.openTasks} class="text-[20px] font-semibold text-ws-ink" />
						<span class="text-[12px] text-ws-faint font-normal">{copy.itemsUnit}</span>
					</p>
				</button>
					<button type="button" class="ws-panel-quiet rounded-ws-card px-4 py-3.5 text-left cursor-pointer ws-row-hover" disabled={!canOpenWorkBoard(dueTaskWorkBoardProjectId)} title={!canOpenWorkBoard(dueTaskWorkBoardProjectId) ? copy.stepsLocked : undefined} onclick={() => openWorkBoard(dueTaskWorkBoardProjectId)}>
					<p class="text-[11.5px] text-ws-faint truncate">{copy.metricDueSoon}</p>
					<p class="mt-1 flex items-baseline gap-1 leading-none">
						<NumberValue value={workspaceHomeStore.counts.dueToday} class="text-[20px] font-semibold text-ws-ink" />
						<span class="text-[12px] text-ws-faint font-normal">{copy.itemsUnit}</span>
					</p>
				</button>
				<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
					<p class="text-[11.5px] text-ws-faint truncate">% localized</p>
					<div class="flex items-center gap-2.5 mt-1.5">
						{#if metricsHasRealProgress}
							<p class="leading-none shrink-0 flex items-baseline">
								<NumberValue value={metricsLocalizedPercent} suffix="%" compact={false} class="text-[20px] font-semibold text-ws-ink" />
							</p>
							<div class="ws-track h-1 flex-1 min-w-0"><div class="ws-fill dashboard-fill-success" style={`width:${metricsLocalizedPercent}%`}></div></div>
						{:else}
							<p class="leading-none shrink-0 flex items-baseline">
								<NumberValue value={0} suffix="%" compact={false} class="text-[20px] font-semibold text-ws-ink" />
							</p>
							<span class="text-[11px] text-ws-faint flex-1 min-w-0 truncate">{metricsHasWork ? copy.noProgressYet : copy.metricNoChapters}</span>
						{/if}
					</div>
				</div>
				<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
					<p class="text-[11.5px] text-ws-faint truncate">target languages</p>
					<div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
						{#if metricsHasTargetLangs}
							<span class="leading-none shrink-0 flex items-baseline gap-1">
								<NumberValue value={metricsTargetLangCount} class="text-[20px] font-semibold text-ws-ink" />
								<span class="text-[12px] text-ws-faint font-normal">{copy.langUnit}</span>
							</span>
							<span class="flex items-center gap-1 ml-1">
								<span class="text-[10px] font-medium text-ws-accent bg-ws-accent/10 border border-ws-accent/20 px-1.5 py-px rounded-full">{metricsTargetLangCode}</span>
							</span>
						{:else}
							<span class="leading-none shrink-0 flex items-baseline gap-1">
								<NumberValue value={0} class="text-[20px] font-semibold text-ws-ink" />
								<span class="text-[12px] text-ws-faint font-normal">{copy.langUnit}</span>
							</span>
							<span class="text-[11px] text-ws-faint ml-1">{copy.metricNoChapters}</span>
						{/if}
					</div>
				</div>
			</section>

		</div>
	</section>

	<OnboardingTour />
{/if}









<style>
	/* The surface frame (position / scroll / background / typeface) AND the centered
	   1200px content column (max-width / padding / vertical rhythm) come from the
	   shared `.ws-surface` + `.ws-surface-inner` utilities in app.css — the dashboard
	   is the canonical width every other surface now matches. Only dashboard-specific
	   styling remains below. */
	.workspace-dashboard-shell :global(*) {
		-webkit-font-smoothing: antialiased;
		text-rendering: optimizeLegibility;
	}

	.workspace-dashboard-shell h1,
	.workspace-dashboard-shell h2,
	.workspace-dashboard-shell h3,
	.workspace-dashboard-shell p {
		margin: 0;
		letter-spacing: 0;
	}

	.workspace-dashboard-shell button {
		font-family: inherit;
	}

	.dashboard-primary-action {
		box-shadow: 0 14px 34px -12px color-mix(in srgb, var(--color-ws-accent) 60%, transparent);
	}

	.dashboard-hero-glow {
		background: radial-gradient(circle, color-mix(in srgb, var(--color-ws-violet) 16%, transparent), transparent 65%);
	}

	.dashboard-hero-glow-error {
		background: radial-gradient(circle, color-mix(in srgb, var(--color-ws-rose) 16%, transparent), transparent 65%);
	}

	.dashboard-cover-shadow {
		filter: drop-shadow(0 18px 40px color-mix(in srgb, var(--color-ws-bg) 85%, transparent));
	}

	.dashboard-thumbnail-badge {
		background: color-mix(in srgb, var(--color-ws-bg) 62%, transparent);
		color: var(--color-ws-ink);
	}

	.dashboard-chip-muted {
		background: color-mix(in srgb, var(--color-ws-line) 8%, transparent);
	}

	.dashboard-chip-active {
		background: color-mix(in srgb, var(--color-ws-surface2) 92%, transparent);
	}

	.dashboard-plan-chip {
		border-color: color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		color: var(--color-ws-violet);
	}

	.dashboard-dot-violet-soft {
		background: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
	}

	.dashboard-fill-primary {
		background: linear-gradient(90deg, var(--color-ws-violet), var(--color-ws-accent));
	}

	.dashboard-fill-skeleton {
		background: color-mix(in srgb, var(--color-ws-violet) 35%, transparent);
	}

	.dashboard-fill-warning {
		background: linear-gradient(90deg, var(--color-ws-amber), var(--color-ws-rose));
	}

	.dashboard-fill-success {
		background: linear-gradient(90deg, var(--color-ws-green), var(--color-ws-accent));
	}

	/* tabular figures so numbers don't reflow as values grow */
	:global(.ws-num) {
		font-variant-numeric: tabular-nums;
		font-feature-settings: "tnum" 1;
	}

	/* uppercase section label / eyebrow */
	:global(.ws-eyebrow) {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.13em;
		text-transform: uppercase;
		color: var(--color-ws-faint);
	}

	/* band heading rule that splits the page into calm chapters */
	:global(.ws-band-head) {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	:global(.ws-band-rule) {
		flex: 1 1 auto;
		height: 1px;
		min-width: 0;
		background: linear-gradient(90deg, var(--ws-hair-strong), transparent);
	}

	/* active pipeline tile border accent */
	:global(.ws-pipeline-active) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 30%, transparent) !important;
	}

	/* collapsible <summary> chevron */
	:global(.ws-summary) {
		list-style: none;
		cursor: pointer;
	}
	:global(.ws-summary)::-webkit-details-marker {
		display: none;
	}
	:global(.ws-chev) {
		transition: transform 0.18s ease;
	}
	:global(details[open] > .ws-summary .ws-chev) {
		transform: rotate(90deg);
	}

	/* tinted tag / icon-chip backgrounds (role + severity accents) */
	:global(.ws-tag-violet) {
		color: var(--color-ws-violet);
		background: color-mix(in srgb, var(--color-ws-violet) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-violet) 20%, transparent);
	}
	:global(.ws-tag-cyan) {
		color: var(--color-ws-cyan);
		background: color-mix(in srgb, var(--color-ws-cyan) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-cyan) 20%, transparent);
	}
	:global(.ws-tag-amber) {
		color: var(--color-ws-amber);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 20%, transparent);
	}
	:global(.ws-tag-rose) {
		color: var(--color-ws-rose);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 20%, transparent);
	}
	:global(.ws-tag-blue) {
		color: var(--color-ws-blue);
		background: color-mix(in srgb, var(--color-ws-blue) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-blue) 20%, transparent);
	}

	/* solid status dots per accent */
	:global(.ws-dot-violet) { background: var(--color-ws-violet); }
	:global(.ws-dot-cyan) { background: var(--color-ws-cyan); }
	:global(.ws-dot-amber) { background: var(--color-ws-amber); }
	:global(.ws-dot-rose) { background: var(--color-ws-rose); }
	:global(.ws-dot-blue) { background: var(--color-ws-blue); }

	/* ── search dropdown (rendered via WorkspaceTopUtilityBar snippet) ── */
	.dashboard-search-panel {
		position: absolute;
		left: 0;
		right: 0;
		top: calc(100% + 8px);
		z-index: 1010;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws);
		background: color-mix(in srgb, var(--color-ws-bg) 88%, var(--color-ws-surface2));
		box-shadow:
			0 22px 54px color-mix(in srgb, var(--color-ws-bg) 62%, transparent),
			inset 0 1px 0 color-mix(in srgb, var(--color-ws-line) 5%, transparent);
		padding: 10px;
		backdrop-filter: blur(16px);
	}

	.dashboard-search-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 0 2px;
	}

	.dashboard-search-summary span,
	.dashboard-search-summary strong,
	.dashboard-search-empty span,
	.dashboard-search-empty strong,
	.dashboard-search-result {
		font-size: 11px;
		font-weight: 600;
	}

	.dashboard-search-summary span {
		overflow: hidden;
		color: var(--color-ws-text);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dashboard-search-summary strong {
		color: var(--color-ws-violet);
	}

	.dashboard-search-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.dashboard-search-result {
		min-height: 58px;
		display: grid;
		grid-template-columns: 58px minmax(0, 1fr);
		gap: 8px 12px;
		align-items: center;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-ink);
		padding: 8px 10px;
		text-align: left;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	.dashboard-search-result:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 35%, transparent);
		background: color-mix(in srgb, var(--color-ws-surface2) 92%, transparent);
	}

	.search-result-type {
		grid-row: 1 / 3;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 34px;
		border-radius: 11px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-accent);
		font-size: 9px;
		font-weight: 700;
	}

	.dashboard-search-result.violet .search-result-type { background: color-mix(in srgb, var(--color-ws-violet) 18%, transparent); color: var(--color-ws-violet); }
	.dashboard-search-result.cyan .search-result-type { background: color-mix(in srgb, var(--color-ws-cyan) 16%, transparent); color: var(--color-ws-cyan); }
	.dashboard-search-result.amber .search-result-type { background: color-mix(in srgb, var(--color-ws-amber) 18%, transparent); color: var(--color-ws-amber); }
	.dashboard-search-result.rose .search-result-type { background: color-mix(in srgb, var(--color-ws-rose) 18%, transparent); color: var(--color-ws-rose); }
	.dashboard-search-result.blue .search-result-type { background: color-mix(in srgb, var(--color-ws-blue) 14%, transparent); color: var(--color-ws-blue); }

	.search-result-main {
		min-width: 0;
	}

	.search-result-main strong,
	.search-result-main small,
	.dashboard-search-result em {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.search-result-main strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 700;
	}

	.search-result-main small,
	.dashboard-search-result em {
		color: var(--color-ws-text);
		font-size: 10px;
		font-style: normal;
		font-weight: 500;
	}

	.dashboard-search-empty {
		display: flex;
		min-height: 72px;
		flex-direction: column;
		justify-content: center;
		gap: 5px;
		/* Solid frame to match the other empty/surface panels (border-ws-line/12)
		   rather than a one-off dashed outline. */
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 12%, transparent);
		border-radius: var(--radius-ws-card);
		color: var(--color-ws-text);
		padding: 12px;
	}

	.dashboard-search-empty strong {
		color: var(--color-ws-ink);
	}
</style>
