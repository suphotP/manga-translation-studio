import { maskBuffer, SELECTION_OVERLAY_NAME } from "$lib/editor/tools/index.ts";

type Point = { x: number; y: number };

type TestImageOptions = {
	width?: number;
	height?: number;
	fill?: string;
	label?: string;
};

function createTestImageDataUrl(options: TestImageOptions = {}): string {
	const width = options.width ?? 1600;
	const height = options.height ?? 2400;
	const fill = options.fill ?? "#ffffff";
	const label = options.label ?? "MANGA EDITOR TEST";
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Could not create test image context");

	ctx.fillStyle = fill;
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = fill === "#ffffff" || fill === "white" ? "#111111" : "#ffffff";
	ctx.font = "96px Arial";
	ctx.fillText(`${label} ${width}x${height}`, 100, 180);
	ctx.strokeStyle = "#f00";
	ctx.lineWidth = 12;
	ctx.strokeRect(Math.round(width * 0.08), Math.round(height * 0.22), Math.round(width * 0.76), Math.round(width * 0.76));
	ctx.strokeStyle = "#05f";
	ctx.lineWidth = 8;
	for (let y = 0; y < height; y += 200) {
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
		ctx.stroke();
	}

	return canvas.toDataURL("image/png");
}

function getCanvasMetrics(editor: any) {
	const upperCanvas = editor.canvas?.upperCanvasEl as HTMLCanvasElement | undefined;
	const lowerCanvas = editor.canvas?.lowerCanvasEl as HTMLCanvasElement | undefined;
	const rect = upperCanvas?.getBoundingClientRect();
	return {
		width: editor.canvasWidth,
		height: editor.canvasHeight,
		zoom: editor.canvas?.getZoom?.() ?? 1,
		skipOffscreen: editor.canvas?.skipOffscreen,
		viewportTransform: [...(editor.canvas?.viewportTransform ?? [1, 0, 0, 1, 0, 0])],
		upper: upperCanvas ? { width: upperCanvas.width, height: upperCanvas.height } : null,
		lower: lowerCanvas ? { width: lowerCanvas.width, height: lowerCanvas.height } : null,
		rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
	};
}

function imagePointToClient(editor: any, point: Point): Point {
	const metrics = getCanvasMetrics(editor);
	const rect = metrics.rect;
	if (!rect) throw new Error("Editor canvas is not mounted");
	const bounds = editor.imageBounds;
	const vpt = metrics.viewportTransform;
	const sceneX = bounds.left + (point.x / editor.imageWidth) * bounds.width;
	const sceneY = bounds.top + (point.y / editor.imageHeight) * bounds.height;
	return {
		x: rect.left + sceneX * vpt[0] + vpt[4],
		y: rect.top + sceneY * vpt[3] + vpt[5],
	};
}

function scenePointToClient(editor: any, point: Point): Point {
	const metrics = getCanvasMetrics(editor);
	const rect = metrics.rect;
	if (!rect) throw new Error("Editor canvas is not mounted");
	const vpt = metrics.viewportTransform;
	return {
		x: rect.left + point.x * vpt[0] + vpt[4],
		y: rect.top + point.y * vpt[3] + vpt[5],
	};
}

function getImageLayerSource(editor: any, layerId: string) {
	const imageObject = editor.imageLayers?.find?.((item: any) => item._imageLayerData?.id === layerId);
	const layer = imageObject?._imageLayerData;
	const source = imageObject?.getElement?.() ?? imageObject?._element ?? imageObject?._originalElement;
	return { imageObject, layer, source };
}

function getState(editor: any) {
	const imageItem = editor.imageItem;
	const activeObject = editor.canvas?.getActiveObject?.();
	const viewportTransform = Array.isArray(editor.canvas?.viewportTransform)
		? editor.canvas.viewportTransform.slice()
		: null;
	return {
		canvas: getCanvasMetrics(editor),
		// W3.13 iPad QA — true while an image-edit suite tool owns the pointer, plus
		// the live viewport transform so touch-routing tests can assert a single
		// finger DRAWS (mask grows, no pan) while two fingers PAN (transform moves).
		imageToolActive: editor.imageToolActive === true,
		viewportTransform,
		image: {
			width: editor.imageWidth,
			height: editor.imageHeight,
			bounds: { ...editor.imageBounds },
			item: imageItem ? {
				left: imageItem.left,
				top: imageItem.top,
				scaleX: imageItem.scaleX,
				scaleY: imageItem.scaleY,
			} : null,
		},
		selection: editor.selectionRect ? {
			left: editor.selectionRect.left,
			top: editor.selectionRect.top,
			width: editor.selectionRect.width,
			height: editor.selectionRect.height,
		} : null,
		crop: editor.getCoverCrop?.() ?? null,
			brush: {
				size: editor.brushSize,
				hardness: editor.brushHardness,
				opacity: editor.brushOpacity,
				mode: editor.brushMode,
				defaultCursor: editor.canvas?.defaultCursor ?? null,
				pendingCommit: typeof editor.hasPendingBrushCommit === "function" ? editor.hasPendingBrushCommit() : false,
				commitError: editor.getBrushCommitErrorMessage?.() ?? null,
				selectedImageLayerId: editor.selectedImageLayerIdForBrush ?? null,
				activeTargetLayerId: editor.imageLayerBrushTarget?.layerId ?? null,
				lastTargetKind: editor.lastBrushTargetKind ?? null,
				lastImageLayerBrushCommit: editor.lastImageLayerBrushCommit ?? null,
			preview: editor.brushPreview ? {
				visible: editor.brushPreview.visible === true,
				left: editor.brushPreview.left,
				top: editor.brushPreview.top,
				radius: editor.brushPreview.radius,
				strokeWidth: editor.brushPreview.strokeWidth,
				blocked: editor.brushPreview._brushPreviewBlocked === true,
			} : null,
		},
		textLayers: editor.getAllTextLayers?.() ?? [],
		imageLayers: editor.getAllImageLayers?.() ?? [],
		selectionChromeMuted: editor.selectionChromeMuted === true,
		imageLayerStyles: editor.imageLayers?.map?.((obj: any) => ({
			opacity: obj.opacity,
			scaleX: obj.scaleX,
			scaleY: obj.scaleY,
			angle: obj.angle,
			flipX: obj.flipX === true,
			flipY: obj.flipY === true,
			sourceW: obj._imageLayerData?.sourceW,
			sourceH: obj._imageLayerData?.sourceH,
			globalCompositeOperation: obj.globalCompositeOperation ?? null,
			layerData: obj._imageLayerData ? { ...obj._imageLayerData } : null,
			visible: obj.visible,
			selectable: obj.selectable,
			evented: obj.evented,
			hasControls: obj.hasControls,
			hasBorders: obj.hasBorders,
			locked: obj._imageLayerData?.locked === true,
		})) ?? [],
		activeLayerId: activeObject?._imageLayerData?.id ?? activeObject?._textLayerData?.id ?? null,
		textLayerStyles: editor.textLayers?.map?.((obj: any) => ({
			opacity: obj.opacity,
			fill: obj.fill,
			stroke: obj.stroke,
			strokeWidth: obj.strokeWidth,
			paintFirst: obj.paintFirst,
			shadow: obj.shadow ? {
				color: obj.shadow.color,
				offsetX: obj.shadow.offsetX,
				offsetY: obj.shadow.offsetY,
				blur: obj.shadow.blur,
			} : null,
			fontSize: obj.fontSize,
			width: obj.width,
			height: obj.height,
			boxWidth: obj._textLayerBoxWidth,
			boxHeight: obj._textLayerBoxHeight,
			scaleX: obj.scaleX,
			scaleY: obj.scaleY,
			textHeight: obj.calcTextHeight?.() ?? obj.height,
			layerData: obj._textLayerData ? { ...obj._textLayerData } : null,
			visible: obj.visible,
			selectable: obj.selectable,
			evented: obj.evented,
			hasControls: obj.hasControls,
			hasBorders: obj.hasBorders,
			locked: obj._textLayerData?.locked === true,
		})) ?? [],
		textEffectShadowPassStyles: Array.from(editor.textEffectShadowPasses?.entries?.() ?? []).flatMap(([layerId, passes]: any) =>
			(passes ?? []).map((obj: any) => ({
				layerId,
				opacity: obj.opacity,
				fill: obj.fill,
				stroke: obj.stroke,
				strokeWidth: obj.strokeWidth,
				shadow: obj.shadow ? {
					color: obj.shadow.color,
					offsetX: obj.shadow.offsetX,
					offsetY: obj.shadow.offsetY,
					blur: obj.shadow.blur,
				} : null,
				visible: obj.visible,
				selectable: obj.selectable,
				evented: obj.evented,
			}))
		),
		processingIndicators: Array.from(editor.processingIndicators?.entries?.() ?? []).map(([id, indicator]: any) => ({
			id,
			label: indicator.label?.text,
			fill: indicator.rect?.fill,
			stroke: indicator.rect?.stroke,
			strokeWidth: indicator.rect?.strokeWidth,
			strokeDashArray: indicator.rect?.strokeDashArray,
		})),
		objects: editor.canvas?.getObjects?.().map((obj: any) => obj.type) ?? [],
		objectLayerOrder: editor.canvas?.getObjects?.().map((obj: any) => (
			obj._imageLayerData?.id
				? `image:${obj._imageLayerData.id}`
				: obj._textEffectPassForLayerId
					? `text-effect:${obj._textEffectPassForLayerId}`
				: obj._textLayerData?.id
					? `text:${obj._textLayerData.id}`
					: obj.type
		)) ?? [],
	};
}

export function installEditorDebug(editor: any) {
	if (typeof window === "undefined") return;
	if (!import.meta.env.DEV && import.meta.env.VITE_E2E !== "1") return;

	window.__mangaEditorDebug = {
		getState: () => getState(editor),
		imagePointToClient: (point: Point) => imagePointToClient(editor, point),
		imageLayerSourcePointToClient: (layerId: string, point: Point) => {
			const { imageObject, source } = getImageLayerSource(editor, layerId);
			if (!imageObject || !source || typeof imageObject.calcTransformMatrix !== "function") return null;
			const width = Math.max(1, Math.round(source.width || imageObject.width || 1));
			const height = Math.max(1, Math.round(source.height || imageObject.height || 1));
			const scenePoint = editor.f.util.transformPoint(
				{ x: point.x - width / 2, y: point.y - height / 2 },
				imageObject.calcTransformMatrix(),
			);
			return scenePointToClient(editor, scenePoint);
		},
		loadTestImage: async (options?: TestImageOptions) => {
			await editor.loadImage(createTestImageDataUrl(options));
			return getState(editor);
		},
		loadImageUrl: async (url: string) => {
			await editor.loadImage(url);
			return getState(editor);
		},
		addTextLayers: (layers: any[]) => {
			for (const layer of layers) {
				editor.addTextLayer(layer);
			}
			return getState(editor);
		},
		selectTextLayer: (layerId: string) => {
			editor.selectTextLayer?.(layerId);
			return getState(editor);
		},
		addImageLayers: async (layers: any[]) => {
			for (const layer of layers) {
				const imageUrl = layer.imageUrl ?? createTestImageDataUrl({
					width: Math.max(1, Math.round(layer.w ?? 320)),
					height: Math.max(1, Math.round(layer.h ?? 240)),
					fill: layer.fill ?? "#2563eb",
					label: layer.imageName ?? "IMAGE LAYER",
				});
				const imageLayer = { ...layer };
				delete imageLayer.imageUrl;
				delete imageLayer.fill;
				await editor.addImageLayer(imageLayer, imageUrl);
			}
			return getState(editor);
		},
		selectImageLayer: (layerId: string) => {
			editor.selectImageLayer?.(layerId);
			return getState(editor);
		},
		clearSelection: () => {
			editor.canvas?.discardActiveObject?.();
			editor.selectedImageLayerIdForBrush = null;
			editor.onTextLayerSelect?.(null);
			editor.onImageLayerSelect?.(null);
			editor.canvas?.requestRenderAll?.();
			return getState(editor);
		},
		updateTextLayer: (layerId: string, updates: any) => {
			editor.updateTextLayer?.(layerId, updates);
			return getState(editor);
		},
		updateImageLayer: (layerId: string, updates: any) => {
			editor.updateImageLayer?.(layerId, updates);
			return getState(editor);
		},
		moveLayerInStack: (kind: "text" | "image", layerId: string, direction: -1 | 1) => {
			editor.moveLayerInStack?.(kind, layerId, direction);
			return getState(editor);
		},
		moveLayerInStackWithHistory: (kind: "text" | "image", layerId: string, direction: -1 | 1) => {
			editor.moveLayerInStackWithHistory?.(kind, layerId, direction);
			return getState(editor);
		},
		setBrushMode: (mode: "erase" | "restore") => {
			editor.setBrushMode?.(mode);
			return getState(editor);
		},
		setLegacyAiMaskBrushEnabled: (enabled: boolean) => {
			editor.setLegacyAiMaskBrushEnabled?.(enabled);
			return getState(editor);
		},
		undo: async () => {
			await editor.undo?.();
			return getState(editor);
		},
		redo: async () => {
			await editor.redo?.();
			return getState(editor);
		},
		exportMergedImageDataUrl: () => editor.exportMergedImageDataUrl(),
			getBrushCommitErrorMessage: () => editor.getBrushCommitErrorMessage?.() ?? null,
			clearEraserMask: () => {
				editor.clearEraserMask?.();
				return getState(editor);
			},
			setAiOverlayTestImage: async (options?: TestImageOptions) => {
			await editor.updateBackgroundImage(createTestImageDataUrl({
				fill: "#c1121f",
				label: "AI OVERLAY",
				...options,
			}), true);
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			return getState(editor);
		},
		setAspectRatio: (ratio: [number, number] | null) => {
			editor.setAspectRatio(ratio);
			return getState(editor);
		},
		setTool: (tool: string) => {
			editor.setTool(tool);
			return getState(editor);
		},
		setSelectionChromeMuted: (muted: boolean) => {
			editor.setSelectionChromeMuted?.(muted);
			return getState(editor);
		},
		clearCoverSelection: () => {
			editor.clearCoverSelection?.();
			return getState(editor);
		},
		showProcessingIndicator: (jobId: string, crop: { x: number; y: number; w: number; h: number }, stage: string) => {
			editor.showProcessingIndicator?.(jobId, crop, stage);
			return getState(editor);
		},
		updateProcessingIndicator: (jobId: string, stage: string) => {
			editor.updateProcessingIndicator?.(jobId, stage);
			return getState(editor);
		},
		hideProcessingIndicator: (jobId: string) => {
			editor.hideProcessingIndicator?.(jobId);
			return getState(editor);
		},
		zoomAtCanvasPoint: (point: Point, zoom: number) => {
			editor.zoomAtCanvasPoint(point, zoom);
			return getState(editor);
		},
		setBrushSize: (size: number) => {
			editor.setBrushSize(size);
			return getState(editor);
		},
		sampleEraserPixel: (point: Point) => {
			const canvas = editor.eraserCanvas as HTMLCanvasElement | null;
			if (!canvas) return null;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			return Array.from(ctx.getImageData(point.x, point.y, 1, 1).data);
		},
		sampleImageLayerPixel: (layerId: string, point: Point) => {
			const { layer, source } = getImageLayerSource(editor, layerId);
			if (!layer || !source) return null;
			if (point.x < layer.x || point.x > layer.x + layer.w || point.y < layer.y || point.y > layer.y + layer.h) return null;

			const width = Math.max(1, Math.round(source.width || layer.w));
			const height = Math.max(1, Math.round(source.height || layer.h));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(source, 0, 0, width, height);

			const localX = Math.max(0, Math.min(Math.round((point.x - layer.x) * (width / Math.max(1, layer.w))), width - 1));
			const localY = Math.max(0, Math.min(Math.round((point.y - layer.y) * (height / Math.max(1, layer.h))), height - 1));
			return Array.from(ctx.getImageData(localX, localY, 1, 1).data);
		},
		sampleImageLayerSourcePixel: (layerId: string, point: Point) => {
			const { source } = getImageLayerSource(editor, layerId);
			if (!source) return null;
			const width = Math.max(1, Math.round(source.width || 1));
			const height = Math.max(1, Math.round(source.height || 1));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(source, 0, 0, width, height);
			const localX = Math.max(0, Math.min(Math.round(point.x), width - 1));
			const localY = Math.max(0, Math.min(Math.round(point.y), height - 1));
			return Array.from(ctx.getImageData(localX, localY, 1, 1).data);
		},
		// W3.13 PR#140 QA — observe the image-edit suite's committed selection so
		// tests can assert the mask + on-canvas overlay are cleared on tool-switch
		// (P1a) and editor destroy (P1b). Reads the shared MaskBuffer singleton and
		// counts named selection-overlay Fabric objects on the live canvas.
		getImageSelectionState: () => {
			const objects = editor.canvas?.getObjects?.() ?? [];
			const overlayObjects = objects.filter(
				(o: any) => o?.name === SELECTION_OVERLAY_NAME || o?.[SELECTION_OVERLAY_NAME],
			).length;
			return {
				maskSelectedPixels: maskBuffer.countSelected(),
				maskEmpty: maskBuffer.isEmpty(),
				maskWidth: maskBuffer.width,
				maskHeight: maskBuffer.height,
				overlayObjects,
			};
		},
		// #255 teardown QA — drive a REAL instant heal/clone patch (the same code
		// path the clone/heal tools use) so a browser test can verify a stroke made
		// just before sign-out survives. Paints a solid `[r,g,b]` rectangle of size
		// `w`x`h` at (`x`,`y`) onto the live backing canvas and SCHEDULES (does not
		// await) the debounced background persist — mirroring applyToolPatchInstant.
		applyInstantPatch: (
			region: { x: number; y: number; width: number; height: number },
			rgb: [number, number, number] = [255, 0, 0],
		) => {
			if (typeof editor.applyToolPatchInstant !== "function") return false;
			const w = Math.max(1, Math.round(region.width));
			const h = Math.max(1, Math.round(region.height));
			const data = new Uint8ClampedArray(w * h * 4);
			for (let i = 0; i < w * h; i++) {
				data[i * 4] = rgb[0];
				data[i * 4 + 1] = rgb[1];
				data[i * 4 + 2] = rgb[2];
				data[i * 4 + 3] = 255;
			}
			const patch = new ImageData(data, w, h);
			return editor.applyToolPatchInstant(patch, { x: region.x, y: region.y, width: w, height: h });
		},
		// Read the live current image url kind + a downscaled pixel sample so a test
		// can confirm the patch is (a) on-canvas instantly and (b) persisted after a
		// flush-then-teardown (the durable url changes from the original).
		hasPendingBrushCommit: () =>
			typeof editor.hasPendingBrushCommit === "function" ? editor.hasPendingBrushCommit() : false,
		getCurrentImageUrl: () => (typeof editor.currentImageUrl === "string" ? editor.currentImageUrl : null),
		// PR #264 P1 proof seam: shrink the off-thread inpaint worker's round-trip
		// timeout so a "wedged worker → bounded timeout → sync fallback" can be driven
		// fast in a browser test (production default is ~10s). DEV/E2E only.
		setInpaintWorkerTimeout: async (ms: number) => {
			const m = await import("$lib/editor/tools/inpaint-worker-client.ts");
			m.__setInpaintWorkerTimeout(ms);
		},
		// PR #264 P1 proof seam: re-enable the inpaint worker after a hang disabled it
		// in-session, so a follow-up proof case can exercise a HEALTHY worker. DEV/E2E
		// only — production never re-enables a worker that hung this session.
		resetInpaintWorker: async () => {
			const m = await import("$lib/editor/tools/inpaint-worker-client.ts");
			m.__resetInpaintWorkerForTests();
		},
		// codex #392 P1-1 proof seam (DEV/E2E only) — arm the Phase B non-destructive
		// edit-layer path for a debug-loaded page. The store sets the edit-layer source
		// id on its real page-render path (project.svelte setImageEditLayers); the debug
		// `loadTestImage` bypasses that, so a browser test arms it explicitly here. With
		// it set (and the host's onCommitImageEditLayerPatch wired), a heal/clone records
		// a real edit LAYER + overlay, which is the path under test.
		setEditLayersSourceForTests: (sourceImageId: string) => {
			editor.setImageEditLayers?.([], sourceImageId);
			return getState(editor);
		},
		// codex #392 P1-1 proof seam — number of recorded non-destructive edit layers +
		// whether the undo stack can revert (so a browser test can assert one stroke = one
		// layer = one undo step, and that undo emptied the stack).
		getImageEditLayerInfo: () => ({
			count: typeof editor.getImageEditLayers === "function" ? editor.getImageEditLayers().length : 0,
			canUndo: typeof editor.canUndo === "function" ? editor.canUndo() : false,
			canRedo: typeof editor.canRedo === "function" ? editor.canRedo() : false,
		}),
		// Concurrent-edit Phase 1 proof seam (DEV/E2E only) — force the page-lease
		// steering state without a backend round-trip so a real-browser test can
		// exercise the PageLeaseBanner presence UI ("X is editing" + View / Take
		// over, and the same-user "Continue here" case). Inert in production.
		setEditLeaseStateForTests: async (
			status: "idle" | "held" | "held-by-other" | "held-by-self-tab" | "unavailable",
			conflict?: { heldByUserId?: string; heldByClientId?: string; expiresAt?: string; lockId?: string } | null,
		) => {
			const m = await import("$lib/stores/edit-lease.svelte.ts");
			m.editLeaseStore.__setStateForTesting(status, conflict ?? null);
			return { status: m.editLeaseStore.status };
		},
		getEditLeaseClientId: async () => {
			const m = await import("$lib/stores/edit-session.svelte.ts");
			return m.editSessionStore.clientId;
		},
	};
}

export function uninstallEditorDebug() {
	if (typeof window === "undefined") return;
	delete window.__mangaEditorDebug;
}

declare global {
	interface Window {
		__mangaEditorDebug?: {
			getState: () => ReturnType<typeof getState>;
			imagePointToClient: (point: Point) => Point;
			imageLayerSourcePointToClient: (layerId: string, point: Point) => Point | null;
			loadTestImage: (options?: TestImageOptions) => Promise<ReturnType<typeof getState>>;
			loadImageUrl: (url: string) => Promise<ReturnType<typeof getState>>;
			addTextLayers: (layers: any[]) => ReturnType<typeof getState>;
			selectTextLayer: (layerId: string) => ReturnType<typeof getState>;
			addImageLayers: (layers: any[]) => Promise<ReturnType<typeof getState>>;
			selectImageLayer: (layerId: string) => ReturnType<typeof getState>;
			clearSelection: () => ReturnType<typeof getState>;
			updateTextLayer: (layerId: string, updates: any) => ReturnType<typeof getState>;
			updateImageLayer: (layerId: string, updates: any) => ReturnType<typeof getState>;
			moveLayerInStack: (kind: "text" | "image", layerId: string, direction: -1 | 1) => ReturnType<typeof getState>;
			moveLayerInStackWithHistory: (kind: "text" | "image", layerId: string, direction: -1 | 1) => ReturnType<typeof getState>;
			setBrushMode: (mode: "erase" | "restore") => ReturnType<typeof getState>;
			setLegacyAiMaskBrushEnabled: (enabled: boolean) => ReturnType<typeof getState>;
			undo: () => Promise<ReturnType<typeof getState>>;
			redo: () => Promise<ReturnType<typeof getState>>;
			exportMergedImageDataUrl: () => Promise<string>;
			getBrushCommitErrorMessage: () => string | null;
			clearEraserMask: () => ReturnType<typeof getState>;
			setAiOverlayTestImage: (options?: TestImageOptions) => Promise<ReturnType<typeof getState>>;
			setAspectRatio: (ratio: [number, number] | null) => ReturnType<typeof getState>;
			setTool: (tool: string) => ReturnType<typeof getState>;
			setSelectionChromeMuted: (muted: boolean) => ReturnType<typeof getState>;
			clearCoverSelection: () => ReturnType<typeof getState>;
			showProcessingIndicator: (jobId: string, crop: { x: number; y: number; w: number; h: number }, stage: string) => ReturnType<typeof getState>;
			updateProcessingIndicator: (jobId: string, stage: string) => ReturnType<typeof getState>;
			hideProcessingIndicator: (jobId: string) => ReturnType<typeof getState>;
			zoomAtCanvasPoint: (point: Point, zoom: number) => ReturnType<typeof getState>;
			setBrushSize: (size: number) => ReturnType<typeof getState>;
			sampleEraserPixel: (point: Point) => number[] | null;
			sampleImageLayerPixel: (layerId: string, point: Point) => number[] | null;
			sampleImageLayerSourcePixel: (layerId: string, point: Point) => number[] | null;
			getImageSelectionState: () => {
				maskSelectedPixels: number;
				maskEmpty: boolean;
				maskWidth: number;
				maskHeight: number;
				overlayObjects: number;
			};
			applyInstantPatch: (
				region: { x: number; y: number; width: number; height: number },
				rgb?: [number, number, number],
			) => boolean;
			hasPendingBrushCommit: () => boolean;
			getCurrentImageUrl: () => string | null;
			setInpaintWorkerTimeout: (ms: number) => Promise<void>;
			resetInpaintWorker: () => Promise<void>;
			setEditLayersSourceForTests: (sourceImageId: string) => ReturnType<typeof getState>;
			getImageEditLayerInfo: () => { count: number; canUndo: boolean; canRedo: boolean };
			setEditLeaseStateForTests: (
				status: "idle" | "held" | "held-by-other" | "held-by-self-tab" | "unavailable",
				conflict?: { heldByUserId?: string; heldByClientId?: string; expiresAt?: string; lockId?: string } | null,
			) => Promise<{ status: string }>;
			getEditLeaseClientId: () => Promise<string>;
		};
	}
}
