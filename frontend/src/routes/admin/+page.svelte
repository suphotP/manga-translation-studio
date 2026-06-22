<script lang="ts">
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	// Default landing inside /admin points to the workspaces overview.
	onMount(() => goto("/admin/workspaces"));
</script>

<p style="padding: 32px; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px;">กำลังพาไปแผงผู้ดูแล…</p>
