<!--
	หมุดสคริปต์แปลบนภาพ (2026-06-13): แสดงเฉพาะตอน right panel = โหมดแปล.
	จิ้มบนภาพ → เพิ่ม slot ที่จุดนั้น (เก็บเป็น % ของภาพ ตาม TranslationScriptSlot)
	จิ้มหมุด → เลือกการ์ดในแผง (editorUiStore.translateSelectedSlotId ใช้ร่วมกัน).
	ตำแหน่ง: กล่องภาพเต็มจาก imageRegionToWorkspaceBox + หมุดวางด้วย % ภายในกล่อง
	(แพทเทิร์นเดียวกับ CommentRegionOverlay).
-->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { imageRegionToWorkspaceBox } from "$lib/editor/overlay-geometry.js";
	import { getCanvasOverlayZIndex } from "$lib/editor/overlay-priority.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { resolveDutyCapabilities } from "$lib/editor/duty-profile.ts";

	let active = $derived(editorUiStore.rightPanelMode === "translate");
	let dutyCaps = $derived(resolveDutyCapabilities({
		userId: authStore.user?.id,
		email: authStore.user?.email,
		accountRole: authStore.role,
		memberStudioRole: projectStore.currentWorkspaceMember?.memberStudioRole,
		chapterTeam: projectStore.project?.chapterTeam,
		storyRoles: projectStore.viewerStoryDutyRoles,
	}));
	let placingSlotId = $derived(editorUiStore.translatePlacingSlotId);
	// คลิกบนภาพถูกดักเฉพาะตอน "ตั้งใจ" เท่านั้น: เครื่องมือแปล active (คนแปลปักหมุด)
	// หรือคนลงคำ arm วางคำค้างไว้ — ไม่งั้น overlay ต้องโปร่งให้ select/Fabric ทำงาน
	// ปกติ (หมุดยังคลิกเลือกได้เสมอ เพราะ pin เปิด pointer-events ของตัวเอง)
	let interceptClicks = $derived(
		// #E6a: arm pin-on-image whenever the translator is in TRANSLATE MODE — via the dock
		// tool OR the right-panel mode. The natural entry (Easy Mode "แปล" / the Translate
		// inspector) sets rightPanelMode="translate" without necessarily owning the dock tool,
		// and gating on activeDockTool alone made clicking a bubble silently do nothing.
		Boolean(placingSlotId)
			|| (dutyCaps.canTranslate
				&& (editorUiStore.activeDockTool === "translate" || editorUiStore.rightPanelMode === "translate")),
	);
	let slots = $derived(projectStore.currentPageTranslationScriptSlots);

	let imageBox = $derived.by(() => {
		// Re-derive on every viewport change (zoom/pan/resize), like the sibling overlays.
		void editorStore.viewportVersion;
		const editor = editorStore.editor;
		if (!active || !editor || !editor.imageWidth || !editor.imageHeight) return null;
		return imageRegionToWorkspaceBox(editor, { x: 0, y: 0, w: editor.imageWidth, h: editor.imageHeight });
	});

	function pointPct(event: MouseEvent): { x: number; y: number } | null {
		const target = event.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		return {
			x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
			y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100)),
		};
	}

	function addSlotAtPoint(event: MouseEvent): void {
		const point = pointPct(event);
		if (!point) return;
		// คนลงคำ "arm" การ์ดไว้ → คลิกนี้คือจุดวางคำ ไม่ใช่ปักหมุดใหม่
		if (placingSlotId) {
			const layer = projectStore.createTextLayerFromCurrentPageTranslationScriptSlot(
				placingSlotId,
				"local-user",
				{ xPct: point.x, yPct: point.y },
			);
			if (layer) editorUiStore.translatePlacingSlotId = null;
			return;
		}
		// ปักหมุดใหม่ = งานของคนแปลเท่านั้น
		if (!dutyCaps.canTranslate) return;
		const { x, y } = point;
		const ordinal = slots.length + 1;
		const id = `slot-${Date.now().toString(36)}-${ordinal}`;
		projectStore.updateCurrentPageTranslationScriptSlot({
			id,
			label: `#${ordinal}`,
			x: Math.round(x * 10) / 10,
			y: Math.round(y * 10) / 10,
			translatedText: "",
		});
		editorUiStore.translateSelectedSlotId = id;
	}

	function selectSlot(event: MouseEvent, slotId: string): void {
		event.stopPropagation();
		editorUiStore.translateSelectedSlotId = slotId;
	}
</script>

{#if active && imageBox}
	<div
		class="translate-slot-overlay"
		style={`z-index:${getCanvasOverlayZIndex("comment", { selected: true })};`}
	>
		<div
			class="translate-hit-area"
			class:inert={!interceptClicks}
			style={`left:${imageBox.left}px;top:${imageBox.top}px;width:${imageBox.width}px;height:${imageBox.height}px;`}
			onclick={addSlotAtPoint}
			role="button"
			tabindex="-1"
			aria-label={$_("translateOverlay.addAria")}
		>
			{#each slots as slot, index (slot.id)}
				<button
					type="button"
					class="translate-pin"
					class:selected={editorUiStore.translateSelectedSlotId === slot.id}
					class:done={slot.translatedText.trim().length > 0}
					style={`left:${slot.x}%;top:${slot.y}%;`}
					onclick={(event) => selectSlot(event, slot.id)}
					aria-label={$_("translateOverlay.pinAria", { values: { n: index + 1 } })}
				>
					{index + 1}
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.translate-slot-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}
	.translate-hit-area {
		position: absolute;
		pointer-events: auto;
		cursor: crosshair;
	}
	.translate-hit-area.inert {
		pointer-events: none;
		cursor: default;
	}
	.translate-pin {
		position: absolute;
		transform: translate(-50%, -50%);
		width: 26px;
		height: 26px;
		border-radius: 999px;
		border: 2px solid white;
		background: var(--color-ws-accent, #7c5cff);
		color: white;
		font-size: 12px;
		font-weight: 800;
		cursor: pointer;
		box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
		pointer-events: auto;
	}
	.translate-pin.done {
		background: #16a34a;
	}
	.translate-pin.selected {
		outline: 3px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 55%, transparent);
		outline-offset: 1px;
	}
</style>
