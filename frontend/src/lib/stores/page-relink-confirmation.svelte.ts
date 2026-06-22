import type { MatchingPageImageRelinkPreviewLike } from "$lib/project/page-relink-confirmation.js";

interface PageRelinkConfirmationRequest {
	preview: MatchingPageImageRelinkPreviewLike;
	resolve: (confirmed: boolean) => void;
}

class PageRelinkConfirmationStore {
	request = $state<PageRelinkConfirmationRequest | null>(null);

	confirmOrderFallback(preview: MatchingPageImageRelinkPreviewLike): Promise<boolean> {
		if (!preview.requiresOrderConfirmation) return Promise.resolve(true);
		if (this.request) {
			this.request.resolve(false);
		}
		return new Promise((resolve) => {
			this.request = { preview, resolve };
		});
	}

	confirm(): void {
		const request = this.request;
		this.request = null;
		request?.resolve(true);
	}

	cancel(): void {
		const request = this.request;
		this.request = null;
		request?.resolve(false);
	}
}

export const pageRelinkConfirmationStore = new PageRelinkConfirmationStore();
