<!--
	Workspace-group error boundary — catches errors inside workspace routes
	(dashboard/library/projects) before they bubble to the root boundary.
	Friendly fallback with reset + escape hatch back to the dashboard.
-->
<script lang="ts">
	import { page } from "$app/state";
	import { invalidateAll, goto } from "$app/navigation";
	import { safeT } from "$lib/i18n/safeLocale";

	let status = $derived(page.status);
	let message = $derived(
		page.error?.message ?? safeT("errorPage.wsMessageFallback", "เปิดพื้นที่ทำงานไม่สำเร็จ"),
	);

	async function reset(): Promise<void> {
		await invalidateAll();
	}

	function goHome(): void {
		void goto("/dashboard");
	}
</script>

<main class="ws-error-shell">
	<section class="ws-error-card" aria-labelledby="ws-error-title">
		<span class="ws-error-status">{status}</span>
		<h1 id="ws-error-title" class="ws-error-title">{safeT("errorPage.wsTitle", "เปิดพื้นที่ทำงานไม่สำเร็จ")}</h1>
		<p class="ws-error-message">{message}</p>
		<div class="ws-error-actions">
			<button type="button" class="ws-error-btn primary" onclick={reset}>{safeT("errorPage.wsRetry", "ลองโหลดใหม่")}</button>
			<button type="button" class="ws-error-btn" onclick={goHome}>{safeT("errorPage.goHome", "กลับหน้าหลัก")}</button>
		</div>
	</section>
</main>

<style>
	.ws-error-shell {
		display: grid;
		place-items: center;
		width: 100vw;
		height: 100vh;
		padding: 24px;
		background:
			radial-gradient(circle at 5% 5%, rgba(251, 113, 133, 0.12), transparent 45%),
			radial-gradient(circle at 95% 95%, rgba(99, 102, 241, 0.12), transparent 45%),
			#05070c;
		color: var(--color-ws-ink, #ececf2);
	}

	.ws-error-card {
		width: min(440px, 100%);
		padding: 32px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 16px;
		background: var(--color-ws-surface, #15151d);
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
		text-align: center;
	}

	.ws-error-status {
		display: inline-block;
		margin-bottom: 12px;
		padding: 3px 12px;
		border-radius: 999px;
		background: rgba(251, 113, 133, 0.16);
		color: var(--color-ws-rose, #fb7185);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.08em;
	}

	.ws-error-title {
		margin: 0 0 8px;
		font-size: 20px;
		font-weight: 700;
	}

	.ws-error-message {
		margin: 0 0 24px;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 14px;
		line-height: 1.5;
		word-break: break-word;
	}

	.ws-error-actions {
		display: flex;
		justify-content: center;
		gap: 10px;
	}

	.ws-error-btn {
		min-height: 42px;
		padding: 0 18px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 9px;
		background: rgba(255, 255, 255, 0.05);
		color: var(--color-ws-ink, #ececf2);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.ws-error-btn.primary {
		border-color: rgba(124, 92, 255, 0.6);
		background: linear-gradient(135deg, rgba(124, 92, 255, 0.95), rgba(34, 211, 238, 0.85));
		color: #0b0b0f;
	}

	.ws-error-btn:focus-visible {
		outline: 2px solid var(--color-ws-accent, #7c5cff);
		outline-offset: 2px;
	}
</style>
