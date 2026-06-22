<!-- Standalone cleaning tool -->
<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { isSupportedImageFile, SUPPORTED_IMAGE_ACCEPT } from "$lib/project/file-order.js";
	import { _ } from "$lib/i18n";

	// $_ returns the key itself on a miss / before init, so fall back to the
	// English source string in that case (keys live in all 5 locale files).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let canvasEl = $state<HTMLCanvasElement>();
	let fabricCanvas: any = $state(null);
	let fabricApi: any = null;
	let uploadedImage: any = $state(null);
	let isDrawing = $state(false);
	let brushSize = $state(20);
	let statusMsg = $state(t("tools.statusUploadToClean", "Upload an image to start cleaning"));
	let hasEdits = $state(false);

	const CLEAN_BRUSH_COLOR = "white";

	function readWorkspaceToken(name: string, fallback: string): string {
		if (typeof document === "undefined") return fallback;
		return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
	}

	function canvasBackgroundColor(): string {
		return readWorkspaceToken("--color-ws-surface2", "Canvas");
	}

	async function loadFabricApi() {
		if (!fabricApi) fabricApi = await import("fabric");
		return fabricApi;
	}

	function paintCanvasBackground() {
		if (!fabricCanvas) return;
		fabricCanvas.backgroundColor = canvasBackgroundColor();
		fabricCanvas.renderAll();
	}

	// Initialize Fabric.js canvas
	onMount(async () => {
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
		if (canvasEl) {
			const fabric = await loadFabricApi();
			fabricCanvas = new fabric.Canvas(canvasEl, {
				backgroundColor: canvasBackgroundColor(),
				selection: false,
				isDrawingMode: true,
			});

			fabricCanvas.freeDrawingBrush = new (fabric as any).PencilBrush(fabricCanvas);
			// Keep the output stroke pure white because this tool paints over scan dust.
			fabricCanvas.freeDrawingBrush.color = CLEAN_BRUSH_COLOR;
			fabricCanvas.freeDrawingBrush.width = brushSize;
			fabricCanvas.on("path:created", () => {
				hasEdits = true;
				statusMsg = t("tools.statusBrushAdded", "Brush stroke added");
			});
		}
	});

	// Dispose the Fabric canvas (and its path:created listener / drawing brush) on
	// unmount so the canvas DOM nodes and contexts are released instead of leaking.
	onDestroy(() => {
		if (fabricCanvas) {
			fabricCanvas.dispose();
			fabricCanvas = null;
		}
		uploadedImage = null;
	});

	async function handleUpload() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;

		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file || !fabricCanvas) return;
			if (!isSupportedImageFile(file)) {
				statusMsg = t("tools.errUnsupportedFile", "{name} isn't a supported image. Use PNG, JPG, or WebP.").replace("{name}", file.name);
				return;
			}

			statusMsg = t("tools.statusLoadingImage", "Loading image...");
			const url = URL.createObjectURL(file);

			const fabric = await loadFabricApi();
			try {
				const img = await fabric.FabricImage.fromURL(url);
				if (!fabricCanvas) return;

				fabricCanvas.clear();
				paintCanvasBackground();

				const maxWidth = 800;
				const scale = img.width! > maxWidth ? maxWidth / img.width! : 1;
				img.scale(scale);

				uploadedImage = img;
				img.set("selectable", false);
				img.set("evented", false);
				fabricCanvas.add(img);
				fabricCanvas.centerObject(img);
				fabricCanvas.renderAll();

				hasEdits = false;
				statusMsg = t("tools.statusDragBrush", "Drag the brush over spots to clean or cover");
			} catch {
				statusMsg = t("tools.statusLoadFailed", "Couldn't load the image. Choose a PNG, JPG, or WebP and try again.");
			} finally {
				URL.revokeObjectURL(url);
			}
		};

		input.click();
	}

	$effect(() => {
		if (fabricCanvas?.freeDrawingBrush) {
			fabricCanvas.freeDrawingBrush.width = brushSize;
		}
	});

	async function downloadResult() {
		if (!fabricCanvas || !uploadedImage) return;

		statusMsg = t("tools.statusPreparingDownload", "Preparing the download...");

		const canvas = document.createElement("canvas");
		const img = uploadedImage!;
		const scaleX = img.scaleX!;
		const scaleY = img.scaleY!;

		canvas.width = img.width! * scaleX;
		canvas.height = img.height! * scaleY;
		const ctx = canvas.getContext("2d")!;

		const dataUrl = img.toDataURL({
			format: "png",
			quality: 1,
		});

		const bgImg = new Image();
		bgImg.src = dataUrl;
		await new Promise(r => bgImg.onload = r);
		ctx.drawImage(bgImg, 0, 0, canvas.width, canvas.height);

		const paths = fabricCanvas.getObjects().filter((o: any) => o.type === "path");
		for (const path of paths) {
			const pathData = (path as any).path;
			ctx.save();
			ctx.translate(path.left + path.width / 2, path.top + path.height / 2);
			ctx.rotate(path.angle * Math.PI / 180);
			ctx.scale(path.scaleX, path.scaleY);
			ctx.translate(-path.left - path.width / 2, -path.top - path.height / 2);

			ctx.beginPath();
			for (let i = 0; i < pathData.length; i++) {
				const seg = pathData[i];
				if (seg[0] === "M") {
					ctx.moveTo(seg[1], seg[2]);
				} else if (seg[0] === "L") {
					ctx.lineTo(seg[1], seg[2]);
				} else if (seg[0] === "Q") {
					ctx.quadraticCurveTo(seg[1], seg[2], seg[3], seg[4]);
				} else if (seg[0] === "C") {
					ctx.bezierCurveTo(seg[1], seg[2], seg[3], seg[4], seg[5], seg[6]);
				}
			}
			ctx.strokeStyle = CLEAN_BRUSH_COLOR;
			ctx.lineWidth = (path as any).strokeWidth;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.stroke();
			ctx.restore();
		}

		const a = document.createElement("a");
		a.href = canvas.toDataURL("image/png");
		a.download = `cleaned_${Date.now()}.png`;
		a.click();

		statusMsg = t("tools.statusDownloaded", "File downloaded");
	}

	function undo() {
		if (!fabricCanvas) return;
		const objects = fabricCanvas.getObjects();
		const paths = objects.filter((o: any) => o.type === "path");
		if (paths.length > 0) {
			fabricCanvas.remove(paths[paths.length - 1]);
			fabricCanvas.renderAll();
			hasEdits = paths.length > 1;
			statusMsg = hasEdits ? t("tools.statusUndoneLatest", "Undid the latest brush stroke") : t("tools.statusUndoneAll", "Undid all brush strokes");
		}
	}

	function clearAll() {
		if (!fabricCanvas || !uploadedImage) return;
		const objects = fabricCanvas.getObjects();
		const paths = objects.filter((o: any) => o.type === "path");
		for (const path of paths) {
			fabricCanvas.remove(path);
		}
		fabricCanvas.renderAll();
		hasEdits = false;
		statusMsg = t("tools.statusClearedAll", "Cleared all brush strokes");
	}

	function reset() {
		if (!fabricCanvas) return;
		fabricCanvas.clear();
		paintCanvasBackground();
		uploadedImage = null;
		hasEdits = false;
		statusMsg = t("tools.statusUploadToClean", "Upload an image to start cleaning");
	}
</script>

<svelte:head>
	<title>{t("tools.cleanMeta", "Quick clean")} - Manga Editor</title>
</svelte:head>

<div class="tool-page ws-sans">
	<header class="tool-header ws-panel-quiet">
		<a href="/tools" class="back-link ws-btn-ghost">&lt; {t("tools.back", "Tools")}</a>
		<div class="header-title">
			<h1>{t("tools.cleanHeading", "Quick clean")}</h1>
			<p>{t("tools.cleanSub", "Use a brush to erase dust and stray bits on a page")}</p>
		</div>
	</header>

	<main class="tool-main">
		<div class="canvas-wrapper">
			<canvas bind:this={canvasEl}></canvas>

			{#if !uploadedImage}
				<div class="upload-prompt ws-panel">
					<div class="upload-icon ws-grad-primary-soft" aria-hidden="true">{t("tools.cleanUploadIcon", "Clean")}</div>
					<p>{t("tools.cleanUploadPrompt", "Upload an image to clean")}</p>
					<button class="btn-upload ws-grad-primary" onclick={handleUpload}>{t("tools.chooseImage", "Choose image")}</button>
				</div>
			{/if}
		</div>

		<aside class="tool-sidebar ws-panel">
			<div class="sidebar-section">
				<h3>{t("tools.brushSize", "Brush size")}</h3>
				<div class="brush-size-control">
					<input type="range" min="5" max="100" bind:value={brushSize} class="slider" />
					<span class="brush-size-value">{brushSize}px</span>
				</div>
				<div class="brush-preview">
					<div class="brush-dot" style="width: {brushSize}px; height: {brushSize}px;"></div>
				</div>
			</div>

			<div class="sidebar-section">
				<h3>{t("tools.commands", "Actions")}</h3>
				{#if uploadedImage}
					<button class="btn btn-secondary ws-btn-ghost" onclick={handleUpload}>{t("tools.changeImage", "Change image")}</button>
					{#if hasEdits}
						<button class="btn btn-secondary ws-btn-ghost" onclick={undo}>{t("tools.undo", "Undo brush stroke")}</button>
						<button class="btn btn-secondary ws-btn-ghost" onclick={clearAll}>{t("tools.clearAll", "Clear all strokes")}</button>
					{:else}
						<span class="btn btn-receipt ws-panel-quiet">{t("tools.noBrushStroke", "No brush strokes yet")}</span>
						<span class="btn btn-receipt ws-panel-quiet">{t("tools.noStrokeToClear", "No strokes to clear")}</span>
					{/if}
				{/if}
			</div>

			<div class="sidebar-section">
				<h3>{t("tools.export", "Export")}</h3>
				{#if uploadedImage}
					<button class="btn btn-primary ws-grad-primary" onclick={downloadResult}>{t("tools.download", "Download")}</button>
					<button class="btn btn-secondary ws-btn-ghost" onclick={reset}>{t("tools.restart", "Start over")}</button>
				{:else}
					<span class="btn btn-receipt ws-panel-quiet">{t("tools.uploadBeforeExport", "Upload before exporting")}</span>
					<span class="btn btn-receipt ws-panel-quiet">{t("tools.noImageToRestart", "No image to restart")}</span>
				{/if}
			</div>

			<div class="sidebar-section status-section">
				<p class="status">{statusMsg}</p>
			</div>
		</aside>
	</main>
</div>

<style>
	.tool-page {
		min-height: 100vh;
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		display: flex;
		flex-direction: column;
	}

	.tool-header {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 16px 24px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		color: var(--color-ws-ink);
		text-decoration: none;
		font-size: 14px;
		padding: 6px 12px;
		border-radius: var(--radius-ws-ctrl);
		transition: background 0.15s;
	}

	.back-link:hover {
		color: var(--color-ws-ink);
	}

	.header-title h1 {
		font-size: 18px;
		font-weight: 800;
		margin: 0;
	}

	.header-title p {
		font-size: 12px;
		color: var(--color-ws-text);
		margin: 4px 0 0 0;
	}

	.tool-main {
		flex: 1;
		display: grid;
		grid-template-columns: 1fr 280px;
		overflow: hidden;
	}

	.canvas-wrapper {
		position: relative;
		background: var(--color-ws-bg);
		background-image: radial-gradient(circle, var(--ws-hair) 1px, transparent 1px);
		background-size: 20px 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}

	.canvas-wrapper canvas {
		max-width: 100%;
		max-height: 100%;
		cursor: crosshair;
	}

	.upload-prompt {
		text-align: center;
		padding: 40px;
		border-radius: var(--radius-ws-card);
	}

	.upload-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		margin-bottom: 16px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		border-radius: 14px;
		color: var(--color-ws-ink);
		font-size: 17px;
		font-weight: 800;
		letter-spacing: 0;
	}

	.upload-prompt p {
		font-size: 14px;
		color: var(--color-ws-text);
		margin-bottom: 20px;
	}

	.btn-upload {
		min-height: 40px;
		padding: 10px 20px;
		color: var(--color-ws-ink);
		border: none;
		border-radius: var(--radius-ws-ctrl);
		font-size: 14px;
		font-weight: 800;
		cursor: pointer;
		transition: filter 0.15s;
	}

	.btn-upload:hover {
		filter: brightness(1.08);
	}

	.tool-sidebar {
		border-left: 1px solid var(--ws-hair);
		padding: 16px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.sidebar-section h3 {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--color-ws-text);
		margin: 0 0 12px 0;
	}

	.brush-size-control {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
	}

	.slider {
		flex: 1;
		height: 40px;
		border-radius: var(--radius-ws-ctrl);
		background: transparent;
		outline: none;
		appearance: none;
		-webkit-appearance: none;
	}

	.slider::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 999px;
		background: var(--ws-hair-strong);
	}

	.slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		margin-top: -6px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--color-ws-accent);
		cursor: pointer;
	}

	.brush-size-value {
		font-size: 12px;
		color: var(--color-ws-text);
		min-width: 40px;
		text-align: right;
	}

	.brush-preview {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 60px;
		background: var(--color-ws-bg);
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
	}

	.brush-dot {
		background: var(--color-ws-ink);
		border-radius: 50%;
		max-width: 50px;
		max-height: 50px;
	}

	.btn {
		width: 100%;
		min-height: 40px;
		padding: 10px;
		border: 1px solid transparent;
		border-radius: var(--radius-ws-ctrl);
		font-size: 13px;
		font-weight: 800;
		cursor: pointer;
		transition: all 0.15s;
		margin-bottom: 8px;
	}

	.btn-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-ws-text);
		cursor: default;
		opacity: 0.72;
	}

	.btn-primary {
		color: var(--color-ws-ink);
	}

	.btn-primary:hover {
		filter: brightness(1.08);
	}

	.btn-secondary {
		border-color: var(--ws-hair);
		color: var(--color-ws-ink);
	}

	.btn-secondary:hover {
		border-color: var(--ws-hair-strong);
	}

	.status-section {
		padding-top: 8px;
		border-top: 1px solid var(--ws-hair);
	}

	.status {
		font-size: 12px;
		color: var(--color-ws-text);
		margin: 0;
		line-height: 1.45;
	}

	.back-link:focus-visible,
	.btn:focus-visible,
	.btn-upload:focus-visible,
	.slider:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}

	@media (max-width: 768px) {
		.tool-main {
			grid-template-columns: 1fr;
			grid-template-rows: 1fr auto;
		}

		.tool-sidebar {
			border-left: none;
			border-top: 1px solid var(--ws-hair);
			max-height: 40vh;
		}

		.canvas-wrapper {
			min-height: 40vh;
		}
	}
</style>
