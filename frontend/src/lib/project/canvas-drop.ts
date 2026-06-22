export type CanvasImageDropAction = "create-project" | "relink-current-page" | "relink-matching-pages";

interface CanvasImageDropContext {
	hasProject: boolean;
	hasCurrentAssetError: boolean;
	fileCount: number;
}

export function resolveCanvasImageDropAction(context: CanvasImageDropContext): CanvasImageDropAction | null {
	if (context.fileCount <= 0) return null;
	if (context.hasProject && context.hasCurrentAssetError) {
		return context.fileCount === 1 ? "relink-current-page" : "relink-matching-pages";
	}
	// Dropping files onto an active, healthy canvas must not create a new chapter.
	// That surface is also used while selecting AI/crop regions, so treating every
	// drop as setup can re-upload the whole source batch behind an editor workflow.
	if (context.hasProject) return null;
	return "create-project";
}
