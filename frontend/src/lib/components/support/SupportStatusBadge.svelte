<!-- SupportStatusBadge — coloured pill for a support ticket's lifecycle status.
     Mirrors PlanBadge's ws-* utility approach so it reads as part of the app. -->
<script lang="ts">
	import type { SupportTicketStatus } from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import { statusLabel } from "./support-format.ts";

	let {
		status,
		size = "sm",
	}: {
		status: SupportTicketStatus;
		size?: "sm" | "md";
	} = $props();

	// Localise via svelte-i18n with an explicit Thai fallback ($_ returns the
	// key itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let label = $derived(statusLabel(status, t));

	const TONE: Record<SupportTicketStatus, string> = {
		open: "border-ws-cyan/35 bg-ws-cyan/15 text-ws-cyan",
		pending: "border-ws-amber/40 bg-ws-amber/15 text-ws-amber",
		escalated: "border-ws-rose/40 bg-ws-rose/15 text-ws-rose",
		resolved: "border-ws-green/40 bg-ws-green/15 text-ws-green",
		closed: "border-white/15 bg-white/[0.06] text-ws-faint",
	};

	const SIZE: Record<"sm" | "md", string> = {
		sm: "h-5 px-2 text-[10px] tracking-wider",
		md: "h-6 px-2.5 text-[11px] tracking-wider",
	};
</script>

<span
	class={`inline-flex items-center gap-1 rounded-full border font-bold uppercase ${SIZE[size]} ${TONE[status]}`}
	aria-label={`${t("support.statusBadge.aria", "สถานะ")} ${label}`}
>
	{label}
</span>
