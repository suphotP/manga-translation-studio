<!-- LibraryEmptyShelf — the local-first empty state for the library-home route
	(aria-label "คลังงานว่าง") shown when no saved titles exist. Honest copy only:
	the recent-projects error never leaks endpoint/status detail to the shelf. -->
<script lang="ts">
	import { _ } from "$lib/i18n";

	let {
		hasError,
		onCreate,
		onRefresh,
	}: {
		hasError: boolean;
		/** Absent ⇒ viewer cannot create stories (owner/admin-only); show shelf without the CTA. */
		onCreate?: () => void;
		onRefresh: () => void;
	} = $props();

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<section class="library-empty-home ws-panel-quiet grid w-full max-w-[1180px] grid-cols-1 items-center gap-3.5 rounded-ws p-5 min-[761px]:grid-cols-[minmax(0,1fr)_auto]" aria-label={msg("library.emptyAriaShelf", "คลังงานว่าง")}>
	<div class="min-w-0">
		<span class="text-[11px] font-black text-ws-accent">{msg("library.emptyEyebrow", "ยังไม่มีเรื่องบนเครื่องนี้")}</span>
		<h2 class="mt-1 text-2xl font-extrabold leading-tight text-ws-ink">{msg("library.emptyTitle", "เริ่มจากเรื่องแรก")}</h2>
		<p class="text-xs font-semibold leading-relaxed text-ws-text/70">{msg("library.emptyCopy", "สร้างเรื่องและตอนใหม่ หรือเปิดโปรเจกต์ที่มีอยู่เพื่อให้ชั้นวางแสดงปก ชื่อเรื่อง และตอนล่าสุด")}</p>
	</div>
	<div class="library-empty-actions flex flex-wrap justify-end gap-2 max-[760px]:[&>button]:flex-1">
		{#if onCreate}
			<button type="button" class="primary ws-grad-primary inline-flex min-h-11 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3.5 text-xs font-black text-white transition hover:brightness-110" onclick={onCreate}>{msg("library.emptyCreate", "สร้างเรื่อง / ตอน")}</button>
		{/if}
		<button type="button" onclick={onRefresh} class="ws-btn-ghost inline-flex min-h-11 items-center justify-center rounded-ws-ctrl px-3.5 text-xs font-black text-ws-ink">{msg("library.emptyRefresh", "รีเฟรชคลังงาน")}</button>
	</div>
	{#if hasError}
		<small class="text-xs font-semibold leading-relaxed text-ws-text/70 min-[761px]:col-span-full">{msg("library.emptyLocalHint", "ใช้แบบ local ได้ก่อน งานที่สร้างใหม่จะแสดงในชั้นวางหลังบันทึก")}</small>
	{/if}
</section>
