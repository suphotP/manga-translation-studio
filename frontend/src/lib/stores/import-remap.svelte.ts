import type { JsonImportMappingSelection, JsonImportRemapRequestInput } from "$lib/project/import-json-remap.js";

interface ImportRemapRequest extends JsonImportRemapRequestInput {
	resolve: (value: JsonImportMappingSelection[] | null) => void;
}

class ImportRemapStore {
	request = $state<ImportRemapRequest | null>(null);

	open(input: JsonImportRemapRequestInput): Promise<JsonImportMappingSelection[] | null> {
		if (this.request) {
			this.request.resolve(null);
		}
		return new Promise((resolve) => {
			this.request = {
				...input,
				resolve,
			};
		});
	}

	apply(selection: JsonImportMappingSelection[]): void {
		const request = this.request;
		this.request = null;
		request?.resolve(selection);
	}

	cancel(): void {
		const request = this.request;
		this.request = null;
		request?.resolve(null);
	}
}

export const importRemapStore = new ImportRemapStore();
