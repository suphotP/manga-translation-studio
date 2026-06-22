<script lang="ts">
	let {
		size = 12,
		fill = "currentColor",
		fillOpacity = undefined,
		class: className = undefined,
	}: {
		size?: number;
		fill?: string;
		fillOpacity?: number | string;
		class?: string;
	} = $props();
</script>

<svg class={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
	<path d="M12 6l1.6 4.4L18 12l-4.4 1.6L12 18l-1.6-4.4L6 12l4.4-1.6z" fill={fill} fill-opacity={fillOpacity} />
</svg>
