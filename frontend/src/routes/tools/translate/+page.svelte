<!-- Standalone translation tool -->
<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { config } from "$lib/config.js";
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
	let cropRect: any = $state(null);
	let isDrawing = $state(false);
	let startX = $state(0);
	let startY = $state(0);
	let selectedLang = $state(config.defaultLang);
	let isProcessing = $state(false);
	let statusMsg = $state(t("tools.statusUploadToTranslate", "Upload an image to start translating"));
	let resultUrl = $state<string | null>(null);

	function readWorkspaceToken(name: string, fallback: string): string {
		if (typeof document === "undefined") return fallback;
		return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
	}

	function canvasBackgroundColor(): string {
		return readWorkspaceToken("--color-ws-surface2", "Canvas");
	}

	function cropStrokeColor(): string {
		return readWorkspaceToken("--color-ws-accent", "AccentColor");
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
			});
			setupCanvasEvents();
		}
	});

	// Dispose the Fabric canvas on unmount so its event listeners, DOM nodes,
	// and WebGL/2D contexts are released instead of leaking when navigating away.
	onDestroy(() => {
		if (fabricCanvas) {
			fabricCanvas.dispose();
			fabricCanvas = null;
		}
		uploadedImage = null;
		cropRect = null;
	});

	function setupCanvasEvents() {
		if (!fabricCanvas || !fabricApi) return;

		fabricCanvas.on("mouse:down", (opt: any) => {
			if (!uploadedImage || isProcessing) return;
			isDrawing = true;
			const ptr = fabricCanvas.getPointer(opt.e);
			startX = ptr.x;
			startY = ptr.y;

			if (cropRect) {
				fabricCanvas.remove(cropRect);
			}

			cropRect = new fabricApi.Rect({
				left: startX,
				top: startY,
				width: 0,
				height: 0,
				fill: "rgba(124, 92, 255, 0.2)",
				stroke: cropStrokeColor(),
				strokeWidth: 2,
				strokeDashArray: [5, 5],
			});
			fabricCanvas.add(cropRect);
		});

		fabricCanvas.on("mouse:move", (opt: any) => {
			if (!isDrawing || !cropRect) return;
			const ptr = fabricCanvas.getPointer(opt.e);
			const width = ptr.x - startX;
			const height = ptr.y - startY;

			cropRect.set({
				width: Math.abs(width),
				height: Math.abs(height),
				left: width < 0 ? ptr.x : startX,
				top: height < 0 ? ptr.y : startY,
			});
			fabricCanvas.renderAll();
		});

		fabricCanvas.on("mouse:up", () => {
			isDrawing = false;
		});
	}

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
				fabricCanvas.add(img);
				fabricCanvas.centerObject(img);
				fabricCanvas.setZoom(1);
				fabricCanvas.renderAll();

				cropRect = null;
				resultUrl = null;
				statusMsg = t("tools.statusDragCropOrTranslate", "Drag a crop box, or press translate to use the whole image");
			} catch {
				statusMsg = t("tools.statusLoadFailed", "Couldn't load the image. Choose a PNG, JPG, or WebP and try again.");
			} finally {
				URL.revokeObjectURL(url);
			}
		};

		input.click();
	}

	function clearCrop() {
		if (cropRect && fabricCanvas) {
			fabricCanvas.remove(cropRect);
			cropRect = null;
			fabricCanvas.renderAll();
		}
	}

	async function generate() {
		if (!uploadedImage || !fabricCanvas || isProcessing) return;

		isProcessing = true;
		statusMsg = t("tools.statusTranslating", "Translating...");

		try {
			let crop: { x: number; y: number; w: number; h: number };

			if (cropRect) {
				const bounds = cropRect.getBoundingRect();
				const vpt = fabricCanvas.viewportTransform;
				crop = {
					x: (bounds.left - vpt![4]) / fabricCanvas.getZoom(),
					y: (bounds.top - vpt![5]) / fabricCanvas.getZoom(),
					w: bounds.width,
					h: bounds.height,
				};
			} else {
				const img = uploadedImage;
				crop = {
					x: 0,
					y: 0,
					w: img.width! * img.scaleX!,
					h: img.height! * img.scaleY!,
				};
			}

			const canvas = document.createElement("canvas");
			canvas.width = crop.w;
			canvas.height = crop.h;
			const ctx = canvas.getContext("2d")!;

			const dataUrl = uploadedImage.toDataURL({
				left: crop.x,
				top: crop.y,
				width: crop.w,
				height: crop.h,
			});

			const img = new Image();
			img.src = dataUrl;
			await new Promise(r => img.onload = r);
			ctx.drawImage(img, 0, 0);

			const blob = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob((value) => {
					if (value) resolve(value);
					else reject(new Error("crop_blob_failed"));
				}, "image/png");
			});
			const file = new File([blob], "crop.png", { type: "image/png" });

			const fd = new FormData();
			fd.append("image", file);
			fd.append("lang", selectedLang);

			const res = await fetch("/api/tools/translate", {
				method: "POST",
				body: fd,
			});

			if (!res.ok) throw new Error("translation_failed");

			const data = await res.json();
			resultUrl = `/api/tools/result/${data.resultId}`;
			statusMsg = t("tools.statusTranslateDone", "Translation done");
		} catch (e) {
			const code = (e as Error).message;
			const message = code === "translation_failed" || code === "crop_blob_failed"
				? t("tools.statusTranslateFailedGeneric", "Translation failed, please try again")
				: code;
			statusMsg = t("tools.errTranslateFailed", "Translation failed: {message}").replace("{message}", message);
		} finally {
			isProcessing = false;
		}
	}

	function downloadResult() {
		if (!resultUrl) return;
		const a = document.createElement("a");
		a.href = resultUrl;
		a.download = `translated_${Date.now()}.png`;
		a.click();
	}

	function reset() {
		if (!fabricCanvas) return;
		fabricCanvas.clear();
		paintCanvasBackground();
		uploadedImage = null;
		cropRect = null;
		resultUrl = null;
		statusMsg = t("tools.statusUploadToTranslate", "Upload an image to start translating");
	}
</script>

<svelte:head>
	<title>{t("tools.translateMeta", "Quick translate")} - Manga Editor</title>
</svelte:head>

<div class="tool-page ws-sans">
	<header class="tool-header ws-panel-quiet">
		<a href="/tools" class="back-link ws-btn-ghost">&lt; {t("tools.back", "Tools")}</a>
		<div class="header-title">
			<h1>{t("tools.translateHeading", "Quick translate")}</h1>
			<p>{t("tools.translateSub", "Upload, crop, then translate a page fast")}</p>
		</div>
	</header>

	<main class="tool-main">
		<div class="canvas-wrapper">
			<canvas bind:this={canvasEl}></canvas>

			{#if !uploadedImage}
				<div class="upload-prompt ws-panel">
					<div class="upload-icon ws-grad-primary-soft" aria-hidden="true">{t("tools.translateUploadIcon", "Translate")}</div>
					<p>{t("tools.translateUploadPrompt", "Upload an image to start translating")}</p>
					<button class="btn-upload ws-grad-primary" onclick={handleUpload}>{t("tools.chooseImage", "Choose image")}</button>
				</div>
			{/if}
		</div>

		<aside class="tool-sidebar ws-panel">
			<div class="sidebar-section">
				<h3>{t("tools.settings", "Settings")}</h3>
				<label class="field">
					<span class="label">{t("tools.targetLanguage", "Target language")}</span>
					<select class="select" bind:value={selectedLang}>
						{#each Object.entries(config.languages) as [code, name] (code)}
							<option value={code}>{name}</option>
						{/each}
					</select>
				</label>
			</div>

			<div class="sidebar-section">
				<h3>{t("tools.commands", "Actions")}</h3>
				{#if uploadedImage}
					<button class="btn btn-secondary ws-btn-ghost" onclick={handleUpload}>{t("tools.changeImage", "Change image")}</button>
					{#if cropRect}
						<button class="btn btn-secondary ws-btn-ghost" onclick={clearCrop}>{t("tools.clearCrop", "Clear crop box")}</button>
					{:else}
						<span class="btn btn-receipt ws-panel-quiet">{t("tools.noCropBox", "No crop box yet")}</span>
					{/if}
				{/if}
			</div>

			<div class="sidebar-section">
				<h3>{t("tools.process", "Process")}</h3>
				{#if !uploadedImage}
					<span class="btn btn-receipt ws-panel-quiet">{t("tools.uploadBeforeTranslate", "Upload before translating")}</span>
				{:else if isProcessing}
					<span class="btn btn-receipt ws-panel-quiet">{t("tools.translating", "Translating...")}</span>
				{:else}
					<button class="btn btn-primary ws-grad-primary" onclick={generate}>{t("tools.translate", "Translate")}</button>
				{/if}
				{#if resultUrl}
					<button class="btn btn-success ws-btn-ghost" onclick={downloadResult}>{t("tools.download", "Download")}</button>
				{:else}
					<span class="btn btn-receipt ws-panel-quiet">{t("tools.waitForResult", "Wait for the result first")}</span>
				{/if}
				{#if uploadedImage}
					<button class="btn btn-secondary ws-btn-ghost" onclick={reset}>{t("tools.restart", "Start over")}</button>
				{:else}
					<span class="btn btn-receipt ws-panel-quiet">{t("tools.noImageToRestart", "No image to restart")}</span>
				{/if}
			</div>

			<div class="sidebar-section status-section">
				<p class="status">{statusMsg}</p>
			</div>

			{#if resultUrl}
				<div class="sidebar-section">
					<h3>{t("tools.result", "Result")}</h3>
					<img src={resultUrl} alt={t("tools.resultAlt", "Translation result")} class="result-preview" />
				</div>
			{/if}
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

	.field {
		display: block;
		margin-bottom: 12px;
	}

	.label {
		display: block;
		font-size: 12px;
		color: var(--color-ws-text);
		margin-bottom: 6px;
	}

	.select {
		width: 100%;
		min-height: 40px;
		padding: 8px;
		background: var(--color-ws-bg);
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-size: 13px;
		outline: none;
	}

	.select:focus {
		border-color: var(--color-ws-accent);
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

	.btn-success {
		border-color: color-mix(in srgb, var(--color-ws-green) 42%, transparent);
		color: var(--color-ws-green);
	}

	.btn-success:hover {
		border-color: color-mix(in srgb, var(--color-ws-green) 64%, transparent);
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

	.result-preview {
		width: 100%;
		border-radius: var(--radius-ws-card);
		border: 1px solid var(--ws-hair);
	}

	.back-link:focus-visible,
	.btn:focus-visible,
	.btn-upload:focus-visible,
	.select:focus-visible {
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
