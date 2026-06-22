<!--
	Toast — Wave 2 W2.5 ephemeral notification stack.

	Mounted once in the workspace root. Consumes toastsStore.items and renders
	a small stack in the top-right corner. Smooth slide-in via CSS transitions
	on insertion.
-->
<script lang="ts">
	import { toastsStore } from "$lib/stores/toasts.svelte.ts";
	import type { ToastVariant } from "$lib/stores/toasts.svelte.ts";
	import { _ } from "$lib/i18n";
	import { flip } from "svelte/animate";
	import { fly } from "svelte/transition";

	let items = $derived(toastsStore.items);

	// Respect the OS "reduce motion" setting — collapse to 0-duration so the stack
	// still re-flows correctly but without the slide/reflow/countdown animation.
	const prefersReducedMotion =
		typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia("(prefers-reduced-motion: reduce)").matches
			: false;
	const anim = (ms: number) => (prefersReducedMotion ? 0 : ms);

	function variantLabel(variant: ToastVariant): string {
		switch (variant) {
			case "success":
				return $_("toast.variantSuccess");
			case "info":
				return $_("toast.variantInfo");
			case "warn":
				return $_("toast.variantWarn");
			case "error":
				return $_("toast.variantError");
		}
	}

	async function runAction(id: string, action: () => void | Promise<void>): Promise<void> {
		try {
			await action();
		} finally {
			toastsStore.dismiss(id);
		}
	}
</script>

<div class="ws-toast-stack" role="region" aria-live="polite" aria-label={$_("toast.regionLabel")}>
	{#each items as toast (toast.id)}
		<div
			class="ws-toast ws-panel"
			data-variant={toast.variant}
			role="status"
			in:fly={{ x: 28, duration: anim(240) }}
			out:fly={{ x: 28, duration: anim(200) }}
			animate:flip={{ duration: anim(240) }}
			onmouseenter={() => toastsStore.pause(toast.id)}
			onmouseleave={() => toastsStore.resume(toast.id)}
			onfocusin={() => toastsStore.pause(toast.id)}
			onfocusout={() => toastsStore.resume(toast.id)}
		>
			<span class="ws-toast-icon" aria-hidden="true">
				{#if toast.variant === "success"}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12l5 5L20 7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
				{:else if toast.variant === "error"}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 7v6M12 17v.01" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke-width="2"/></svg>
				{:else if toast.variant === "warn"}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 4l9 16H3z" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 18v.01" stroke-width="2.2" stroke-linecap="round"/></svg>
				{:else}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" stroke-width="2"/><path d="M12 8v4M12 16v.01" stroke-width="2.2" stroke-linecap="round"/></svg>
				{/if}
			</span>
			<div class="ws-toast-content">
				<strong>{toast.title}</strong>
				{#if toast.body}<p>{toast.body}</p>{/if}
				{#if toast.action}
					<button
						type="button"
						class="ws-toast-action ws-grad-primary"
						onclick={() => void runAction(toast.id, toast.action!.onClick)}
					>{toast.action.label}</button>
				{/if}
			</div>
			<button
				type="button"
				class="ws-toast-close ws-btn-ghost"
				aria-label={$_("toast.dismiss", { values: { variant: variantLabel(toast.variant) } })}
				onclick={() => toastsStore.dismiss(toast.id)}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke-width="2"/></svg>
			</button>
			{#if toast.durationMs > 0 && !prefersReducedMotion}
				<!-- Countdown: a bar that drains over the toast's lifetime so the user can
				     see how long until it auto-dismisses. Pauses on hover/focus (CSS) in
				     lockstep with the store timer (pause/resume). -->
				<span
					class="ws-toast-countdown"
					aria-hidden="true"
					style={`--toast-duration:${toast.durationMs}ms`}
				></span>
			{/if}
		</div>
	{/each}
</div>

<style>
	.ws-toast-stack {
		position: fixed;
		top: 16px;
		right: 16px;
		z-index: 1500;
		display: flex;
		flex-direction: column;
		gap: 10px;
		max-width: 360px;
		pointer-events: none;
	}

	.ws-toast {
		position: relative;
		overflow: hidden;
		display: grid;
		grid-template-columns: 28px 1fr auto;
		gap: 12px;
		padding: 12px 14px;
		border-radius: var(--radius-ws-card, 12px);
		color: var(--color-ws-ink);
		pointer-events: auto;
		font-family: var(--font-ws-sans, system-ui, sans-serif);
	}

	/* Countdown bar: drains left→right over the toast's lifetime; pauses on hover
	   /focus so the user can finish reading (the store timer pauses in lockstep). */
	.ws-toast-countdown {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 3px;
		width: 100%;
		transform-origin: left center;
		border-bottom-left-radius: var(--radius-ws-card, 12px);
		background: var(--color-ws-cyan);
		opacity: 0.85;
		animation: ws-toast-countdown var(--toast-duration, 5000ms) linear forwards;
	}

	.ws-toast:hover .ws-toast-countdown,
	.ws-toast:focus-within .ws-toast-countdown {
		animation-play-state: paused;
	}

	@keyframes ws-toast-countdown {
		from { transform: scaleX(1); }
		to   { transform: scaleX(0); }
	}

	.ws-toast[data-variant="success"] .ws-toast-countdown { background: var(--color-ws-green); }
	.ws-toast[data-variant="info"]    .ws-toast-countdown { background: var(--color-ws-cyan); }
	.ws-toast[data-variant="warn"]    .ws-toast-countdown { background: var(--color-ws-amber); }
	.ws-toast[data-variant="error"]   .ws-toast-countdown { background: var(--color-ws-rose); }

	.ws-toast[data-variant="success"] { border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent); }
	.ws-toast[data-variant="info"]    { border-color: color-mix(in srgb, var(--color-ws-cyan) 32%, transparent); }
	.ws-toast[data-variant="warn"]    { border-color: color-mix(in srgb, var(--color-ws-amber) 32%, transparent); }
	.ws-toast[data-variant="error"]   { border-color: color-mix(in srgb, var(--color-ws-rose) 32%, transparent); }

	.ws-toast-icon {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
	}

	.ws-toast[data-variant="success"] .ws-toast-icon { background: color-mix(in srgb, var(--color-ws-green) 18%, transparent); color: var(--color-ws-green); }
	.ws-toast[data-variant="info"]    .ws-toast-icon { background: color-mix(in srgb, var(--color-ws-cyan) 18%, transparent); color: var(--color-ws-cyan); }
	.ws-toast[data-variant="warn"]    .ws-toast-icon { background: color-mix(in srgb, var(--color-ws-amber) 18%, transparent); color: var(--color-ws-amber); }
	.ws-toast[data-variant="error"]   .ws-toast-icon { background: color-mix(in srgb, var(--color-ws-rose) 18%, transparent); color: var(--color-ws-rose); }

	.ws-toast-icon svg {
		width: 16px;
		height: 16px;
	}

	.ws-toast-content {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.ws-toast-content strong {
		font-size: 13px;
		font-weight: 600;
	}

	.ws-toast-content p {
		margin: 0;
		font-size: 12px;
		color: var(--color-ws-text);
		line-height: 1.45;
	}

	.ws-toast-action {
		align-self: flex-start;
		margin-top: 4px;
		min-height: 36px;
		padding: 0 12px;
		border-radius: var(--radius-ws-ctrl, 10px);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
		transition: filter 0.14s ease, border-color 0.14s ease;
	}

	.ws-toast-action:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 58%, transparent);
		filter: brightness(1.08);
	}

	.ws-toast-close {
		align-self: flex-start;
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		color: var(--color-ws-faint);
		cursor: pointer;
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.ws-toast-close:hover {
		color: var(--color-ws-ink);
	}

	.ws-toast-close svg {
		width: 12px;
		height: 12px;
		stroke-width: 2;
	}
</style>
