<script lang="ts">
	import { _ } from "$lib/i18n";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import {
		disambiguateImageFileNames,
		formatUnsupportedImageFileSummary,
		orderProjectImageFiles,
		SUPPORTED_IMAGE_ACCEPT,
	} from "$lib/project/file-order.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore, type WorkspaceEditorEntryContext } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import {
		defaultReadingDirectionForSourceLang,
		READING_DIRECTION_OPTIONS,
		type ReadingDirection,
	} from "$lib/project/reading-direction.js";
	import { buildStorySlug, buildStoryTitleKey, generateStableStoryId } from "$lib/project/story-id.js";
	import type { ProjectState } from "$lib/types.js";
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import ChapterTeamManager from "$lib/components/ChapterTeamManager.svelte";
	import type { ChapterTeamInviteInput } from "$lib/api/client.ts";
	import type { ProductionMode } from "$lib/types.js";
	import LanguagePicker from "$lib/components/ui/LanguagePicker.svelte";
	import ProgressBar from "$lib/components/ui/ProgressBar.svelte";
	import { isUploadTooLargeError, UPLOAD_TOO_LARGE_MESSAGE } from "$lib/api/client.js";
	import { ImageUploadBatchError } from "$lib/project/upload-batches.js";

	const imageAccept = SUPPORTED_IMAGE_ACCEPT;
	/** Hard cap on chapter page images (mirrors backend maxImagesPerChapter). */
	const MAX_CHAPTER_PAGES = 1000;
	type UploadMode = "files" | "folder";
	type ImagePreviewItem = {
		id: string;
		name: string;
		pageNumber: number;
		url: string;
	};

	// Same-named files are routine in manga (pages copied from several folders).
	// Keying the preview `{#each}` by name then throws `each_key_duplicate` and
	// wipes the whole strip, so we hand every selected File a STABLE UNIQUE id
	// (kept across drag/sort reorders via this WeakMap) and key the each by it.
	const fileIdMap = new WeakMap<File, string>();
	let fileIdSeq = 0;
	function stableFileId(file: File): string {
		let id = fileIdMap.get(file);
		if (!id) {
			id = `f${fileIdSeq++}`;
			fileIdMap.set(file, id);
		}
		return id;
	}

	// Localise via svelte-i18n with a Thai fallback ($_ returns the key itself on
	// a miss / before init, so guard against that).
	function t(key: string, fallback: string, params?: Record<string, string | number>): string {
		const value = $_(key, params ? { values: params } : undefined);
		return value && value !== key ? value : fallback;
	}

	// Reading-direction option label/helper are localized at the render site
	// (keyed by the option `value`) rather than baked into the shared
	// READING_DIRECTION_OPTIONS data, which is plain logic reused outside this
	// dialog. The `t(key, fallback)` call happens lazily in
	// readingDirectionLabel/Helper (re-run every render), so this lookup stays
	// reactive on a live locale switch. The fallback strings are English-only
	// (no raw Thai ships here); the th locale still renders the original Thai via
	// the `chapterSetup.readingDirection*` keys, which exist in every locale.
	const READING_DIRECTION_I18N: Record<
		ReadingDirection,
		{ label: [string, string]; helper: [string, string] }
	> = {
		rtl: {
			label: ["chapterSetup.readingDirectionRtlLabel", "Right to left (manga)"],
			helper: [
				"chapterSetup.readingDirectionRtlHelper",
				"Read right to left, pages in reverse order — best for Japanese manga.",
			],
		},
		ltr: {
			label: ["chapterSetup.readingDirectionLtrLabel", "Left to right (manhua)"],
			helper: [
				"chapterSetup.readingDirectionLtrHelper",
				"Read left to right as usual — best for manhua and Western comics.",
			],
		},
		// `vertical` is retained in the type for back-compat but never shown in the
		// picker; fall back to the LTR copy if it is ever rendered.
		vertical: {
			label: ["chapterSetup.readingDirectionLtrLabel", "Left to right (manhua)"],
			helper: [
				"chapterSetup.readingDirectionLtrHelper",
				"Read left to right as usual — best for manhua and Western comics.",
			],
		},
	};
	function readingDirectionLabel(value: ReadingDirection): string {
		const [key, fallback] = READING_DIRECTION_I18N[value].label;
		return t(key, fallback);
	}
	function readingDirectionHelper(value: ReadingDirection): string {
		const [key, fallback] = READING_DIRECTION_I18N[value].helper;
		return t(key, fallback);
	}

	// Field-routing kind for the inline error. Previously the code matched the
	// (Thai) error STRING by prefix to decide which field to attach it to — which
	// breaks the moment the message is localised. We now carry a stable code
	// alongside the localised message so routing is locale-independent.
	type LocalErrorKind = "" | "title" | "pages";
	let localErrorKind = $state<LocalErrorKind>("");
	function setLocalError(message: string, kind: LocalErrorKind = ""): void {
		localError = message;
		localErrorKind = kind;
	}
	function clearLocalError(): void {
		localError = "";
		localErrorKind = "";
	}

	let titleName = $state("");
	let chapterNumber = $state("1");
	let chapterName = $state("");
	let targetLang = $state("th");
	let sourceLang = $state("ja");
	// Default reading direction = ltr (the webtoon/vertical continuous mode was
	// removed; the editor shows one page at a time). The user can change it any
	// time; we no longer silently override their pick from the source language.
	let readingDirection = $state<ReadingDirection>("ltr");
	let readingDirectionTouched = $state(false);
	let uploadMode = $state<UploadMode>("files");
	let coverFile = $state<File | null>(null);
	let imageFiles = $state<File[]>([]);
	let coverPreviewUrl = $state("");
	let pagePreviewItems = $state<ImagePreviewItem[]>([]);
	// Merge-at-creation (webtoon strips): stitch every N source files into one
	// page server-side. Bounds mirror the backend MIN/MAX_MERGE_PER_PAGE (2..50).
	const MERGE_PER_PAGE_MIN = 2;
	const MERGE_PER_PAGE_MAX = 50;
	let mergeEnabled = $state(false);
	let mergePerPageRaw = $state(10);
	let mergePerPage = $derived(Math.min(MERGE_PER_PAGE_MAX, Math.max(MERGE_PER_PAGE_MIN, Math.round(mergePerPageRaw) || MERGE_PER_PAGE_MIN)));
	let mergedPageCount = $derived(imageFiles.length ? Math.ceil(imageFiles.length / mergePerPage) : 0);
	let pageUnsupportedSummary = $state("");
	let busy = $state(false);
	let localError = $state("");
	let setupStage = $state<"story" | "chapter">("story");
	// Chapter-level Team/Solo selection + invite-at-creation (draft, sent on create).
	let productionMode = $state<ProductionMode>("solo");
	let chapterInvites = $state<ChapterTeamInviteInput[]>([]);
	let pendingSetupProjectId = $state<string | null>(null);
	let titleInput: HTMLInputElement | null = $state(null);
	let coverInput: HTMLInputElement | null = $state(null);
	let pageInput: HTMLInputElement | null = $state(null);
	let folderInput: HTMLInputElement | null = $state(null);
	let progressSection: HTMLElement | null = $state(null);
	let appliedChapterSetupContextKey = $state("");

	let fillExistingProject = $derived(
		editorUiStore.chapterSetupContext.mode === "fill-existing-zero-page"
			|| Boolean(projectStore.project && projectStore.project.pages.length === 0),
	);
	let addToExistingTitle = $derived(editorUiStore.chapterSetupContext.mode === "add-chapter-to-title");
	let importReviewIntent = $derived(editorUiStore.chapterSetupContext.completionView === "import-review");
	let lockedTitleName = $derived((editorUiStore.chapterSetupContext.titleName ?? "").trim());
	let storyStepActive = $derived(!fillExistingProject && !addToExistingTitle && setupStage === "story");
	let chapterStepActive = $derived(fillExistingProject || addToExistingTitle || setupStage === "chapter");
	let dialogEyebrow = $derived(fillExistingProject ? t("chapterSetup.eyebrowFill", "เติมรูปเข้าโปรเจกต์นี้") : (addToExistingTitle ? t("chapterSetup.eyebrowAddChapter", "เพิ่มตอนในเรื่องนี้") : (storyStepActive ? (importReviewIntent ? t("chapterSetup.eyebrowStoryImport", "สร้างตอนเพื่อ Import / Review") : t("chapterSetup.eyebrowStory", "สร้างเรื่อง")) : t("chapterSetup.eyebrowChapter", "สร้างตอน"))));
	let dialogTitle = $derived(fillExistingProject
		? t("chapterSetup.titleFill", "เพิ่มรูปหน้าก่อนเข้าแก้หน้า")
		: (addToExistingTitle
			? t("chapterSetup.titleAddChapter", `เพิ่มตอนของ ${lockedTitleName || "เรื่องนี้"}`, { story: lockedTitleName || t("chapterSetup.thisStory", "เรื่องนี้") })
			: (storyStepActive ? (importReviewIntent ? t("chapterSetup.titleStoryImport", "ตั้งชื่อเรื่อง แล้วอัปโหลดรูปหน้า") : t("chapterSetup.titleStory", "ตั้งชื่อเรื่องก่อนสร้างตอน")) : t("chapterSetup.titleChapter", "สร้างตอนของเรื่องนี้"))));
	let dialogDescription = $derived(fillExistingProject
		? t("chapterSetup.descFill", "โปรเจกต์นี้ถูกสร้างไว้แล้วแต่ยังไม่มีรูปหน้า เลือกรูปเพื่อเติมเข้าโปรเจกต์เดิมและเข้าแก้หน้าได้ทันที")
		: (addToExistingTitle
			? t("chapterSetup.descAddChapter", "เรื่องถูกเลือกจากคลังแล้ว ใส่เลขตอน ภาษา และรูปหน้า ระบบจะจัดตอนใหม่เข้าชั้นเรื่องนี้ทันที")
		: (storyStepActive
			? (importReviewIntent
				? t("chapterSetup.descStoryImport", "ตั้งชื่อเรื่องก่อนเพื่อเก็บเข้าคลังให้ถูก จากนั้นขั้นถัดไปคือเลือกรูปหน้าตอน แล้วระบบจะพาไป Import / Review")
				: t("chapterSetup.descStory", "เริ่มจากชื่อเรื่องและปกก่อน จากนั้นค่อยเพิ่มตอน ภาษา และรูปหน้า เพื่อให้คลังงาน scale ได้หลายตอน"))
			: t("chapterSetup.descChapter", "เพิ่มเลขตอน ภาษา และรูปหน้าของตอนนี้ งานจะถูกจัดเข้าชั้นเรื่องเดิมแทนการเป็นตอนลอยๆ"))),
	);
	let setupSummaryLabel = $derived(fillExistingProject ? t("chapterSetup.summaryFill", "จะเติมเข้า") : (addToExistingTitle ? t("chapterSetup.summaryAddChapter", "จะเพิ่มเป็นตอน") : t("chapterSetup.summaryCreate", "จะสร้างเป็น")));
	let submitLabel = $derived(fillExistingProject
		? (importReviewIntent ? t("chapterSetup.submitFillImport", "เพิ่มรูปและไป Import / Review") : t("chapterSetup.submitFillEdit", "เพิ่มรูปและเปิดหน้า 1"))
		: (storyStepActive
			? (importReviewIntent ? t("chapterSetup.submitNextUpload", "ต่อไป: อัปโหลดรูปหน้า") : t("chapterSetup.submitNextChapter", "ต่อไป: ตั้งตอน"))
			: (importReviewIntent ? t("chapterSetup.submitCreateImport", "สร้างตอนและไป Import / Review") : t("chapterSetup.submitCreateEdit", "สร้างตอนและเปิดหน้า 1"))));
	let busyLabel = $derived(fillExistingProject ? t("chapterSetup.busyAddingPages", "กำลังเพิ่มรูป...") : t("chapterSetup.busyCreating", "กำลังสร้าง..."));
	let projectNamePreview = $derived(buildProjectName());
	let imageSummary = $derived(imageFiles.length ? t("chapterSetup.imageSummaryReady", `${imageFiles.length} รูปพร้อมImport`, { count: imageFiles.length }) : t("chapterSetup.noPages", "ยังไม่มีรูปหน้า"));
	let coverSummary = $derived(coverFile?.name ?? t("chapterSetup.noCover", "ยังไม่มีปก"));
	let pageFileSummary = $derived(imageFiles.length ? t("chapterSetup.imageSummarySelected", `${imageFiles.length} รูปที่เลือกแล้ว`, { count: imageFiles.length }) : t("chapterSetup.noPages", "ยังไม่มีรูปหน้า"));
	let pageOrderSummary = $derived(pageImportOrderSummary());
	let titleFieldError = $derived(
		!fillExistingProject && !addToExistingTitle && localErrorKind === "title" ? localError : "",
	);
	let pageFieldError = $derived(
		localErrorKind === "pages" ? localError : "",
	);
	let coverPreviewSummary = $derived(
		coverFile?.name ?? (imageFiles.length ? t("chapterSetup.useFirstPage", "ใช้รูปหน้าแรก") : t("chapterSetup.waitingForPages", "รอเลือกรูปหน้า")),
	);
	let pagePreviewHiddenCount = $derived(Math.max(0, imageFiles.length - pagePreviewItems.length));
	// Over-limit guard (req #3): block + clearly message past MAX_CHAPTER_PAGES.
	let pagesOverLimit = $derived(imageFiles.length > MAX_CHAPTER_PAGES);
	let pageLimitWarning = $derived(
		pagesOverLimit
			? t("chapterSetup.pageLimitWarning", `เลือกรูปหน้าได้สูงสุด ${MAX_CHAPTER_PAGES.toLocaleString()} หน้า (ตอนนี้เลือก ${imageFiles.length.toLocaleString()} หน้า) เอาออกบางหน้าก่อนสร้างตอน`, { max: MAX_CHAPTER_PAGES.toLocaleString(), count: imageFiles.length.toLocaleString() })
			: "",
	);
	// Live upload progress (req #2). Only reflect this dialog's own create/fill run.
	let activeUploadProgress = $derived(busy ? projectStore.chapterUploadProgress : null);
	let uploadProgressPercent = $derived.by(() => {
		const p = activeUploadProgress;
		if (!p) return 0;
		if (p.phase === "cover") return 96;
		if (p.totalFiles > 0) return Math.min(95, Math.round((p.uploadedFiles / p.totalFiles) * 95));
		if (p.total > 0) return Math.min(95, Math.round((p.done / p.total) * 95));
		return 0;
	});
	let uploadProgressLabel = $derived.by(() => {
		const p = activeUploadProgress;
		if (!p) return "";
		if (p.phase === "cover") return t("chapterSetup.uploadingCover", "กำลังอัปโหลดรูปปก…");
		if (p.totalFiles <= 1) return t("chapterSetup.uploadingPages", "กำลังอัปโหลดรูปหน้า…");
		// uploadedFiles is a fractional estimate (byte-progress within a batch);
		// show the page currently in flight (floor + 1), capped at the total.
		const currentPage = Math.min(Math.floor(p.uploadedFiles) + 1, p.totalFiles);
		return t("chapterSetup.uploadingPageOfTotal", `กำลังอัปโหลดรูปหน้า ${currentPage}/${p.totalFiles}…`, { current: currentPage, total: p.totalFiles });
	});
	let setupRecoveryMessage = $derived(
		Boolean(pendingSetupProjectId)
		&& projectStore.project?.projectId === pendingSetupProjectId
		&& projectStore.saveSyncStatus === "error"
			? (projectStore.statusMsg || projectStore.saveErrorMessage || t("chapterSetup.createNotReady", "สร้างตอนยังไม่สำเร็จ"))
			: "",
	);

	// Default reading direction is ltr (the webtoon/vertical continuous mode was
	// removed) and is NOT auto-overridden by the source language — the user's pick
	// wins and is fully changeable. We only surface a soft suggestion when the
	// source language conventionally differs.
	let readingDirectionSuggestion = $derived(defaultReadingDirectionForSourceLang(sourceLang));
	let showReadingDirectionSuggestion = $derived(
		!readingDirectionTouched && readingDirectionSuggestion !== readingDirection,
	);
	let remainingRequiredSetupItems = $derived.by(() => buildRemainingRequiredSetupItems());
	let footerSetupHint = $derived.by(() => {
		if (!remainingRequiredSetupItems.length) return "";
		const itemList = remainingRequiredSetupItems.join(", ");
		return `${remainingRequiredSetupItems.length} ${t("chapterSetup.required", "(จำเป็น)")}: ${itemList}`;
	});

	// The sticky footer can be visible before mobile users have scrolled through
	// every required setup field, so keep an explicit count in the action row.
	function buildRemainingRequiredSetupItems(): string[] {
		const items: string[] = [];
		if (storyStepActive && !titleName.trim()) {
			items.push(t("chapterSetup.storyName", "ชื่อเรื่อง"));
		}
		if (chapterStepActive) {
			if (!targetLang.trim()) items.push(t("chapterSetup.targetLang", "ภาษาเป้าหมาย"));
			if (!sourceLang.trim()) items.push(t("chapterSetup.sourceLang", "ภาษาต้นฉบับ"));
			if (!readingDirection) items.push(t("chapterSetup.readingDirection", "ทิศทางการอ่าน"));
			if (!imageFiles.length) {
				items.push(t("chapterSetup.chapterPages", "รูปหน้าของตอน"));
			} else if (pagesOverLimit) {
				items.push(t("chapterSetup.chapterPages", "รูปหน้าของตอน"));
			}
		}
		return items;
	}

	function selectReadingDirection(direction: ReadingDirection): void {
		readingDirectionTouched = true;
		readingDirection = direction;
	}

	function applyReadingDirectionSuggestion(): void {
		readingDirectionTouched = true;
		readingDirection = readingDirectionSuggestion;
	}

	$effect(() => {
		if (!editorUiStore.chapterSetupOpen) {
			appliedChapterSetupContextKey = "";
			return;
		}
		const context = editorUiStore.chapterSetupContext;
		const contextKey = `${context.mode}:${context.projectId ?? ""}:${context.titleKey ?? ""}:${context.titleName ?? ""}:${context.targetLang ?? ""}:${context.completionView ?? ""}`;
		if (contextKey === appliedChapterSetupContextKey) return;
		appliedChapterSetupContextKey = contextKey;
		resetDraftForContext(context);
	});

	// Focus the first relevant field once the shared Dialog has mounted + trapped
	// focus. Runs only on the open transition; step-change focus is owned by
	// continueToChapterStep/editStoryStep so this never fights those handlers.
	let focusedOnOpen = false;
	$effect(() => {
		if (!editorUiStore.chapterSetupOpen) {
			focusedOnOpen = false;
			return;
		}
		if (focusedOnOpen) return;
		focusedOnOpen = true;
		const focusFrame = requestAnimationFrame(() => {
			(storyStepActive ? titleInput : pageInput)?.focus();
		});
		return () => cancelAnimationFrame(focusFrame);
	});

	$effect(() => {
		const urls: string[] = [];
		const nextCoverPreviewUrl = coverFile ? createImagePreviewUrl(coverFile) : "";
		if (nextCoverPreviewUrl) urls.push(nextCoverPreviewUrl);

		const previewFiles = imageFiles.slice(0, 32);
		const displayNames = disambiguateImageFileNames(previewFiles);
		const nextPagePreviewItems = previewFiles.map((file, index) => {
			const url = createImagePreviewUrl(file);
			if (url) urls.push(url);
			return {
				id: stableFileId(file),
				name: displayNames[index],
				pageNumber: index + 1,
				url,
			};
		}).filter((item) => item.url);

		coverPreviewUrl = nextCoverPreviewUrl;
		pagePreviewItems = nextPagePreviewItems;

		return () => {
			for (const url of urls) URL.revokeObjectURL?.(url);
		};
	});

	// Turn a raw upload failure into friendly guidance. A 413 (per-file too big or
	// the cumulative 500MB/batch cap) otherwise surfaces the backend's raw English
	// string; show an actionable Thai message instead.
	function friendlyUploadError(error: unknown, fallback: string): string {
		if (isUploadTooLargeError(error)) return UPLOAD_TOO_LARGE_MESSAGE;
		// Name the exact page span that failed so the user can fix/retry that range
		// instead of facing a silent generic stall. Keeps the underlying reason.
		if (error instanceof ImageUploadBatchError) {
			const span = error.fromPage === error.toPage
				? t("chapterSetup.spanPage", `หน้า ${error.fromPage}`, { page: error.fromPage })
				: t("chapterSetup.spanRange", `หน้า ${error.fromPage}–${error.toPage}`, { from: error.fromPage, to: error.toPage });
			const reason = error.message?.trim();
			return reason
				? t("chapterSetup.uploadFailedSpanReason", `อัปโหลด${span}ไม่สำเร็จ: ${reason} แก้รูปช่วงนี้แล้วลองอีกครั้ง`, { span, reason })
				: t("chapterSetup.uploadFailedSpan", `อัปโหลด${span}ไม่สำเร็จ แก้รูปช่วงนี้แล้วลองอีกครั้ง`, { span });
		}
		if (error instanceof Error && error.message) return error.message;
		return fallback;
	}

	// On submit the live progress + preview can render below the dialog fold;
	// pull the progress section into view so the user actually sees it working.
	$effect(() => {
		if (busy && activeUploadProgress && progressSection) {
			progressSection.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	});

	function createImagePreviewUrl(file: File): string {
		if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
		return URL.createObjectURL(file);
	}

	function buildProjectName(): string {
		const title = titleName.trim();
		const chapterLabel = buildChapterLabel();
		return title ? `${title} - ${chapterLabel}` : chapterLabel;
	}

	function buildChapterLabel(): string {
		const chapter = chapterName.trim();
		const number = chapterNumber.trim();
		const numberLabel = number ? t("chapterSetup.chapterNumberLabel", `ตอน ${number}`, { number }) : "";
		return [numberLabel, chapter].filter(Boolean).join(" - ") || t("chapterSetup.newChapter", "ตอนใหม่");
	}

	// A new-story id is minted once per dialog session so retries / the
	// story→chapter step transition reuse the same stable id instead of churning
	// a fresh one each render.
	let mintedStoryId = "";

	/**
	 * Resolve the STABLE story key for the chapter being created.
	 *
	 * The story key used to be a title-derived slug, which collided on duplicate
	 * titles and changed on rename. It is now a stable, dash-free random id never
	 * derived from the title:
	 *  - Adding a chapter to an EXISTING story reuses that story's id (the library
	 *    passes it through `chapterSetupContext.titleKey`), so the new chapter lands
	 *    on the same shelf.
	 *  - A brand-new story mints a fresh stable id, so two stories with the same
	 *    title never merge and a later rename keeps the same URL.
	 */
	function buildStoryId(): string {
		const contextKey = (editorUiStore.chapterSetupContext.titleKey ?? "").trim();
		if (contextKey) return contextKey;
		if (!mintedStoryId) {
			// Avoid minting an id that collides with an already-known story (or the
			// leading token of a legacy dashed slug). Resolution is deterministic
			// regardless, but this keeps every story's URL leading token unique.
			const knownStoryIds = (projectStore.recentProjects ?? [])
				.map((project) => project.storyId)
				.filter((id): id is string => Boolean(id));
			mintedStoryId = generateStableStoryId(knownStoryIds);
		}
		return mintedStoryId;
	}

	function storyKeyFromTitle(value: string): string {
		return buildStorySlug(value) || "untitled";
	}

	function buildSetupMetadata() {
		// First-run scope guard: a "create" (brand-new project) opened from ANY entry
		// point must be workspace-scoped. Thread the flag from the open context plus the
		// LIVE workspace id so the store create refuses to mint an unscoped/orphan
		// project when the workspace is still resolving. Filling an existing project or
		// adding a chapter already targets a resolved, already-scoped project, so the
		// flag stays off there (and never blocks those flows).
		const requireScopedCreate = editorUiStore.chapterSetupContext.requireScopedCreate === true;
		const liveWorkspaceId = workspacesStore.currentWorkspace?.workspaceId?.trim() || undefined;
		return {
			projectName: projectNamePreview,
			targetLang,
			sourceLang,
			coverFile,
			...(requireScopedCreate ? { requireScopedCreate: true } : {}),
			...(liveWorkspaceId ? { workspaceId: liveWorkspaceId } : {}),
			// Filling an existing zero-page project must NOT re-key its story: that
			// project already owns a stable storyId. Only mint/reuse a story id when
			// creating a chapter (new story → fresh id, existing story → its id).
			storyId: fillExistingProject ? undefined : buildStoryId(),
			storyTitle: titleName.trim() || lockedTitleName || undefined,
			chapterNumber: chapterNumber.trim() || undefined,
			chapterTitle: chapterName.trim() || undefined,
			chapterLabel: buildChapterLabel(),
			readingDirection,
			// Chapter-level Team/Solo + invite-at-creation. Only meaningful for a NEW
			// chapter (not a fill-existing add), so omit for the fill path. An explicit
			// Solo with no invites stays byte-identical to the legacy create payload.
			...(fillExistingProject
				? {}
				: {
					productionMode,
					initialInvites: chapterInvites,
				}),
			// Optional merge-at-creation (webtoon strips): stitch every N source
			// files into one page server-side. Only sent when the toggle is on AND
			// the selection actually merges (≥2 sources).
			...(mergeEnabled && imageFiles.length >= 2
				? { pageTransform: { mode: "merge" as const, perPage: mergePerPage } }
				: {}),
		};
	}

	function buildPostSetupEditorEntry(
		activeProject: ProjectState,
		shouldFillExisting: boolean,
	): WorkspaceEditorEntryContext {
		const title = (activeProject.storyTitle ?? titleName ?? lockedTitleName ?? "").trim()
			|| activeProject.name;
		const chapterLabel = (activeProject.chapterLabel ?? buildChapterLabel()).trim()
			|| activeProject.name;
		// Prefer the backend-authoritative stable story id and surface the hybrid
		// `<storyId>-<slug>` segment so post-setup links match the library URL.
		const resolvedStoryId = (activeProject.storyId ?? editorUiStore.chapterSetupContext.titleKey ?? "").trim();
		const titleKey = resolvedStoryId
			? buildStoryTitleKey(resolvedStoryId, title)
			: storyKeyFromTitle(title);
		return {
			source: "library",
			projectId: activeProject.projectId,
			titleKey,
			title,
			chapterLabel,
			language: activeProject.targetLang || targetLang,
			reason: shouldFillExisting
				? t("chapterSetup.reasonPagesAdded", "เพิ่มรูปหน้าแล้ว")
				: addToExistingTitle
					? t("chapterSetup.reasonChapterInStory", "สร้างตอนในเรื่องนี้")
					: t("chapterSetup.reasonNewChapter", "สร้างตอนใหม่"),
			};
	}

	function finishSetupAtRequestedView(
		activeProject: ProjectState,
		shouldFillExisting: boolean,
	): void {
		const completionView = editorUiStore.chapterSetupContext.completionView ?? "editor";
		const editorEntry = buildPostSetupEditorEntry(activeProject, shouldFillExisting);
		editorUiStore.closeChapterSetup();
		if (completionView === "import-review") {
			editorUiStore.openImportReview();
			queueWorkspaceNavigation({
				view: "import",
				projectId: activeProject.projectId,
			});
			return;
		}
		editorUiStore.openEditor(editorEntry);
		queueWorkspaceNavigation({
			view: "editor",
			projectId: activeProject.projectId,
			pageIndex: activeProject.currentPage,
		});
	}

	function resetDraftForContext(context = editorUiStore.chapterSetupContext): void {
		const nextTitle = context.mode === "add-chapter-to-title" ? (context.titleName ?? "").trim() : "";
		const contextProjectLang = context.mode === "fill-existing-zero-page" ? projectStore.project?.targetLang : undefined;
		const nextLang = (context.targetLang ?? contextProjectLang ?? "th").trim() || "th";
		titleName = nextTitle;
		chapterNumber = "1";
		chapterName = "";
		targetLang = nextLang;
		const contextReadingDirection = context.mode === "fill-existing-zero-page"
			? projectStore.project?.readingDirection
			: undefined;
		sourceLang = (context.mode === "fill-existing-zero-page" ? projectStore.project?.sourceLang : undefined) ?? "ja";
		readingDirectionTouched = Boolean(contextReadingDirection);
		// Default to ltr for brand-new chapters (webtoon/vertical mode removed); an
		// existing project keeps its stored direction.
		readingDirection = contextReadingDirection ?? "ltr";
		uploadMode = "files";
		coverFile = null;
		imageFiles = [];
		pageUnsupportedSummary = "";
		// The dialog component stays mounted across closes/opens — a previous
		// session's merge toggle must never silently stitch the NEXT chapter.
		mergeEnabled = false;
		mergePerPageRaw = 10;
		clearLocalError();
		setupStage = context.mode === "add-chapter-to-title" ? "chapter" : "story";
		productionMode = "solo";
		chapterInvites = [];
		pendingSetupProjectId = null;
		// Each new-story session mints its own stable id; clear so the next story
		// (e.g. two stories with the same title) never reuses the previous id.
		mintedStoryId = "";
		dragActive = false;
	}

	function close(): void {
		if (busy) return;
		editorUiStore.closeChapterSetup();
		resetDraftForContext({ mode: "create" });
		appliedChapterSetupContextKey = "";
	}

	function onCoverChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		coverFile = input.files?.[0] ?? null;
	}

	function acceptSelectedImageFiles(files: File[]): void {
		imageFiles = orderProjectImageFiles(files);
		pageUnsupportedSummary = formatUnsupportedImageFileSummary(files);
		// Picking valid files clears any stale "missing/too many pages" error.
		if (imageFiles.length && localErrorKind === "pages") {
			clearLocalError();
		}
	}

	function onImagesChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		acceptSelectedImageFiles(Array.from(input.files ?? []));
	}

	function setUploadMode(mode: UploadMode): void {
		uploadMode = mode;
	}

	function openPagePicker(): void {
		if (uploadMode === "folder") folderInput?.click();
		else pageInput?.click();
	}

	function pageImportOrderSummary(): string {
		if (!imageFiles.length) return t("chapterSetup.dropManyHint", "เลือกได้หลายรูป ระบบเรียงหน้าให้อัตโนมัติตามชื่อไฟล์");
		if (imageFiles.length === 1) return t("chapterSetup.orderSingle", `จะเปิดเป็นหน้า 1: ${imageFiles[0].name}`, { name: imageFiles[0].name });
		const first = imageFiles[0].name;
		const last = imageFiles[imageFiles.length - 1].name;
		return t("chapterSetup.orderRange", `จะสร้างหน้า 1-${imageFiles.length} ตามชื่อไฟล์: ${first} → ${last}`, { count: imageFiles.length, first, last });
	}

	function continueToChapterStep(): void {
		if (!titleName.trim()) {
			setLocalError(t("chapterSetup.errTitleRequired", "กรอกชื่อเรื่องก่อนสร้างตอน เพื่อให้คลังงานและรายการล่าสุดไม่เป็นตอนลอยๆ"), "title");
			requestAnimationFrame(() => titleInput?.focus());
			return;
		}
		clearLocalError();
		setupStage = "chapter";
		requestAnimationFrame(() => pageInput?.focus());
	}

	function editStoryStep(): void {
		if (busy || fillExistingProject || addToExistingTitle) return;
		clearLocalError();
		setupStage = "story";
		requestAnimationFrame(() => titleInput?.focus());
	}

	async function createChapter(): Promise<void> {
		if (storyStepActive) {
			continueToChapterStep();
			return;
		}
		if (!fillExistingProject && !titleName.trim()) {
			setLocalError(t("chapterSetup.errTitleRequired", "กรอกชื่อเรื่องก่อนสร้างตอน เพื่อให้คลังงานและรายการล่าสุดไม่เป็นตอนลอยๆ"), "title");
			requestAnimationFrame(() => titleInput?.focus());
			return;
		}
		if (!imageFiles.length) {
			setLocalError(fillExistingProject ? t("chapterSetup.errPagesRequiredFill", "เลือกไฟล์รูปหน้าก่อนเพิ่มเข้าโปรเจกต์") : t("chapterSetup.errPagesRequired", "เลือกไฟล์รูปหน้าก่อนสร้างตอน"), "pages");
			requestAnimationFrame(() => pageInput?.focus());
			return;
		}
		if (imageFiles.length > MAX_CHAPTER_PAGES) {
			setLocalError(t("chapterSetup.pageLimitWarning", `เลือกรูปหน้าได้สูงสุด ${MAX_CHAPTER_PAGES.toLocaleString()} หน้า (ตอนนี้เลือก ${imageFiles.length.toLocaleString()} หน้า) เอาออกบางหน้าก่อนสร้างตอน`, { max: MAX_CHAPTER_PAGES.toLocaleString(), count: imageFiles.length.toLocaleString() }), "pages");
			requestAnimationFrame(() => pageInput?.focus());
			return;
		}
		const previousProjectId = projectStore.project?.projectId ?? null;
		busy = true;
		clearLocalError();
		pendingSetupProjectId = null;
		try {
			const targetProjectId = editorUiStore.chapterSetupContext.projectId ?? projectStore.project?.projectId ?? null;
			const shouldFillExisting = editorUiStore.chapterSetupContext.mode === "fill-existing-zero-page"
				|| Boolean(projectStore.project && projectStore.project.pages.length === 0);
			if (shouldFillExisting) {
				if (targetProjectId && projectStore.project?.projectId !== targetProjectId) {
					const opened = await projectStore.openProject(targetProjectId, editorStore.editor);
					if (opened === false) {
						setLocalError(projectStore.statusMsg || t("chapterSetup.errOpenFillFailed", "เปิดโปรเจกต์ที่จะเติมรูปไม่สำเร็จ"));
						return;
					}
				}
				const setupMetadata = buildSetupMetadata();
				await projectStore.fillEmptyProjectWithPages(imageFiles, editorStore.editor, {
					...setupMetadata,
				});
			} else {
				const setupMetadata = buildSetupMetadata();
				await projectStore.loadFilesWithSetup(imageFiles, editorStore.editor, {
					...setupMetadata,
				});
			}
			const activeProject = projectStore.project;
			const createdProjectReady = !!activeProject
				&& (shouldFillExisting ? activeProject.projectId === (targetProjectId ?? previousProjectId) : activeProject.projectId !== previousProjectId)
				&& activeProject.pages.length > 0
				&& projectStore.saveSyncStatus !== "error";
			if (createdProjectReady) {
				finishSetupAtRequestedView(activeProject, shouldFillExisting);
			} else {
				const attemptedSetupProjectId = targetProjectId ?? previousProjectId;
				const setupProjectHasUnsafeSave = !!activeProject
					&& activeProject.pages.length > 0
					&& projectStore.saveSyncStatus === "error"
					&& (shouldFillExisting
						? activeProject.projectId === attemptedSetupProjectId
						: activeProject.projectId !== previousProjectId);
				if (setupProjectHasUnsafeSave) {
					pendingSetupProjectId = activeProject.projectId;
				}
				setLocalError(projectStore.statusMsg || (shouldFillExisting ? t("chapterSetup.errFillNotReady", "เพิ่มรูปยังไม่พร้อมเปิดหน้าแก้") : t("chapterSetup.errCreateNotReady", "สร้างตอนยังไม่พร้อมเปิดหน้าแก้")));
			}
		} catch (error) {
			setLocalError(friendlyUploadError(error, fillExistingProject ? t("chapterSetup.errAddFailed", "เพิ่มรูปไม่สำเร็จ") : t("chapterSetup.errCreateFailed", "สร้างตอนไม่สำเร็จ")));
		} finally {
			busy = false;
		}
	}

	async function retrySetupSave(): Promise<void> {
		if (!projectStore.project) return;
		busy = true;
		clearLocalError();
		try {
			await projectStore.saveCurrentPage(editorStore.editor);
			const activeProject = projectStore.project;
			if (
				pendingSetupProjectId
				&& activeProject?.projectId === pendingSetupProjectId
				&& activeProject.pages.length > 0
				&& projectStore.saveSyncStatus !== "error"
			) {
				await projectStore.loadPage(activeProject.currentPage, editorStore.editor);
				finishSetupAtRequestedView(
					activeProject,
					editorUiStore.chapterSetupContext.mode === "fill-existing-zero-page",
				);
				pendingSetupProjectId = null;
				return;
			}
			setLocalError(projectStore.saveSyncStatus === "error"
				? (projectStore.statusMsg || projectStore.saveErrorMessage || t("chapterSetup.errSaveNotDone", "บันทึกยังไม่สำเร็จ"))
				: t("chapterSetup.errSavedRetry", "บันทึกงานเดิมแล้ว กดสร้างตอนอีกครั้ง"));
		} catch (error) {
			setLocalError(error instanceof Error ? error.message : t("chapterSetup.errResaveFailed", "บันทึกซ้ำไม่สำเร็จ"));
		} finally {
			busy = false;
		}
	}

	let dragActive = $state(false);

	function handleDrag(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (e.type === "dragenter" || e.type === "dragover") {
			dragActive = true;
		} else if (e.type === "dragleave") {
			// `dragleave` also fires when the pointer crosses onto a CHILD of the
			// dropzone (icon/text), which used to flip the highlight off and—if the
			// drag then ended off-target—leave it stuck. Only clear when the pointer
			// actually left the dropzone (relatedTarget is outside it / null).
			const dropzone = e.currentTarget as HTMLElement;
			const next = e.relatedTarget as Node | null;
			if (!next || !dropzone.contains(next)) {
				dragActive = false;
			}
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		dragActive = false;
		if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
			acceptSelectedImageFiles(Array.from(e.dataTransfer.files));
		}
	}

	function movePage(index: number, direction: "left" | "right") {
		if (direction === "left" && index > 0) {
			const nextImages = [...imageFiles];
			const temp = nextImages[index];
			nextImages[index] = nextImages[index - 1];
			nextImages[index - 1] = temp;
			imageFiles = nextImages;
		} else if (direction === "right" && index < imageFiles.length - 1) {
			const nextImages = [...imageFiles];
			const temp = nextImages[index];
			nextImages[index] = nextImages[index + 1];
			nextImages[index + 1] = temp;
			imageFiles = nextImages;
		}
	}

	function sortPages(direction: "asc" | "desc") {
		const sorted = [...imageFiles].sort((a, b) => {
			return direction === "asc"
				? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
				: b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" });
		});
		imageFiles = sorted;
	}

	// Drag-and-drop reorder of page thumbnails (in addition to the ◀ ▶ buttons +
	// A-Z/Z-A sort). Operates on the imageFiles index; the preview strip is a
	// prefix slice so the #each index maps 1:1 to imageFiles for the shown pages.
	let dragIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);

	function reorderPage(from: number, to: number) {
		if (from === to || from < 0 || to < 0 || from >= imageFiles.length || to >= imageFiles.length) return;
		const next = [...imageFiles];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		imageFiles = next;
	}

	function onThumbDragStart(index: number, e: DragEvent) {
		dragIndex = index;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = "move";
			// Some browsers require data to be set for the drag to start.
			try { e.dataTransfer.setData("text/plain", String(index)); } catch { /* ignore */ }
		}
	}

	function onThumbDragOver(index: number, e: DragEvent) {
		// Internal thumbnail reorder — claim the event so it never bubbles to the
		// file dropzone (which only acts on dataTransfer.files anyway).
		if (dragIndex === null) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		dragOverIndex = index;
	}

	function onThumbDrop(index: number, e: DragEvent) {
		if (dragIndex === null) return;
		e.preventDefault();
		e.stopPropagation();
		reorderPage(dragIndex, index);
		dragIndex = null;
		dragOverIndex = null;
	}

	function onThumbDragEnd() {
		dragIndex = null;
		dragOverIndex = null;
	}

	function clearImages() {
		imageFiles = [];
		pageUnsupportedSummary = "";
	}
</script>

<Dialog
	open={editorUiStore.chapterSetupOpen}
	onClose={close}
	ariaLabel={t("chapterSetup.ariaLabel", "ตั้งค่าตอนใหม่")}
	busy={busy}
	autoFocus={false}
	showClose={false}
	panelClass={`chapter-dialog ${chapterStepActive ? "chapter-dialog--chapter" : "chapter-dialog--story"}`}
>
	{#snippet header()}
		<header class="chapter-dialog-header">
			<span>{dialogEyebrow}</span>
			<h2>{dialogTitle}</h2>
			<p>{dialogDescription}</p>
		</header>
	{/snippet}

		<div class="setup-steps" aria-label={t("chapterSetup.stepsAria", "ขั้นตอนสร้างงาน")}>
			<span class:active={storyStepActive || addToExistingTitle}>{addToExistingTitle ? t("chapterSetup.stepStorySelected", "1 เรื่องที่เลือก") : t("chapterSetup.stepStory", "1 สร้างเรื่อง")}</span>
			<span class:active={chapterStepActive}>{importReviewIntent ? t("chapterSetup.stepUpload", "2 อัปโหลดรูปหน้า") : t("chapterSetup.stepChapter", "2 สร้างตอน")}</span>
		</div>

		<div class="setup-grid">
			{#if storyStepActive}
				<label class="wide">
					<span>{t("chapterSetup.storyName", "ชื่อเรื่อง")} <span class="req" aria-hidden="true">*</span><span class="sr-only">{t("chapterSetup.required", "(จำเป็น)")}</span></span>
					<input
						id="chapter-setup-title"
						name="chapterTitle"
						bind:this={titleInput}
						bind:value={titleName}
						placeholder={t("chapterSetup.storyNamePlaceholder", "เช่น Moonlit Courier")}
						autocomplete="off"
						required
						aria-required="true"
						aria-label={t("chapterSetup.storyName", "ชื่อเรื่อง")}
						aria-invalid={Boolean(titleFieldError)}
						aria-describedby={titleFieldError ? "chapter-setup-title-error" : undefined}
					/>
					{#if titleFieldError}
						<small id="chapter-setup-title-error" class="field-error">{titleFieldError}</small>
					{:else}
						<small class="field-hint">{t("chapterSetup.storyNameHint", "เรื่องหนึ่งเรื่องสามารถมีหลายตอนและหลายภาษาได้ ภายหลังจะเพิ่มตอนจากเรื่องนี้โดยไม่ต้องตั้งใหม่")}</small>
					{/if}
				</label>
				<label class="wide">
					<span>{t("chapterSetup.cover", "รูปปก")} <span class="opt">{t("chapterSetup.optional", "(ไม่บังคับ)")}</span></span>
					<div class="file-field">
						<input id="chapter-setup-cover" name="coverImage" bind:this={coverInput} class="file-input-hidden" type="file" accept={imageAccept} onchange={onCoverChange} />
						<button type="button" onclick={() => coverInput?.click()}>{t("chapterSetup.pickCover", "เลือกรูปปก")}</button>
						<strong>{coverSummary}</strong>
					</div>
					<small class="field-hint">{t("chapterSetup.coverHintStory", "ถ้ายังไม่มีปก ใช้รูปหน้าแรกเป็นปกชั่วคราวได้ตอนสร้างตอน")}</small>
					{#if coverPreviewUrl}
						<figure class="cover-file-preview">
							<img src={coverPreviewUrl} alt={t("chapterSetup.coverAlt", `ปก: ${coverFile?.name ?? "รูปปก"}`, { name: coverFile?.name ?? t("chapterSetup.coverFallbackName", "รูปปก") })} />
							<figcaption>{coverFile?.name}</figcaption>
						</figure>
					{/if}
				</label>
				{#if importReviewIntent}
					<section class="page-upload-promise" aria-label={t("chapterSetup.uploadPromiseAria", "ขั้นถัดไปอัปโหลดรูปหน้า")}>
						<span>{t("chapterSetup.uploadPromiseNext", "ถัดไปหลังตั้งชื่อเรื่อง")}</span>
						<strong>{t("chapterSetup.uploadPromiseTitle", "อัปโหลดรูปหน้าตอนก่อน Import ข้อความ")}</strong>
						<small>{t("chapterSetup.uploadPromiseHint", "ปุ่มต่อไปจะเปิดช่องเลือกรูปหน้า และสร้างเสร็จจะพาไป Import / Review")}</small>
					</section>
				{/if}
			{:else}
				{#if !fillExistingProject}
					<section class="story-lock" aria-label={t("chapterSetup.storyLockAria", "เรื่องที่กำลังสร้างตอน")}>
						<div>
							<span>{t("chapterSetup.story", "เรื่อง")}</span>
							<strong>{titleName.trim()}</strong>
							<small>{coverPreviewSummary}</small>
						</div>
						{#if busy}
							<span class="setup-action-receipt">{t("chapterSetup.creatingChapter", "กำลังสร้างตอน")}</span>
						{:else if addToExistingTitle}
							<span class="setup-action-receipt">{t("chapterSetup.chosenFromLibrary", "เลือกจากคลังงาน")}</span>
						{:else}
							<button type="button" onclick={editStoryStep}>{t("chapterSetup.editStory", "แก้เรื่อง")}</button>
						{/if}
					</section>
				{/if}
				<label>
					<span>{t("chapterSetup.chapterNumber", "ตอนที่")}</span>
					<input id="chapter-setup-number" name="chapterNumber" bind:value={chapterNumber} placeholder={t("chapterSetup.chapterNumberPlaceholder", "104")} autocomplete="off" />
				</label>
				<label class="wide">
					<span>{t("chapterSetup.chapterName", "ชื่อตอน")}</span>
					<input id="chapter-setup-name" name="chapterName" bind:value={chapterName} placeholder={t("chapterSetup.chapterNamePlaceholder", "ตอนพิเศษ หรือชื่อตอนที่ต้องการ")} autocomplete="off" />
				</label>
				<label>
					<span>{t("chapterSetup.targetLang", "ภาษาเป้าหมาย")} <span class="req" aria-hidden="true">*</span><span class="sr-only">{t("chapterSetup.required", "(จำเป็น)")}</span></span>
					<LanguagePicker
						id="chapter-setup-target-lang"
						value={targetLang}
						ariaLabel={t("chapterSetup.targetLangAria", "ภาษาเป้าหมาย")}
						placeholder={t("chapterSetup.targetLangPlaceholder", "ค้นหาภาษาเป้าหมาย…")}
						onChange={(code) => (targetLang = code)}
					/>
					<small class="field-hint">{t("chapterSetup.targetLangHint", "เปลี่ยนได้ทุกเมื่อ และเพิ่มภาษาเป้าหมายอื่นให้ตอนนี้ภายหลังได้")}</small>
				</label>
				<label>
					<span>{t("chapterSetup.sourceLang", "ภาษาต้นฉบับ")} <span class="req" aria-hidden="true">*</span><span class="sr-only">{t("chapterSetup.required", "(จำเป็น)")}</span></span>
					<LanguagePicker
						id="chapter-setup-source-lang"
						value={sourceLang}
						ariaLabel={t("chapterSetup.sourceLangAria", "ภาษาต้นฉบับ")}
						placeholder={t("chapterSetup.sourceLangPlaceholder", "ค้นหาภาษาต้นฉบับ…")}
						onChange={(code) => (sourceLang = code)}
					/>
					<small class="field-hint">{t("chapterSetup.sourceLangHint", "ภาษาของไฟล์ต้นฉบับ เลือกได้อิสระ ไม่ได้ล็อกเป็นญี่ปุ่น")}</small>
				</label>
				<fieldset class="reading-direction-field wide">
					<legend>{t("chapterSetup.readingDirection", "ทิศทางการอ่าน")} <span class="req" aria-hidden="true">*</span><span class="sr-only">{t("chapterSetup.required", "(จำเป็น)")}</span> {t("chapterSetup.readingDirectionDefault", "· ค่าเริ่มต้นคือเว็บตูน")}</legend>
					<div class="reading-direction-options" role="radiogroup" aria-label={t("chapterSetup.readingDirectionAria", "ทิศทางการอ่านของตอนนี้")}>
						{#each READING_DIRECTION_OPTIONS as option (option.value)}
							<button
								type="button"
								class="reading-direction-option"
								class:active={readingDirection === option.value}
								role="radio"
								aria-checked={readingDirection === option.value}
								onclick={() => selectReadingDirection(option.value)}
							>
								<span class="reading-direction-icon" aria-hidden="true">{option.icon}</span>
								<strong>{readingDirectionLabel(option.value)}</strong>
								<small>{readingDirectionHelper(option.value)}</small>
							</button>
						{/each}
					</div>
					<small class="field-hint reading-direction-hint">{t("chapterSetup.readingDirectionHint", "เปลี่ยนได้ตลอดเวลา — สลับทิศการอ่านในตอนได้ภายหลังจากแถบเครื่องมือ")}</small>
					{#if showReadingDirectionSuggestion}
						<button type="button" class="reading-direction-suggest" onclick={applyReadingDirectionSuggestion}>
							{t("chapterSetup.readingDirectionSuggest", `ภาษาต้นฉบับนี้มักอ่านแบบ “${readingDirectionLabel(readingDirectionSuggestion)}” · กดเพื่อใช้`, { label: readingDirectionLabel(readingDirectionSuggestion) })}
						</button>
					{/if}
				</fieldset>
				{#if !fillExistingProject}
					<fieldset class="chapter-team-field wide">
						<legend>{t("chapterSetup.teamLegend", "ทีมทำงานในตอนนี้ · เลือกทำคนเดียวหรือชวนทีม")}</legend>
						<ChapterTeamManager mode="draft" bind:productionMode bind:invites={chapterInvites} />
						<small class="field-hint">{t("chapterSetup.teamHint", "เลือก Team แล้วชวนคนด้วยอีเมลหรือ UID เลือกบทบาท และเปลี่ยน/เพิ่มทีมภายหลังได้")}</small>
					</fieldset>
				{/if}
				{#if fillExistingProject}
					<label class="wide cover-section">
						<span>{t("chapterSetup.chapterCover", "รูปปกของตอน")} <span class="opt">{t("chapterSetup.optional", "(ไม่บังคับ)")}</span></span>
						<div class="file-field">
							<input id="chapter-setup-cover" name="coverImage" bind:this={coverInput} class="file-input-hidden" type="file" accept={imageAccept} onchange={onCoverChange} />
							<button type="button" onclick={() => coverInput?.click()}>{t("chapterSetup.pickCover", "เลือกรูปปก")}</button>
							<strong>{coverSummary}</strong>
						</div>
						<small class="field-hint">{t("chapterSetup.coverHintChapter", "ปกใช้แสดงในคลังงาน แยกจากรูปหน้าด้านล่าง ถ้าไม่เลือกจะใช้รูปหน้าแรกเป็นปกชั่วคราว")}</small>
						{#if coverPreviewUrl}
							<figure class="cover-file-preview">
								<img src={coverPreviewUrl} alt={t("chapterSetup.coverAlt", `ปก: ${coverFile?.name ?? "รูปปก"}`, { name: coverFile?.name ?? t("chapterSetup.coverFallbackName", "รูปปก") })} />
								<figcaption>{coverFile?.name}</figcaption>
							</figure>
						{/if}
					</label>
				{/if}
				<label class="wide pages-section">
					<span class="pages-label-row">
						<span>{t("chapterSetup.chapterPages", "รูปหน้าของตอน")} <span class="req" aria-hidden="true">*</span><span class="sr-only">{t("chapterSetup.required", "(จำเป็น)")}</span></span>
						<span class="upload-mode-toggle" role="radiogroup" aria-label={t("chapterSetup.uploadModeAria", "วิธีอัปโหลดรูปหน้า")}>
							<button
								type="button"
								class="upload-mode-btn"
								class:active={uploadMode === "files"}
								role="radio"
								aria-checked={uploadMode === "files"}
								onclick={() => setUploadMode("files")}
							>{t("chapterSetup.uploadModeFiles", "หลายไฟล์")}</button>
							<button
								type="button"
								class="upload-mode-btn"
								class:active={uploadMode === "folder"}
								role="radio"
								aria-checked={uploadMode === "folder"}
								onclick={() => setUploadMode("folder")}
							>{t("chapterSetup.uploadModeFolder", "ทั้งโฟลเดอร์")}</button>
						</span>
					</span>
					<div
						class="dropzone-area file-field"
						class:drag-active={dragActive}
						class:error={Boolean(pageFieldError) || pagesOverLimit}
						ondragenter={handleDrag}
						ondragover={handleDrag}
						ondragleave={handleDrag}
						ondrop={handleDrop}
						onclick={openPagePicker}
						role="button"
						tabindex="0"
						onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") openPagePicker(); }}
					>
						<input
							id="chapter-setup-pages"
							name="pageImages"
							bind:this={pageInput}
							class="file-input-hidden"
							type="file"
							accept={imageAccept}
							multiple
							onchange={onImagesChange}
							aria-invalid={Boolean(pageFieldError)}
							aria-describedby={pageFieldError ? "chapter-setup-pages-error" : undefined}
						/>
						<input
							id="chapter-setup-pages-folder"
							name="pageImagesFolder"
							bind:this={folderInput}
							class="file-input-hidden"
							type="file"
							accept={imageAccept}
							multiple
							webkitdirectory
							onchange={onImagesChange}
						/>

						<svg class="dropzone-icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="17 8 12 3 7 8" />
							<line x1="12" y1="3" x2="12" y2="15" />
						</svg>

						<strong>{t("chapterSetup.dropzoneTitle", "ลากรูปภาพหน้าตอนมาวางที่นี่")}</strong>
						{#if uploadMode === "folder"}
							{@const parts = t("chapterSetup.dropzoneFolder", "หรือคลิกพื้นที่ %TOKEN% ระบบจะดึงรูปทุกหน้าในโฟลเดอร์ให้").split("%TOKEN%")}
							<span>{parts[0]}<span class="dropzone-picker-token">{t("chapterSetup.dropzoneFolderToken", "เลือกทั้งโฟลเดอร์")}</span>{parts[1] ?? ""}</span>
						{:else}
							{@const parts = t("chapterSetup.dropzoneFiles", "หรือคลิกพื้นที่ %TOKEN% เลือกได้หลายไฟล์พร้อมกัน").split("%TOKEN%")}
							<span>{parts[0]}<span class="dropzone-picker-token">{t("chapterSetup.dropzoneFilesToken", "เลือกรูปหน้า")}</span>{parts[1] ?? ""}</span>
						{/if}
						<small class="dropzone-limit">{t("chapterSetup.dropzoneLimit", `รองรับไฟล์ JPG, PNG, WEBP (สูงสุด ${MAX_CHAPTER_PAGES.toLocaleString()} หน้า)`, { max: MAX_CHAPTER_PAGES.toLocaleString() })}</small>
						<span style="position: absolute; width: 1px; height: 1px; overflow: hidden; opacity: 0;">{pageFileSummary}</span>
					</div>

					{#if pagesOverLimit}
						<small id="chapter-setup-pages-error" class="field-error">{pageLimitWarning}</small>
					{:else if pageFieldError}
						<small id="chapter-setup-pages-error" class="field-error">{pageFieldError}</small>
					{:else}
						<small class="field-hint">{pageOrderSummary}</small>
					{/if}
					{#if pageUnsupportedSummary}
						<small class="field-warning">{pageUnsupportedSummary}</small>
					{/if}
					{#if pagePreviewItems.length}
						<section class="page-import-preview" aria-label={t("chapterSetup.previewAria", "ตัวอย่างรูปหน้าก่อนสร้างตอน")}>
							<div class="preview-header">
								<div>
									<span>{t("chapterSetup.previewSortable", "รูปตัวอย่างจัดเรียงได้")}</span>
									<small style="color: var(--editor-text-muted); display: block; margin-top: 2px;">{t("chapterSetup.previewSortHint", "กดลูกศร ◀ ▶ เพื่อเปลี่ยนลำดับภาพ หรือกดปุ่มเรียงชื่อภาพอัตโนมัติ")}</small>
								</div>
								<div class="preview-sort-actions">
									<button type="button" class="preview-sort-btn" onclick={() => sortPages("asc")}>A-Z</button>
									<button type="button" class="preview-sort-btn" onclick={() => sortPages("desc")}>Z-A</button>
									<button type="button" class="preview-sort-btn danger" onclick={clearImages}>{t("chapterSetup.previewClear", "ล้าง")}</button>
								</div>
								<strong>{t("chapterSetup.pageCount", `${imageFiles.length} หน้า`, { count: imageFiles.length })}</strong>
							</div>
							<div class="preview-strip">
								{#each pagePreviewItems as item, index (item.id)}
									<figure
										class="page-thumb"
										class:dragging={dragIndex === index}
										class:drag-over={dragOverIndex === index && dragIndex !== index}
										draggable="true"
										ondragstart={(e) => onThumbDragStart(index, e)}
										ondragover={(e) => onThumbDragOver(index, e)}
										ondrop={(e) => onThumbDrop(index, e)}
										ondragend={onThumbDragEnd}
										title={t("chapterSetup.dragToReorder", "ลากเพื่อสลับตำแหน่งหน้า")}
									>
										<div class="figure-thumb-container">
											<img src={item.url} alt={t("chapterSetup.pageThumbAlt", `หน้า ${item.pageNumber}: ${item.name}`, { n: item.pageNumber, name: item.name })} draggable="false" />
											<div class="figure-arrow-overlay">
												{#if index > 0}
													<button
														type="button"
														class="arrow-btn"
														onclick={(e) => { e.stopPropagation(); movePage(index, "left"); }}
														aria-label={t("chapterSetup.moveUp", "เลื่อนขึ้น")}
													>
														◀
													</button>
												{:else}
													<span class="arrow-btn arrow-placeholder" aria-hidden="true">◀</span>
												{/if}
												{#if index < imageFiles.length - 1}
													<button
														type="button"
														class="arrow-btn"
														onclick={(e) => { e.stopPropagation(); movePage(index, "right"); }}
														aria-label={t("chapterSetup.moveDown", "เลื่อนลง")}
													>
														▶
													</button>
												{:else}
													<span class="arrow-btn arrow-placeholder" aria-hidden="true">▶</span>
												{/if}
											</div>
										</div>
										<figcaption>
											<strong>P{item.pageNumber}</strong>
											<span title={item.name}>{item.name}</span>
										</figcaption>
									</figure>
								{/each}
								{#if pagePreviewHiddenCount}
									<div class="preview-more" aria-label={t("chapterSetup.moreHidden", `ยังมีอีก ${pagePreviewHiddenCount} หน้า`, { count: pagePreviewHiddenCount })}>
										<span>+{pagePreviewHiddenCount}</span>
										<small>{t("chapterSetup.pagesUnit", "หน้า")}</small>
									</div>
								{/if}
							</div>
						</section>
					{/if}
				</label>

				<!-- Advanced: merge N source slices into 1 page (webtoon). -->
				<div class="merge-option">
					<label class="merge-toggle">
						<input type="checkbox" bind:checked={mergeEnabled} disabled={busy} />
						<span>{t("chapterSetup.mergeToggle", "รวมหลายรูปเป็นหน้าเดียว (เว็บตูน)")}</span>
					</label>
					{#if mergeEnabled}
						<div class="merge-controls">
							<label class="merge-count">
								{t("chapterSetup.mergePerPage", "รูปต่อหน้า")}
								<input
									type="number"
									min={MERGE_PER_PAGE_MIN}
									max={MERGE_PER_PAGE_MAX}
									bind:value={mergePerPageRaw}
									disabled={busy}
									aria-label={t("chapterSetup.mergePerPageAria", "จำนวนรูปต้นฉบับต่อหนึ่งหน้า")}
								/>
							</label>
							{#if imageFiles.length >= 2}
								<span class="merge-result" role="status">
									{t("chapterSetup.mergeResult", `${imageFiles.length} รูป → ${mergedPageCount} หน้า`, { files: imageFiles.length, pages: mergedPageCount })}
								</span>
							{:else}
								<span class="merge-result">{t("chapterSetup.mergeNeedsFiles", "เลือกรูปอย่างน้อย 2 รูปก่อน")}</span>
							{/if}
						</div>
						<small class="merge-hint">{t("chapterSetup.mergeHint", "รูปจะถูกต่อกันแนวตั้งตามลำดับ และหน้าที่ได้จะถือเป็นรูปต้นฉบับของตอนนี้")}</small>
					{/if}
				</div>
			{/if}
		</div>

		{#if chapterStepActive}
			<div class="setup-preview" aria-label={t("chapterSetup.previewSummaryAria", "สรุปตอนที่จะสร้าง")}>
				<div>
					<span>{setupSummaryLabel}</span>
					<strong>{fillExistingProject ? (projectStore.project?.name || projectNamePreview) : projectNamePreview}</strong>
				</div>
				<div>
					<span>{t("chapterSetup.pageImagesLabel", "รูปหน้า")}</span>
					<strong>{imageSummary}</strong>
				</div>
				<div>
					<span>{t("chapterSetup.coverLabel", "ปก")}</span>
					<strong>{coverPreviewSummary}</strong>
				</div>
			</div>
		{/if}

		{#if busy && activeUploadProgress}
			<section class="setup-progress" aria-label={t("chapterSetup.progressAria", "ความคืบหน้าการอัปโหลด")} bind:this={progressSection}>
				<div class="setup-progress-head">
					<strong>{uploadProgressLabel}</strong>
					<span>{uploadProgressPercent}%</span>
				</div>
				<ProgressBar value={uploadProgressPercent} gradient="violet-fuchsia" ariaLabel={t("chapterSetup.progressBarAria", "ความคืบหน้าการอัปโหลดรูปหน้า")} />
			</section>
		{/if}

		{#if localError && !setupRecoveryMessage && !titleFieldError && !pageFieldError}
			<p class="setup-error">{localError}</p>
		{/if}

		{#if setupRecoveryMessage}
			<section class="setup-recovery" role="alert" aria-label={t("chapterSetup.recoveryAria", "สร้างตอนยังไม่ปลอดภัย")}>
				<div>
					<span>{t("chapterSetup.recoveryDontClose", "ยังไม่ควรปิดหน้านี้")}</span>
					<strong>{t("chapterSetup.recoveryTitle", "สร้างตอนยังไม่บันทึกปลอดภัย")}</strong>
					<p>{setupRecoveryMessage}</p>
				</div>
				{#if busy}
					<span class="setup-action-receipt">{t("chapterSetup.recoveryRetrying", "กำลังลองบันทึก...")}</span>
				{:else if projectStore.project}
					<button type="button" onclick={retrySetupSave}>{t("chapterSetup.recoveryRetry", "ลองบันทึกอีกครั้ง")}</button>
				{:else}
					<span class="setup-action-receipt">{t("chapterSetup.recoveryOpenFirst", "เปิดตอนก่อนลองบันทึก")}</span>
				{/if}
			</section>
		{/if}

	{#snippet footer()}
		{#if footerSetupHint && !busy}
			<p class="setup-footer-hint" role="status" aria-live="polite">{footerSetupHint}</p>
		{/if}
		<div class="setup-footer-actions" class:busy>
			{#if busy}
				<span class="setup-action-receipt">{t("chapterSetup.footerCreating", "กำลังสร้างตอน")}</span>
				<span class="setup-action-receipt primary">{busyLabel}</span>
			{:else}
				<button type="button" class="setup-cancel-btn" onclick={close}>{t("chapterSetup.cancel", "ยกเลิก")}</button>
				<button type="button" class="primary" onclick={createChapter}>{submitLabel}</button>
			{/if}
		</div>
	{/snippet}
</Dialog>

<style>
	/* The shared Dialog atom owns the layer/backdrop/panel/body/footer chrome.
		These rules only style the chapter-setup content + header. */
	:global(.chapter-dialog) {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		overflow: hidden;
	}

	:global(.chapter-dialog > .ws-dialog-body) {
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	:global(.chapter-dialog > .ws-dialog-footer) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
	}

	.chapter-dialog-header {
		display: grid;
		gap: 4px;
		padding: 18px 18px 14px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.chapter-dialog-header span,
	label span,
	.setup-preview span,
	.setup-recovery span {
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 850;
	}

	.chapter-dialog-header h2 {
		margin: 2px 0;
		color: var(--color-ws-ink);
		font-size: 24px;
		font-weight: 800;
		line-height: 1.1;
	}

	.chapter-dialog-header p {
		margin: 0;
		max-width: 620px;
		color: var(--color-ws-text);
		font-size: 13px;
		line-height: 1.55;
	}

	.setup-grid {
		display: grid;
		grid-template-columns: 1fr 180px;
		gap: 12px;
	}

	.setup-steps {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
		margin-bottom: 14px;
	}

	.setup-steps span {
		display: flex;
		min-height: 38px;
		align-items: center;
		justify-content: center;
		border: 1px solid rgba(166, 183, 220, 0.14);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.045);
		color: var(--editor-text-muted);
		font-size: 12px;
		font-weight: 880;
	}

	.setup-steps span.active {
		border-color: rgba(124, 92, 255, 0.45);
		background: rgba(124, 92, 255, 0.14);
		color: #efeaff;
	}

	label {
		display: grid;
		gap: 7px;
	}

	label.wide {
		grid-column: 1 / -1;
	}

	.reading-direction-field {
		grid-column: 1 / -1;
		margin: 0;
		border: 0;
		padding: 0;
		min-width: 0;
	}

	.reading-direction-field legend {
		padding: 0;
		margin-bottom: 7px;
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 850;
	}

	.reading-direction-options {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
	}

	.reading-direction-option {
		display: grid;
		gap: 4px;
		min-height: auto;
		justify-items: start;
		text-align: left;
		padding: 10px 12px;
		border: 1px solid rgba(166, 183, 220, 0.18);
		border-radius: 10px;
		background: rgba(4, 7, 12, 0.6);
		color: var(--editor-text);
		cursor: pointer;
	}

	.reading-direction-option:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 6%, transparent);
	}

	.reading-direction-option.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-ws-accent) 25%, transparent);
	}

	.reading-direction-icon {
		font-size: 20px;
		font-weight: 900;
		line-height: 1;
		color: color-mix(in srgb, var(--color-ws-accent) 78%, #ffffff);
	}

	.reading-direction-option strong {
		font-size: 13px;
		font-weight: 850;
	}

	.reading-direction-option small {
		color: var(--editor-text-muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 1.35;
		white-space: normal;
	}

	.story-lock {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		border: 1px solid rgba(124, 92, 255, 0.24);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(124, 92, 255, 0.07);
		padding: 12px;
	}

	.story-lock div {
		display: grid;
		min-width: 0;
		gap: 3px;
	}

	.page-upload-promise {
		display: grid;
		grid-column: 1 / -1;
		gap: 4px;
		border: 1px solid rgba(124, 92, 255, 0.26);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: linear-gradient(135deg, rgba(124, 92, 255, 0.14), rgba(217, 70, 239, 0.08));
		padding: 12px;
	}

	.page-upload-promise span {
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 850;
	}

	.page-upload-promise strong {
		color: var(--color-ws-ink);
		font-size: 15px;
		font-weight: 900;
		line-height: 1.25;
	}

	.page-upload-promise small {
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 760;
		line-height: 1.35;
	}

	.story-lock span {
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 850;
	}

	.story-lock strong,
	.story-lock small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.story-lock strong {
		color: var(--editor-text);
		font-size: 15px;
		font-weight: 900;
	}

	.story-lock small {
		color: var(--editor-text-muted);
		font-size: 12px;
		font-weight: 760;
	}

	/* Required-field asterisk + optional tag + a11y-only label text. */
	.req {
		color: #ff8585;
		font-weight: 900;
	}

	.opt {
		color: var(--editor-text-muted);
		font-size: 10px;
		font-weight: 700;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.pages-label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	/* Multi-file vs whole-folder upload-mode toggle. */
	.upload-mode-toggle {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border: 1px solid rgba(166, 183, 220, 0.18);
		border-radius: 9px;
		background: rgba(4, 7, 12, 0.6);
	}

	.upload-mode-btn {
		min-height: 28px !important;
		padding: 0 12px !important;
		border: 1px solid transparent !important;
		border-radius: 7px !important;
		background: transparent !important;
		color: var(--editor-text-muted) !important;
		font-size: 11px !important;
		font-weight: 850 !important;
		cursor: pointer;
	}

	.upload-mode-btn.active {
		border-color: rgba(124, 92, 255, 0.45) !important;
		background: rgba(124, 92, 255, 0.16) !important;
		color: #efeaff !important;
	}

	.reading-direction-hint {
		grid-column: 1 / -1;
		margin-top: 8px;
	}

	.reading-direction-suggest {
		grid-column: 1 / -1;
		justify-self: start;
		min-height: 32px;
		margin-top: 6px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 40%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
		color: color-mix(in srgb, var(--color-ws-accent) 72%, #ffffff);
		font-size: 12px;
		font-weight: 800;
		cursor: pointer;
	}

	.reading-direction-suggest:hover {
		background: color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
	}

	/* Upload progress block (real determinate bar during create/fill). */
	.setup-progress {
		display: grid;
		gap: 8px;
		margin-top: 14px;
		padding: 14px;
		border: 1px solid rgba(124, 92, 255, 0.28);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(124, 92, 255, 0.08);
	}

	.setup-progress-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.setup-progress-head strong {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 850;
	}

	.setup-progress-head span {
		color: #cbb9ff;
		font-size: 12px;
		font-weight: 900;
	}

	input,
	.file-field {
		min-height: 42px;
		width: 100%;
		border: 1px solid rgba(166, 183, 220, 0.18);
		border-radius: 8px;
		background: rgba(4, 7, 12, 0.86);
		color: var(--editor-text);
		font: inherit;
		font-size: 13px;
		padding: 8px 10px;
	}

	input[aria-invalid="true"] {
		border-color: rgba(248, 113, 113, 0.58);
		background: rgba(69, 10, 10, 0.36);
		box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.18);
	}

	.file-field.error {
		border-color: rgba(248, 113, 113, 0.58);
		background: rgba(69, 10, 10, 0.36);
		box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.18);
	}

	.field-error,
	.field-hint,
	.field-warning {
		color: #ffb4a8;
		font-size: 12px;
		font-weight: 780;
		line-height: 1.35;
	}

	.field-hint {
		color: var(--editor-text-muted);
		font-weight: 720;
	}

	.field-warning {
		color: #ffd28a;
	}

	.file-field {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px;
	}

	.file-field button {
		min-height: 40px;
		flex: 0 0 auto;
		padding: 0 12px;
	}

	.file-field strong {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text-muted);
		font-size: 12px;
		font-weight: 800;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-input-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		min-height: 1px;
		border: 0;
		overflow: hidden;
		padding: 0;
		clip: rect(0 0 0 0);
		opacity: 0;
		pointer-events: none;
		white-space: nowrap;
	}

	.setup-preview {
		display: grid;
		grid-template-columns: 1.4fr 1fr 1fr;
		gap: 10px;
		margin-top: 14px;
		padding: 14px;
		border: 1px solid rgba(124, 92, 255, 0.22);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(124, 92, 255, 0.06);
	}

	.setup-preview div {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.setup-preview strong,
	.setup-preview div > strong {
		color: var(--color-ws-ink);
	}

	.setup-preview strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cover-file-preview {
		display: grid;
		grid-template-columns: 72px minmax(0, 1fr);
		gap: 10px;
		align-items: center;
		margin: 0;
		border: 1px solid rgba(166, 183, 220, 0.14);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.04);
		padding: 8px;
	}

	.cover-file-preview img {
		width: 72px;
		height: 96px;
		border-radius: 7px;
		object-fit: cover;
		background: rgba(4, 7, 12, 0.8);
	}

	.cover-file-preview figcaption {
		min-width: 0;
		overflow: hidden;
		color: var(--editor-text-muted);
		font-size: 12px;
		font-weight: 780;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dropzone-area {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 140px;
		padding: 24px;
		border: 2px dashed rgba(166, 183, 220, 0.2);
		border-radius: 12px;
		background: rgba(4, 7, 12, 0.5);
		cursor: pointer;
		text-align: center;
		transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
		width: 100%;
		outline: none;
	}

	.dropzone-area:hover,
	.dropzone-area.drag-active {
		border-color: rgba(124, 92, 255, 0.6);
		background: rgba(124, 92, 255, 0.08);
		box-shadow: 0 4px 20px rgba(124, 92, 255, 0.15);
	}

	.dropzone-area.error {
		border-color: rgba(248, 113, 113, 0.5);
		background: rgba(69, 10, 10, 0.2);
	}

	.dropzone-icon {
		color: #94a3b8;
		margin-bottom: 12px;
		transition: all 0.3s ease;
	}

	.dropzone-area:hover .dropzone-icon,
	.dropzone-area.drag-active .dropzone-icon {
		color: #b9a8ff;
		transform: translateY(-2px);
	}

	.dropzone-area strong {
		color: #e2e8f0;
		font-size: 14px;
		font-weight: 800;
		margin-bottom: 4px;
	}

	.dropzone-area span {
		color: #94a3b8;
		font-size: 12px;
		font-weight: 600;
		margin-bottom: 8px;
	}

	.dropzone-picker-token {
		display: inline-flex;
		min-height: 28px;
		align-items: center;
		padding: 2px 8px;
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.08);
		color: #fff !important;
		font-size: 11px !important;
	}

	.dropzone-limit {
		color: #64748b;
		font-size: 11px;
		font-weight: 600;
	}

	.preview-sort-actions {
		display: flex;
		gap: 6px;
	}

	.preview-sort-btn {
		min-height: 40px !important;
		min-width: 40px;
		padding: 0 8px;
		border: 1px solid rgba(255, 255, 255, 0.1) !important;
		border-radius: 6px !important;
		background: rgba(255, 255, 255, 0.05) !important;
		color: #e2e8f0 !important;
		font-size: 10px !important;
		font-weight: 800 !important;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s ease;
	}

	.preview-sort-btn:hover {
		border-color: rgba(59, 130, 246, 0.5) !important;
		background: rgba(30, 41, 59, 0.5) !important;
		color: #ffffff !important;
	}

	.preview-sort-btn.danger {
		border-color: rgba(239, 68, 68, 0.2) !important;
		background: rgba(239, 68, 68, 0.1) !important;
		color: #fca5a5 !important;
	}

	.preview-sort-btn.danger:hover {
		border-color: #ef4444 !important;
		background: #ef4444 !important;
		color: #ffffff !important;
		box-shadow: 0 0 10px rgba(239, 68, 68, 0.3);
	}

	.page-import-preview {
		display: grid;
		gap: 12px;
		margin-top: 4px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 12px;
		background: rgba(22, 26, 33, 0.3);
		padding: 12px;
	}

	.preview-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-bottom: 8px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}

	.preview-header strong {
		color: #f8fafc;
		font-size: 12px;
		font-weight: 850;
	}

	.preview-strip {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
		gap: 10px;
		max-height: 280px;
		overflow-y: auto;
		padding-right: 4px;
		scrollbar-width: thin;
	}

	.preview-strip figure,
	.preview-more {
		min-width: 0;
		margin: 0;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 10px;
		background: rgba(15, 23, 42, 0.6);
		overflow: hidden;
	}

	.preview-strip figure {
		display: flex;
		flex-direction: column;
		position: relative;
	}

	.preview-strip figure.page-thumb {
		cursor: grab;
		border-radius: 8px;
		transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
	}
	.preview-strip figure.page-thumb:active {
		cursor: grabbing;
	}
	.preview-strip figure.page-thumb.dragging {
		opacity: 0.45;
		transform: scale(0.97);
	}
	.preview-strip figure.page-thumb.drag-over {
		box-shadow: 0 0 0 2px #8b5cf6, 0 0 0 6px rgba(139, 92, 246, 0.25);
		transform: translateY(-2px);
	}

	.figure-thumb-container {
		position: relative;
		width: 100%;
		aspect-ratio: 2 / 3;
		overflow: hidden;
		background: #020617;
		display: flex;
		align-items: center;
		justify-content: center;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}

	.preview-strip img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition: transform 0.3s ease;
	}

	.preview-strip figure:hover img {
		transform: scale(1.05);
	}

	.figure-arrow-overlay {
		position: absolute;
		bottom: 4px;
		left: 0;
		right: 0;
		display: flex;
		justify-content: center;
		gap: 4px;
		padding: 0 4px;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.2s ease;
		z-index: 10;
	}

	.preview-strip figure:hover .figure-arrow-overlay {
		opacity: 1;
		pointer-events: auto;
	}

	.arrow-btn {
		min-height: 40px !important;
		min-width: 40px;
		padding: 0;
		border: 1px solid rgba(255, 255, 255, 0.15) !important;
		border-radius: 50% !important;
		background: rgba(15, 23, 42, 0.85) !important;
		backdrop-filter: blur(4px);
		color: #ffffff !important;
		font-size: 8px !important;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.arrow-btn:hover {
		background: #3b82f6 !important;
		border-color: #3b82f6 !important;
		box-shadow: 0 0 8px rgba(59, 130, 246, 0.5);
	}

	.arrow-placeholder {
		opacity: 0.3 !important;
		cursor: default !important;
		pointer-events: none;
	}

	.preview-strip figcaption {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding: 6px;
	}

	.preview-strip figcaption strong {
		color: #e2e8f0;
		font-size: 11px;
		font-weight: 850;
	}

	.preview-strip figcaption span {
		min-width: 0;
		overflow: hidden;
		color: #64748b;
		font-size: 10px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.preview-more {
		display: grid;
		min-height: 112px;
		place-items: center;
		align-content: center;
		color: #efeaff;
	}

	.preview-more span {
		color: #efeaff;
		font-size: 18px;
		font-weight: 940;
	}

	.preview-more small {
		color: var(--editor-text-muted);
		font-size: 11px;
		font-weight: 780;
	}

	.setup-error {
		margin: 12px 0 0;
		color: #ffb4a8;
		font-size: 13px;
		font-weight: 800;
	}

	.setup-recovery {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		margin: 14px 0 0;
		border: 1px solid rgba(255, 180, 120, 0.36);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(255, 180, 120, 0.08);
		padding: 14px;
	}

	.setup-recovery div {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.setup-recovery strong {
		color: #fff2d8;
		font-size: 14px;
	}

	.setup-recovery p {
		margin: 0;
		color: var(--color-ws-text);
		font-size: 12px;
		line-height: 1.5;
	}

	.setup-recovery button {
		min-width: 142px;
		border-color: rgba(255, 203, 128, 0.42);
		background: rgba(255, 203, 128, 0.12);
		color: #ffe1a8;
	}

	button {
		min-height: 42px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(255, 255, 255, 0.05);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13px;
		font-weight: 850;
		padding: 0 14px;
		cursor: pointer;
	}

	button:hover {
		border-color: rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.08);
	}

	button.primary {
		border-color: rgba(124, 92, 255, 0.5);
		background: linear-gradient(100deg, #8b5cf6 0%, #d946ef 100%);
		color: #fff;
	}

	button.primary:hover {
		border-color: rgba(124, 92, 255, 0.7);
		filter: brightness(1.08);
	}

	.setup-footer-hint {
		grid-column: 1;
		margin: 0;
		max-width: 390px;
		color: var(--editor-text-muted);
		font-size: 12px;
		font-weight: 800;
		line-height: 1.35;
	}

	.setup-footer-actions {
		display: flex;
		grid-column: 2;
		min-width: 0;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
	}

	.setup-footer-actions button {
		min-width: 0;
	}

	.setup-action-receipt {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		padding: 0 14px;
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 8px;
		background: rgba(148, 163, 184, 0.08);
		color: rgba(226, 232, 240, 0.72);
		font-size: 13px;
		font-weight: 850;
		line-height: 1.25;
		text-align: center;
	}

	.setup-action-receipt.primary {
		border-color: rgba(124, 92, 255, 0.34);
		background: rgba(124, 92, 255, 0.14);
		color: #efeaff;
	}

	@media (max-height: 820px) and (min-width: 761px) {
		:global(.chapter-dialog--chapter) .chapter-dialog-header {
			padding: 14px 18px 10px;
		}

		:global(.chapter-dialog--chapter) .chapter-dialog-header h2 {
			font-size: 22px;
		}

		:global(.chapter-dialog--chapter) .chapter-dialog-header p {
			line-height: 1.38;
		}

		:global(.chapter-dialog--chapter > .ws-dialog-body) {
			padding: 14px 18px 16px;
		}

		:global(.chapter-dialog--chapter > .ws-dialog-footer) {
			padding: 10px 18px;
		}

		:global(.chapter-dialog--chapter) .setup-steps {
			margin-bottom: 10px;
		}

		:global(.chapter-dialog--chapter) .setup-steps span {
			min-height: 34px;
		}

		:global(.chapter-dialog--chapter) .setup-grid {
			gap: 10px 12px;
		}

		:global(.chapter-dialog--chapter) .story-lock {
			padding: 10px 12px;
		}

		:global(.chapter-dialog--chapter) input,
		:global(.chapter-dialog--chapter) .file-field {
			min-height: 40px;
		}

		:global(.chapter-dialog--chapter) .reading-direction-option {
			padding: 8px 10px;
		}

		:global(.chapter-dialog--chapter) .reading-direction-icon {
			font-size: 18px;
		}

		:global(.chapter-dialog--chapter) .reading-direction-hint {
			margin-top: 6px;
		}
	}

	@media (max-width: 760px) {
		:global(.chapter-dialog > .ws-dialog-body) {
			padding: 12px 18px 14px;
		}

		:global(.chapter-dialog > .ws-dialog-footer) {
			grid-template-columns: 1fr;
			gap: 8px;
			padding: 10px 18px 12px;
		}

		.setup-footer-hint,
		.setup-footer-actions {
			grid-column: 1;
		}

		.setup-footer-hint {
			max-width: none;
			font-size: 11px;
		}

		.setup-footer-actions {
			display: grid;
			grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
			gap: 8px;
		}

		.setup-footer-actions.busy {
			grid-template-columns: 1fr;
		}

		.setup-footer-actions button,
		.setup-footer-actions .setup-action-receipt {
			width: 100%;
			min-width: 0;
			padding-right: 10px;
			padding-left: 10px;
			white-space: normal;
		}

		:global(.chapter-dialog--chapter) .chapter-dialog-header {
			padding: 14px 18px 10px;
		}

		:global(.chapter-dialog--chapter) .chapter-dialog-header p {
			line-height: 1.38;
		}

		:global(.chapter-dialog--chapter) .setup-steps {
			margin-bottom: 10px;
		}

		:global(.chapter-dialog--chapter) .setup-steps span {
			min-height: 34px;
		}

		:global(.chapter-dialog--chapter) .story-lock {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 8px;
			padding: 10px;
		}

		:global(.chapter-dialog--chapter) .story-lock .setup-action-receipt {
			min-height: 34px;
			padding: 0 10px;
			font-size: 11px;
		}

		:global(.chapter-dialog--chapter) .pages-section {
			order: 1;
		}

		/* Required page upload must come before optional team setup on mobile. */
		:global(.chapter-dialog--chapter) .chapter-team-field {
			order: 2;
		}

		:global(.chapter-dialog--chapter) .merge-option {
			order: 3;
		}

		:global(.chapter-dialog--chapter) .setup-preview {
			padding: 10px;
		}

		.setup-grid,
		.setup-preview,
		.setup-recovery,
		.story-lock {
			grid-template-columns: 1fr;
		}

		.reading-direction-options {
			grid-template-columns: 1fr;
		}

		.preview-strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.chapter-dialog-header h2 {
			font-size: 21px;
		}
	}

	.merge-option {
		display: grid;
		gap: 8px;
		margin-top: 10px;
		padding: 10px 12px;
		border: 1px solid var(--editor-border, rgba(255, 255, 255, 0.08));
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.03);
	}
	.merge-toggle {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}
	.merge-toggle input {
		width: 15px;
		height: 15px;
		accent-color: var(--editor-accent, #8b5cf6);
	}
	.merge-controls {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.merge-count {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		font-weight: 600;
	}
	.merge-count input {
		width: 64px;
		min-height: 34px;
		padding: 2px 8px;
		border: 1px solid var(--editor-border, rgba(255, 255, 255, 0.12));
		border-radius: 8px;
		background: var(--editor-surface, rgba(0, 0, 0, 0.25));
		color: inherit;
		font-size: 12px;
	}
	.merge-result {
		font-size: 12px;
		font-weight: 700;
		opacity: 0.85;
	}
	.merge-hint {
		font-size: 11px;
		opacity: 0.6;
		line-height: 1.5;
	}
</style>
