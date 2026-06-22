<!-- ToolCard - reusable card for tool selection -->
<script lang="ts">
	interface Props {
		title: string;
		description: string;
		icon: string;
		href: string;
		color: string;
	}

	let { title, description, icon, href, color }: Props = $props();
</script>

<a {href} class="tool-card" style="--card-color: {color};">
	<div class="tool-icon">{icon}</div>
	<div class="tool-content">
		<h2 class="tool-title">{title}</h2>
		<p class="tool-description">{description}</p>
	</div>
	<div class="tool-arrow">&gt;</div>
</a>

<style>
	.tool-card {
		position: relative;
		display: flex;
		align-items: center;
		gap: 16px;
		overflow: hidden;
		padding: 20px;
		border: 1px solid var(--editor-border);
		border-radius: 8px;
		background: var(--editor-surface);
		color: inherit;
		text-decoration: none;
		transition: all 0.2s ease;
	}

	.tool-card::before {
		position: absolute;
		top: 0;
		left: 0;
		width: 4px;
		height: 100%;
		background: var(--card-color);
		opacity: 0;
		transition: opacity 0.2s ease;
		content: "";
	}

	.tool-card:hover {
		border-color: var(--card-color);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
		transform: translateY(-2px);
	}

	.tool-card:hover::before {
		opacity: 1;
	}

	.tool-icon {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--card-color) 12%, transparent);
		color: var(--card-color);
		font-size: 15px;
		font-weight: 900;
		letter-spacing: 0.04em;
	}

	.tool-content {
		flex: 1;
		min-width: 0;
	}

	.tool-title {
		margin: 0 0 4px;
		color: var(--editor-text);
		font-size: 16px;
		font-weight: 600;
	}

	.tool-description {
		margin: 0;
		color: var(--editor-text-dim);
		font-size: 13px;
		line-height: 1.4;
	}

	.tool-arrow {
		flex-shrink: 0;
		color: var(--card-color);
		font-size: 18px;
		opacity: 0.85;
		transition: all 0.2s ease;
	}

	.tool-card:hover .tool-arrow {
		opacity: 1;
	}

	@media (max-width: 480px) {
		.tool-card {
			gap: 12px;
			padding: 16px;
		}

		.tool-icon {
			width: 44px;
			height: 44px;
			font-size: 12px;
		}

		.tool-title {
			font-size: 14px;
		}

		.tool-description {
			font-size: 12px;
		}
	}
</style>
