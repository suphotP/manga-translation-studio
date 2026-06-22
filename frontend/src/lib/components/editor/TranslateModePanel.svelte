<!--
	โหมดแปล (2026-06-13): แผงสคริปต์ข้างนอกรูป — การ์ดเลขกำกับตรงกับหมุดที่คนแปล
	จิ้มไว้บนภาพ (TranslateSlotOverlay) ใส่คำแปลได้หลายบรรทัด + ข้อความต้นฉบับ +
	โน้ตถึงคนลงคำ แล้วกด "ส่งให้ลงคำ" เป็น handoff ของหน้านี้. Persist ผ่าน
	projectStore slot CRUD (client-authoritative /save เหมือน text layers).
-->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { resolveDutyCapabilities } from "$lib/editor/duty-profile.ts";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.ts";
	import { signedAssetSrc } from "$lib/actions/signedAssetSrc.ts";
	import type { TranslationScriptSlot } from "$lib/types.js";

	let slots = $derived(projectStore.currentPageTranslationScriptSlots);
	let handoff = $derived(projectStore.currentPageTranslationHandoff);
	let translatedCount = $derived(slots.filter((slot) => slot.translatedText.trim().length > 0).length);
	let selectedSlotId = $derived(editorUiStore.translateSelectedSlotId);
	let dutyCaps = $derived(resolveDutyCapabilities({
		userId: authStore.user?.id,
		email: authStore.user?.email,
		accountRole: authStore.role,
		memberStudioRole: projectStore.currentWorkspaceMember?.memberStudioRole,
		chapterTeam: projectStore.project?.chapterTeam,
		storyRoles: projectStore.viewerStoryDutyRoles,
	}));
	// คนแปลแก้สคริปต์ได้; คนลงคำเห็นอ่านอย่างเดียว + ปุ่มวางบนภาพ
	let canEditScript = $derived(dutyCaps.canTranslate);
	let canPlace = $derived(dutyCaps.canTypeset);

	function armPlacement(slot: TranslationScriptSlot): void {
		editorUiStore.translatePlacingSlotId =
			editorUiStore.translatePlacingSlotId === slot.id ? null : slot.id;
		editorUiStore.translateSelectedSlotId = slot.id;
	}

	// crop พรีวิวรอบหมุด (zoom 3.2x) — คนลงคำเห็น "กรอบไหน" โดยไม่ต้องสลับไปดูภาพ
	const CROP_ZOOM = 3.2;
	let cropPreview = $derived.by(() => {
		const project = projectStore.project;
		const page = project?.pages[project.currentPage];
		if (!project || !page) return null;
		const imageId = getPagePreviewImageId(page, projectStore.localImageUrls);
		if (!imageId) return null;
		const url = projectStore.getImageUrl(imageId);
		if (!url) return null;
		return { projectId: project.projectId, imageId, url, purpose: "editor_preview" as const };
	});

	function slotNumber(slot: TranslationScriptSlot): number {
		return slots.findIndex((entry) => entry.id === slot.id) + 1;
	}

	function addSlotAtCenter(): void {
		const ordinal = slots.length + 1;
		projectStore.updateCurrentPageTranslationScriptSlot({
			id: `slot-${Date.now().toString(36)}-${ordinal}`,
			label: `#${ordinal}`,
			x: 50,
			y: 50,
			translatedText: "",
		});
	}

	function updateSlot(slot: TranslationScriptSlot, patch: Partial<TranslationScriptSlot>): void {
		projectStore.updateCurrentPageTranslationScriptSlot({ ...slot, ...patch });
	}

	function removeSlot(slot: TranslationScriptSlot): void {
		projectStore.deleteCurrentPageTranslationScriptSlot(slot.id);
		if (editorUiStore.translateSelectedSlotId === slot.id) editorUiStore.translateSelectedSlotId = null;
	}

	function sendToTypeset(): void {
		projectStore.updateCurrentPageTranslationHandoff("translated");
	}

	function reopenDraft(): void {
		projectStore.updateCurrentPageTranslationHandoff("draft");
	}
</script>

<section class="translate-panel" aria-label={$_("translatePanel.aria")}>
	<header class="translate-panel-head">
		<div>
			<strong>{$_("translatePanel.title")}</strong>
			<small>{$_("translatePanel.progress", { values: { done: translatedCount, total: slots.length } })}</small>
		</div>
		{#if canEditScript}
			<button type="button" class="tp-add" onclick={addSlotAtCenter}>{$_("translatePanel.addSlot")}</button>
		{/if}
	</header>
	<p class="tp-hint">{canPlace && !canEditScript ? $_("translatePanel.placeHint") : $_("translatePanel.clickHint")}</p>

	{#if slots.length === 0}
		<p class="tp-empty">{$_("translatePanel.empty")}</p>
	{:else}
		<ol class="tp-list">
			{#each slots as slot (slot.id)}
				<li class="tp-card" class:selected={selectedSlotId === slot.id}>
					{#if cropPreview}
						<div class="tp-crop" aria-hidden="true">
							<img
								use:signedAssetSrc={cropPreview}
								alt=""
								style={`width:${CROP_ZOOM * 100}%;left:calc(50% - ${(slot.x * CROP_ZOOM).toFixed(1)}%);top:calc(50% - ${(slot.y * CROP_ZOOM).toFixed(1)}%);`}
							/>
						</div>
					{/if}
					<div class="tp-card-head">
						<button type="button" class="tp-pin-number" onclick={() => (editorUiStore.translateSelectedSlotId = slot.id)} aria-label={$_("translatePanel.selectSlot", { values: { n: slotNumber(slot) } })}>
							{slotNumber(slot)}
						</button>
						<input
							class="tp-source"
							placeholder={$_("translatePanel.sourcePlaceholder")}
							value={slot.sourceText ?? ""}
							onchange={(event) => updateSlot(slot, { sourceText: (event.currentTarget as HTMLInputElement).value })}
							readonly={!canEditScript}
						/>
						{#if canEditScript}
							<button type="button" class="tp-delete" onclick={() => removeSlot(slot)} aria-label={$_("translatePanel.deleteSlot")}>×</button>
						{/if}
					</div>
					<textarea
						class="tp-translation"
						rows="3"
						placeholder={$_("translatePanel.translationPlaceholder")}
						value={slot.translatedText}
						onchange={(event) => updateSlot(slot, { translatedText: (event.currentTarget as HTMLTextAreaElement).value })}
						readonly={!canEditScript}
					></textarea>
					{#if canPlace && slot.translatedText.trim()}
						<button
							type="button"
							class="tp-place"
							class:arming={editorUiStore.translatePlacingSlotId === slot.id}
							onclick={() => armPlacement(slot)}
						>
							{editorUiStore.translatePlacingSlotId === slot.id ? $_("translatePanel.placingActive") : $_("translatePanel.placeOnImage")}
						</button>
					{/if}
					<input
						class="tp-note"
						placeholder={$_("translatePanel.notePlaceholder")}
						value={slot.note ?? ""}
						onchange={(event) => updateSlot(slot, { note: (event.currentTarget as HTMLInputElement).value })}
						readonly={!canEditScript}
					/>
				</li>
			{/each}
		</ol>
	{/if}

	<footer class="tp-footer">
		{#if handoff?.status === "translated"}
			<span class="tp-status done">{$_("translatePanel.statusSent")}</span>
			<button type="button" class="tp-secondary" onclick={reopenDraft}>{$_("translatePanel.reopen")}</button>
		{:else if canEditScript}
			<button type="button" class="tp-send" disabled={slots.length === 0} onclick={sendToTypeset}>
				{$_("translatePanel.sendToTypeset")}
			</button>
		{/if}
	</footer>
</section>

<style>
	.translate-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; min-height: 0; overflow-y: auto; color: var(--editor-text); }
	.translate-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.translate-panel-head strong { display: block; font-size: 13px; }
	.translate-panel-head small { color: var(--editor-text-dim); font-size: 11px; }
	.tp-add { border: 1px solid var(--editor-border); background: var(--editor-surface-raised); color: var(--editor-text); border-radius: 8px; padding: 6px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer; }
	.tp-hint { font-size: 11px; color: var(--editor-text-muted); margin: 0; }
	.tp-empty { font-size: 12px; color: var(--editor-text-dim); border: 1px dashed var(--editor-border); border-radius: 10px; padding: 14px; text-align: center; }
	.tp-list { list-style: none; display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; }
	.tp-card { border: 1px solid var(--editor-border-soft); border-radius: 10px; background: var(--editor-surface); padding: 8px; display: grid; gap: 6px; }
	.tp-crop { position: relative; width: 100%; height: 72px; overflow: hidden; border-radius: 8px; border: 1px solid var(--editor-border-soft); background: var(--editor-bg); }
	.tp-crop img { position: absolute; max-width: none; height: auto; }
	.tp-card.selected { border-color: var(--editor-accent); box-shadow: 0 0 0 1px var(--editor-accent); }
	.tp-card-head { display: flex; align-items: center; gap: 6px; }
	.tp-pin-number { width: 24px; height: 24px; border-radius: 999px; border: none; background: var(--editor-accent); color: white; font-size: 12px; font-weight: 800; cursor: pointer; flex-shrink: 0; }
	.tp-source { flex: 1; min-width: 0; background: transparent; border: none; border-bottom: 1px dashed var(--editor-border-soft); color: var(--editor-text-dim); font-size: 11.5px; padding: 2px 0; }
	.tp-delete { border: none; background: transparent; color: var(--editor-text-muted); font-size: 16px; cursor: pointer; line-height: 1; }
	.tp-translation { width: 100%; resize: vertical; min-height: 56px; border: 1px solid var(--editor-border-soft); border-radius: 8px; background: var(--editor-bg); color: var(--editor-text); font-size: 13px; line-height: 1.5; padding: 7px 8px; }
	.tp-note { width: 100%; background: transparent; border: none; color: var(--editor-text-muted); font-size: 11px; padding: 1px 0; }
	.tp-footer { margin-top: 4px; display: flex; align-items: center; gap: 8px; }
	.tp-send { flex: 1; border: none; border-radius: 9px; padding: 9px 12px; background: var(--editor-accent); color: white; font-weight: 800; font-size: 12.5px; cursor: pointer; }
	.tp-send:disabled { opacity: 0.5; cursor: not-allowed; }
	.tp-secondary { border: 1px solid var(--editor-border); background: transparent; color: var(--editor-text); border-radius: 9px; padding: 8px 12px; font-size: 12px; cursor: pointer; }
	.tp-status.done { font-size: 12px; font-weight: 700; color: var(--editor-accent); }
	.tp-place { border: 1px dashed var(--editor-accent); background: transparent; color: var(--editor-accent); border-radius: 8px; padding: 6px 10px; font-size: 11.5px; font-weight: 800; cursor: pointer; }
	.tp-place.arming { background: var(--editor-accent); color: white; }
</style>
