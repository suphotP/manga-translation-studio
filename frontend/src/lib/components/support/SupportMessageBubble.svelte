<!-- SupportMessageBubble — one message in a ticket thread.
     Distinguishes the requester (you), the AI assistant, a human support agent,
     and system notes via authorKind: alignment, avatar mark, sender label, and
     accent colour. The body is rendered as plain TEXT (Svelte auto-escapes the
     `{message.body}` interpolation) — NEVER {@html} — because it carries
     untrusted user + AI-model content and must be XSS-safe.

     Newlines are preserved via `white-space: pre-wrap` rather than splitting
     into HTML, so no markup is ever injected. -->
<script lang="ts">
	import type { SupportTicketMessage } from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import { authorLabel, customerVisibleBody, formatAbsolute, formatRelative, isOwnMessage } from "./support-format.ts";

	let { message }: { message: SupportTicketMessage } = $props();

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let own = $derived(isOwnMessage(message.authorKind));
	let kind = $derived(message.authorKind);
	let senderLabel = $derived(authorLabel(kind, t));

	// Two-letter avatar mark per author kind.
	const MARK: Record<SupportTicketMessage["authorKind"], string> = {
		customer: "ME",
		ai: "AI",
		agent: "TS",
		system: "SYS",
	};

	// Linkify http(s) URLs WITHOUT {@html}: split the body into plain-text and
	// link segments, then render each through Svelte's auto-escaping interpolation
	// (text in `{seg.text}`, URLs in an `<a href>` whose attribute Svelte also
	// escapes). This stays XSS-safe — no raw markup is ever injected — while
	// making real links (help articles, receipts) clickable. Only http/https
	// schemes are linkified, so `javascript:`/`data:` strings never become links.
	type Segment = { url: string } | { text: string };
	const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,!?:;)\]}'"])/g;

	function linkify(body: string): Segment[] {
		const segments: Segment[] = [];
		let lastIndex = 0;
		for (const match of body.matchAll(URL_RE)) {
			const url = match[0];
			const start = match.index ?? 0;
			if (start > lastIndex) segments.push({ text: body.slice(lastIndex, start) });
			segments.push({ url });
			lastIndex = start + url.length;
		}
		if (lastIndex < body.length) segments.push({ text: body.slice(lastIndex) });
		return segments;
	}

	// Defense in depth (a16 #11): re-strip internal AI reasoning at render time so
	// internal triage / "## Internal reasoning" sections can never reach the
	// customer even from a stale/unfiltered payload. Non-AI bodies pass through.
	let visibleBody = $derived(customerVisibleBody(message.authorKind, message.body));
	let segments = $derived(linkify(visibleBody));
</script>

<article
	class="msg-row"
	class:own
	data-author={kind}
	aria-label={`${t("support.bubble.fromAria", "ข้อความจาก")} ${senderLabel}`}
>
	<div class="msg-avatar" data-author={kind} aria-hidden="true">{MARK[kind]}</div>
	<div class="msg-bubble" data-author={kind}>
		<header class="msg-head">
			<span class="msg-author">{senderLabel}</span>
			{#if kind === "ai"}
				<span class="msg-tag" aria-hidden="true">{t("support.bubble.autoReply", "ตอบอัตโนมัติ")}</span>
			{/if}
			<time class="msg-time" datetime={message.createdAt} title={formatAbsolute(message.createdAt)}>
				{formatRelative(message.createdAt, Date.now(), t)}
			</time>
		</header>
		<!-- TEXT only — every segment is auto-escaped (no {@html}); URLs become
		     real <a> elements with Svelte-escaped href. pre-wrap keeps line breaks. -->
		<p class="msg-body">{#each segments as seg}{#if "url" in seg}<a class="msg-link" href={seg.url} target="_blank" rel="noopener noreferrer nofollow ugc">{seg.url}</a>{:else}{seg.text}{/if}{/each}</p>
	</div>
</article>

<style>
	.msg-row {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		max-width: 80%;
	}
	.msg-row.own {
		flex-direction: row-reverse;
		margin-left: auto;
	}

	.msg-avatar {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 8px;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.04em;
		border: 1px solid rgba(255, 255, 255, 0.1);
		color: var(--color-ws-ink, #ececf2);
		background: rgba(255, 255, 255, 0.05);
	}
	.msg-avatar[data-author="customer"] {
		border-color: rgba(124, 92, 255, 0.4);
		background: rgba(124, 92, 255, 0.16);
		color: #cabfff;
	}
	.msg-avatar[data-author="ai"] {
		border-color: rgba(34, 211, 238, 0.4);
		background: rgba(34, 211, 238, 0.14);
		color: #a5f0fb;
	}
	.msg-avatar[data-author="agent"] {
		border-color: rgba(52, 211, 153, 0.4);
		background: rgba(52, 211, 153, 0.14);
		color: #a7f3d0;
	}

	.msg-bubble {
		min-width: 0;
		padding: 10px 13px;
		border-radius: 12px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
	}
	.msg-bubble[data-author="customer"] {
		border-color: rgba(124, 92, 255, 0.3);
		background: rgba(124, 92, 255, 0.1);
	}
	.msg-bubble[data-author="ai"] {
		border-color: rgba(34, 211, 238, 0.28);
		background: rgba(34, 211, 238, 0.08);
	}
	.msg-bubble[data-author="agent"] {
		border-color: rgba(52, 211, 153, 0.28);
		background: rgba(52, 211, 153, 0.08);
	}
	.msg-bubble[data-author="system"] {
		border-style: dashed;
	}

	.msg-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 5px;
	}
	.msg-author {
		font-size: 11.5px;
		font-weight: 800;
		color: var(--color-ws-ink, #ececf2);
	}
	.msg-tag {
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		padding: 1px 6px;
		border-radius: 9999px;
		border: 1px solid rgba(34, 211, 238, 0.4);
		color: #a5f0fb;
	}
	.msg-time {
		margin-left: auto;
		font-size: 10.5px;
		color: var(--color-ws-faint, #6b6b78);
		white-space: nowrap;
	}
	.msg-row.own .msg-time {
		margin-left: 0;
		margin-right: auto;
	}

	.msg-body {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--color-ws-ink, #ececf2);
		/* Preserve user/AI line breaks WITHOUT converting to markup. */
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.msg-link {
		color: #a5b4fc;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.msg-link:hover {
		color: #c7d2fe;
	}
</style>
