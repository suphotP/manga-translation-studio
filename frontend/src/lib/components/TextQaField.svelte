<script module lang="ts">
	import { ApiError } from "$lib/api/client.js";

	// ── Provider circuit-breaker (shared across ALL fields) ─────────────────
	// The typo checker auto-fires on every keystroke. When the AI provider is
	// down (502 `text_qa_provider_error`, network/timeout), the structured
	// retryable error from the backend would otherwise let the client keep
	// hammering `POST /api/text-qa/check` on each character — spamming the
	// console with 502s on a CORE action (typing). A provider outage is GLOBAL,
	// not per-field, so the breaker lives at MODULE scope: once tripped, NO field
	// fires checks until the cooldown elapses (or the user explicitly retries).
	const BREAKER_MAX_FAILURES = 3;
	const BREAKER_COOLDOWN_MS = 60_000;
	let providerFailureCount = 0;
	let breakerOpenedAt = 0;

	/** True while the breaker is open: too many recent failures, cooldown not elapsed. */
	function isBreakerOpen(now: number = Date.now()): boolean {
		if (providerFailureCount < BREAKER_MAX_FAILURES) return false;
		return now - breakerOpenedAt < BREAKER_COOLDOWN_MS;
	}

	/** A provider-level failure that should count toward tripping the breaker. */
	function isProviderFailure(error: unknown): boolean {
		if (error instanceof ApiError) {
			// Backend marks transient provider outages with this structured code
			// (502). Quota (429) / disabled (503) are NOT provider failures — they
			// are deterministic states the breaker must not mask.
			if (error.code === "text_qa_provider_error") return true;
			return error.status === 502 || error.status === 504;
		}
		// Network error / timeout / abort-less fetch rejection.
		return error instanceof Error && error.name !== "AbortError";
	}

	function recordProviderFailure(): void {
		providerFailureCount += 1;
		if (providerFailureCount >= BREAKER_MAX_FAILURES) breakerOpenedAt = Date.now();
	}

	function resetBreaker(): void {
		providerFailureCount = 0;
		breakerOpenedAt = 0;
	}

	/** Test-only: reset the shared breaker between cases. */
	export function __resetTextQaBreakerForTesting(): void {
		resetBreaker();
	}
</script>

<script lang="ts">
	import { onDestroy } from "svelte";
	import { _ } from "$lib/i18n";
	import { checkTextQa, type TextQaIssue } from "$lib/api/client.js";

	interface Props {
		/** Bound text value. */
		value: string;
		/** Language code (th/en/ja/ko/zh...). */
		lang: string;
		/** Project the text belongs to — bills the check against its workspace plan. */
		projectId?: string | null;
		id?: string;
		rows?: number;
		disabled?: boolean;
		placeholder?: string;
		/** Extra classes for the textarea (e.g. existing panel styles). */
		textareaClass?: string;
		/** Debounce before a background check fires, in ms. */
		debounceMs?: number;
		/** Emitted on every textarea input. */
		onInput: (value: string) => void;
		/**
		 * Apply a single issue's suggestion. The parent owns the text, so it must
		 * commit the replacement and re-render `value`. Returns the new string for
		 * optimistic local handling.
		 */
		onApplySuggestion?: (nextValue: string) => void;
	}

	let {
		value,
		lang,
		projectId = null,
		id,
		rows = 3,
		disabled = false,
		placeholder = "",
		textareaClass = "panel-input selected-text-textarea",
		debounceMs = 700,
		onInput,
		onApplySuggestion,
	}: Props = $props();

	type QaStatus = "idle" | "checking" | "done" | "error" | "quota" | "disabled" | "unavailable";

	let issues = $state<TextQaIssue[]>([]);
	let status = $state<QaStatus>("idle");
	let statusMessage = $state("");
	let activeIssueIndex = $state<number | null>(null);
	let textareaEl: HTMLTextAreaElement | null = $state(null);
	let backdropEl: HTMLDivElement | null = $state(null);

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: AbortController | null = null;
	// The text the current `issues` were computed for. When `value` drifts from
	// this (mid-typing), offsets are stale, so underlines are suppressed.
	let checkedText = $state("");
	// The language the current `issues` were computed for. When `lang` changes
	// while the text is unchanged (e.g. switching the layer's target language),
	// issues are stale even though the text matches — suppress until re-checked.
	let checkedLang = $state("");

	const ZERO_WIDTH = "​";

	// Issues are only valid while the text AND language still match what we checked.
	let issuesValid = $derived(checkedText === value && checkedLang === lang && issues.length > 0);

	// Build segments [{text, issueIndex|null}] over the CURRENT value so the
	// backdrop mirrors the textarea exactly. Only used when issuesValid.
	let segments = $derived.by(() => {
		if (!issuesValid) return [{ text: value, issueIndex: null as number | null }];
		const out: { text: string; issueIndex: number | null }[] = [];
		let cursor = 0;
		issues.forEach((issue, index) => {
			if (issue.start > cursor) out.push({ text: value.slice(cursor, issue.start), issueIndex: null });
			out.push({ text: value.slice(issue.start, issue.end), issueIndex: index });
			cursor = issue.end;
		});
		if (cursor < value.length) out.push({ text: value.slice(cursor), issueIndex: null });
		return out;
	});

	let issueCount = $derived(issuesValid ? issues.length : 0);
	let activeIssue = $derived(
		activeIssueIndex !== null && issuesValid ? issues[activeIssueIndex] ?? null : null,
	);

	function clearDebounce(): void {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	function scheduleCheck(): void {
		clearDebounce();
		if (disabled) return;
		const text = value;
		if (!text.trim()) {
			inFlight?.abort();
			inFlight = null;
			issues = [];
			checkedText = text;
			checkedLang = lang;
			status = "idle";
			statusMessage = "";
			return;
		}
		// Circuit-breaker open: the provider failed repeatedly. Fail QUIETLY — do
		// NOT fire a request (so no fresh 502 hits the console) and surface a
		// subtle, tappable "unavailable" hint instead of hammering on every key.
		if (isBreakerOpen()) {
			inFlight?.abort();
			inFlight = null;
			status = "unavailable";
			statusMessage = $_("textQaField.unavailable");
			return;
		}
		debounceTimer = setTimeout(() => void runCheck(text, lang), debounceMs);
	}

	async function runCheck(text: string, reqLang: string): Promise<void> {
		// A newer keystroke / language switch superseded this scheduled check.
		if (text !== value || reqLang !== lang) return;
		// Breaker open (e.g. reached here via blur-flush): fail quietly, no request.
		if (isBreakerOpen()) {
			status = "unavailable";
			statusMessage = $_("textQaField.unavailable");
			return;
		}
		// Abort any prior in-flight request so its response can't land late and
		// repopulate issues for stale text/language.
		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		status = "checking";
		statusMessage = $_("textQaField.checking");
		try {
			const result = await checkTextQa(text, reqLang, {
				projectId: projectId ?? undefined,
				signal: controller.signal,
			});
			// Drop stale responses if the text or language changed while we waited.
			if (text !== value || reqLang !== lang) return;
			// Provider healthy again — clear any prior failure streak.
			resetBreaker();
			issues = result.issues;
			checkedText = text;
			checkedLang = reqLang;
			status = "done";
			statusMessage = result.issues.length
				? $_("textQaField.foundIssues", { values: { n: result.issues.length } })
				: $_("textQaField.noIssues");
		} catch (error) {
			// A superseded/aborted request must not clobber newer state.
			if (controller.signal.aborted || text !== value || reqLang !== lang) return;
			issues = [];
			checkedText = text;
			checkedLang = reqLang;
			if (error instanceof ApiError && error.code === "text_qa_quota_exceeded") {
				status = "quota";
				statusMessage = $_("textQaField.quotaExceeded");
			} else if (error instanceof ApiError && error.status === 503) {
				status = "disabled";
				statusMessage = $_("textQaField.disabled");
			} else if (isProviderFailure(error)) {
				// Transient provider outage (502 `text_qa_provider_error`, timeout,
				// network). Count it toward the breaker; once it trips, subsequent
				// keystrokes stop firing checks (no more 502 spam) until cooldown.
				recordProviderFailure();
				if (isBreakerOpen()) {
					status = "unavailable";
					statusMessage = $_("textQaField.unavailable");
				} else {
					status = "error";
					statusMessage = $_("textQaField.checkFailed");
				}
			} else {
				status = "error";
				statusMessage = $_("textQaField.checkFailed");
			}
		} finally {
			// Only clear if this controller is still the active one; a newer check
			// started during the await must keep its controller live.
			if (inFlight === controller) inFlight = null;
		}
	}

	function handleInput(event: Event): void {
		const next = (event.currentTarget as HTMLTextAreaElement).value;
		onInput(next);
		activeIssueIndex = null;
		// Underlines for the old text no longer line up; hide until re-checked.
		if (checkedText !== next) status = status === "checking" ? "checking" : "idle";
		scheduleCheck();
	}

	function handleBlur(): void {
		// On blur, flush any pending check immediately for a final pass.
		if (debounceTimer) {
			clearDebounce();
			if (value.trim() && (checkedText !== value || checkedLang !== lang)) void runCheck(value, lang);
		}
	}

	// User explicitly asks to retry after the breaker tripped: clear the failure
	// streak and fire one check immediately. If the provider is still down this
	// single request fails and re-trips the breaker — it does NOT resume the
	// per-keystroke spam.
	function retryCheck(): void {
		if (disabled) return;
		resetBreaker();
		clearDebounce();
		if (value.trim()) void runCheck(value, lang);
	}

	function syncScroll(): void {
		if (backdropEl && textareaEl) {
			backdropEl.scrollTop = textareaEl.scrollTop;
			backdropEl.scrollLeft = textareaEl.scrollLeft;
		}
	}

	function toggleIssue(index: number): void {
		activeIssueIndex = activeIssueIndex === index ? null : index;
	}

	function applySuggestion(index: number): void {
		if (!issuesValid) return;
		const issue = issues[index];
		if (!issue) return;
		const next = value.slice(0, issue.start) + issue.suggestion + value.slice(issue.end);
		activeIssueIndex = null;
		// Optimistically clear this issue; a fresh check will reconcile.
		issues = [];
		checkedText = next;
		checkedLang = lang;
		onInput(next);
		onApplySuggestion?.(next);
		scheduleCheck();
	}

	function issueTypeLabel(type: TextQaIssue["type"]): string {
		switch (type) {
			case "typo":
				return $_("textQaField.typeTypo");
			case "spacing":
				return $_("textQaField.typeSpacing");
			case "grammar":
				return $_("textQaField.typeGrammar");
			case "punctuation":
				return $_("textQaField.typePunctuation");
			default:
				return $_("textQaField.typeDefault");
		}
	}

	// Re-check when value is replaced from outside (e.g. switching layers) — but
	// not on our own optimistic apply (checkedText already tracks that).
	$effect(() => {
		// Touch value + lang so this effect re-runs on either change.
		void value;
		void lang;
		// Re-check when either the text OR the language drifts from what we last
		// checked (e.g. switching the layer's target language with the text intact).
		if (checkedText !== value || checkedLang !== lang) scheduleCheck();
	});

	onDestroy(() => {
		clearDebounce();
		inFlight?.abort();
	});
</script>

<div class="text-qa-field" class:has-issues={issueCount > 0}>
	<div class="text-qa-input-wrap">
		<div class="text-qa-backdrop" bind:this={backdropEl} aria-hidden="true">
			{#each segments as segment, i (i)}
				{#if segment.issueIndex !== null}
					<span class="text-qa-mark" data-type={issues[segment.issueIndex]?.type}>{segment.text || ZERO_WIDTH}</span>
				{:else}
					<span>{segment.text}</span>
				{/if}
			{/each}
			<span class="text-qa-trailing">{ZERO_WIDTH}</span>
		</div>
		<textarea
			{id}
			bind:this={textareaEl}
			class={`text-qa-textarea ${textareaClass}`}
			{rows}
			{disabled}
			{placeholder}
			{value}
			oninput={handleInput}
			onblur={handleBlur}
			onscroll={syncScroll}
			spellcheck="false"
		></textarea>
	</div>

	<div class="text-qa-status" data-status={status}>
		{#if status === "checking"}
			<span class="text-qa-spinner" aria-hidden="true"></span>
		{/if}
		{#if status === "unavailable"}
			<button type="button" class="text-qa-retry" onclick={retryCheck}>
				{statusMessage}
			</button>
		{:else}
			<span class="text-qa-status-text">{statusMessage}</span>
		{/if}
		{#if issueCount > 0}
			<div class="text-qa-issue-chips">
				{#each issues as issue, index (index)}
					<button
						type="button"
						class="text-qa-chip"
						class:active={activeIssueIndex === index}
						data-type={issue.type}
						onclick={() => toggleIssue(index)}
						title={issue.message}
						aria-label={`${issueTypeLabel(issue.type)}: ${issue.message}`}
					>
						<span class="text-qa-chip-type">{issueTypeLabel(issue.type)}</span>
						<span class="text-qa-chip-text">{value.slice(issue.start, issue.end)}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if activeIssue}
		<div class="text-qa-tooltip" role="dialog" aria-label={$_("textQaField.tooltipAria")}>
			<div class="text-qa-tooltip-head">
				<span class="text-qa-tooltip-type" data-type={activeIssue.type}>{issueTypeLabel(activeIssue.type)}</span>
				<button
					type="button"
					class="text-qa-tooltip-close"
					onclick={() => (activeIssueIndex = null)}
					aria-label={$_("textQaField.close")}
				>×</button>
			</div>
			<p class="text-qa-tooltip-message">{activeIssue.message || $_("textQaField.issueFallback")}</p>
			<div class="text-qa-tooltip-diff">
				<span class="text-qa-diff-from">{value.slice(activeIssue.start, activeIssue.end) || $_("textQaField.empty")}</span>
				<span class="text-qa-diff-arrow" aria-hidden="true">→</span>
				<span class="text-qa-diff-to">{activeIssue.suggestion || $_("textQaField.deleted")}</span>
			</div>
			<button
				type="button"
				class="text-qa-apply"
				onclick={() => applySuggestion(activeIssueIndex!)}
			>{$_("textQaField.applySuggestion")}</button>
		</div>
	{/if}
</div>

<style>
	.text-qa-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		position: relative;
	}

	.text-qa-input-wrap {
		position: relative;
		width: 100%;
	}

	/* The backdrop mirrors the textarea glyph-for-glyph so wavy underlines land
	   under the right characters. It must share every text-metric property. */
	.text-qa-backdrop,
	.text-qa-textarea {
		font-size: 12px;
		line-height: 1.35;
		font-family: inherit;
		letter-spacing: normal;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		word-break: break-word;
		padding: 8px;
		border: 1px solid transparent;
		border-radius: 4px;
		box-sizing: border-box;
		min-height: 84px;
	}

	.text-qa-backdrop {
		position: absolute;
		inset: 0;
		margin: 0;
		color: transparent;
		pointer-events: none;
		overflow: hidden;
		user-select: none;
	}

	.text-qa-textarea.text-qa-textarea {
		position: relative;
		background: transparent;
		resize: vertical;
	}

	/* Wavy underline on flagged ranges. */
	.text-qa-mark {
		text-decoration: underline wavy;
		text-decoration-color: #ef4444;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
		border-radius: 2px;
		background: rgba(239, 68, 68, 0.08);
	}
	.text-qa-mark[data-type="spacing"] {
		text-decoration-color: #f59e0b;
		background: rgba(245, 158, 11, 0.08);
	}
	.text-qa-mark[data-type="grammar"] {
		text-decoration-color: #6366f1;
		background: rgba(99, 102, 241, 0.08);
	}

	.text-qa-status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-height: 16px;
		font-size: 11px;
		color: var(--editor-text-dim, #94a3b8);
	}
	.text-qa-status[data-status="error"] .text-qa-status-text,
	.text-qa-status[data-status="quota"] .text-qa-status-text {
		color: #f59e0b;
	}
	.text-qa-status[data-status="done"] .text-qa-status-text {
		color: var(--editor-text-dim, #94a3b8);
	}
	.text-qa-status[data-status="unavailable"] {
		color: var(--editor-text-dim, #94a3b8);
	}

	/* Quiet, tappable retry hint shown while the breaker is open. */
	.text-qa-retry {
		padding: 0;
		border: none;
		background: transparent;
		color: var(--editor-text-dim, #94a3b8);
		font-size: 11px;
		text-align: left;
		cursor: pointer;
		text-decoration: underline dotted;
		text-underline-offset: 2px;
	}
	.text-qa-retry:hover {
		color: var(--editor-text, #e2e8f0);
	}

	.text-qa-spinner {
		width: 10px;
		height: 10px;
		border: 2px solid rgba(148, 163, 184, 0.35);
		border-top-color: var(--editor-accent, #7c5cff);
		border-radius: 50%;
		animation: text-qa-spin 0.7s linear infinite;
	}
	@keyframes text-qa-spin {
		to { transform: rotate(360deg); }
	}

	.text-qa-issue-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		width: 100%;
	}
	.text-qa-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 2px 6px;
		border: 1px solid var(--editor-border, rgba(148, 163, 184, 0.3));
		border-radius: 10px;
		background: var(--editor-bg, rgba(15, 23, 42, 0.6));
		color: var(--editor-text, #e2e8f0);
		font-size: 10px;
		cursor: pointer;
		min-width: 0;
	}
	.text-qa-chip:hover,
	.text-qa-chip.active {
		border-color: var(--editor-accent, #7c5cff);
	}
	.text-qa-chip-type {
		flex: none;
		font-weight: 600;
		color: #ef4444;
	}
	.text-qa-chip[data-type="spacing"] .text-qa-chip-type { color: #f59e0b; }
	.text-qa-chip[data-type="grammar"] .text-qa-chip-type { color: #6366f1; }
	.text-qa-chip-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.85;
	}

	.text-qa-tooltip {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border: 1px solid var(--editor-border, rgba(148, 163, 184, 0.3));
		border-radius: 6px;
		background: var(--editor-panel-bg, rgba(15, 23, 42, 0.96));
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
	}
	.text-qa-tooltip-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.text-qa-tooltip-type {
		font-size: 10px;
		font-weight: 700;
		color: #ef4444;
	}
	.text-qa-tooltip-type[data-type="spacing"] { color: #f59e0b; }
	.text-qa-tooltip-type[data-type="grammar"] { color: #6366f1; }
	.text-qa-tooltip-close {
		border: none;
		background: transparent;
		color: var(--editor-text-dim, #94a3b8);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		padding: 0 2px;
	}
	.text-qa-tooltip-message {
		margin: 0;
		font-size: 11px;
		color: var(--editor-text, #e2e8f0);
	}
	.text-qa-tooltip-diff {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		font-size: 12px;
	}
	.text-qa-diff-from {
		text-decoration: line-through;
		color: #ef4444;
		opacity: 0.85;
	}
	.text-qa-diff-arrow {
		color: var(--editor-text-dim, #94a3b8);
	}
	.text-qa-diff-to {
		color: #22c55e;
		font-weight: 600;
	}
	.text-qa-apply {
		align-self: flex-start;
		padding: 4px 10px;
		border: none;
		border-radius: 4px;
		background: var(--editor-accent, #7c5cff);
		color: #0b1220;
		font-size: 11px;
		font-weight: 700;
		cursor: pointer;
	}
	.text-qa-apply:hover {
		filter: brightness(1.06);
	}
</style>
